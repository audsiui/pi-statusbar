import type { Theme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** 提取各种工具的目标参数摘要 */
export function extractTarget(toolName: string, args: any): string {
	if (!args || typeof args !== "object") return "";
	if (toolName === "bash" || toolName === "$") return args.command || "";
	if (toolName === "read" || toolName === "edit" || toolName === "write") return args.path || args.file_path || "";
	if (toolName === "grep") return args.pattern || args.query || "";
	if (toolName === "find") return args.pattern || "";
	if (toolName === "ls") return args.path || ".";
	if (args.query) return `"${args.query}"`;
	if (args.url) return args.url;
	if (args.prompt) return `"${args.prompt.length > 40 ? args.prompt.slice(0, 37) + "..." : args.prompt}"`;
	if (args.message) return `"${args.message.length > 40 ? args.message.slice(0, 37) + "..." : args.message}"`;
	if (args.text) return `"${args.text.length > 40 ? args.text.slice(0, 37) + "..." : args.text}"`;
	if (args.name) return args.name;
	if (args.path) return args.path;
	const keys = Object.keys(args);
	if (keys.length === 1 && typeof args[keys[0]] === "string") {
		const val = args[keys[0]];
		return `"${val.length > 40 ? val.slice(0, 37) + "..." : val}"`;
	}
	return "";
}

/** 格式化视觉辨识度极高的单行 ToolCall 顶行 */
function formatToolHeader(
	theme: Theme,
	badge: string,
	target: string,
	meta: string,
	state: "running" | "success" | "error",
	expanded: boolean,
	width: number,
): string {
	const gutter =
		state === "running"
			? theme.fg("warning", "▎")
			: state === "error"
				? theme.fg("error", "▎")
				: theme.fg("success", "▎");

	const arrow =
		state === "error"
			? theme.fg("error", "✖")
			: state === "running"
				? theme.fg("warning", "⠋")
				: expanded
					? theme.fg("accent", "▼")
					: theme.fg("dim", "▶");

	const toolPill = `${theme.fg("dim", "[")}${theme.bold(theme.fg("accent", badge))}${theme.fg("dim", "]")}`;
	const metaStr = meta ? ` ${theme.fg("dim", `· ${meta}`)}` : "";

	let line = `  ${gutter} ${arrow} ${toolPill} ${target}${metaStr}`;
	if (visibleWidth(line) > width) {
		// 优先裁剪 target，保证前缀与后缀元数据完整
		const fixedLen = visibleWidth(`  ${gutter} ${arrow} ${toolPill} `) + visibleWidth(metaStr);
		const maxTargetWidth = Math.max(10, width - fixedLen - 2);
		const shortTarget = truncateToWidth(target, maxTargetWidth, "…");
		line = `  ${gutter} ${arrow} ${toolPill} ${shortTarget}${metaStr}`;
	}
	return truncateToWidth(line, width);
}

/** 格式化展开后的多行输出，左侧附带连贯细竖线，绝不与聊天正文混淆 */
function formatExpandedBody(theme: Theme, content: string, width: number): string[] {
	const gutter = theme.fg("dim", "│");
	const lines = content.split("\n");
	return lines.map((l) => truncateToWidth(`  ${gutter}   ${l}`, width));
}

/** 为单个 ToolExecutionComponent 挂载单行响应式拦截器 */
function hookToolComponent(comp: any, theme: Theme): void {
	if (comp.__statusbar_hooked) return;
	comp.__statusbar_hooked = true;

	const startMs = Date.now();
	let elapsedMs: number | undefined;

	comp.render = function (width: number): string[] {
		const toolName = comp.toolName || "tool";
		const isRunning = Boolean(comp.isPartial);

		if (!isRunning && elapsedMs === undefined) {
			elapsedMs = Date.now() - startMs;
		}

		const isError = Boolean(comp.result?.isError);
		const state: "running" | "success" | "error" = isRunning ? "running" : isError ? "error" : "success";

		// 提取目标参数
		const target = extractTarget(toolName, comp.args);

		// 提取输出内容与字符统计
		let rawText = "";
		for (const c of comp.result?.content ?? []) {
			if (c?.type === "text" && typeof c.text === "string") {
				rawText += (rawText ? "\n" : "") + c.text;
			}
		}

		// Edit 工具若有 diff 则以 diff 为文本基准
		const diff = comp.result?.details?.diff;
		if (diff && typeof diff === "string") {
			rawText = diff;
		}

		// 元数据构建：纯净的 字符数 + 耗时
		const elapsedStr = elapsedMs !== undefined ? ` · ${(elapsedMs / 1000).toFixed(1)}s` : "";
		const chars = rawText.length;
		const meta = isRunning ? "running..." : `${chars.toLocaleString()} chars${elapsedStr}`;

		const expanded = Boolean(comp.expanded);
		const header = formatToolHeader(theme, toolName, target, meta, state, expanded, width);

		if (expanded && rawText) {
			const bodyLines = formatExpandedBody(theme, rawText, width);
			return [header, ...bodyLines];
		}

		// 默认状态下严格只返回 1 行！
		return [header];
	};
}

/** 拦截并统一全量 ToolExecutionComponent（包括 keenable_search 及所有第三方工具） */
export function installUniversalToolHook(tui: TUI, theme: Theme): void {
	const chatContainer = (tui as any)?.children?.[0]?.children?.[2];
	if (!chatContainer) return;

	// 1. 扫描当前已有子组件
	for (const child of chatContainer.children ?? []) {
		if (child && typeof child.toolName === "string") {
			hookToolComponent(child, theme);
		}
	}

	// 2. 拦截未来 addChild
	if (!chatContainer.__statusbar_hooked) {
		chatContainer.__statusbar_hooked = true;
		const origAddChild = chatContainer.addChild.bind(chatContainer);
		chatContainer.addChild = function (child: any) {
			if (child && typeof child.toolName === "string") {
				hookToolComponent(child, theme);
			}
			return origAddChild(child);
		};

		// 3. 在 render 帧中做二次保障（捕获任何通过 splice 插入的工具）
		const origRender = chatContainer.render.bind(chatContainer);
		chatContainer.render = function (width: number) {
			for (const child of chatContainer.children ?? []) {
				if (child && typeof child.toolName === "string" && !child.__statusbar_hooked) {
					hookToolComponent(child, theme);
				}
			}
			return origRender(width);
		};
	}
}
