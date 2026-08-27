import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { ModelBorderEditor } from "./editor.ts";
import { SingleLineStatusbar } from "./footer.ts";
import { DashboardHeader } from "./header.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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

	// 监听核心生命周期与交互事件
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
		// 1. 关闭内置的多余 working... 行，避免动画冲突并省出空间
		ctx.ui.setWorkingVisible(false);

		// 2. 迎宾台：极客仪表盘 Header (带 2 行阈值保护与溢出折叠)
		ctx.ui.setHeader((tui, theme) => {
			activeTui = tui;
			return new DashboardHeader(ctx, tui, theme);
		});

		// 3. 遥测栏：极致单行状态栏
		ctx.ui.setFooter((tui, theme, footerData) => {
			activeTui = tui;
			statusbar = new SingleLineStatusbar(ctx, tui, theme, footerData);
			return statusbar;
		});

		// 4. 输入框：圆角边框 + 模型身份与工具执行动态反馈
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
