/**
 * 中文美化状态栏 —— 替换内置 footer。
 *
 * 设计理念（调研自 Claude Code statusline 官方文档、claude-stat、
 * note.com 用户实战、Calm Technology / Glanceable UX、Starship）：
 *
 * - 状态栏是"外围显示"（periphery）：inform without demanding。
 *   扫一眼应能回答 4 个问题：我在哪 / 还能干多久 / 在烧多少钱 / 模型在什么状态。
 * - 多行叙事：第 1 行是仪表（上下文/用量/缓存/成本 + 模型身份）——变化频率最高，
 *   紧贴内容区；第 2 行是环境（目录/分支/git 变更/会话名 + 扩展状态）——
 *   低频信息合并，按注意力随变化频率分配。
 * - 颜色 = 注意力线索，只在"有行动含义"处使用：
 *   上下文占用是仪表 —— 渐变绿→黄→红（<50% 绿 / ≥50% 黄 / ≥80% 红），
 *   阈值取社区实测的"行动阈值"（50% 清理对话、80% 开新会话），不是被动挨打阈值；
 *   git 变更 +N ~M 是状态信号（绿=暂存 / 黄=已修改）。
 *   其余数据一律 dim 保持安静。
 * - thinking 级别是"智能程度"色阶（官方 thinkingOff→thinkingMax 主题色），
 *   表达投入强度，不是危险度。
 * - 上下文感知（Starship 原则）：git 段只在仓库内出现，思考级别只在
 *   支持推理的模型上出现，一切按需展示。
 * - 窄屏降级：每行独立截断；第 2 行按价值从低到高逐段丢弃，绝不换行。
 * - 性能：git 状态异步拉取 + 缓存（GIT_OPTIONAL_LOCKS=0 不等待锁），
 *   每 10s 与分支变化时刷新，渲染永远读缓存。
 */

import { execFile } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, Theme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** 进度条格子数（8 格精巧且比例适中） */
const BAR_CELLS = 8;

/** 上下文占用行动阈值：≥50% 黄（开始清理/压缩），≥80% 红（准备开新会话） */
const CONTEXT_WARN_PCT = 50;
const CONTEXT_DANGER_PCT = 80;

/** Git 状态兜底轮询间隔（毫秒） */
const GIT_POLL_INTERVAL_MS = 15_000;

interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	latestCacheHitRate?: number;
}

/** 数字缩写，与内置 footer 口径一致：<1k 原样，<10k 一位小数 k，<1M 整数 k，<10M 一位小数 M，否则整数 M */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/** HOME 缩写：/home/u/proj → ~/proj（与内置 footer 一致） */
function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const rel = relative(resolvedHome, resolvedCwd);
	const insideHome =
		rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	if (!insideHome) return cwd;
	return rel === "" ? "~" : `~${sep}${rel}`;
}

/** 清洗 setStatus 文本：换行/制表符 → 空格，折叠连续空格（同内置 footer） */
function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

/** 运行 git 命令，永不抛出；失败返回空串 */
function runGit(cwd: string, args: string[]): Promise<string> {
	return new Promise((resolvePromise) => {
		execFile(
			"git",
			args,
			{
				cwd,
				env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
				timeout: 3000,
			},
			(err, stdout) => {
				resolvePromise(err ? "" : stdout);
			},
		);
	});
}

/**
 * 解析 git status --porcelain：
 * 每行 "XY path"，X=暂存区状态，Y=工作区状态；"??" 是未跟踪文件，不计入。
 * 与内置 footer 口径一致的 staged(暂存) / modified(已修改) 计数。
 */
function parseGitStatus(out: string): { staged: number; modified: number } {
	let staged = 0;
	let modified = 0;
	for (const line of out.split("\n")) {
		if (line.length < 2) continue;
		const x = line[0];
		const y = line[1];
		if (x !== " " && x !== "?") staged++;
		if (y !== " " && y !== "?") modified++;
	}
	return { staged, modified };
}


class StatusbarComponent implements Component {
	private disposed = false;
	private gitTimer: ReturnType<typeof setInterval>;
	private gitStatus: { staged: number; modified: number } | undefined;
	private gitInFlight = false;
	private gitPending = false;
	private totalsDirty = true;
	private cachedTotals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	private unsubBranch: () => void;

	constructor(
		private ctx: ExtensionContext,
		public tui: TUI,
		private theme: Theme,
		private footerData: any,
	) {
		this.unsubBranch = this.footerData.onBranchChange(() => {
			this.tui.requestRender();
			void this.refreshGit();
		});

		void this.refreshGit();
		this.gitTimer = setInterval(() => void this.refreshGit(), GIT_POLL_INTERVAL_MS);
	}

	invalidate(): void {
		this.totalsDirty = true;
	}

	dispose(): void {
		this.disposed = true;
		clearInterval(this.gitTimer);
		this.unsubBranch();
	}

	/** 异步拉取 Git 状态，带并发锁与防抖合并 */
	async refreshGit(): Promise<void> {
		if (this.disposed) return;
		if (this.footerData.getGitBranch() === null) {
			this.gitStatus = undefined;
			return;
		}

		if (this.gitInFlight) {
			this.gitPending = true;
			return;
		}

		this.gitInFlight = true;
		try {
			// -uno 忽略未跟踪文件扫描，大幅减少磁盘 I/O
			const out = await runGit(this.ctx.sessionManager.getCwd(), ["status", "--porcelain", "-uno"]);
			if (this.disposed) return;
			this.gitStatus = parseGitStatus(out);
			this.tui.requestRender();
		} finally {
			this.gitInFlight = false;
			if (this.gitPending && !this.disposed) {
				this.gitPending = false;
				void this.refreshGit();
			}
		}
	}

	/** 缓存驱动的用量统计，避免每帧 O(N) 遍历 */
	private getTotals(): UsageTotals {
		if (!this.totalsDirty) {
			return this.cachedTotals;
		}

		const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
		let latestCacheHitRate: number | undefined;

		for (const entry of this.ctx.sessionManager.getEntries()) {
			if (entry.type !== "message") {
				if (
					(entry.type === "branch_summary" || entry.type === "compaction") &&
					entry.usage
				) {
					const u = entry.usage;
					totals.input += u.input ?? 0;
					totals.output += u.output ?? 0;
					totals.cacheRead += u.cacheRead ?? 0;
					totals.cacheWrite += u.cacheWrite ?? 0;
					totals.cost += u.cost?.total ?? 0;
				}
				continue;
			}
			if (entry.type === "message" && entry.message.role === "assistant") {
				const u = entry.message.usage;
				if (u) {
					totals.input += u.input ?? 0;
					totals.output += u.output ?? 0;
					totals.cacheRead += u.cacheRead ?? 0;
					totals.cacheWrite += u.cacheWrite ?? 0;
					totals.cost += u.cost?.total ?? 0;
					const promptTokens = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
					if (promptTokens > 0) {
						latestCacheHitRate = ((u.cacheRead ?? 0) / promptTokens) * 100;
					}
				}
			} else if (
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.usage
			) {
				const u = entry.message.usage;
				totals.input += u.input ?? 0;
				totals.output += u.output ?? 0;
				totals.cacheRead += u.cacheRead ?? 0;
				totals.cacheWrite += u.cacheWrite ?? 0;
				totals.cost += u.cost?.total ?? 0;
			}
		}

		totals.latestCacheHitRate = latestCacheHitRate;
		this.cachedTotals = totals;
		this.totalsDirty = false;
		return totals;
	}

	render(width: number): string[] {
		const theme = this.theme;
		const ctx = this.ctx;

		// ---------- 第 2 行基础：工作目录 + 分支 + Git 变更 + 会话名 ----------
		const home = process.env.HOME || process.env.USERPROFILE;
		const cwd = formatCwdForFooter(ctx.sessionManager.getCwd(), home);
		const branch = this.footerData.getGitBranch();
		const sessionName = ctx.sessionManager.getSessionName();
		let pwdLine = theme.fg("dim", cwd);
		if (branch) {
			pwdLine += ` ${theme.fg("accent", `⎇ ${branch}`)}`;
			if (this.gitStatus && (this.gitStatus.staged > 0 || this.gitStatus.modified > 0)) {
				const bits: string[] = [];
				if (this.gitStatus.staged > 0) bits.push(theme.fg("success", `+${this.gitStatus.staged}`));
				if (this.gitStatus.modified > 0) bits.push(theme.fg("warning", `~${this.gitStatus.modified}`));
				pwdLine += ` ${bits.join(" ")}`;
			}
		}
		if (sessionName) {
			pwdLine += theme.fg("dim", ` • ${sessionName}`);
		}

		// ---------- 上下文占用：分段着色（仅填充格着色，轨道与总数保持暗调） ----------
		const context = ctx.getContextUsage();
		const contextWindow = context?.contextWindow ?? ctx.model?.contextWindow ?? 0;
		let contextPart: string | undefined;
		if (contextWindow > 0) {
			const percent = context?.percent;
			if (percent === null || percent === undefined) {
				contextPart = theme.fg("dim", `?/${formatTokens(contextWindow)}`);
			} else {
				const filled = Math.min(BAR_CELLS, Math.round((percent / 100) * BAR_CELLS));
				const empty = BAR_CELLS - filled;
				const levelColor: "success" | "warning" | "error" =
					percent >= CONTEXT_DANGER_PCT ? "error" : percent >= CONTEXT_WARN_PCT ? "warning" : "success";

				const bar = theme.fg(levelColor, "▰".repeat(filled)) + theme.fg("dim", "▱".repeat(empty));
				const pctStr = theme.fg(levelColor, `${percent.toFixed(1)}%`);
				const totalStr = theme.fg("dim", `/${formatTokens(contextWindow)}`);
				contextPart = `${bar} ${pctStr}${totalStr}`;
			}
		}

		// ---------- 缓存驱动的会话用量（O(1) 读取） ----------
		const totals = this.getTotals();

		// ---------- 第 1 行左侧：核心指标组 ----------
		const parts: string[] = [];
		if (contextPart) parts.push(contextPart);
		if (totals.input > 0 || totals.output > 0) {
			parts.push(theme.fg("dim", `↑${formatTokens(totals.input)} ↓${formatTokens(totals.output)}`));
		}
		if (totals.cacheRead > 0 || totals.cacheWrite > 0) {
			const cacheBits: string[] = [];
			if (totals.cacheRead > 0) cacheBits.push(`⇣${formatTokens(totals.cacheRead)}`);
			if (totals.cacheWrite > 0) cacheBits.push(`⇡${formatTokens(totals.cacheWrite)}`);
			if (totals.latestCacheHitRate !== undefined) {
				cacheBits.push(`⚡${totals.latestCacheHitRate.toFixed(1)}%`);
			}
			if (cacheBits.length > 0) parts.push(theme.fg("dim", cacheBits.join(" ")));
		}
		if (totals.cost > 0) {
			parts.push(theme.fg("dim", `$${totals.cost.toFixed(3)}`));
		} else if (ctx.model?.provider === "kimi-coding") {
			parts.push(theme.fg("dim", "∞"));
		}

		// ---------- 第 1 行右侧：模型身份与状态（● 运行 / ○ 待命） ----------
		const isRunning = !ctx.isIdle();
		const modelGlyph = isRunning ? "●" : "○";
		const modelId = ctx.model?.id ?? "no-model";
		let right = theme.fg("accent", theme.bold(`${modelGlyph} ${modelId}`));

		if (ctx.model?.reasoning && ctx.thinkingLevel && ctx.thinkingLevel !== "off") {
			const level = ctx.thinkingLevel;
			const thinkingColor =
				level === "minimal"
					? "thinkingMinimal"
					: level === "low"
						? "thinkingLow"
						: level === "medium"
							? "thinkingMedium"
							: level === "high"
								? "thinkingHigh"
								: level === "xhigh"
									? "thinkingXhigh"
									: "thinkingMax";
			right += theme.fg(thinkingColor, ` • ${level}`);
		}
		const provider = ctx.model?.provider;
		if (provider && this.footerData.getAvailableProviderCount() > 1) {
			right = theme.fg("dim", `(${provider}) `) + right;
		}

		const rightWidth = visibleWidth(right);
		const separator = theme.fg("dim", " · ");

		// 响应式降级：从末尾逐段丢弃辅助数据，确保核心上下文占用保留
		let left = "";
		while (parts.length > 0) {
			const candidate = parts.join(separator);
			if (visibleWidth(candidate) + rightWidth + 2 <= width) {
				left = candidate;
				break;
			}
			parts.pop();
		}

		// 第 1 行布局：稳定右对齐，绝不突变跳跃到最左侧
		let line1: string;
		const leftWidth = visibleWidth(left);
		if (leftWidth + rightWidth + 1 <= width) {
			const gap = " ".repeat(Math.max(1, width - leftWidth - rightWidth));
			line1 = left === "" ? " ".repeat(width - rightWidth) + right : left + gap + right;
		} else if (rightWidth <= width) {
			line1 = " ".repeat(width - rightWidth) + right;
		} else {
			line1 = truncateToWidth(right, width, "…");
		}

		// 第 2 行：位置 + 扩展状态合并
		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const statusLine = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text))
				.join(" ");
			pwdLine += theme.fg("dim", ` · ${statusLine}`);
		}
		const line2 = truncateToWidth(pwdLine, width, theme.fg("dim", "…"));

		return [line1, line2];
	}
}

export default function (pi: ExtensionAPI) {
	let statusbar: StatusbarComponent | undefined;

	const invalidate = () => statusbar?.invalidate();
	const refreshGit = () => void statusbar?.refreshGit();
	const rerender = () => statusbar?.tui.requestRender();

	// 监听生命周期与交互事件，实现毫秒级响应
	pi.on("agent_start", () => rerender());
	pi.on("agent_end", () => {
		invalidate();
		refreshGit();
		rerender();
	});
	pi.on("agent_settled", () => {
		invalidate();
		rerender();
	});
	pi.on("turn_end", () => {
		invalidate();
		refreshGit();
		rerender();
	});
	pi.on("message_end", () => {
		invalidate();
		rerender();
	});
	pi.on("model_select", () => rerender());
	pi.on("thinking_level_select", () => rerender());
	pi.on("session_info_changed", () => rerender());
	pi.on("session_compact", () => {
		invalidate();
		rerender();
	});

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			statusbar = new StatusbarComponent(ctx, tui, theme, footerData);
			return statusbar;
		});
	});
}