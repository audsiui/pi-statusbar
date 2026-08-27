import { isAbsolute, relative, resolve, sep } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const rel = relative(resolvedHome, resolvedCwd);
	const insideHome =
		rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	if (!insideHome) return cwd;
	return rel === "" ? "~" : `~${sep}${rel}`;
}

export function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

/** 格式化自适应边框行，支持圆角字符 */
export function formatBorder(
	left: string,
	right: string,
	width: number,
	borderColor: (text: string) => string,
	corners: { left: string; right: string },
): string {
	const cLeft = borderColor(corners.left);
	const cRight = borderColor(corners.right);
	const fixedWidth = visibleWidth(cLeft) + visibleWidth(cRight);
	const minGap = 2;

	let leftText = left;
	let rightText = right;

	while (
		fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minGap > width &&
		visibleWidth(rightText) > 0
	) {
		rightText = truncateToWidth(rightText, Math.max(0, visibleWidth(rightText) - 1), "");
	}
	while (
		fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minGap > width &&
		visibleWidth(leftText) > 0
	) {
		leftText = truncateToWidth(leftText, Math.max(0, visibleWidth(leftText) - 1), "");
	}

	const gapWidth = Math.max(0, width - fixedWidth - visibleWidth(leftText) - visibleWidth(rightText));
	return `${cLeft}${leftText}${borderColor("─".repeat(gapWidth))}${rightText}${cRight}`;
}

/** 洗净包名，去除 npm:/git: 前缀、作用域、版本号与 :dist/:file.ts 尾巴 */
export function cleanPackageName(raw: string): string {
	let name = raw.trim();
	// 去除协议前缀
	if (name.startsWith("npm:")) name = name.slice(4);
	if (name.startsWith("git:")) name = name.slice(4);

	// 去除 url 协议
	name = name.replace(/^https?:\/\//, "");

	// 去除 github.com/ 域名前缀
	name = name.replace(/^github\.com\//, "");

	// 去除 :dist 或 :xxx.ts 等入口文件后缀
	name = name.replace(/:.*$/, "");

	// 去除 @version 或 @ref 后缀
	const atIdx = name.lastIndexOf("@");
	if (atIdx > 0) {
		name = name.slice(0, atIdx);
	}

	// 如果包含 scope (@user/pkg)，提取核心包名
	if (name.startsWith("@") && name.includes("/")) {
		name = name.split("/")[1];
	} else if (name.includes("/")) {
		// user/repo
		name = name.split("/").pop() || name;
	}

	// 去除末尾 .ts 或 .js
	name = name.replace(/\.(ts|js)$/, "");

	return name;
}
