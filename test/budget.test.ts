import { describe, it, expect } from "vitest";
import { withinBudget, elapsedSec } from "../src/verifier/budget";
import { Budget } from "../src/types";

const B = (over: Partial<Budget> = {}): Budget => ({ maxWallTimeSec: 0, perFuzzSec: 1, maxSurfaceAttempts: 5, maxCostUsd: 0, genTimeoutSec: 0, ...over });

describe("withinBudget", () => {
  it("is unbounded when maxWallTimeSec and maxCostUsd are 0", () => {
    expect(withinBudget(B(), 0, 10_000_000, 9999)).toBe(true);
  });

  it("respects the wall-time cap", () => {
    const b = B({ maxWallTimeSec: 1 });
    expect(withinBudget(b, 0, 500)).toBe(true); // 0.5s elapsed
    expect(withinBudget(b, 0, 1000)).toBe(false); // 1.0s elapsed >= cap
    expect(withinBudget(b, 0, 2000)).toBe(false);
  });

  it("respects the cumulative cost cap", () => {
    const b = B({ maxCostUsd: 2 });
    expect(withinBudget(b, 0, 0, 0)).toBe(true);
    expect(withinBudget(b, 0, 0, 1.99)).toBe(true);
    expect(withinBudget(b, 0, 0, 2)).toBe(false); // spend >= cap
    expect(withinBudget(b, 0, 0, 3.5)).toBe(false);
  });

  it("stops on whichever cap is hit first (time or cost)", () => {
    const b = B({ maxWallTimeSec: 100, maxCostUsd: 5 });
    expect(withinBudget(b, 0, 1000, 1)).toBe(true); // under both
    expect(withinBudget(b, 0, 1000, 5)).toBe(false); // cost hit, time fine
    expect(withinBudget(b, 0, 200_000, 1)).toBe(false); // time hit, cost fine
  });

  it("computes elapsed seconds from start", () => {
    expect(elapsedSec(1000, 4000)).toBe(3);
  });
});
