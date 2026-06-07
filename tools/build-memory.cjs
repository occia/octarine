/**
 * One-off: hand-assemble the cross-run memory archive for the three already-completed runs
 * (htslib / libucl / librdkafka) from their reports, so a later run can resume from them.
 *
 * Writes to the HOST side of the /hack-memory bind mount (/project/.hack-memory), keyed by
 * <projectId>-<commit>, with ledger/ (the surface md set) + harnesses/<surface-id>/ (the confirmed
 * fuzz-proj sources). Reuses the compiled projectIdFromRepoUrl + renderLedger so the layout matches
 * exactly what the running CRS would produce.
 *
 * Re-classification applied: a surface marked `abandoned` with attempts < maxSurfaceAttempts was cut
 * off by the budget, NOT genuinely exhausted → it becomes `pending` (redo next run), not `failed`.
 */
const fs = require("fs");
const path = require("path");
const DIST = path.join(__dirname, "..", "dist");
const { projectIdFromRepoUrl, renderLedger } = require(path.join(DIST, "ledger/index.js"));

const RESULTS = "/project/harness-gen-results";
const OSS_FUZZ = "/project/oss-fuzz-projects/projects";
const HOST_MEMORY = "/project/.hack-memory"; // host side of the container's /hack-memory bind
const slug = (s) => s.replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-").slice(0, 80) || "x";

function mainRepo(target) {
  const y = fs.readFileSync(path.join(OSS_FUZZ, target, "project.yaml"), "utf8");
  const m = y.match(/^\s*main_repo\s*:\s*['"]?([^'"\n]+)['"]?\s*$/m);
  return m ? m[1].trim() : "";
}

for (const target of ["htslib", "libucl", "librdkafka"]) {
  const j = JSON.parse(fs.readFileSync(path.join(RESULTS, target, "journal.json"), "utf8"));
  const projectId = projectIdFromRepoUrl(mainRepo(target));
  const maxAtt = j.budget.maxSurfaceAttempts;
  const memDir = path.join(HOST_MEMORY, `${slug(projectId)}-${j.commit}`);
  const ledger = path.join(memDir, "ledger");
  const harnesses = path.join(memDir, "harnesses");

  const worked = new Map(j.surfaces.map((s) => [s.id, s]));
  let done = 0, failed = 0, pending = 0, covered = 0;

  // Build the full AttackSurface[] from the survey list, applying final/non-final classification.
  const surfaces = (j.survey.surfaces || []).map((sv) => {
    const w = worked.get(sv.id);
    let status, harnessName, attempts, lastFeedback;
    if (w && w.status === "done") {
      status = "done"; harnessName = w.harnessName; attempts = w.attempts.length;
      lastFeedback = (w.attempts[w.attempts.length - 1] || {}).assess?.reasoning;
      done++;
    } else if (w) {
      // worked but not done: exhausted attempts → failed; otherwise budget cut-off → redo (pending)
      attempts = w.attempts.length;
      if (attempts >= maxAtt) { status = "failed"; lastFeedback = (w.attempts[attempts - 1] || {}).assess?.reasoning; failed++; }
      else { status = "pending"; attempts = 0; pending++; } // fresh redo, no carried feedback
    } else {
      status = sv.status === "covered" ? "covered" : "pending";
      attempts = 0;
      status === "covered" ? covered++ : pending++;
    }
    return { id: sv.id, title: sv.title, apis: sv.apis || [], rationale: "", priority: sv.priority || 0, status, harnessName, attempts, lastFeedback };
  });

  fs.mkdirSync(ledger, { recursive: true });
  renderLedger(ledger, target, j.commit, surfaces);

  // Copy confirmed (done) harness sources into harnesses/<surface-id>/.
  fs.mkdirSync(harnesses, { recursive: true });
  let stored = 0;
  for (const s of surfaces.filter((x) => x.status === "done")) {
    const src = path.join(RESULTS, target, `surface-${slug(s.id)}`, "submitted");
    if (fs.existsSync(src)) { fs.cpSync(src, path.join(harnesses, slug(s.id)), { recursive: true }); stored++; }
  }

  console.log(`${projectId}-${j.commit}: ${surfaces.length} surfaces (done=${done} failed=${failed} covered=${covered} pending=${pending}); ${stored} harness(es) stored`);
}
