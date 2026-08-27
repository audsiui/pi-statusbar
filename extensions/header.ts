import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, Theme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { cleanPackageName, formatCwdForFooter } from "./utils/format.ts";

export class DashboardHeader implements Component {
	private packages: string[] = [];
	private skills: string[] = [];
	private prompts: string[] = [];

	constructor(
		private ctx: ExtensionContext,
		public tui: TUI,
		private theme: Theme,
	) {
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

			// Clean and deduplicate package names
			const extSet = new Set<string>();
			for (const pkg of rawPackages) {
				const cleaned = cleanPackageName(pkg);
				if (cleaned) extSet.add(cleaned);
			}
			// Always include pi-statusbar
			extSet.add("pi-statusbar");
			this.packages = Array.from(extSet);

			// Common skills & prompts detection from packages
			const skillSet = new Set<string>();
			for (const p of this.packages) {
				if (p.includes("codegraph")) skillSet.add("codegraph");
				if (p.includes("keenable")) skillSet.add("keenable-search");
				if (p.includes("subagent")) skillSet.add("pi-subagents");
				if (p.includes("council")) skillSet.add("council-mode");
			}
			this.skills = Array.from(skillSet);

			const promptSet = new Set<string>([
				"/council",
				"/review-loop",
				"/cleanup",
				"/research",
			]);
			if (this.packages.some((p) => p.includes("todo"))) promptSet.add("/todos");
			if (this.packages.some((p) => p.includes("plan"))) promptSet.add("/plan");
			if (this.packages.some((p) => p.includes("goal"))) promptSet.add("/goal");
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

		// 1. Logo & App Info
		const logoGlyph = theme.fg("accent", "  ┌─┐┬  \n  ├─┘│  \n  ┴  ┴  ");
		const title = `${theme.fg("accent", theme.bold("π coding agent"))} ${theme.fg("dim", "·")} ${theme.fg("dim", cwdStr)}`;
		const subtitle = theme.fg("dim", `就绪: ${this.packages.length} 个扩展 · ${this.skills.length} 个技能 · ${this.prompts.length} 个模版`);

		// Split logoGlyph into lines
		const logoLines = logoGlyph.split("\n");
		lines.push(`${logoLines[0]}`);
		lines.push(`${logoLines[1]}${title}`);
		lines.push(`${logoLines[2]}${subtitle}`);
		lines.push("");

		// 2. Keybinding Pills
		const pill = (key: string, label: string) =>
			`${theme.fg("accent", `[${key}]`)} ${theme.fg("muted", label)}`;
		const pills = [
			pill(" / ", "指令菜单"),
			pill(" ! ", "运行终端"),
			pill("Alt+M", "切换模型"),
			pill("Ctrl+P", "命令面板"),
		].join("    ");

		lines.push(`  ${pills}`);
		lines.push("");

		// 3. Adaptive Cards (If terminal is compact < 26 rows, render slim chips instead)
		if (rows < 26) {
			const compactLine = theme.fg(
				"dim",
				`  🧩 ${this.packages.length} 扩展 · ⚡ ${this.skills.length} 技能 · 💬 ${this.prompts.length} 模版 (按 Ctrl+O 查看详情)`,
			);
			lines.push(compactLine);
			lines.push("");
			return lines.map((l) => truncateToWidth(l, width));
		}

		// Full Card Box with 2-row ceiling & overflow tag
		const cardWidth = Math.min(width - 4, 82);
		if (cardWidth > 40) {
			const topBorder = `  ┌─ ${theme.fg("accent", "🧩 扩展组件")} ${theme.fg("dim", `(${this.packages.length})`)} ${"─".repeat(Math.max(2, cardWidth - 20))}┐`;
			lines.push(topBorder);

			// Render packages (max 6 items = 2 rows of 3-4 items)
			const MAX_PKGS = 6;
			const displayPkgs = this.packages.slice(0, MAX_PKGS);
			const overflow = this.packages.length - MAX_PKGS;

			const pkgItems = displayPkgs.map((p) => theme.fg("dim", `• ${p}`));
			if (overflow > 0) {
				pkgItems.push(theme.fg("accent", `+${overflow} 更多 (Ctrl+O)`));
			}

			// Format into 1-2 rows
			const midIndex = Math.ceil(pkgItems.length / 2);
			const row1 = pkgItems.slice(0, midIndex).join("    ");
			const row2 = pkgItems.slice(midIndex).join("    ");

			const padRow = (content: string) => {
				const innerW = cardWidth - 2;
				const curW = visibleWidth(content);
				const pad = " ".repeat(Math.max(0, innerW - curW));
				return `  │  ${content}${pad}│`;
			};

			lines.push(padRow(row1));
			if (row2) lines.push(padRow(row2));

			// Middle Divider
			const midBorder = `  ├─ ${theme.fg("accent", "⚡ 技能")} ${theme.fg("dim", `(${this.skills.length})`)} ──┬─ ${theme.fg("accent", "💬 快捷模版")} ${theme.fg("dim", `(${this.prompts.length})`)} ${"─".repeat(Math.max(2, cardWidth - 36))}┤`;
			lines.push(midBorder);

			const skillStr = this.skills.map((s) => theme.fg("dim", `• ${s}`)).join("  ") || theme.fg("dim", "无");
			const promptStr = this.prompts.map((p) => theme.fg("dim", `• ${p}`)).join("  ");

			lines.push(padRow(`${skillStr}   │  ${promptStr}`));

			const bottomBorder = `  └${"─".repeat(cardWidth)}┘`;
			lines.push(bottomBorder);
		}

		lines.push("");
		return lines.map((l) => truncateToWidth(l, width));
	}
}
