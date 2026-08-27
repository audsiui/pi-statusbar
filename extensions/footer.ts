import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, Theme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatCwdForFooter, formatTokens, sanitizeStatusText } from "./utils/format.ts";
import { parseGitStatus, runGit } from "./utils/git.ts";
import { calculateUsageTotals, type UsageTotals } from "./utils/tokens.ts";

/** 进度条格子数（6 格最适合单行布局，精巧直观） */
const BAR_CELLS = 6;

/** 上下文占用行动阈值：≥50% 黄（开始清理/压缩），≥80% 红（准备开新会话） */
const CONTEXT_WARN_PCT = 50;
const CONTEXT_DANGER_PCT = 80;

/** Git 兜底轮询间隔（毫秒） */
const GIT_POLL_INTERVAL_MS = 15_000;

export class SingleLineStatusbar implements Component {
	private disposed = false;
	private gitTimer: ReturnType<typeof setInterval>;
	private gitStatus: { staged: number; modified: number } | undefined;
	private gitInFlight = false;
	private gitPending = false;
	private totalsDirty = true;
	private cachedTotals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	private unsubBranch: () => void;

	constructor(
		private ctx: ExtensionContext,
		public tui: TUI,
		private theme: Theme,
		private footerData: any,
	) {
		this.unsubBranch = this.footerData.onBranchChange(() => {
			this.tui.requestRender();
			void this.refreshGit();
		});

		void this.refreshGit();
		this.gitTimer = setInterval(() => void this.refreshGit(), GIT_POLL_INTERVAL_MS);
	}

	invalidate(): void {
		this.totalsDirty = true;
	}

	dispose(): void {
		this.disposed = true;
		clearInterval(this.gitTimer);
		this.unsubBranch();
	}

	async refreshGit(): Promise<void> {
		if (this.disposed) return;
		if (this.footerData.getGitBranch() === null) {
			this.gitStatus = undefined;
			return;
		}

		if (this.gitInFlight) {
			this.gitPending = true;
			return;
		}

		this.gitInFlight = true;
		try {
			const out = await runGit(this.ctx.sessionManager.getCwd(), ["status", "--porcelain", "-uno"]);
			if (this.disposed) return;
			this.gitStatus = parseGitStatus(out);
			this.tui.requestRender();
		} finally {
			this.gitInFlight = false;
			if (this.gitPending && !this.disposed) {
				this.gitPending = false;
				void this.refreshGit();
			}
		}
	}

	private getTotals(): UsageTotals {
		if (!this.totalsDirty) {
			return this.cachedTotals;
		}
		this.cachedTotals = calculateUsageTotals(this.ctx.sessionManager);
		this.totalsDirty = false;
		return this.cachedTotals;
	}

	render(width: number): string[] {
		const theme = this.theme;
		const ctx = this.ctx;

		// ---------- 左侧环境：CWD + Git 分支 + 变更计数 + 会话名 ----------
		const home = process.env.HOME || process.env.USERPROFILE;
		const cwd = formatCwdForFooter(ctx.sessionManager.getCwd(), home);
		const branch = this.footerData.getGitBranch();
		const sessionName = ctx.sessionManager.getSessionName();
		let left = theme.fg("dim", cwd);
		if (branch) {
			left += ` ${theme.fg("accent", `⎇ ${branch}`)}`;
			if (this.gitStatus && (this.gitStatus.staged > 0 || this.gitStatus.modified > 0)) {
				const bits: string[] = [];
				if (this.gitStatus.staged > 0) bits.push(theme.fg("success", `+${this.gitStatus.staged}`));
				if (this.gitStatus.modified > 0) bits.push(theme.fg("warning", `~${this.gitStatus.modified}`));
				left += ` ${bits.join(" ")}`;
			}
		}
		if (sessionName) {
			left += theme.fg("dim", ` • ${sessionName}`);
		}

		// ---------- 右侧指标：上下文仪表 + 费用 + 缓存 + Token 吞吐 ----------
		const context = ctx.getContextUsage();
		const contextWindow = context?.contextWindow ?? ctx.model?.contextWindow ?? 0;
		let contextPart: string | undefined;
		if (contextWindow > 0) {
			const percent = context?.percent;
			if (percent === null || percent === undefined) {
				contextPart = theme.fg("dim", `?/${formatTokens(contextWindow)}`);
			} else {
				const filled = Math.min(BAR_CELLS, Math.round((percent / 100) * BAR_CELLS));
				const empty = BAR_CELLS - filled;
				const levelColor: "success" | "warning" | "error" =
					percent >= CONTEXT_DANGER_PCT ? "error" : percent >= CONTEXT_WARN_PCT ? "warning" : "success";

				const bar = theme.fg(levelColor, "▰".repeat(filled)) + theme.fg("dim", "▱".repeat(empty));
				const pctStr = theme.fg(levelColor, `${percent.toFixed(1)}%`);
				const totalStr = theme.fg("dim", `/${formatTokens(contextWindow)}`);
				contextPart = `${bar} ${pctStr}${totalStr}`;
			}
		}

		const totals = this.getTotals();
		const rightParts: string[] = [];
		if (contextPart) rightParts.push(contextPart);

		if (totals.cost > 0) {
			rightParts.push(theme.fg("dim", `$${totals.cost.toFixed(3)}`));
		} else if (ctx.model?.provider === "kimi-coding") {
			rightParts.push(theme.fg("dim", "∞"));
		}

		if (totals.cacheRead > 0 || totals.cacheWrite > 0) {
			const cacheBits: string[] = [];
			if (totals.cacheRead > 0) cacheBits.push(`⇣${formatTokens(totals.cacheRead)}`);
			if (totals.cacheWrite > 0) cacheBits.push(`⇡${formatTokens(totals.cacheWrite)}`);
			if (totals.latestCacheHitRate !== undefined) {
				cacheBits.push(`⚡${totals.latestCacheHitRate.toFixed(1)}%`);
			}
			if (cacheBits.length > 0) rightParts.push(theme.fg("dim", cacheBits.join(" ")));
		}

		if (totals.input > 0 || totals.output > 0) {
			rightParts.push(theme.fg("dim", `↑${formatTokens(totals.input)} ↓${formatTokens(totals.output)}`));
		}

		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const statusLine = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text))
				.join(" ");
			rightParts.push(theme.fg("dim", `[${statusLine}]`));
		}

		const separator = theme.fg("dim", " · ");
		let right = rightParts.join(separator);

		// 响应式单行收缩：空间紧张时从右端末尾逐步丢弃辅助指标
		while (rightParts.length > 0 && visibleWidth(left) + visibleWidth(right) + 2 > width) {
			rightParts.pop();
			right = rightParts.join(separator);
		}

		// 如果左侧过长，收缩左侧
		const rightWidth = visibleWidth(right);
		if (visibleWidth(left) + rightWidth + 2 > width) {
			left = truncateToWidth(left, Math.max(0, width - rightWidth - 2), theme.fg("dim", "…"));
		}

		const gap = " ".repeat(Math.max(1, width - visibleWidth(left) - rightWidth));
		const singleLine = right === "" ? left : left + gap + right;

		// 仅返回一行！省出垂直高度！
		return [truncateToWidth(singleLine, width)];
	}
}
