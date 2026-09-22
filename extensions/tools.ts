import { keyText, type Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type ToolState = "running" | "success" | "error";
type ToolBandBg = "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";

/**
 * 与 Pi 原生 ToolExecutionComponent 完全一致的语义底色：
 * 运行中 / 成功 / 失败 各自一块通栏色带，折叠态因此不再是“裸奔的一行文字”。
 */
const STATE_BAND_BG: Record<ToolState, ToolBandBg> = {
	running: "toolPendingBg",
	success: "toolSuccessBg",
	error: "toolErrorBg",
};

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** 工具名之前可能出现的装饰性符号（● ▸ ▶ • ┃ 等），先剥掉再匹配工具名 */
const LEADING_DECOR = /^[\s•●○◉◎◆◇▸▹►▶➤›»·—–:|]*/;

/** 展开快捷键提示，跟随用户自定义 keybindings */
function expandKeyHint(): string {
	try {
		return keyText("app.tools.expand");
	} catch {
		return "ctrl+o";
	}
}

/** 剥离工具名或命令行前缀（如 "todo + task" -> "+ task"，"read /path" -> "/path"，"$ cmd" -> "cmd"） */
function stripToolPrefix(text: string, toolName: string): string {
	const trimmed = text.trim().replace(LEADING_DECOR, "");
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

/** 取工具输出里的全部文本（edit 类工具在调用方切换为 diff 基准） */
function collectTextOutput(comp: any): string {
	let rawText = "";
	for (const c of comp.result?.content ?? []) {
		if (c?.type === "text" && typeof c.text === "string") {
			rawText += (rawText ? "\n" : "") + c.text;
		}
	}
	return rawText;
}

/** diff 统计：edit/write 显示 "+12 -3" 远比 "1,024 chars" 有信息量 */
function formatDiffStat(diff: string): string {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	if (added === 0 && removed === 0) return "";
	return `+${added} -${removed}`;
}

/** 从错误输出里挑一行最有信息量的摘要（优先末尾的 status 行，如 "Command exited with code 1"） */
function extractErrorReason(text: string): string {
	const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
	if (lines.length === 0) return "";
	const isStatusLine = (l: string) =>
		l.length <= 80 &&
		/(exit(ed)? with code|exited with|error|failed|failure|aborted|timed? out|denied|not found|no such file|cannot|unable|refused|✖|⚠)/i.test(l);
	for (let i = lines.length - 1; i >= 0 && i >= lines.length - 5; i--) {
		if (isStatusLine(lines[i])) return lines[i];
	}
	return lines[0];
}

/**
 * 把一行补齐到整行宽度并染上语义底色（复刻原生 Box 的 toolPendingBg/Success/Error 观感）。
 * 注意：truncateToWidth 截断时会在末尾补一个 \x1b[0m 全重置，会把后面的内容连底色一起清掉，
 * 因此这里在每个全重置之后把底色补回去，保证色带连续不断裂。
 */
function bandLine(theme: Theme, line: string, width: number, state: ToolState): string {
	const bg = STATE_BAND_BG[state];
	if (width < 4) return truncateToWidth(line, Math.max(0, width), "…");

	const fitted = truncateToWidth(line, width, "", true);
	const bgAnsi = (theme as any).getBgAnsi?.(bg) as string | undefined;
	const patched = bgAnsi ? fitted.replace(/\x1b\[0m/g, `\x1b[0m${bgAnsi}`) : fitted;
	return theme.bg(bg, patched);
}

/**
 * 组装右侧元信息，空间不足时按“展开提示 → 耗时 → 主体”的顺序优雅降级，
 * 避免出现 "53 …" 这种被硬切碎的残句。
 */
function buildRightSide(theme: Theme, parts: string[], hint: string, budget: number): string {
	// 连一段有意义的信息都放不下时，整个右侧让位给目标参数
	if (budget < 6) return "";
	if (parts.length === 0 && hint.trim() === "") return "";
	const styled = (text: string) => theme.fg("dim", text);

	const full = parts.length > 0 ? `${parts.join(" · ")}${hint}` : hint.trim();
	if (visibleWidth(full) <= budget) return styled(full);

	const withoutHint = parts.join(" · ");
	if (visibleWidth(withoutHint) <= budget) return styled(withoutHint);

	// 先丢掉末尾的耗时，再丢更次要的段
	if (parts.length > 1) {
		const shorter = parts.slice(0, -1).join(" · ");
		if (visibleWidth(shorter) <= budget) return styled(shorter);
	}

	const primary = parts[0] ?? "";
	return primary ? styled(truncateToWidth(primary, budget, "…")) : "";
}

/** 格式化单行 ToolCall 顶行：状态 gutter + 状态符号 + 工具名 + 目标（左），元信息右对齐锚定 */
function formatToolHeader(
	theme: Theme,
	toolName: string,
	target: string,
	metaParts: string[],
	state: ToolState,
	expanded: boolean,
	width: number,
	hasHiddenContent: boolean,
	getSpinnerFrame?: () => string,
): string {
	const gutterColor = state === "running" ? "warning" : state === "error" ? "error" : "success";
	const gutter = theme.fg(gutterColor, "▎");

	const spinner = getSpinnerFrame
		? getSpinnerFrame()
		: SPINNER_FRAMES[Math.floor(Date.now() / 80) % SPINNER_FRAMES.length];

	const glyph =
		state === "error"
			? theme.fg("error", "✖")
			: state === "running"
				? theme.fg("warning", spinner)
				: theme.fg("success", "✓");

	const toolLabel = theme.bold(theme.fg("accent", toolName));
	const prefix = ` ${gutter} ${glyph} ${toolLabel} `;
	const prefixWidth = visibleWidth(prefix);

	// 折叠且仍有隐藏内容时，附上展开键提示
	const hint = !expanded && hasHiddenContent ? `  ${expandKeyHint()}` : "";

	const minTarget = 8;
	const gap = 2;
	const available = width - prefixWidth - gap;

	// 终端极窄：保留工具名与目标，丢弃元信息
	if (available < minTarget) {
		return bandLine(theme, `${prefix}${target}`, width, state);
	}

	const right = buildRightSide(theme, metaParts, hint, available - minTarget);
	const targetText = truncateToWidth(target, Math.max(minTarget, available - visibleWidth(right)), "…");

	const left = `${prefix}${targetText}`;
	const padding = Math.max(gap, width - visibleWidth(left) - visibleWidth(right));
	return bandLine(theme, `${left}${" ".repeat(padding)}${right}`, width, state);
}

/** 格式化展开后的多行输出，左侧附带连贯细竖线，整体沿用同一条语义色带 */
function formatExpandedBody(theme: Theme, content: string, width: number, state: ToolState): string[] {
	const rail = theme.fg("dim", "│");
	return content.split("\n").map((line) => bandLine(theme, `  ${rail}   ${line}`, width, state));
}

/** 优先复用工具原生 callRendererComponent 的首行（自动兼容各工具的格式化），否则走通用参数提取 */
function extractCallTarget(comp: any, toolName: string, width: number): string {
	if (comp.callRendererComponent && typeof comp.callRendererComponent.render === "function") {
		try {
			const rendered = comp.callRendererComponent.render(width);
			if (Array.isArray(rendered) && rendered.length > 0) {
				const firstLine = stripTerminalSequences(rendered[0] || "").trim();
				const stripped = stripToolPrefix(firstLine, toolName);
				if (stripped) {
					return stripped;
				}
			}
		} catch {
			// 忽略异常，降级到通用参数提取
		}
	}
	return extractTarget(comp.args);
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
		const state: ToolState = isRunning ? "running" : isError ? "error" : "success";

		// 1. 目标参数（工具名 + 核心入参）
		let target = extractCallTarget(comp, toolName, width);

		// 2. 输出内容与字符统计；edit 类工具若有 diff 则以 diff 为文本基准
		let rawText = collectTextOutput(comp);
		const diff = typeof comp.result?.details?.diff === "string" ? comp.result.details.diff : "";
		if (diff) {
			rawText = diff;
		}

		// 3. 错误态在左侧补一条原因摘要，避免折叠时只剩一个红色的 ✖
		if (state === "error") {
			const reason = extractErrorReason(rawText);
			if (reason) {
				const shortReason = truncateToWidth(reason, 48, "…");
				target = target ? `${target} · ${shortReason}` : shortReason;
			}
		}

		// 4. 元数据：diff 统计 / 字符数 + 耗时，右对齐
		const metaParts: string[] = [];
		if (isRunning) {
			metaParts.push("running…");
		} else {
			const diffStat = diff ? formatDiffStat(diff) : "";
			if (diffStat) {
				// diff 统计比字符数有信息量，二者不重复展示
				metaParts.push(diffStat);
			} else if (rawText.length > 0) {
				metaParts.push(`${rawText.length.toLocaleString("en-US")} chars`);
			} else if ((comp.imageComponents?.length ?? 0) > 0) {
				metaParts.push("image");
			}
			if (elapsedMs !== undefined) {
				metaParts.push(`${(elapsedMs / 1000).toFixed(1)}s`);
			}
		}

		const expanded = Boolean(comp.expanded);
		const header = formatToolHeader(
			theme,
			toolName,
			target,
			metaParts,
			state,
			expanded,
			width,
			rawText.length > 0 || (comp.imageComponents?.length ?? 0) > 0,
			getSpinnerFrame,
		);

		// 顶部补一个空行，复刻原生组件的 Spacer(1)，让色带不与上文糊在一起
		const lines: string[] = ["", header];

		if (expanded && rawText) {
			lines.push(...formatExpandedBody(theme, rawText, width, state));
		}

		// 图片类结果不能丢：原样透传原生 Image 组件
		try {
			for (const img of comp.imageComponents ?? []) {
				lines.push(...img.render(width));
			}
		} catch {
			// 忽略图片渲染异常，保证至少有一行摘要
		}

		return lines;
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
