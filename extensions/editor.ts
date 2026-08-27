import {
	CustomEditor,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, Theme, TUI } from "@earendil-works/pi-tui";
import { formatBorder } from "./utils/format.ts";

export class ModelBorderEditor extends CustomEditor {
	private ctx: ExtensionContext;
	private appTheme: Theme;
	private getSpinnerFrame: () => string;
	private getCurrentToolName: () => string | undefined;
	private getLatestTps?: () => number | undefined;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		ctx: ExtensionContext,
		appTheme: Theme,
		getSpinnerFrame: () => string,
		getCurrentToolName: () => string | undefined,
		getLatestTps?: () => number | undefined,
	) {
		super(tui, theme, keybindings, { paddingX: 0 });
		this.ctx = ctx;
		this.appTheme = appTheme;
		this.getSpinnerFrame = getSpinnerFrame;
		this.getCurrentToolName = getCurrentToolName;
		this.getLatestTps = getLatestTps;
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

		// 顶边框：内嵌模型徽章（左）与生成速率 tok/s（右）
		const tps = this.getLatestTps?.();
		const rightBadge = tps && tps > 0 ? thm.fg("dim", `[ ${tps.toFixed(1)} tok/s ] `) : "";

		lines[0] = formatBorder(badge, rightBadge, width, borderColor, { left: "╭─", right: "─╮" });

		// 底边框：圆角 ╰─ ... ─╯，未激活补全时附带微提示
		if (!this.isShowingAutocomplete()) {
			const bottomHint = thm.fg("dim", " [ ↵ Send ] ");
			lines[lines.length - 1] = formatBorder("", bottomHint, width, borderColor, { left: "╰─", right: "─╯" });
		}

		return lines;
	}
}
