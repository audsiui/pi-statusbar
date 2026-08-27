import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, Theme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { cleanPackageName, formatCwdForFooter } from "./utils/format.ts";

/** 将一组项目根据最大可用宽度自动流式排列，严格保证不超过 maxWidth，超出行数则附加溢出标签 */
function packItems(
	items: string[],
	maxWidth: number,
	maxRows: number,
	theme: Theme,
): string[] {
	if (items.length === 0) return [theme.fg("dim", "无")];

	const rows: string[][] = [];
	let currentRow: string[] = [];
	let currentWidth = 0;
	let itemIdx = 0;

	while (itemIdx < items.length) {
		const item = items[itemIdx];
		const itemW = visibleWidth(item);
		const gap = currentRow.length > 0 ? 3 : 0; // 项目间留 3 个空格

		const isLastRow = rows.length === maxRows - 1;
		const remainingCount = items.length - itemIdx;

		// 如果处于最后一行且还有多个项目，预留溢出标签位置
		if (isLastRow && remainingCount > 1) {
			const tag = `+${remainingCount} 更多`;
			const tagW = visibleWidth(tag);
			if (currentWidth + gap + itemW + 3 + tagW > maxWidth) {
				currentRow.push(theme.fg("accent", tag));
				break;
			}
		}

		if (currentWidth + gap + itemW <= maxWidth) {
			currentRow.push(item);
			currentWidth += gap + itemW;
			itemIdx++;
		} else {
			if (rows.length + 1 >= maxRows) {
				const remaining = items.length - itemIdx;
				if (remaining > 0) {
					const overflowTag = theme.fg("accent", `+${remaining} 更多`);
					while (currentRow.length > 0 && currentWidth + 3 + visibleWidth(overflowTag) > maxWidth) {
						const popped = currentRow.pop();
						if (popped) currentWidth -= visibleWidth(popped) + 3;
					}
					currentRow.push(overflowTag);
				}
				break;
			}
			rows.push(currentRow);
			currentRow = [item];
			currentWidth = itemW;
			itemIdx++;
		}
	}

	if (currentRow.length > 0 && rows.length < maxRows) {
		rows.push(currentRow);
	}

	return rows.map((r) => r.join("   "));
}

export class DashboardHeader implements Component {
	private ctx: ExtensionContext;
	public tui: TUI;
	private theme: Theme;
	private packages: string[] = [];
	private skills: string[] = [];
	private prompts: string[] = [];

	constructor(ctx: ExtensionContext, tui: TUI, theme: Theme) {
		this.ctx = ctx;
		this.tui = tui;
		this.theme = theme;
		this.loadResources();
	}

	invalidate(): void {}

	private loadResources(): void {
		try {
			const home = homedir();
			const globalSettingsPath = join(home, ".pi", "agent", "settings.json");
			const projectSettingsPath = join(this.ctx.cwd, ".pi", "settings.json");

			const rawPackages: string[] = [];

			if (existsSync(globalSettingsPath)) {
				try {
					const data = JSON.parse(readFileSync(globalSettingsPath, "utf8"));
					if (Array.isArray(data.packages)) {
						rawPackages.push(...data.packages);
					}
				} catch {}
			}

			if (existsSync(projectSettingsPath)) {
				try {
					const data = JSON.parse(readFileSync(projectSettingsPath, "utf8"));
					if (Array.isArray(data.packages)) {
						rawPackages.push(...data.packages);
					}
				} catch {}
			}

			// 洗净并去重包名
			const extSet = new Set<string>();
			for (const pkg of rawPackages) {
				const cleaned = cleanPackageName(pkg);
				if (cleaned) extSet.add(cleaned);
			}
			extSet.add("pi-statusbar");
			this.packages = Array.from(extSet);

			// 技能推导与洗净
			const skillSet = new Set<string>();
			for (const p of this.packages) {
				if (p.includes("codegraph")) skillSet.add("codegraph");
				if (p.includes("keenable")) skillSet.add("keenable-search");
				if (p.includes("subagent")) skillSet.add("pi-subagents");
				if (p.includes("council")) skillSet.add("council-mode");
			}
			this.skills = Array.from(skillSet);

			// 常用指令模版
			const promptSet = new Set<string>();
			if (this.packages.some((p) => p.includes("todo"))) promptSet.add("/todos");
			if (this.packages.some((p) => p.includes("plan"))) promptSet.add("/plan");
			if (this.packages.some((p) => p.includes("goal"))) promptSet.add("/goal");
			if (this.skills.includes("council-mode")) promptSet.add("/council");
			promptSet.add("/review-loop");
			promptSet.add("/cleanup");
			this.prompts = Array.from(promptSet);
		} catch {
			this.packages = ["pi-statusbar"];
		}
	}

	render(width: number): string[] {
		const theme = this.theme;
		const home = homedir();
		const cwdStr = formatCwdForFooter(this.ctx.cwd, home);
		const rows = this.tui.terminal.rows || 30;

		const lines: string[] = [];

		// 1. 紧凑型品牌标识与项目信息
		const logoGlyph = theme.fg("accent", "  ┌─┐┬  \n  ├─┘│  \n  ┴  ┴  ");
		const title = `${theme.fg("accent", theme.bold("π coding agent"))} ${theme.fg("dim", "·")} ${theme.fg("dim", cwdStr)}`;
		const subtitle = theme.fg("dim", `就绪: ${this.packages.length} 个扩展 · ${this.skills.length} 个技能 · ${this.prompts.length} 个模版`);

		const logoLines = logoGlyph.split("\n");
		lines.push(`${logoLines[0]}`);
		lines.push(`${logoLines[1]}${title}`);
		lines.push(`${logoLines[2]}${subtitle}`);
		lines.push("");

		// 2. 屏幕高度保护：超矮屏降级为极简单行
		if (rows < 24) {
			const compactLine = theme.fg(
				"dim",
				`  🧩 ${this.packages.length} 扩展 · ⚡ ${this.skills.length} 技能 · 💬 ${this.prompts.length} 模版`,
			);
			lines.push(compactLine);
			lines.push("");
			return lines.map((l) => truncateToWidth(l, width));
		}

		// 3. 严格边界对齐的自适应卡片容器
		// 容器总宽度（含边框）：cardWidth
		// 内部文字宽度：innerWidth = cardWidth - 6 (两边空 2 格 + 边框 2 格)
		const cardWidth = Math.max(40, Math.min(width - 4, 86));
		const innerWidth = cardWidth - 6;

		// 顶边框
		const headerTitle = `🧩 扩展组件 (${this.packages.length})`;
		const headerTitleW = visibleWidth(headerTitle);
		const topFill = "─".repeat(Math.max(2, innerWidth + 1 - headerTitleW));
		lines.push(`  ┌─ ${theme.fg("accent", "🧩 扩展组件")} ${theme.fg("dim", `(${this.packages.length})`)} ${theme.fg("dim", topFill)}┐`);

		// 包装每行文字并确保右侧边框对齐
		const padRow = (content: string) => {
			const cWidth = visibleWidth(content);
			const padding = " ".repeat(Math.max(0, innerWidth - cWidth));
			return `  │  ${content}${padding}  │`;
		};

		// 扩展组件列表（最多 2 行）
		const pkgItems = this.packages.map((p) => theme.fg("dim", `• ${p}`));
		const pkgRows = packItems(pkgItems, innerWidth, 2, theme);
		for (const r of pkgRows) {
			lines.push(padRow(r));
		}

		// 分割线
		lines.push(`  ├${theme.fg("dim", "─".repeat(innerWidth + 4))}┤`);

		// 技能与指令列表（各 1 行）
		const skillItems = this.skills.map((s) => theme.fg("dim", `• ${s}`));
		const skillRow = packItems(skillItems, innerWidth - 4, 1, theme)[0];
		lines.push(padRow(`${theme.fg("accent", "⚡")}  ${skillRow}`));

		const promptItems = this.prompts.map((p) => theme.fg("dim", `• ${p}`));
		const promptRow = packItems(promptItems, innerWidth - 4, 1, theme)[0];
		lines.push(padRow(`${theme.fg("accent", "💬")}  ${promptRow}`));

		// 底边框
		lines.push(`  └${theme.fg("dim", "─".repeat(innerWidth + 4))}┘`);
		lines.push("");

		return lines.map((l) => truncateToWidth(l, width));
	}
}
