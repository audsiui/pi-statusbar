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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** 进度条格子数（1 格 = 10%） */
const BAR_CELLS = 10;

/** 上下文占用行动阈值：≥50% 黄（开始清理/压缩），≥80% 红（准备开新会话） */
const CONTEXT_WARN_PCT = 50;
const CONTEXT_DANGER_PCT = 80;

/** git 状态刷新间隔（毫秒） */
const GIT_STATUS_INTERVAL_MS = 10_000;

interface Totals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
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


export default function (pi: ExtensionAPI) {
	let running = false;
	let requestRender: (() => void) | undefined;

	const rerender = (): void => requestRender?.();

	pi.on("agent_start", () => {
		running = true;
		rerender();
	});
	pi.on("agent_end", () => {
		running = false;
		rerender();
	});
	pi.on("agent_settled", () => {
		running = false;
		rerender();
	});
	pi.on("model_select", () => rerender());

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();

			// ---------- git 变更状态：异步拉取 + 缓存，渲染永不走磁盘 ----------
			let gitStatus: { staged: number; modified: number } | undefined;
			let disposed = false;
			const refreshGitStatus = async (): Promise<void> => {
				if (disposed) return;
				if (footerData.getGitBranch() === null) {
					// 不在 git 仓库：无状态可显示
					gitStatus = undefined;
					return;
				}
				const out = await runGit(ctx.sessionManager.getCwd(), ["status", "--porcelain"]);
				if (disposed) return;
				gitStatus = parseGitStatus(out);
				requestRender?.();
			};
			void refreshGitStatus();
			const gitRefreshTimer = setInterval(() => void refreshGitStatus(), GIT_STATUS_INTERVAL_MS);
			const unsubBranch = footerData.onBranchChange(() => {
				tui.requestRender();
				void refreshGitStatus();
			});

			return {
				dispose: () => {
					disposed = true;
					clearInterval(gitRefreshTimer);
					unsubBranch();
				},
				invalidate() {},
				render(width: number): string[] {
					// ---------- 第 2 行：工作目录 + 分支（accent）+ git 变更 + 会话名 + 扩展状态 ----------
					const home = process.env.HOME || process.env.USERPROFILE;
					const cwd = formatCwdForFooter(ctx.sessionManager.getCwd(), home);
					const branch = footerData.getGitBranch();
					const sessionName = ctx.sessionManager.getSessionName();
					let pwdLine = theme.fg("dim", cwd);
					if (branch) {
						pwdLine += ` ${theme.fg("accent", `⎇ ${branch}`)}`;
						// 变更状态：+暂存(绿) ~已修改(黄)，无变更或不在仓库时不显示
						if (gitStatus && (gitStatus.staged > 0 || gitStatus.modified > 0)) {
							const bits: string[] = [];
							if (gitStatus.staged > 0) bits.push(theme.fg("success", `+${gitStatus.staged}`));
							if (gitStatus.modified > 0) bits.push(theme.fg("warning", `~${gitStatus.modified}`));
							pwdLine += ` ${bits.join(" ")}`;
						}
					}
					if (sessionName) {
						pwdLine += theme.fg("dim", ` • ${sessionName}`);
					}

					// ---------- 上下文占用：唯一带渐变仪表色的数据（行动阈值） ----------
					const context = ctx.getContextUsage();
					const contextWindow = context?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					let contextPart: string | undefined;
					if (contextWindow > 0) {
						const percent = context?.percent;
						if (percent === null || percent === undefined) {
							// 压缩后 token 数未知，等待下一次 LLM 响应
							contextPart = theme.fg("dim", `上下文 ?/${formatTokens(contextWindow)}`);
						} else {
							const filled = Math.min(BAR_CELLS, Math.ceil((percent / 100) * BAR_CELLS));
							const bar = "▰".repeat(filled) + "▱".repeat(BAR_CELLS - filled);
							// 渐变仪表色：<50% 绿 / ≥50% 黄（行动）/ ≥80% 红（紧急）
							const color: "success" | "warning" | "error" =
								percent >= CONTEXT_DANGER_PCT ? "error" : percent >= CONTEXT_WARN_PCT ? "warning" : "success";
							contextPart = theme.fg(
								color,
								`上下文 ${bar} ${percent.toFixed(1)}%/${formatTokens(contextWindow)}`,
							);
						}
					}

					// ---------- 会话累计用量（与内置 footer 口径一致：assistant + toolResult + 压缩摘要） ----------
					const totals: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
					let latestCacheHitRate: number | undefined;
					for (const entry of ctx.sessionManager.getEntries()) {
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

					// ---------- 第 2 行左侧：会话数据，全部 dim ----------
					const parts: string[] = [];
					if (contextPart) parts.push(contextPart);
					if (totals.input > 0) {
						parts.push(theme.fg("dim", `↑${formatTokens(totals.input)} ↓${formatTokens(totals.output)}`));
					}
					if (totals.cacheRead > 0 || totals.cacheWrite > 0) {
						parts.push(
							theme.fg(
								"dim",
								`R${formatTokens(totals.cacheRead)} W${formatTokens(totals.cacheWrite)}`,
							),
						);
						if (latestCacheHitRate !== undefined) {
							parts.push(theme.fg("dim", `缓存${latestCacheHitRate.toFixed(1)}%`));
						}
					}
					if (totals.cost > 0) {
						parts.push(theme.fg("dim", `$${totals.cost.toFixed(3)}`));
					} else if (ctx.model?.provider === "kimi-coding") {
						parts.push(theme.fg("dim", "订阅"));
					}

					// ---------- 第 1 行右侧：模型身份，accent 加粗；● 工作中 / ○ 待命 ----------
					const modelId = ctx.model?.id ?? "no-model";
					const modelGlyph = running ? "●" : "○";
					let right = theme.fg("accent", theme.bold(`${modelGlyph} ${modelId}`));
					// 思考级别 = 智能程度色阶（官方 thinking* 主题色：灰→蓝→紫→品红递增）
					if (ctx.model?.reasoning && ctx.thinkingLevel) {
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
						right += theme.fg(thinkingColor, ` • thinking ${level}`);
					}
					const provider = ctx.model?.provider;
					if (provider && footerData.getAvailableProviderCount() > 1) {
						right = theme.fg("dim", `(${provider}) `) + right;
					}

					const rightWidth = visibleWidth(right);
					const separator = theme.fg("dim", " · ");

					// 窄屏降级：从尾部（价值最低）逐段丢弃，直到左段放得下
					let left = "";
					while (parts.length > 0) {
						const candidate = parts.join(separator);
						if (visibleWidth(candidate) + rightWidth + 2 <= width) {
							left = candidate;
							break;
						}
						parts.pop();
					}

					// 极窄：左段全丢后右侧仍超宽，截断右侧
					let line1: string;
					if (visibleWidth(right) > width) {
						line1 = truncateToWidth(right, width, "…");
					} else {
						const gap = " ".repeat(Math.max(1, width - visibleWidth(left) - rightWidth));
						line1 = left === "" ? right : left + gap + right;
					}

					// 第 2 行：位置信息 + 扩展状态（ctx.ui.setStatus 设置的内容）合并，整体截断
					const extensionStatuses = footerData.getExtensionStatuses();
					if (extensionStatuses.size > 0) {
						const statusLine = Array.from(extensionStatuses.entries())
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, text]) => sanitizeStatusText(text))
							.join(" ");
						pwdLine += theme.fg("dim", ` · ${statusLine}`);
					}
					const pwdLineFinal = truncateToWidth(pwdLine, width, theme.fg("dim", "…"));
					return [line1, pwdLineFinal];
				},
			};
		});
	});
}