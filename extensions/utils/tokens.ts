import type { ReadonlySessionManager } from "@earendil-works/pi-coding-agent";

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	/** 整会话缓存命中率：cacheRead / (input + cacheRead + cacheWrite)，无 prompt 流量时为 undefined */
	cacheHitRate?: number;
}

export function calculateUsageTotals(sessionManager: ReadonlySessionManager): UsageTotals {
	const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

	for (const entry of sessionManager.getEntries()) {
		if (entry.type !== "message") {
			if (
				(entry.type === "branch_summary" || entry.type === "compaction") &&
				entry.usage
			) {
				const u = entry.usage;
				totals.input += u.input ?? 0;
				totals.output += u.output ?? 0;
				totals.cacheRead += u.cacheRead ?? 0;
				totals.cacheWrite += u.cacheWrite ?? 0;
				totals.cost += u.cost?.total ?? 0;
			}
			continue;
		}
		if (entry.type === "message" && entry.message.role === "assistant") {
			const u = entry.message.usage;
			if (u) {
				totals.input += u.input ?? 0;
				totals.output += u.output ?? 0;
				totals.cacheRead += u.cacheRead ?? 0;
				totals.cacheWrite += u.cacheWrite ?? 0;
				totals.cost += u.cost?.total ?? 0;
			}
		} else if (
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.usage
		) {
			const u = entry.message.usage;
			totals.input += u.input ?? 0;
			totals.output += u.output ?? 0;
			totals.cacheRead += u.cacheRead ?? 0;
			totals.cacheWrite += u.cacheWrite ?? 0;
			totals.cost += u.cost?.total ?? 0;
		}
	}

	// 会话口径：整个会话的 cacheRead 占总 prompt token（input + cacheRead + cacheWrite）的比例。
	// 天然覆盖 assistant / toolResult / compaction 等全部带 usage 的 entry，与 ⇣/⇡ 总额口径一致。
	const promptTokens = totals.input + totals.cacheRead + totals.cacheWrite;
	if (promptTokens > 0) {
		totals.cacheHitRate = (totals.cacheRead / promptTokens) * 100;
	}
	return totals;
}
