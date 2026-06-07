import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { renderLedger, loadLedger, selectNextPending, projectIdFromRepoUrl, memoryDir, ledgerDir, harnessesDir, resumeEnabled } from "../src/ledger";
import { AttackSurface } from "../src/types";

let dir: string;
beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-"))));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const surface = (over: Partial<AttackSurface>): AttackSurface => ({
  id: "s1",
  title: "decoder",
  apis: ["foo_decode"],
  rationale: "uncovered decoder",
  priority: 5,
  status: "pending",
  attempts: 0,
  ...over,
});

describe("ledger", () => {
  it("renders and reloads surface status from the md index", () => {
    const surfaces = [
      surface({ id: "a", status: "done", harnessName: "a_fuzzer", priority: 3, title: "A api" }),
      surface({ id: "b", status: "pending", priority: 9, title: "B api" }),
      surface({ id: "c", status: "failed", priority: 1, title: "C api" }),
    ];
    renderLedger(dir, "demo", "abc123", surfaces);

    expect(fs.existsSync(path.join(dir, "ledger.md"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "a.md"))).toBe(true);

    const loaded = loadLedger(dir);
    const byId = Object.fromEntries(loaded.map((s) => [s.id, s]));
    expect(byId.a.status).toBe("done");
    expect(byId.a.harnessName).toBe("a_fuzzer");
    expect(byId.b.status).toBe("pending");
    expect(byId.c.status).toBe("failed");
    // APIs are recovered from the per-surface .md (so a resumed run can skip the survey and still
    // know which APIs to drive).
    expect(byId.a.apis).toEqual(["foo_decode"]);
    expect(byId.b.apis).toEqual(["foo_decode"]);
  });

  it("derives a globally-unique project id from main_repo URLs", () => {
    expect(projectIdFromRepoUrl("https://github.com/samtools/htslib.git")).toBe("github.com.samtools.htslib");
    expect(projectIdFromRepoUrl("https://github.com/vstakhov/libucl")).toBe("github.com.vstakhov.libucl");
    expect(projectIdFromRepoUrl("git@github.com:edenhill/librdkafka.git")).toBe("github.com.edenhill.librdkafka");
    expect(projectIdFromRepoUrl("")).toBe("project");
  });

  it("keys cross-run memory dirs by (project, commit) under the fixed root", () => {
    const m = memoryDir("github.com.samtools.htslib", "74589a2018f6");
    expect(m).toBe("/hack-memory/github.com.samtools.htslib-74589a2018f6");
    expect(ledgerDir("github.com.samtools.htslib", "74589a2018f6")).toBe(m + "/ledger");
    expect(harnessesDir("github.com.samtools.htslib", "74589a2018f6")).toBe(m + "/harnesses");
  });

  it("IN_OSS_CRS_ENV disables resume and redirects memory into the work dir", () => {
    const saved = process.env.IN_OSS_CRS_ENV;
    const savedWork = process.env.HARNESS_GEN_WORK_DIR;
    try {
      delete process.env.IN_OSS_CRS_ENV;
      expect(resumeEnabled()).toBe(true);
      expect(memoryDir("p", "c")).toBe("/hack-memory/p-c"); // local hack

      process.env.IN_OSS_CRS_ENV = "1";
      process.env.HARNESS_GEN_WORK_DIR = "/work";
      expect(resumeEnabled()).toBe(false);
      expect(memoryDir("p", "c")).toBe("/work/harness-gen-memory/p-c"); // per-run, no /hack-memory
    } finally {
      if (saved === undefined) delete process.env.IN_OSS_CRS_ENV;
      else process.env.IN_OSS_CRS_ENV = saved;
      if (savedWork === undefined) delete process.env.HARNESS_GEN_WORK_DIR;
      else process.env.HARNESS_GEN_WORK_DIR = savedWork;
    }
  });

  it("selectNextPending returns the highest-priority pending surface", () => {
    const surfaces = [
      surface({ id: "a", status: "pending", priority: 3 }),
      surface({ id: "b", status: "pending", priority: 9 }),
      surface({ id: "c", status: "done", priority: 10 }),
    ];
    expect(selectNextPending(surfaces)?.id).toBe("b");
  });

  it("selectNextPending is undefined when nothing is pending", () => {
    expect(selectNextPending([surface({ status: "done" })])).toBeUndefined();
  });

  it("loadLedger returns [] for a missing ledger", () => {
    expect(loadLedger(path.join(dir, "nope"))).toEqual([]);
  });
});
