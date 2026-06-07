import { describe, it, expect } from "vitest";
import { decideVerdict } from "../src/verifier/verdict";
import { AttributionVerdict } from "../src/types";

const av = (attribution: AttributionVerdict["attribution"], fixLocation: AttributionVerdict["fixLocation"]): AttributionVerdict => ({
  groupId: "g1",
  attribution,
  fixLocation,
  explanation: "x",
});

const common = { groupsMeta: [], round: 1, treatUncertainAsDirty: true };

describe("decideVerdict", () => {
  it("build failure ⇒ dirty", () => {
    const v = decideVerdict({ ...common, groups: [], buildFailed: true, hadHarness: true });
    expect(v).toMatchObject({ clean: false, reason: "build_failed" });
  });

  it("no harness ⇒ dirty", () => {
    const v = decideVerdict({ ...common, groups: [], buildFailed: false, hadHarness: false });
    expect(v).toMatchObject({ clean: false, reason: "no_harness" });
  });

  it("any false positive ⇒ dirty", () => {
    const v = decideVerdict({ ...common, groups: [av("real_bug", "target"), av("false_positive", "harness")], buildFailed: false, hadHarness: true });
    expect(v).toMatchObject({ clean: false, reason: "false_positive" });
  });

  it("only real bugs ⇒ clean", () => {
    const v = decideVerdict({ ...common, groups: [av("real_bug", "target")], buildFailed: false, hadHarness: true });
    expect(v).toMatchObject({ clean: true, reason: "ok" });
  });

  it("no crashes ⇒ clean", () => {
    const v = decideVerdict({ ...common, groups: [], buildFailed: false, hadHarness: true });
    expect(v).toMatchObject({ clean: true, reason: "ok" });
  });

  it("uncertain is dirty when treatUncertainAsDirty, clean otherwise", () => {
    const groups = [av("uncertain", "none")];
    expect(decideVerdict({ ...common, groups, buildFailed: false, hadHarness: true }).clean).toBe(false);
    expect(decideVerdict({ ...common, treatUncertainAsDirty: false, groups, buildFailed: false, hadHarness: true }).clean).toBe(true);
  });
});
