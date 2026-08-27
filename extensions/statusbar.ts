/**
 * pi-statusbar: 状态栏与输入框一体化美化扩展
 *
 * 核心设计哲学：
 * 1. 视线动线合一（Model on Editor Border）：
 *    将模型身份与思考等级（● claude-3-7-sonnet • high）直接内嵌到输入框顶部的圆角边框上，
 *    在用户打字思考的第一焦点处展示 AI 状态；运行中实时旋转 Braille 动效。
 * 2. 底部栏极致单行（Single-Line Telemetry Footer）：
 *    底部释放为纯净的单行：左侧环境锚点（目录、Git 分支、暂存/修改），
 *    右侧核心遥测（上下文进度条、用量吞吐、缓存命中率、费用）。省出整整一行垂直高度给代码！
 * 3. 性能与架构：
 *    - O(1) 缓存驱动 Token 统计，告别每帧遍历。
 *    - -uno 极速 Git 检查 + 事件驱动即时刷新。
 *    - 分段着色进度条，无光污染。
 */

import { execFile } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Component, EditorTheme, Theme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** 进度条格子数（6 格最适合单行布局，精巧直观） */
const BAR_CELLS = 6;

/** 上下文占用行动阈值：≥50% 黄（开始清理/压缩），≥80% 红（准备开新会话） */
const CONTEXT_WARN_PCT = 50;
const CONTEXT_DANGER_PCT = 80;

/** Git 兜底轮询间隔（毫秒） */
const GIT_POLL_INTERVAL_MS = 15_000;

/** 盲文旋转帧 */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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


/** 格式化自适应边框行，支持圆角字符 */
function formatBorder(
	left: string,
	right: string,
	width: number,
	borderColor: (text: string) => string,
	corners: { left: string; right: string },
): string {
	const cLeft = borderColor(corners.left);
	const cRight = borderColor(corners.right);
	const fixedWidth = visibleWidth(cLeft) + visibleWidth(cRight);
	const minGap = 2;

	let leftText = left;
	let rightText = right;

	while (
		fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minGap > width &&
		visibleWidth(rightText) > 0
	) {
		rightText = truncateToWidth(rightText, Math.max(0, visibleWidth(rightText) - 1), "");
	}
	while (
		fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minGap > width &&
		visibleWidth(leftText) > 0
	) {
		leftText = truncateToWidth(leftText, Math.max(0, visibleWidth(leftText) - 1), "");
	}

	const gapWidth = Math.max(0, width - fixedWidth - visibleWidth(leftText) - visibleWidth(rightText));
	return `${cLeft}${leftText}${borderColor("─".repeat(gapWidth))}${rightText}${cRight}`;
}

// ============================================================================
// 1. 带模型身份与动效的圆角输入框
// ============================================================================
class ModelBorderEditor extends CustomEditor {
	private ctx: ExtensionContext;
	private appTheme: Theme;
	private getSpinnerFrame: () => string;
	private getCurrentToolName: () => string | undefined;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		ctx: ExtensionContext,
		appTheme: Theme,
		getSpinnerFrame: () => string,
		getCurrentToolName: () => string | undefined,
	) {
		super(tui, theme, keybindings, { paddingX: 0 });
		this.ctx = ctx;
		this.appTheme = appTheme;
		this.getSpinnerFrame = getSpinnerFrame;
		this.getCurrentToolName = getCurrentToolName;
	}

	render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length < 2) return lines;

		const thm = this.appTheme;
		const ctx = this.ctx;
		const isRunning = !ctx.isIdle();

		// 运行中旋转动态 Braille 点阵，待命时显示平静圆点
		const glyph = isRunning ? thm.fg("accent", this.getSpinnerFrame()) : thm.fg("dim", "○");
		const modelId = ctx.model?.id ?? "no-model";

		let badge = ` ${glyph} ${thm.fg("accent", thm.bold(modelId))}`;

		const toolName = isRunning ? this.getCurrentToolName() : undefined;
		if (toolName) {
			badge += thm.fg("warning", ` [${toolName}]`);
		} else if (ctx.model?.reasoning && ctx.thinkingLevel && ctx.thinkingLevel !== "off") {
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
			badge += thm.fg(thinkingColor, ` • ${level}`);
		}

		const provider = ctx.model?.provider;
		if (provider && ctx.model) {
			badge = thm.fg("dim", ` (${provider})`) + badge;
		}

		badge += " ";

		const borderColor = (str: string) => this.borderColor(str);

		// 顶边框：内嵌模型徽章与圆角 ╭─ ... ─╮
		lines[0] = formatBorder(badge, "", width, borderColor, { left: "╭─", right: "─╮" });

		// 底边框：圆角 ╰─ ... ─╯，未激活补全时附带微提示
		if (!this.isShowingAutocomplete()) {
			const bottomHint = thm.fg("dim", " [ ↵ Send ] ");
			lines[lines.length - 1] = formatBorder("", bottomHint, width, borderColor, { left: "╰─", right: "─╯" });
		}

		return lines;
	}
}

// ============================================================================
// 2. 极致单行状态栏（遥测与环境感知）
// ============================================================================
class SingleLineStatusbar implements Component {
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

		// ---------- 左侧环境：CWD + Git 分支 + 变更计数 + 会话名 ----------
		const home = process.env.HOME || process.env.USERPROFILE;
		const cwd = formatCwdForFooter(ctx.sessionManager.getCwd(), home);
		const branch = this.footerData.getGitBranch();
		const sessionName = ctx.sessionManager.getSessionName();
		let left = theme.fg("dim", cwd);
		if (branch) {
			left += ` ${theme.fg("accent", `⎇ ${branch}`)}`;
			if (this.gitStatus && (this.gitStatus.staged > 0 || this.gitStatus.modified > 0)) {
				const bits: string[] = [];
				if (this.gitStatus.staged > 0) bits.push(theme.fg("success", `+${this.gitStatus.staged}`));
				if (this.gitStatus.modified > 0) bits.push(theme.fg("warning", `~${this.gitStatus.modified}`));
				left += ` ${bits.join(" ")}`;
			}
		}
		if (sessionName) {
			left += theme.fg("dim", ` • ${sessionName}`);
		}

		// ---------- 右侧指标：上下文仪表 + 费用 + 缓存 + Token 吞吐 ----------
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

		const totals = this.getTotals();
		const rightParts: string[] = [];
		if (contextPart) rightParts.push(contextPart);

		if (totals.cost > 0) {
			rightParts.push(theme.fg("dim", `$${totals.cost.toFixed(3)}`));
		} else if (ctx.model?.provider === "kimi-coding") {
			rightParts.push(theme.fg("dim", "∞"));
		}

		if (totals.cacheRead > 0 || totals.cacheWrite > 0) {
			const cacheBits: string[] = [];
			if (totals.cacheRead > 0) cacheBits.push(`⇣${formatTokens(totals.cacheRead)}`);
			if (totals.cacheWrite > 0) cacheBits.push(`⇡${formatTokens(totals.cacheWrite)}`);
			if (totals.latestCacheHitRate !== undefined) {
				cacheBits.push(`⚡${totals.latestCacheHitRate.toFixed(1)}%`);
			}
			if (cacheBits.length > 0) rightParts.push(theme.fg("dim", cacheBits.join(" ")));
		}

		if (totals.input > 0 || totals.output > 0) {
			rightParts.push(theme.fg("dim", `↑${formatTokens(totals.input)} ↓${formatTokens(totals.output)}`));
		}

		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const statusLine = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text))
				.join(" ");
			rightParts.push(theme.fg("dim", `[${statusLine}]`));
		}

		const separator = theme.fg("dim", " · ");
		let right = rightParts.join(separator);

		// 响应式单行收缩：空间紧张时从右端末尾逐步丢弃辅助指标
		while (rightParts.length > 0 && visibleWidth(left) + visibleWidth(right) + 2 > width) {
			rightParts.pop();
			right = rightParts.join(separator);
		}

		// 如果左侧过长，收缩左侧
		const rightWidth = visibleWidth(right);
		if (visibleWidth(left) + rightWidth + 2 > width) {
			left = truncateToWidth(left, Math.max(0, width - rightWidth - 2), theme.fg("dim", "…"));
		}

		const gap = " ".repeat(Math.max(1, width - visibleWidth(left) - rightWidth));
		const singleLine = right === "" ? left : left + gap + right;

		// 仅返回一行！省出垂直高度！
		return [truncateToWidth(singleLine, width)];
	}
}

// ============================================================================
// 3. 插件注册入口
// ============================================================================
export default function (pi: ExtensionAPI) {
	let statusbar: SingleLineStatusbar | undefined;
	let activeTui: TUI | undefined;
	let spinnerIndex = 0;
	let spinnerTimer: ReturnType<typeof setInterval> | undefined;
	let currentToolName: string | undefined;

	const startSpinner = () => {
		if (spinnerTimer) return;
		spinnerTimer = setInterval(() => {
			spinnerIndex = (spinnerIndex + 1) % SPINNER_FRAMES.length;
			activeTui?.requestRender();
		}, 80);
	};

	const stopSpinner = () => {
		if (spinnerTimer) {
			clearInterval(spinnerTimer);
			spinnerTimer = undefined;
		}
	};

	const getSpinnerFrame = () => SPINNER_FRAMES[spinnerIndex];

	const invalidate = () => statusbar?.invalidate();
	const refreshGit = () => void statusbar?.refreshGit();
	const rerender = () => activeTui?.requestRender();

	// 监听核心生命周期事件
	pi.on("agent_start", () => {
		startSpinner();
		rerender();
	});
	pi.on("agent_end", () => {
		stopSpinner();
		currentToolName = undefined;
		invalidate();
		refreshGit();
		rerender();
	});
	pi.on("agent_settled", () => {
		stopSpinner();
		currentToolName = undefined;
		invalidate();
		rerender();
	});
	pi.on("turn_end", () => {
		currentToolName = undefined;
		invalidate();
		refreshGit();
		rerender();
	});
	pi.on("message_end", () => {
		invalidate();
		rerender();
	});
	pi.on("tool_execution_start", (event) => {
		currentToolName = event.toolName;
		rerender();
	});
	pi.on("tool_execution_end", () => {
		currentToolName = undefined;
		rerender();
	});
	pi.on("model_select", () => rerender());
	pi.on("thinking_level_select", () => rerender());
	pi.on("session_info_changed", () => rerender());
	pi.on("session_compact", () => {
		invalidate();
		rerender();
	});
	pi.on("session_shutdown", () => {
		stopSpinner();
		currentToolName = undefined;
		activeTui = undefined;
	});

	pi.on("session_start", (_event, ctx) => {
		// 隐藏内置 working... 行，由输入框顶边框独占接管，彻底解决双重 Spinner 冲突并多省出 1 行高度
		ctx.ui.setWorkingVisible(false);

		// 1. 设置极简单行状态栏
		ctx.ui.setFooter((tui, theme, footerData) => {
			activeTui = tui;
			statusbar = new SingleLineStatusbar(ctx, tui, theme, footerData);
			return statusbar;
		});

		// 2. 设置圆角模型状态输入框
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			activeTui = tui;
			return new ModelBorderEditor(
				tui,
				theme,
				keybindings,
				ctx,
				ctx.ui.theme,
				getSpinnerFrame,
				() => currentToolName,
			);
		});
	});
}