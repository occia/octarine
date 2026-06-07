import { describe, it, expect } from "vitest";
import { renderEntryHtml } from "../src/entry-html";
import { totals, RunJournal } from "../src/journal";

const journal: RunJournal = {
  target: "demo",
  commit: "abc123",
  language: "c++",
  sanitizer: "address",
  budget: { maxWallTimeSec: 600, perFuzzSec: 60, maxSurfaceAttempts: 3 },
  startedAtMs: 0,
  endedAtMs: 600000,
  survey: { stats: { durationMs: 90000, inputTokens: 1000, outputTokens: 50, costUsd: 0 }, total: 3, covered: 1, pending: 2 },
  surfaces: [
    {
      id: "decoder",
      title: "Streaming decoder",
      apis: ["foo_decode"],
      priority: 9,
      status: "done",
      harnessName: "foo_decode_fuzzer",
      harnessSrcRel: "surface-decoder/submitted",
      attempts: [
        {
          attempt: 1,
          dir: "surface-decoder/attempt-1",
          generation: { durationMs: 120000, inputTokens: 500000, outputTokens: 4000, costUsd: 0 },
          harnessName: "foo_decode_fuzzer",
          verify: { durationMs: 65000, clean: true, reason: "ok", edges: 390, features: 2325, corpus: 1856, crashGroups: 0 },
          assess: { durationMs: 30000, inputTokens: 80000, outputTokens: 200, costUsd: 0, sufficient: true, reasoning: "drives the API well" },
          outcome: "submitted",
        },
      ],
    },
  ],
};

describe("entry-html", () => {
  it("totals sums survey + per-attempt tokens and counts done/submitted", () => {
    const t = totals(journal);
    expect(t.done).toBe(1);
    expect(t.submitted).toBe(1);
    expect(t.inputTokens).toBe(1000 + 500000 + 80000);
    expect(t.outputTokens).toBe(50 + 4000 + 200);
    expect(t.elapsedMin).toBe(10);
  });

  it("renders self-contained html with target, survey, surface, and relative links", () => {
    const html = renderEntryHtml(journal);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("demo");
    expect(html).toContain("Streaming decoder");
    expect(html).toContain("./surface-decoder/attempt-1/generation.log");
    expect(html).toContain("./surface-decoder/attempt-1/harness-foo_decode_fuzzer/fuzz.log");
    expect(html).toContain("./ledger/ledger.md");
    expect(html).toContain("sufficient");
  });
});
