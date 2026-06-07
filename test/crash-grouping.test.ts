import { describe, it, expect } from "vitest";
import { groupCrashes, groupId } from "../src/verifier/crash-grouping";
import { CrashSignature } from "../src/types";

const sigA: CrashSignature = {
  errorType: "heap-buffer-overflow",
  topFrames: [{ func: "parse_token", file: "/src/parser.c", line: 88 }],
};
const sigAdup: CrashSignature = {
  errorType: "heap-buffer-overflow",
  topFrames: [{ func: "parse_token", file: "/src/parser.c", line: 88 }],
};
const sigB: CrashSignature = {
  errorType: "stack-overflow",
  topFrames: [{ func: "recurse", file: "/src/x.c", line: 5 }],
};

describe("crash grouping", () => {
  it("collapses identical signatures into one group and keeps distinct ones apart", () => {
    const groups = groupCrashes([
      { sig: sigA, artifact: "/c/crash-1", tsMs: 100 },
      { sig: sigAdup, artifact: "/c/crash-2", tsMs: 50 },
      { sig: sigB, artifact: "/c/crash-3", tsMs: 200 },
    ]);
    expect(groups).toHaveLength(2);
    const a = groups.find((g) => g.id === groupId(sigA))!;
    expect(a.artifacts.sort()).toEqual(["/c/crash-1", "/c/crash-2"]);
    expect(a.firstSeenMs).toBe(50); // earliest
    // sorted by firstSeen
    expect(groups[0].id).toBe(groupId(sigA));
  });
});
