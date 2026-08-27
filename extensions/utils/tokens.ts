import type { ReadonlySessionManager } from "@earendil-works/pi-coding-agent";

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	latestCacheHitRate?: number;
}

export function calculateUsageTotals(sessionManager: ReadonlySessionManager): UsageTotals {
	const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	let latestCacheHitRate: number | undefined;

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
				const promptTokens = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
				if (promptTokens > 0) {
					latestCacheHitRate = ((u.cacheRead ?? 0) / promptTokens) * 100;
				}
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

	totals.latestCacheHitRate = latestCacheHitRate;
	return totals;
}
