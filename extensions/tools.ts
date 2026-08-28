import type { Theme, TUI } from "@earendil-works/pi-tui";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** 剥离工具名或命令行前缀（如 "todo + task" -> "+ task"，"read /path" -> "/path"，"$ cmd" -> "cmd"） */
function stripToolPrefix(text: string, toolName: string): string {
	const trimmed = text.trim();
	const escaped = toolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(`^(?:\\[?${escaped}\\]?|\\$)\\s*[:\\-—]?\\s*`, "i");
	return trimmed.replace(pattern, "").trim();
}

/**
 * 通用参数提取器：不绑定任何具体工具名称，自动根据通用的对象结构与语义字段提取入参摘要
 * 兼容 extractTarget(args) 与 extractTarget(toolName, args) 两种调用形式
 */
export function extractTarget(argsOrToolName: any, maybeArgs?: any): string {
	const args = maybeArgs !== undefined ? maybeArgs : argsOrToolName;
	if (!args || typeof args !== "object") {
		return args !== undefined && args !== null ? String(args) : "";
	}

	// 1. 数组类型
	if (Array.isArray(args)) {
		if (args.length === 0) return "";
		if (args.length === 1) return extractTarget(args[0]);
		return `[${args.length} items]`;
	}

	// 2. 识别常见的“动作/操作”动词字段
	const actionKey = ["action", "op", "operation", "cmd", "command", "type", "method"].find(
		(k) => typeof args[k] === "string" && args[k].length > 0 && args[k].length <= 20,
	);
	const actionVal = actionKey ? String(args[actionKey]) : "";

	// 3. 识别常见的“核心目标/主体载荷”字段
	const targetKey = [
		"command", "cmd", "path", "file_path", "filePath", "file",
		"pattern", "query", "url", "subject", "title",
		"id", "name", "target", "prompt", "message", "text", "summary",
	].find((k) => {
		if (k === actionKey) return false;
		const v = args[k];
		return v !== undefined && v !== null && (typeof v === "string" || typeof v === "number");
	});

	const targetVal = targetKey !== undefined ? String(args[targetKey]) : "";

	// 动作 + 目标组合（如 action="create", subject="xxx" 或 action="update", id=1）
	if (actionVal && targetVal) {
		const formattedTarget = typeof args[targetKey!] === "string"
			? `"${targetVal.length > 40 ? targetVal.slice(0, 37) + "..." : targetVal}"`
			: `#${targetVal}`;
		return `${actionVal} ${formattedTarget}`;
	}

	// 单独目标
	if (targetVal) {
		if (typeof args[targetKey!] === "number") return `#${targetVal}`;
		return targetVal.length > 40 ? `"${targetVal.slice(0, 37)}..."` : targetVal;
	}

	// 单独动作
	if (actionVal) {
		return actionVal;
	}

	// 4. 检查嵌套列表（如 questions: [...]）
	for (const key of Object.keys(args)) {
		const val = args[key];
		if (Array.isArray(val) && val.length > 0 && typeof val[0] === "object") {
			const sub = extractTarget(val[0]);
			if (sub) return sub;
		}
	}

	// 5. 纯单键兜底
	const keys = Object.keys(args);
	if (keys.length === 1) {
		const v = args[keys[0]];
		if (typeof v === "string") return `"${v.length > 40 ? v.slice(0, 37) + "..." : v}"`;
		if (typeof v === "number" || typeof v === "boolean") return String(v);
	}

	// 6. 多键通用键值对压缩展示（例如 { foo: "bar", port: 8080 } -> "foo=\"bar\", port=8080"）
	const entries = keys
		.filter((k) => typeof args[k] === "string" || typeof args[k] === "number" || typeof args[k] === "boolean")
		.slice(0, 2)
		.map((k) => `${k}=${JSON.stringify(args[k])}`);

	if (entries.length > 0) {
		const summary = entries.join(", ");
		return summary.length > 40 ? summary.slice(0, 37) + "..." : summary;
	}

	return "";
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** 格式化视觉辨识度极高的单行 ToolCall 顶行 */
function formatToolHeader(
	theme: Theme,
	badge: string,
	target: string,
	meta: string,
	state: "running" | "success" | "error",
	expanded: boolean,
	width: number,
	getSpinnerFrame?: () => string,
): string {
	const gutter =
		state === "running"
			? theme.fg("warning", "▎")
			: state === "error"
				? theme.fg("error", "▎")
				: theme.fg("success", "▎");

	const spinner = getSpinnerFrame
		? getSpinnerFrame()
		: SPINNER_FRAMES[Math.floor(Date.now() / 80) % SPINNER_FRAMES.length];

	const arrow =
		state === "error"
			? theme.fg("error", "✖")
			: state === "running"
				? theme.fg("warning", spinner)
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
function hookToolComponent(comp: any, theme: Theme, getSpinnerFrame?: () => string): void {
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

		// 1. 优先尝试从组件原生的 callRendererComponent 中提取（自动复用工具自带的 renderCall 格式化）
		let target = "";
		if (comp.callRendererComponent && typeof comp.callRendererComponent.render === "function") {
			try {
				const rendered = comp.callRendererComponent.render(width);
				if (Array.isArray(rendered) && rendered.length > 0) {
					const firstLine = stripTerminalSequences(rendered[0] || "").trim();
					const stripped = stripToolPrefix(firstLine, toolName);
					if (stripped) {
						target = stripped;
					}
				}
			} catch {
				// 忽略异常，降级到通用参数提取
			}
		}

		// 2. 若无原生 callRenderer 或提取为空，使用纯通用参数提取器（无任何工具名硬编码）
		if (!target) {
			target = extractTarget(comp.args);
		}

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
		const header = formatToolHeader(theme, toolName, target, meta, state, expanded, width, getSpinnerFrame);

		if (expanded && rawText) {
			const bodyLines = formatExpandedBody(theme, rawText, width);
			return [header, ...bodyLines];
		}

		// 默认状态下严格只返回 1 行！
		return [header];
	};
}

/** 拦截并统一全量 ToolExecutionComponent（包括 keenable_search 及所有第三方工具） */
export function installUniversalToolHook(tui: TUI, theme: Theme, getSpinnerFrame?: () => string): void {
	const chatContainer = (tui as any)?.children?.[0]?.children?.[2];
	if (!chatContainer) return;

	// 1. 扫描当前已有子组件
	for (const child of chatContainer.children ?? []) {
		if (child && typeof child.toolName === "string") {
			hookToolComponent(child, theme, getSpinnerFrame);
		}
	}

	// 2. 拦截未来 addChild
	if (!chatContainer.__statusbar_hooked) {
		chatContainer.__statusbar_hooked = true;
		const origAddChild = chatContainer.addChild.bind(chatContainer);
		chatContainer.addChild = function (child: any) {
			if (child && typeof child.toolName === "string") {
				hookToolComponent(child, theme, getSpinnerFrame);
			}
			return origAddChild(child);
		};

		// 3. 在 render 帧中做二次保障（捕获任何通过 splice 插入的工具）
		const origRender = chatContainer.render.bind(chatContainer);
		chatContainer.render = function (width: number) {
			for (const child of chatContainer.children ?? []) {
				if (child && typeof child.toolName === "string" && !child.__statusbar_hooked) {
					hookToolComponent(child, theme, getSpinnerFrame);
				}
			}
			return origRender(width);
		};
	}
}
