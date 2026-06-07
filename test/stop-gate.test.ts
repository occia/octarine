import { describe, it, expect } from "vitest";
import { decideStopGate } from "../src/hooks/stop-gate";

describe("decideStopGate", () => {
  it("blocks when the build is not green", () => {
    expect(decideStopGate({ stopHookActive: false, buildRetcode: 1 }).block).toBe(true);
    expect(decideStopGate({ stopHookActive: false, buildRetcode: null }).block).toBe(true);
  });

  it("allows when the build is green", () => {
    expect(decideStopGate({ stopHookActive: false, buildRetcode: 0 }).block).toBe(false);
  });

  it("never blocks twice in a row (re-entrancy guard)", () => {
    expect(decideStopGate({ stopHookActive: true, buildRetcode: 1 }).block).toBe(false);
  });
});
