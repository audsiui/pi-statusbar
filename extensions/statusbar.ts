/**
 * 中文美化状态栏 —— 替换内置 footer。
 *
 * 设计原则（调研自 Starship、Claude Code、Microsoft 状态栏指南）：
 * - 左右叙事：左侧是会话数据（安静、dim 色调），右侧是模型身份（accent 高亮）。
 * - 颜色纪律：唯一使用语义色（黄/红）的是上下文占用 —— >70% 警告、>90% 危险；
 *   其余数据一律用 dim 保持安静，避免整条底栏像霓虹灯。
 * - 信息优先，装饰最后：分隔符只承担分组功能（·），进度条只表达占用比例（▰▱）。
 * - 窄屏降级：宽度不足时按价值从低到高逐段丢弃（成本 → 缓存 → 用量 → 进度条 →
 *   上下文 → 分支），绝不换行、不挤压。
 * - 状态变化克制：仅"工作中/待命"一个状态指示（●/○），每轮至多变化一次。
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
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

function isAssistantMessage(message: unknown): message is AssistantMessage {
	if (!message || typeof message !== "object") return false;
	return (message as { role?: unknown }).role === "assistant";
}

/** 数字缩写：1234 → 1.2k，2100000 → 2.1M */
function fmt(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
	return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
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
					const parts: string[] = [];

					// 分支：身份锚点，accent 色（唯一与数据并列的强调）
					const branch = footerData.getGitBranch();
					if (branch) {
						parts.push(theme.fg("accent", `⎇ ${branch}`));
					}

					// 上下文占用：唯一使用语义色的数据
					const context = ctx.getContextUsage();
					const contextWindow = context?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					if (contextWindow > 0) {
						const percent = context?.percent;
						if (percent === null || percent === undefined) {
							// 压缩后 token 数未知，等待下一次 LLM 响应
							parts.push(theme.fg("dim", `上下文 ?/${fmt(contextWindow)}`));
						} else {
							const filled = Math.min(BAR_CELLS, Math.ceil((percent / 100) * BAR_CELLS));
							const bar = "▰".repeat(filled) + "▱".repeat(BAR_CELLS - filled);
							const color: "error" | "warning" | "dim" =
								percent > 90 ? "error" : percent > 70 ? "warning" : "dim";
							parts.push(theme.fg(color, `上下文 ${bar} ${percent.toFixed(1)}%`));
						}
					}

					// 会话累计用量（与内置 footer 口径一致：assistant + toolResult + 压缩摘要）
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
						if (isAssistantMessage(entry.message)) {
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
						} else if (entry.message.role === "toolResult" && entry.message.usage) {
							const u = entry.message.usage;
							totals.input += u.input ?? 0;
							totals.output += u.output ?? 0;
							totals.cacheRead += u.cacheRead ?? 0;
							totals.cacheWrite += u.cacheWrite ?? 0;
							totals.cost += u.cost?.total ?? 0;
						}
					}

					// 用量、缓存命中率、成本：全部 dim，安静呈现
					if (totals.input > 0) {
						parts.push(theme.fg("dim", `↑${fmt(totals.input)} ↓${fmt(totals.output)}`));
					}
					if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
						parts.push(theme.fg("dim", `缓存 ${latestCacheHitRate.toFixed(0)}%`));
					}
					if (totals.cost > 0) {
						parts.push(theme.fg("dim", `$${totals.cost.toFixed(3)}`));
					} else if (ctx.model?.provider === "kimi-coding") {
						parts.push(theme.fg("dim", "订阅"));
					}

					// 右侧：模型身份，accent 加粗；● 工作中 / ○ 待命
					const modelId = ctx.model?.id ?? "no-model";
					const modelGlyph = running ? "●" : "○";
					const modelPart = theme.fg("accent", theme.bold(`${modelGlyph} ${modelId}`));
					const provider = ctx.model?.provider;
					const right =
						provider && footerData.getAvailableProviderCount() > 1
							? theme.fg("dim", `(${provider}) `) + modelPart
							: modelPart;

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

					// 极窄：左段全丢后右侧仍超宽，截断模型名
					if (visibleWidth(right) > width) {
						return [truncateToWidth(right, width, "…")];
					}
					if (left === "") {
						return [right];
					}
					const gap = " ".repeat(Math.max(1, width - visibleWidth(left) - rightWidth));
					return [left + gap + right];
				},
			};
		});
	});
}
