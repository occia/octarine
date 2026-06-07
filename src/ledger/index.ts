/**
 * The attack-surface ledger: a per-(target, commit) markdown set that is the
 * CRS's persistent "memory" of which attack surfaces have been tested and which
 * remain. The orchestrator holds the in-memory AttackSurface[] (the source of
 * truth for control flow) and renders it to the md set; the agents drive the
 * *content* (Surveyor proposes surfaces, Assessor closes them).
 *
 *   <ledger>/ledger.md      index table of all surfaces (parsed on resume)
 *   <ledger>/<id>.md        per-surface notes (APIs, rationale, last feedback)
 */

import * as path from "path";
import * as crypto from "crypto";
import { AttackSurface, Config, SurfaceStatus, SourceVersion } from "../types";
import { LibCrs } from "../libcrs/client";
import { runCapture } from "../util/proc";
import { mkdirp, writeFileAtomic, readFileOr } from "../util/fs";
import { sourceIdentityMd } from "../util/version";

const STATUSES: SurfaceStatus[] = ["covered", "pending", "in_progress", "done", "failed"];

// HACK(temporary): cross-run memory lives at a fixed local absolute path (a /hack-memory bind-mount)
// so a later run always knows where to look and can resume. This is a stopgap for LOCAL TESTING —
// OSS-CRS will later add a first-class persist/download artifact for this.
const HACK_MEMORY_ROOT = "/hack-memory";

/**
 * Cross-run resume is supported ONLY in our local-testing setup (the /hack-memory bind-mount). In the
 * real OSS-CRS environment that mount does not exist and OSS-CRS's first-class cross-run persistence is
 * not ready yet, so callers set `IN_OSS_CRS_ENV` (to any non-empty value) to opt OUT: we then skip the
 * memory scan and always start fresh. Default (var unset/empty) = local hack enabled.
 */
export function resumeEnabled(): boolean {
  return !process.env.IN_OSS_CRS_ENV;
}

// Where the per-(project, commit) memory store lives. Local-testing: the shared /hack-memory mount
// (persists across runs → resume). In the OSS-CRS env: a per-run work-dir location instead — it is
// empty at start (→ no resume, start fresh) and never persists, so we never touch the missing mount.
function memoryRoot(): string {
  if (resumeEnabled()) return HACK_MEMORY_ROOT;
  return path.join(process.env.HARNESS_GEN_WORK_DIR ?? "/work", "harness-gen-memory");
}

const sha = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");
const slug = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-").slice(0, 80) || "x";

/** Short, stable id for the target source version: git HEAD, else a tree hash. Used to KEY cross-run
 *  memory, so it must depend only on source CONTENT. (The real upstream branch+commit is a separate,
 *  display-only signal — see SourceVersion / readSourceVersion — captured at build time.) The provenance
 *  file is excluded so its presence/format never shifts the key. */
export async function deriveCommit(srcDir: string): Promise<string> {
  const r = await runCapture("git", ["-C", srcDir, "rev-parse", "HEAD"]);
  const out = r.stdout.trim();
  if (r.code === 0 && /^[0-9a-f]{7,40}$/.test(out)) return out.slice(0, 12);
  const ls = await runCapture("bash", [
    "-lc",
    `cd ${JSON.stringify(srcDir)} && find . -type f -not -name .crs-source-version.json 2>/dev/null | sort | head -n 5000`,
  ]);
  return "t" + sha(ls.stdout).slice(0, 11);
}

/** Globally-unique project id from a repo URL: `github.com/org/proj(.git)` → `github.com.org.proj`. */
export function projectIdFromRepoUrl(url: string): string {
  let u = (url || "").trim();
  u = u.replace(/^https?:\/\//i, "").replace(/^git@/i, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  u = u.replace(/:/g, "/"); // ssh form host:org/proj → host/org/proj
  const joined = u.split("/").filter(Boolean).join(".");
  return joined ? slug(joined) : "project";
}

/** Read the OSS-Fuzz project's metadata (downloads fuzz-proj to read project.yaml): the `main_repo`
 *  and the globally-unique project id derived from it (so memory dirs never collide). `mainRepo` is
 *  also used to pick the project's own repo out of the build-time provenance file. */
export async function readProjectMeta(libcrs: LibCrs, c: Config): Promise<{ projectId: string; mainRepo: string }> {
  const tmp = path.join(c.paths.work, "projmeta");
  let mainRepo = "";
  try {
    mkdirp(tmp);
    await libcrs.downloadSource("fuzz-proj", tmp);
    const y = readFileOr(path.join(tmp, "project.yaml"), "");
    const m = y.match(/^\s*main_repo\s*:\s*['"]?([^'"\n]+)['"]?\s*$/m);
    if (m && m[1]) mainRepo = m[1].trim();
  } catch {
    /* fall through to target name */
  }
  const projectId = mainRepo ? projectIdFromRepoUrl(mainRepo) : slug(c.target || "project");
  return { projectId, mainRepo };
}

/** Derive just the project id (back-compat wrapper around readProjectMeta). */
export async function deriveProjectId(libcrs: LibCrs, c: Config): Promise<string> {
  return (await readProjectMeta(libcrs, c)).projectId;
}

/** Per-(project, commit) memory dir. Location depends on resumeEnabled() — see memoryRoot(). */
export function memoryDir(projectId: string, commit: string): string {
  return path.join(memoryRoot(), `${slug(projectId)}-${commit}`);
}

/** Persistent ledger dir (the surface md set), keyed by (project, commit). */
export function ledgerDir(projectId: string, commit: string): string {
  return path.join(memoryDir(projectId, commit), "ledger");
}

/** Persistent store for confirmed (done) harness sources, keyed by (project, commit). */
export function harnessesDir(projectId: string, commit: string): string {
  return path.join(memoryDir(projectId, commit), "harnesses");
}

export function ledgerIndexPath(dir: string): string {
  return path.join(dir, "ledger.md");
}

/** Parse the existing ledger into surfaces (for cross-run resume); [] if none. The index table gives
 *  id/status/priority/harness/title; the per-surface `<id>.md` is read to recover APIs/rationale/last
 *  feedback so a resumed run has the full surface (the generator needs the APIs) WITHOUT re-surveying. */
export function loadLedger(dir: string): AttackSurface[] {
  const md = readFileOr(ledgerIndexPath(dir), "");
  const out: AttackSurface[] = [];
  for (const line of md.split("\n")) {
    const m = line.match(/^\s*\|(.+)\|\s*$/);
    if (!m) continue;
    const cells = m[1].split("|").map((x) => x.trim());
    if (cells.length < 5) continue;
    const [id, status, prio, harness, ...rest] = cells;
    if (id === "id" || /^-+$/.test(id)) continue; // header / separator row
    if (!STATUSES.includes(status as SurfaceStatus)) continue;
    const detail = parseSurfaceMd(readFileOr(path.join(dir, `${slug(id)}.md`), ""));
    out.push({
      id,
      title: rest.join(" ").trim() || id,
      apis: detail.apis,
      rationale: detail.rationale,
      priority: Number(prio) || 0,
      status: status as SurfaceStatus,
      harnessName: harness && harness !== "-" ? harness : undefined,
      attempts: 0,
      lastFeedback: detail.lastFeedback,
    });
  }
  return out;
}

/** Pull APIs / rationale / last-feedback out of a per-surface `<id>.md` (line-based: a `## X`
 *  section runs until the next `## ` heading). */
function parseSurfaceMd(md: string): { apis: string[]; rationale: string; lastFeedback?: string } {
  const lines = md.split("\n");
  const section = (name: string): string => {
    const start = lines.findIndex((l) => l.trim() === `## ${name}`);
    if (start < 0) return "";
    const body: string[] = [];
    for (let i = start + 1; i < lines.length; i++) {
      if (lines[i].startsWith("## ")) break;
      body.push(lines[i]);
    }
    return body.join("\n").trim();
  };
  const apis = [...section("APIs").matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((a) => a && a !== "(unspecified)");
  const rationaleRaw = section("Rationale");
  const fbRaw = section("Last feedback");
  return {
    apis,
    rationale: rationaleRaw === "(none)" ? "" : rationaleRaw,
    lastFeedback: fbRaw && fbRaw !== "(none)" ? fbRaw : undefined,
  };
}

/** Write the index table + a per-surface md note for each surface. The heading shows the real source
 *  identity (branch @ commit) when known, with the synthetic `commit` kept as the content-id; the
 *  parser (loadLedger) only reads table rows, so heading text never affects resume. */
export function renderLedger(
  dir: string,
  target: string,
  commit: string,
  surfaces: AttackSurface[],
  sourceVersion?: SourceVersion,
): void {
  mkdirp(dir);
  const counts = STATUSES.map((s) => `${s}=${surfaces.filter((x) => x.status === s).length}`).join("  ");
  const rows = surfaces
    .slice()
    .sort((a, b) => b.priority - a.priority)
    .map((s) => `| ${s.id} | ${s.status} | ${s.priority} | ${s.harnessName ?? "-"} | ${s.title.replace(/\|/g, "/")} |`);
  const index = [
    `# Attack-surface ledger — ${sourceIdentityMd(target, commit, sourceVersion)}`,
    ``,
    counts,
    ``,
    `| id | status | prio | harness | title |`,
    `|---|---|---|---|---|`,
    ...rows,
    ``,
  ].join("\n");
  writeFileAtomic(ledgerIndexPath(dir), index);
  for (const s of surfaces) writeSurfaceMd(dir, s);
}

function writeSurfaceMd(dir: string, s: AttackSurface): void {
  const md = [
    `# ${s.title}  (${s.id})`,
    ``,
    `- status: ${s.status}`,
    `- priority: ${s.priority}`,
    `- harness: ${s.harnessName ?? "-"}`,
    `- attempts: ${s.attempts}`,
    ``,
    `## APIs`,
    ...(s.apis.length ? s.apis.map((a) => `- \`${a}\``) : [`- (unspecified)`]),
    ``,
    `## Rationale`,
    s.rationale || "(none)",
    ``,
    `## Last feedback`,
    s.lastFeedback || "(none)",
    ``,
  ].join("\n");
  writeFileAtomic(path.join(dir, `${slug(s.id)}.md`), md);
}

/** Highest-priority surface still waiting to be worked, or undefined. */
export function selectNextPending(surfaces: AttackSurface[]): AttackSurface | undefined {
  return surfaces.filter((s) => s.status === "pending").sort((a, b) => b.priority - a.priority)[0];
}
