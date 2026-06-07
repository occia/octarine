/**
 * One-off: enrich the already-collected reports under /project/harness-gen-results with the new
 * conversation views + survey surface table, recovered from the claude CLI's canonical session
 * transcripts (sudo-copied into each report's .sessions/ by patch-reports.sh).
 *
 * Mapping (per target):
 *   - survey session   = the one whose first user message is the surveyor prompt; also yields the
 *                        full surface list (a tool_use input with a `surfaces` array).
 *   - generation       = the session ids referenced by each attempt's existing generation.log
 *                        (stream-json) → conversation.{jsonl,html} in that attempt dir.
 *   - assessment       = the remaining -src sessions (analysis runs in a different cwd/project),
 *                        time-ordered and zipped to the attempts that reached the assess gate.
 * Then patch journal.json (survey.surfaces + transcript rels) and re-render entry.html.
 */
const fs = require("fs");
const path = require("path");
const DIST = path.join(__dirname, "..", "dist");
const { renderEntryHtml } = require(path.join(DIST, "entry-html.js"));
const { renderTranscriptHtml, renderMarkdownTree, renderMarkdownFile } = require(path.join(DIST, "transcript.js"));
const { sessionIdsFromStreamLog } = require(path.join(DIST, "agent/claude.js"));

const RESULTS = "/project/harness-gen-results";
const TARGETS = process.argv.slice(2).length ? process.argv.slice(2) : ["htslib", "libucl", "librdkafka"];

const slug = (s) => s.replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-").slice(0, 80) || "x";

function writeTranscript(destDir, name, jsonl, title) {
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, `${name}.jsonl`), jsonl);
  fs.writeFileSync(path.join(destDir, `${name}.html`), renderTranscriptHtml(jsonl, title));
}

/** First user-message text of a session (string content or first text item). */
function firstUserText(jsonl) {
  for (const line of jsonl.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    let d;
    try { d = JSON.parse(s); } catch { continue; }
    if (d.type !== "user") continue;
    const c = d.message && d.message.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      const t = c.find((x) => x && x.type === "text");
      if (t) return String(t.text || "");
    }
  }
  return "";
}

function firstTs(jsonl) {
  for (const line of jsonl.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    try { const d = JSON.parse(s); if (d.timestamp) return d.timestamp; } catch {}
  }
  return "";
}

/** Recursively find a `surfaces` array of surveyed-surface objects anywhere in the session. */
function extractSurfaces(jsonl) {
  let found = null;
  const visit = (o) => {
    if (found || !o || typeof o !== "object") return;
    if (Array.isArray(o)) { o.forEach(visit); return; }
    for (const [k, v] of Object.entries(o)) {
      if (k === "surfaces" && Array.isArray(v) && v.length && v[0] && typeof v[0] === "object" && "coveredByExisting" in v[0]) {
        found = v;
        return;
      }
      visit(v);
    }
  };
  for (const line of jsonl.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    try { visit(JSON.parse(s)); } catch {}
    if (found) break;
  }
  return found;
}

function patchTarget(target) {
  const reportDir = path.join(RESULTS, target);
  const sessDir = path.join(reportDir, ".sessions");
  const jpath = path.join(reportDir, "journal.json");
  if (!fs.existsSync(jpath) || !fs.existsSync(sessDir)) { console.log(`SKIP ${target}: missing journal or .sessions`); return; }
  const journal = JSON.parse(fs.readFileSync(jpath, "utf8"));

  // load all sessions: id -> jsonl
  const sessions = {};
  for (const f of fs.readdirSync(sessDir)) {
    if (!f.endsWith(".jsonl")) continue;
    sessions[f.replace(/\.jsonl$/, "")] = fs.readFileSync(path.join(sessDir, f), "utf8");
  }
  const ids = Object.keys(sessions);
  console.log(`\n=== ${target}: ${ids.length} sessions ===`);

  // Recover harnessName for any attempt that built a harness but didn't record it (failed attempts),
  // so the verify-step fuzz.log/coverage links resolve.
  for (const sf of journal.surfaces) {
    for (const a of sf.attempts) {
      if (a.harnessName) continue;
      let entries = [];
      try { entries = fs.readdirSync(path.join(reportDir, a.dir), { withFileTypes: true }); } catch {}
      const h = entries.find((e) => e.isDirectory() && e.name.startsWith("harness-"));
      if (h) a.harnessName = h.name.slice("harness-".length);
    }
  }

  // 1. survey session
  const surveyId = ids.find((id) => /mapping the ATTACK SURFACE/i.test(firstUserText(sessions[id])));
  const genIdsUsed = new Set();

  // 2. generation transcripts (map via each attempt's generation.log session ids)
  let genCount = 0;
  for (const sf of journal.surfaces) {
    for (const a of sf.attempts) {
      const log = path.join(reportDir, a.dir, "generation.log");
      if (!fs.existsSync(log)) continue;
      const sids = sessionIdsFromStreamLog(fs.readFileSync(log, "utf8")).filter((id) => sessions[id]);
      if (!sids.length) continue;
      const jsonl = sids.map((id) => sessions[id]).join("\n");
      writeTranscript(path.join(reportDir, a.dir), "conversation", jsonl, `${target} — ${sf.id} · attempt ${a.attempt} · generation`);
      a.conversationRel = `${a.dir}/conversation.html`;
      sids.forEach((id) => genIdsUsed.add(id));
      genCount++;
    }
  }

  // 3. assessment transcripts: positively identify assess sessions by the assessor prompt
  // fingerprint (excludes e.g. an incomplete non-journaled surface's generation), time-order
  // them, and zip to the attempts that reached the assess gate (also in execution order).
  const assessIds = ids
    .filter((id) => id !== surveyId && !genIdsUsed.has(id) && /sufficiently explores/i.test(firstUserText(sessions[id])))
    .sort((x, y) => firstTs(sessions[x]).localeCompare(firstTs(sessions[y])));
  const attemptsWithAssess = [];
  for (const sf of journal.surfaces) for (const a of sf.attempts) if (a.assess) attemptsWithAssess.push({ sf, a });
  if (assessIds.length !== attemptsWithAssess.length) {
    console.log(`  WARN assess sessions=${assessIds.length} but attempts-with-assess=${attemptsWithAssess.length} (zipping min)`);
  }
  const n = Math.min(assessIds.length, attemptsWithAssess.length);
  for (let i = 0; i < n; i++) {
    const { sf, a } = attemptsWithAssess[i];
    const text = firstUserText(sessions[assessIds[i]]);
    if (sf.title && !text.includes(sf.title)) {
      console.log(`  WARN assess #${i} ${sf.id}/attempt-${a.attempt}: session prompt does not mention surface title (mapping may be off)`);
    }
    writeTranscript(path.join(reportDir, a.dir), "assessment-conversation", sessions[assessIds[i]], `${target} — ${sf.id} · attempt ${a.attempt} · assessment`);
    a.assessConversationRel = `${a.dir}/assessment-conversation.html`;
  }

  // 3b. crash-attribution transcripts (the verify step's agents) from -work-verifier sessions.
  // Match by harness name (the analysis prompt names the harness) so sessions belonging to a
  // non-journaled trailing surface (hard-kill artifact) are naturally excluded.
  const vDir = path.join(reportDir, ".sessions-verifier");
  if (fs.existsSync(vDir)) {
    const vsess = {};
    for (const f of fs.readdirSync(vDir)) if (f.endsWith(".jsonl")) vsess[f.replace(/\.jsonl$/, "")] = fs.readFileSync(path.join(vDir, f), "utf8");
    const consumed = new Set();
    let attrCount = 0;
    for (const sf of journal.surfaces) {
      for (const a of sf.attempts) {
        const ng = a.verify && a.verify.crashGroups ? a.verify.crashGroups : 0;
        if (!ng || !a.harnessName) continue;
        const cands = Object.keys(vsess)
          .filter((id) => !consumed.has(id) && firstUserText(vsess[id]).includes(a.harnessName))
          .sort((x, y) => firstTs(vsess[x]).localeCompare(firstTs(vsess[y])))
          .slice(0, ng);
        if (!cands.length) continue;
        cands.forEach((id) => consumed.add(id));
        writeTranscript(path.join(reportDir, a.dir), "attribution-conversation", cands.map((id) => vsess[id]).join("\n"), `${target} — ${sf.id} · attempt ${a.attempt} · crash attribution`);
        a.verifyConversationRel = `${a.dir}/attribution-conversation.html`;
        attrCount++;
      }
    }
    const leftover = Object.keys(vsess).length - consumed.size;
    if (leftover) console.log(`  note: ${leftover} attribution session(s) from non-journaled/trailing surface(s), ignored`);
    console.log(`  attribution-conv=${attrCount}`);
  }

  // 4. survey transcript + full surface list (+ ledger reconstruction if missing)
  if (surveyId) {
    writeTranscript(path.join(reportDir, "survey"), "transcript", sessions[surveyId], `${target} — attack-surface survey`);
    journal.survey.transcriptRel = "survey/transcript.html";
    const surveyed = extractSurfaces(sessions[surveyId]);
    if (surveyed) {
      const worked = new Map(journal.surfaces.map((w) => [w.id, w.status]));
      journal.survey.surfaces = surveyed.map((sv) => ({
        id: sv.id,
        title: sv.title,
        apis: (sv.apis || []).map(String),
        priority: Number(sv.priority) || 0,
        status: worked.get(sv.id) || (sv.coveredByExisting ? "covered" : "pending"),
      }));
      const ledgerMd = path.join(reportDir, "ledger", "ledger.md");
      if (!fs.existsSync(ledgerMd)) {
        fs.mkdirSync(path.dirname(ledgerMd), { recursive: true });
        const rows = journal.survey.surfaces
          .slice()
          .sort((p, q) => q.priority - p.priority)
          .map((s) => `| ${s.id} | ${s.status} | ${s.priority} | ${s.apis.slice(0, 6).join(", ")} | ${s.title.replace(/\|/g, "/")} |`);
        fs.writeFileSync(
          ledgerMd,
          [`# Attack-surface ledger — ${target} @ ${journal.commit}`, ``, `| id | status | pri | apis | title |`, `|---|---|---|---|---|`, ...rows, ``].join("\n"),
        );
        console.log(`  + reconstructed ledger/ledger.md (${journal.survey.surfaces.length} surfaces)`);
      }
    } else {
      console.log(`  WARN could not extract surfaces array from survey session`);
    }
  } else {
    console.log(`  WARN no survey session identified`);
  }

  // 5. render markdown docs (ledger + summary) to browsable html, then re-render entry.html
  try { renderMarkdownTree(path.join(reportDir, "ledger")); } catch {}
  const sm = path.join(reportDir, "summary.md");
  if (fs.existsSync(sm)) { try { renderMarkdownFile(sm, `${target} — run summary`); } catch {} }
  fs.writeFileSync(jpath, JSON.stringify(journal, null, 2));
  fs.writeFileSync(path.join(reportDir, "entry.html"), renderEntryHtml(journal));
  const convs = journal.surfaces.reduce((a, s) => a + s.attempts.filter((x) => x.conversationRel).length, 0);
  const ascs = journal.surfaces.reduce((a, s) => a + s.attempts.filter((x) => x.assessConversationRel).length, 0);
  console.log(`  survey=${surveyId ? "yes" : "NO"} gen-conv=${convs} assess-conv=${ascs} surfaces=${(journal.survey.surfaces || []).length}; entry.html re-rendered`);
}

for (const t of TARGETS) patchTarget(t);
