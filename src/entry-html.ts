/**
 * Render a self-contained entry.html from the run journal: a single page that
 * follows the run in execution order (survey → each surface → attempts) with
 * summary data (time / tokens / coverage / verdicts), and relative links into
 * every detail artifact. Download the report folder, open entry.html locally.
 */

import * as path from "path";
import { Config } from "./types";
import { writeFileAtomic } from "./util/fs";
import { repoWebUrl, commitWebUrl } from "./util/version";
import { RunJournal, SurfaceRecord, AttemptRecord, SurveySurface, totals } from "./journal";

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]!));
const sec = (ms: number): string => (ms / 1000).toFixed(1) + "s";
const tok = (n: number): string => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));
const link = (href: string, text: string): string => `<a href="${esc(href)}">${esc(text)}</a>`;

/** This run's start stamp (timezone-aware); falls back to UTC from startedAtMs for older journals. */
const runLabel = (j: RunJournal): string =>
  j.startedAtLabel || new Date(j.startedAtMs).toISOString().replace("T", " ").replace(/\..*/, "") + " UTC";

/** The header source-identity line. Prefers the REAL upstream `branch @ commit` (linked to the commit
 *  page) captured at build time; the synthetic content-hash is kept as a muted "content-id" for
 *  cross-run-memory traceability. Falls back to just the content-hash for pre-capture journals. */
function versionHeader(j: RunJournal): { h1: string; sub: string } {
  const sv = j.sourceVersion;
  if (sv && sv.commit) {
    const cUrl = commitWebUrl(sv.repoUrl, sv.commit);
    const commitEl = cUrl
      ? `<a href="${esc(cUrl)}"><code>${esc(sv.shortCommit)}</code></a>`
      : `<code>${esc(sv.shortCommit)}</code>`;
    const h1 =
      `${esc(j.target)} <span style="color:#636c76;font-weight:400">· ${esc(sv.branch)} @ </span>${commitEl}`;
    const rUrl = repoWebUrl(sv.repoUrl);
    const repoEl = rUrl ? link(rUrl, rUrl.replace(/^https:\/\//, "")) : esc(sv.repoUrl);
    const parts = [
      sv.repoUrl ? `repo ${repoEl}` : "",
      sv.describe && sv.describe !== sv.shortCommit ? `describe <code>${esc(sv.describe)}</code>` : "",
      `content-id <code>${esc(j.commit)}</code>`,
      sv.note ? `<span style="font-style:italic">${esc(sv.note)}</span>` : "",
    ].filter(Boolean);
    return { h1, sub: parts.join(" · ") };
  }
  return { h1: `${esc(j.target)} <span style="color:#636c76;font-weight:400">@ ${esc(j.commit)}</span>`, sub: "" };
}

/** A rendered-conversation link (+ a raw-jsonl button), given a report-relative `*.html` path.
 *  Falls back to a plain link to `fallbackRel` (e.g. the raw stream log) when no transcript exists. */
const convLinks = (rel?: string, fallbackRel?: string, label = "conversation"): string => {
  if (rel) {
    return (
      `<a class="conv" href="./${esc(rel)}">💬 ${esc(label)}</a>` +
      ` <a class="raw" href="./${esc(rel.replace(/\.html$/, ".jsonl"))}">raw</a>`
    );
  }
  return fallbackRel ? link("./" + fallbackRel, fallbackRel.split("/").pop()!) : "";
};

/** A link to a rendered markdown doc (`*.html`) with a small raw-`md` button beside it. */
const docLink = (htmlRel: string, label: string): string =>
  `<a href="./${esc(htmlRel)}">${esc(label)}</a> <a class="raw" href="./${esc(htmlRel.replace(/\.html$/, ".md"))}">md</a>`;

/** The full surveyed attack-surface list as a table (visible even if the ledger snapshot is missing). */
function surveyTable(surfaces?: SurveySurface[]): string {
  if (!surfaces || !surfaces.length) return "";
  const rows = [...surfaces]
    .sort((a, b) => b.priority - a.priority)
    .map(
      (s) =>
        `<tr><td><code>${esc(s.id)}</code></td><td class="pri">${esc(s.priority)}</td>` +
        `<td><span class="badge ${esc(s.status)}">${esc(s.status)}</span></td>` +
        `<td class="apis">${s.apis.slice(0, 6).map((a) => `<code>${esc(a)}</code>`).join(" ")}` +
        `${s.apis.length > 6 ? ` <span class="more">+${s.apis.length - 6}</span>` : ""}</td>` +
        `<td>${esc(s.title)}</td></tr>`,
    )
    .join("");
  return `<table class="surfaces"><thead><tr><th>id</th><th>pri</th><th>status</th><th>APIs</th><th>title</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function attemptHtml(a: AttemptRecord): string {
  const g = a.generation;
  const v = a.verify;
  const as = a.assess;
  const hrel = a.harnessName ? `${a.dir}/harness-${a.harnessName}` : a.dir;
  const steps: string[] = [];
  steps.push(
    `<div class="step"><b>generate</b> ${sec(g.durationMs)} · ${tok(g.inputTokens)}in/${tok(g.outputTokens)}out` +
      (a.harnessName ? ` · → <code>${esc(a.harnessName)}</code>` : ``) +
      ` · ${convLinks(a.conversationRel, a.dir + "/generation.log")}</div>`,
  );
  if (v) {
    steps.push(
      `<div class="step"><b>verify</b> ${sec(v.durationMs)} · cov ${v.edges} ft ${v.features} corp ${v.corpus} · ` +
        `crashes ${v.crashGroups} · <span class="${v.clean ? "ok" : "bad"}">${v.clean ? "clean" : "dirty(" + esc(v.reason) + ")"}</span> · ` +
        link("./" + hrel + "/fuzz.log", "fuzz.log") + " · " + link("./" + a.dir + "/verdict.json", "verdict.json") +
        (a.verifyConversationRel ? " · " + convLinks(a.verifyConversationRel, undefined, "attribution") : "") + `</div>`,
    );
  }
  if (as) {
    steps.push(
      `<div class="step"><b>assess</b> ${sec(as.durationMs)} · ${tok(as.inputTokens)}in/${tok(as.outputTokens)}out · ` +
        `<span class="${as.sufficient ? "ok" : "bad"}">${as.sufficient ? "sufficient" : "insufficient"}</span> · ` +
        link("./" + a.dir + "/assessment.json", "assessment.json") +
        (a.assessConversationRel ? " · " + convLinks(a.assessConversationRel) : "") + `</div>`,
    );
    if (as.reasoning) steps.push(`<div class="reason">${esc(as.reasoning)}</div>`);
  }
  return `<div class="attempt"><div class="ahead">attempt ${a.attempt} → <i>${esc(a.outcome)}</i></div>${steps.join("")}</div>`;
}

function surfaceHtml(s: SurfaceRecord, i: number): string {
  const id = `s${i}`;
  const harnessLink = s.harnessSrcRel ? ` · ${link("./" + s.harnessSrcRel + "/", "harness src")}` : ``;
  return `
  <div class="surface">
    <div class="shead" onclick="document.getElementById('${id}').classList.toggle('open')">
      <span class="badge ${esc(s.status)}">${esc(s.status)}</span>
      <span class="stitle">${esc(s.title)}</span>
      <span class="meta">${s.attempts.length} attempt(s)${s.harnessName ? " · <code>" + esc(s.harnessName) + "</code>" : ""}${harnessLink}</span>
    </div>
    <div class="apis"><code>${s.apis.map(esc).join("</code> <code>")}</code></div>
    <div id="${id}" class="sbody">${s.attempts.map(attemptHtml).join("")}</div>
  </div>`;
}

export function renderEntryHtml(j: RunJournal): string {
  const t = totals(j);
  const vh = versionHeader(j);
  const surfaces = j.surfaces.map(surfaceHtml).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(j.target)} — harness-gen run</title>
<style>
 body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#f6f7f9;color:#1c2128}
 .wrap{max-width:980px;margin:0 auto;padding:24px}
 h1{font-size:20px;margin:0 0 4px} .sub{color:#636c76;margin-bottom:16px}
 .cards{display:flex;flex-wrap:wrap;gap:10px;margin:14px 0}
 .card{background:#fff;border:1px solid #d0d7de;border-radius:8px;padding:10px 14px;min-width:130px}
 .card .k{color:#636c76;font-size:12px} .card .v{font-size:18px;font-weight:600}
 .section{font-size:13px;font-weight:700;color:#636c76;text-transform:uppercase;letter-spacing:.04em;margin:22px 0 8px}
 .surveycard{background:#fff;border:1px solid #d0d7de;border-radius:8px;padding:12px 14px}
 .surface{background:#fff;border:1px solid #d0d7de;border-radius:8px;margin:8px 0;overflow:hidden}
 .shead{display:flex;align-items:center;gap:10px;padding:10px 14px;cursor:pointer}
 .shead:hover{background:#f6f8fa} .stitle{font-weight:600;flex:1} .meta{color:#636c76;font-size:12px}
 .apis{padding:0 14px 8px;color:#57606a;font-size:12px}
 .sbody{display:none;padding:0 14px 12px;border-top:1px solid #eaeef2}
 .sbody.open{display:block}
 .attempt{border-left:3px solid #d0d7de;margin:10px 0 0;padding:2px 0 2px 12px}
 .ahead{font-weight:600;margin:6px 0 4px} .ahead i{color:#636c76;font-weight:400}
 .step{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;padding:2px 0}
 .step b{font-family:inherit;color:#0969da;display:inline-block;min-width:64px}
 .reason{color:#57606a;font-size:12.5px;margin:2px 0 6px;padding:6px 10px;background:#f6f8fa;border-radius:6px}
 .badge{font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;text-transform:uppercase}
 .done{background:#dafbe1;color:#1a7f37} .failed{background:#ffebe9;color:#cf222e}
 .covered{background:#ddf4ff;color:#0969da} .pending{background:#fff8c5;color:#9a6700} .in_progress{background:#fff8c5;color:#9a6700}
 .ok{color:#1a7f37;font-weight:600} .bad{color:#cf222e;font-weight:600}
 a{color:#0969da;text-decoration:none} a:hover{text-decoration:underline}
 table.surfaces{width:100%;border-collapse:collapse;background:#fff;border:1px solid #d0d7de;border-radius:8px;overflow:hidden;font-size:12.5px;margin:4px 0}
 table.surfaces th{text-align:left;background:#f6f8fa;color:#636c76;font-weight:600;padding:6px 10px;border-bottom:1px solid #d0d7de}
 table.surfaces td{padding:6px 10px;border-bottom:1px solid #eaeef2;vertical-align:top}
 table.surfaces tr:last-child td{border-bottom:none}
 table.surfaces td.pri{text-align:center;color:#636c76;font-variant-numeric:tabular-nums}
 table.surfaces td.apis code{font-size:11px;margin:0 2px 2px 0;display:inline-block} td.apis .more{color:#636c76}
 a.conv{font-weight:600} a.raw{font-size:11px;color:#636c76;background:#eff1f3;padding:1px 6px;border-radius:5px}
 code{font-family:ui-monospace,Menlo,monospace;background:#eff1f3;padding:1px 5px;border-radius:5px;font-size:12px}
 .foot{margin-top:24px;color:#636c76;font-size:12px}
</style></head><body><div class="wrap">
 <h1>${vh.h1}</h1>
 ${vh.sub ? `<div class="sub" style="margin-bottom:4px">${vh.sub}</div>` : ``}
 <div class="sub">run ${esc(runLabel(j))} · ${esc(j.language)} · ${esc(j.sanitizer)} · budget ${j.budget.maxWallTimeSec || "∞"}s wall, ${j.budget.perFuzzSec}s fuzz/harness, ≤${j.budget.maxSurfaceAttempts} attempts/surface</div>
 <div class="cards">
   <div class="card"><div class="k">elapsed</div><div class="v">${t.elapsedMin.toFixed(0)} min</div></div>
   <div class="card"><div class="k">surfaces</div><div class="v">${j.surfaces.length}</div></div>
   <div class="card"><div class="k">harnesses submitted</div><div class="v">${t.submitted}</div></div>
   <div class="card"><div class="k">done / failed</div><div class="v">${t.done} / ${t.failed}</div></div>
   <div class="card"><div class="k">tokens (in/out)</div><div class="v">${tok(t.inputTokens)} / ${tok(t.outputTokens)}</div></div>
   ${t.costUsd > 0 ? `<div class="card"><div class="k">cost</div><div class="v">$${t.costUsd.toFixed(2)}</div></div>` : ``}
 </div>

 <div class="section">1 · Survey — attack-surface investigation</div>
 <div class="surveycard">
   ${
     j.survey.skipped
       ? `<b>Resumed</b> from the existing ledger — survey skipped. <b>${j.survey.total}</b> known surfaces ` +
         `(<span class="ok">${j.survey.covered}</span> covered, ${j.survey.pending} pending to work). ` +
         `· ${docLink("ledger/ledger.html", "ledger")}`
       : `Mapped <b>${j.survey.total}</b> attack surfaces (<span class="ok">${j.survey.covered}</span> already covered, ${j.survey.pending} pending) ` +
         `in ${sec(j.survey.stats.durationMs)} · ${tok(j.survey.stats.inputTokens)}in/${tok(j.survey.stats.outputTokens)}out tokens ` +
         `· ${j.survey.transcriptRel ? convLinks(j.survey.transcriptRel) + " · " : ""}${docLink("ledger/ledger.html", "ledger")}`
   }
 </div>
 ${surveyTable(j.survey.surfaces)}

 <div class="section">2 · Surfaces worked (in execution order)</div>
 ${surfaces || "<div class=surveycard>No surfaces worked.</div>"}

 <div class="foot">
   Details: ${docLink("summary.html", "summary")} · ${link("./run.jsonl", "run.jsonl")} · ${link("./state.json", "state.json")} · ${link("./journal.json", "journal.json")} · ${link("./ledger/", "ledger/")}<br>
   Click a surface to expand its attempts. All links are relative — this folder is self-contained.
 </div>
</div></body></html>`;
}

/** Write entry.html + journal.json into the report dir. Best-effort. */
export function writeEntry(c: Config, j: RunJournal): void {
  try {
    writeFileAtomic(path.join(c.paths.report, "journal.json"), JSON.stringify(j, null, 2));
    writeFileAtomic(path.join(c.paths.report, "entry.html"), renderEntryHtml(j));
  } catch {
    /* best-effort */
  }
}
