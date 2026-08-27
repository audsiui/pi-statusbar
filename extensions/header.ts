import { homedir } from "node:os";
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
	if (items.length === 0) return [theme.fg("dim", "none")];

	const rows: string[][] = [];
	let currentRow: string[] = [];
	let currentWidth = 0;
	let itemIdx = 0;

	while (itemIdx < items.length) {
		const item = items[itemIdx];
		const itemW = visibleWidth(item);
		const gap = currentRow.length > 0 ? 3 : 0;

		const isLastRow = rows.length === maxRows - 1;
		const remainingCount = items.length - itemIdx;

		if (isLastRow && remainingCount > 1) {
			const tag = `+${remainingCount} more`;
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
					const overflowTag = theme.fg("accent", `+${remaining} more`);
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

/** 从官方 loadedResourcesContainer 的原有 children 中解析出真实的技能、模版与扩展列表 */
function parseResourceChildren(children: any[]): {
	skills: string[];
	prompts: string[];
	extensions: string[];
} {
	const skills: string[] = [];
	const prompts: string[] = [];
	const extensions: string[] = [];

	for (const child of children) {
		if (typeof child?.render === "function") {
			try {
				const lines = child.render(200);
				if (lines.length >= 2) {
					const headerLine = lines[0].replace(/\x1b\[[0-9;]*m/g, "").trim();
					const bodyLine = lines.slice(1).join(" ").replace(/\x1b\[[0-9;]*m/g, "").trim();
					if (headerLine.includes("[Skills]")) {
						skills.push(...bodyLine.split(",").map((s: string) => s.trim()).filter(Boolean));
					} else if (headerLine.includes("[Prompts]")) {
						prompts.push(...bodyLine.split(",").map((s: string) => s.trim()).filter(Boolean));
					} else if (headerLine.includes("[Extensions]")) {
						extensions.push(
							...bodyLine
								.split(",")
								.map((s: string) => {
									const cleaned = cleanPackageName(s);
									return cleaned === "extensions" ? "pi-statusbar" : cleaned;
								})
								.filter(Boolean),
						);
					}
				}
			} catch {}
		}
	}
	return { skills, prompts, extensions };
}

/** 渲染美化后的资源卡片（统一线框标题、纯粹排版、与输入框一致的圆角设计） */
function renderResourceCard(
	items: { skills: string[]; prompts: string[]; extensions: string[] },
	width: number,
	theme: Theme,
): string[] {
	const cardWidth = Math.max(40, Math.min(width - 4, 86));
	const innerWidth = cardWidth - 6;
	const lines: string[] = [];

	const formatDivider = (title: string, count: number, left: string, right: string) => {
		const label = `${title} (${count})`;
		const labelW = visibleWidth(label);
		const fillW = Math.max(2, innerWidth + 1 - labelW);
		return `  ${left}─ ${theme.fg("accent", title)} ${theme.fg("dim", `(${count})`)} ${theme.fg("dim", "─".repeat(fillW))}${right}`;
	};

	const padRow = (content: string) => {
		const cWidth = visibleWidth(content);
		const padding = " ".repeat(Math.max(0, innerWidth - cWidth));
		return `  │  ${content}${padding}  │`;
	};

	// 1. Extensions
	if (items.extensions.length > 0) {
		lines.push(formatDivider("Extensions", items.extensions.length, "╭", "╮"));
		const pkgRows = packItems(items.extensions.map((p) => theme.fg("dim", `• ${p}`)), innerWidth, 2, theme);
		for (const r of pkgRows) lines.push(padRow(r));
	}

	// 2. Skills
	if (items.skills.length > 0) {
		const isFirstSection = lines.length === 0;
		const left = isFirstSection ? "╭" : "├";
		const right = isFirstSection ? "╮" : "┤";
		lines.push(formatDivider("Skills", items.skills.length, left, right));
		const skillRows = packItems(items.skills.map((s) => theme.fg("dim", `• ${s}`)), innerWidth, 2, theme);
		for (const r of skillRows) lines.push(padRow(r));
	}

	// 3. Prompts
	if (items.prompts.length > 0) {
		const isFirstSection = lines.length === 0;
		const left = isFirstSection ? "╭" : "├";
		const right = isFirstSection ? "╮" : "┤";
		lines.push(formatDivider("Prompts", items.prompts.length, left, right));
		const promptRows = packItems(items.prompts.map((p) => theme.fg("dim", `• ${p}`)), innerWidth, 2, theme);
		for (const r of promptRows) lines.push(padRow(r));
	}

	// 底边框
	if (lines.length > 0) {
		lines.push(`  ╰${theme.fg("dim", "─".repeat(innerWidth + 4))}╯`);
		lines.push("");
	}

	return lines.map((l) => truncateToWidth(l, width));
}

/** 拦截并重新实现官方 loadedResourcesContainer 的 UI，完成无侵入美化 */
export function beautifyLoadedResources(tui: any, theme: Theme): void {
	try {
		const doc = tui?.children?.[0];
		if (doc && Array.isArray(doc.children) && doc.children.length >= 2) {
			const loadedRes = doc.children[1];
			if (loadedRes && !loadedRes._customBeautified) {
				loadedRes._customBeautified = true;
				// 保留官方原始 children 供数据读取
				loadedRes.render = function (width: number): string[] {
					const items = parseResourceChildren(this.children ?? []);
					if (
						items.extensions.length === 0 &&
						items.skills.length === 0 &&
						items.prompts.length === 0
					) {
						return [];
					}
					return renderResourceCard(items, width, theme);
				};
			}
		}
	} catch {}
}

/** 极简 Header 组件：只负责显示顶部简洁优雅的 π 标识，不再冗余堆叠卡片 */
export class DashboardHeader implements Component {
	private ctx: ExtensionContext;
	public tui: TUI;
	private theme: Theme;

	constructor(ctx: ExtensionContext, tui: TUI, theme: Theme) {
		this.ctx = ctx;
		this.tui = tui;
		this.theme = theme;
		beautifyLoadedResources(tui, theme);
	}

	invalidate(): void {}

	render(width: number): string[] {
		beautifyLoadedResources(this.tui, this.theme);
		const theme = this.theme;
		const home = homedir();
		const cwdStr = formatCwdForFooter(this.ctx.cwd, home);
		const title = `${theme.fg("accent", theme.bold("π"))} ${theme.fg("dim", "·")} ${theme.fg("muted", cwdStr)}`;

		return [
			"",
			`  ${title}`,
			"",
		];
	}
}
