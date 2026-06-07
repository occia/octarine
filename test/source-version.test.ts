import { describe, it, expect } from "vitest";
import { pickSourceVersion } from "../src/orchestrator/source";
import { renderEntryHtml } from "../src/entry-html";
import { sourceIdentityMd, commitWebUrl, repoWebUrl } from "../src/util/version";
import { RunJournal } from "../src/journal";

const libplistRepos = [
  { dir: "aflplusplus", commit: "a".repeat(40), branch: "stable", remote: "https://github.com/AFLplusplus/AFLplusplus" },
  { dir: "libplist", commit: "32428abacb909988e8e960a8845a6430b17b6a60", branch: "master", remote: "https://github.com/libimobiledevice/libplist", describe: "32428ab" },
  { dir: "honggfuzz", commit: "c".repeat(40), branch: "master", remote: "https://github.com/google/honggfuzz" },
];

describe("pickSourceVersion", () => {
  it("picks the repo whose remote matches main_repo (ignoring engines)", () => {
    const v = pickSourceVersion(libplistRepos, "https://github.com/libimobiledevice/libplist.git");
    expect(v?.commit).toBe("32428abacb909988e8e960a8845a6430b17b6a60");
    expect(v?.branch).toBe("master");
    expect(v?.shortCommit).toBe("32428abacb90");
    expect(v?.repoUrl).toBe("https://github.com/libimobiledevice/libplist");
  });

  it("matches across ssh/.git/scheme/case differences in main_repo", () => {
    const v = pickSourceVersion(libplistRepos, "git@github.com:libimobiledevice/libplist");
    expect(v?.commit).toBe("32428abacb909988e8e960a8845a6430b17b6a60");
  });

  it("falls back to the sole non-engine repo when main_repo is unknown", () => {
    const v = pickSourceVersion(libplistRepos, "");
    expect(v?.branch).toBe("master");
    expect(v?.repoUrl).toContain("libplist");
  });

  it("returns undefined for empty input or a commitless pick", () => {
    expect(pickSourceVersion([], "x")).toBeUndefined();
    expect(pickSourceVersion([{ dir: "p", remote: "r" }], "")).toBeUndefined();
  });
});

describe("sourceIdentityMd (shared across ledger heading + summary)", () => {
  const sv = { repoUrl: "https://github.com/libimobiledevice/libplist", branch: "master", commit: "32428abacb909988", shortCommit: "32428abacb90", note: "re-derived xyz" };
  it("formats target · branch @ linked-commit + content-id", () => {
    const md = sourceIdentityMd("libplist", "878392ac3cfb", sv);
    expect(md).toBe("libplist · master @ [`32428abacb90`](https://github.com/libimobiledevice/libplist/commit/32428abacb909988)  (content-id `878392ac3cfb`)");
  });
  it("includes the note only when asked", () => {
    expect(sourceIdentityMd("libplist", "x", sv)).not.toContain("re-derived");
    expect(sourceIdentityMd("libplist", "x", sv, true)).toContain("— re-derived xyz");
  });
  it("falls back to target @ content-id without a SourceVersion", () => {
    expect(sourceIdentityMd("libplist", "878392ac3cfb")).toBe("libplist @ 878392ac3cfb");
  });
  it("omits the commit link for non-github/gitlab hosts", () => {
    expect(commitWebUrl("https://git.ghostscript.com/mupdf", "abc")).toBe("");
    expect(repoWebUrl("git@github.com:o/p.git")).toBe("https://github.com/o/p");
  });
});

function journal(sv?: RunJournal["sourceVersion"]): RunJournal {
  return {
    target: "libplist",
    commit: "878392ac3cfb",
    sourceVersion: sv,
    language: "c",
    sanitizer: "address",
    budget: { maxWallTimeSec: 0, perFuzzSec: 300, maxSurfaceAttempts: 3 },
    startedAtMs: 0,
    endedAtMs: 0,
    survey: { stats: { durationMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }, total: 0, covered: 0, pending: 0 },
    surfaces: [],
  };
}

describe("entry.html header source identity", () => {
  it("renders real branch @ commit with a commit link + keeps content-id", () => {
    const html = renderEntryHtml(journal(pickSourceVersion(libplistRepos, "https://github.com/libimobiledevice/libplist")));
    expect(html).toContain("· master @ ");
    expect(html).toContain("https://github.com/libimobiledevice/libplist/commit/32428abacb909988e8e960a8845a6430b17b6a60");
    expect(html).toContain("32428abacb90"); // short commit shown
    expect(html).toContain("content-id <code>878392ac3cfb</code>");
  });

  it("falls back to the synthetic content-hash when no sourceVersion (pre-capture journals)", () => {
    const html = renderEntryHtml(journal(undefined));
    expect(html).toContain("@ 878392ac3cfb");
    expect(html).not.toContain("content-id");
  });
});
