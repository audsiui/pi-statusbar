/**
 * 中文美化状态栏 —— 替换内置 footer。
 *
 * 设计原则（对齐内置 footer 的信息层级，保留调研结论）：
 * - 多行叙事：第 1 行工作目录/分支/会话名，第 2 行会话数据（左侧）
 *   + 模型身份（右侧 accent），第 3 行扩展状态（若有）。
 * - 颜色纪律：唯一使用语义色（黄/红）的是上下文占用 —— >70% 警告、>90% 危险；
 *   其余数据一律用 dim 保持安静，避免整条底栏像霓虹灯。
 * - 信息优先，装饰最后：分隔符只承担分组功能（·），进度条只表达占用比例（▰▱）。
 * - 窄屏降级：每行独立截断；第 2 行按价值从低到高逐段丢弃
 *   （成本 → 缓存 → 用量 → 进度条 → 上下文），绝不换行、不挤压。
 * - 状态变化克制：仅"工作中/待命"一个状态指示（●/○），每轮至多变化一次。
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** 进度条格子数（1 格 = 10%） */
const BAR_CELLS = 10;

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
			const unsubBranch = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose: () => unsubBranch(),
				invalidate() {},
				render(width: number): string[] {
					// ---------- 第 1 行：工作目录 + 分支（accent）+ 会话名 ----------
					const home = process.env.HOME || process.env.USERPROFILE;
					const cwd = formatCwdForFooter(ctx.sessionManager.getCwd(), home);
					const branch = footerData.getGitBranch();
					const sessionName = ctx.sessionManager.getSessionName();
					let pwdLine = theme.fg("dim", cwd);
					if (branch) {
						pwdLine += ` ${theme.fg("accent", `⎇ ${branch}`)}`;
					}
					if (sessionName) {
						pwdLine += theme.fg("dim", ` • ${sessionName}`);
					}
					pwdLine = truncateToWidth(pwdLine, width, theme.fg("dim", "…"));

					// ---------- 上下文占用：唯一使用语义色的数据 ----------
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
							const color: "error" | "warning" | "dim" =
								percent > 90 ? "error" : percent > 70 ? "warning" : "dim";
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
						} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
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

					// ---------- 第 2 行右侧：模型身份，accent 加粗；● 工作中 / ○ 待命 ----------
					const modelId = ctx.model?.id ?? "no-model";
					const modelGlyph = running ? "●" : "○";
					let right = theme.fg("accent", theme.bold(`${modelGlyph} ${modelId}`));
					// 模型支持推理时显示思考级别（同内置 footer）
					if (ctx.model?.reasoning) {
						const level = ctx.thinkingLevel ?? "off";
						right += theme.fg("dim", ` • thinking ${level}`);
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
					if (visibleWidth(right) > width) {
						return [pwdLine, truncateToWidth(right, width, "…")];
					}
					const gap = " ".repeat(Math.max(1, width - visibleWidth(left) - rightWidth));
					const statsLine = left === "" ? right : left + gap + right;
					const lines = [pwdLine, statsLine];

					// ---------- 第 3 行：扩展状态（ctx.ui.setStatus 设置的内容） ----------
					const extensionStatuses = footerData.getExtensionStatuses();
					if (extensionStatuses.size > 0) {
						const statusLine = Array.from(extensionStatuses.entries())
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, text]) => sanitizeStatusText(text))
							.join(" ");
						lines.push(truncateToWidth(theme.fg("dim", statusLine), width, theme.fg("dim", "…")));
					}
					return lines;
				},
			};
		});
	});
}
