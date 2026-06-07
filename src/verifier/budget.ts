/**
 * The single global budget gate for the exploration loop: a run may keep exploring while it is
 * under BOTH the wall-time cap and the cumulative-LLM-cost cap. `spentUsd` is the run's cumulative
 * cost so far (summed from the claude CLI's `total_cost_usd` across survey/generation/assessment).
 */

import { Budget } from "../types";

export function elapsedSec(startedAtMs: number, nowMs: number): number {
  return (nowMs - startedAtMs) / 1000;
}

/** True while the run may keep exploring (start a surface / make another attempt). */
export function withinBudget(budget: Budget, startedAtMs: number, nowMs: number, spentUsd = 0): boolean {
  if (budget.maxWallTimeSec > 0 && elapsedSec(startedAtMs, nowMs) >= budget.maxWallTimeSec) return false;
  if (budget.maxCostUsd > 0 && spentUsd >= budget.maxCostUsd) return false;
  return true;
}
