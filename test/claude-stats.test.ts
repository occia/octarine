import { describe, it, expect } from "vitest";
import { statsFromStreamLog } from "../src/agent/claude";

// A generation spans several result events (the Stop hook continues `claude` for build retries).
// total_cost_usd and token usage are reported CUMULATIVELY — each event carries the running total —
// so the real cost is the MAX (last) event, never the sum.
const r = (durationMs: number, inTok: number, outTok: number, cost: number) =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    duration_ms: durationMs,
    total_cost_usd: cost,
    usage: { input_tokens: inTok, cache_read_input_tokens: 0, output_tokens: outTok },
  });

describe("statsFromStreamLog", () => {
  it("takes the max (cumulative) across result events, NOT the sum", () => {
    const log = [
      `{"type":"system","subtype":"init","session_id":"a"}`,
      r(5_000, 100_000, 1_000, 10.0), // cumulative so far
      `{"type":"system","subtype":"init","session_id":"b"}`, // Stop hook continuation
      r(2_971, 130_000, 1_400, 12.5), // higher cumulative total
      r(1_000, 131_000, 1_450, 12.6), // final cumulative total
    ].join("\n");
    const s = statsFromStreamLog(log);
    expect(s.costUsd).toBeCloseTo(12.6, 6); // last cumulative, NOT 10+12.5+12.6
    expect(s.inputTokens).toBe(131_000); // max, NOT 100k+130k+131k
    expect(s.outputTokens).toBe(1_450);
    expect(s.durationMs).toBe(5_000); // max single-turn duration
  });

  it("includes cache token buckets in inputTokens", () => {
    const log = JSON.stringify({
      type: "result",
      duration_ms: 100,
      usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 5 },
    });
    const s = statsFromStreamLog(log);
    expect(s.inputTokens).toBe(60);
    expect(s.outputTokens).toBe(5);
  });

  it("returns zero stats when there is no result event", () => {
    const s = statsFromStreamLog(`{"type":"assistant","message":{}}\nnot json`);
    expect(s).toEqual({ durationMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
  });
});
