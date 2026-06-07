#!/usr/bin/env node
/**
 * Retroactively enrich existing batch-run reports with the real upstream source identity
 * (repo + branch + commit), shown consistently across every version-display surface:
 *   - entry.html header
 *   - ledger/ledger.md + ledger.html heading  (and _memory/ledger/ledger.md)
 *   - summary.md + summary.html
 *   - state.json (sourceVersion field)
 *
 * The original runs used unpinned shallow clones and did NOT record the exact build commit (the
 * going-forward fix in bin/compile_target now captures it at build time); so for these past reports
 * we re-derive the branch + current upstream HEAD via `git ls-remote` and mark it as re-derived.
 *
 * Usage: node tools/patch-source-version.cjs <versions.tsv> <report-root> [<report-root> ...]
 *   versions.tsv lines: <project>\t<repoUrl>\t<branch>\t<commit>
 */
const fs = require("fs");
const path = require("path");
const { renderEntryHtml } = require("../dist/entry-html");
const { sourceIdentityMd } = require("../dist/util/version");
const { renderMarkdownFile, renderMarkdownTree } = require("../dist/transcript");

const [tsv, ...roots] = process.argv.slice(2);
if (!tsv || roots.length === 0) {
  console.error("usage: patch-source-version.cjs <versions.tsv> <report-root>...");
  process.exit(2);
}

const NOTE = "commit re-derived 2026-06-07 (upstream HEAD) — the original build used an unpinned shallow clone and did not record the exact commit";

const versions = {};
for (const line of fs.readFileSync(tsv, "utf8").split("\n")) {
  const [proj, repoUrl, branch, commit] = line.split("\t");
  if (!proj || !commit || commit === "MISSING") continue;
  versions[proj] = { repoUrl, branch, commit, shortCommit: commit.slice(0, 12), note: NOTE };
}

/** Replace the first line matching `re` in a file (if present) and re-render its sibling html. */
function patchLine(file, re, newLine) {
  if (!fs.existsSync(file)) return false;
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const i = lines.findIndex((l) => re.test(l));
  if (i < 0) return false;
  lines[i] = newLine;
  fs.writeFileSync(file, lines.join("\n"));
  return true;
}

let patched = 0;
for (const root of roots) {
  for (const proj of fs.readdirSync(root)) {
    const dir = path.join(root, proj);
    const jpath = path.join(dir, "journal.json");
    if (!fs.statSync(dir).isDirectory() || !fs.existsSync(jpath)) continue;
    const sv = versions[proj];
    if (!sv) { console.warn(`  no version for ${proj}, skipping`); continue; }

    // 1) journal.json + entry.html (the primary header)
    const j = JSON.parse(fs.readFileSync(jpath, "utf8"));
    j.sourceVersion = sv;
    fs.writeFileSync(jpath, JSON.stringify(j, null, 2));
    fs.writeFileSync(path.join(dir, "entry.html"), renderEntryHtml(j));
    const syn = j.commit;
    const target = j.target;

    // 2) state.json (machine state used by summary)
    const spath = path.join(dir, "state.json");
    if (fs.existsSync(spath)) {
      const st = JSON.parse(fs.readFileSync(spath, "utf8"));
      st.sourceVersion = sv;
      fs.writeFileSync(spath, JSON.stringify(st, null, 2));
    }

    // 3) summary.md/.html — the `- target: … commit: …` (or prior `- source: …`) line
    const sumMd = path.join(dir, "summary.md");
    if (patchLine(sumMd, /^- (target:|source:)/, `- source: ${sourceIdentityMd(target, syn, sv, true)}`)) {
      renderMarkdownFile(sumMd, `${target} — run summary`);
    }

    // 4) ledger headings — `# Attack-surface ledger — …` in the report copy + the persisted memory copy
    const ledgerMd = path.join(dir, "ledger", "ledger.md");
    const headRe = /^# Attack-surface ledger —/;
    const headLine = `# Attack-surface ledger — ${sourceIdentityMd(target, syn, sv)}`;
    if (patchLine(ledgerMd, headRe, headLine)) renderMarkdownTree(path.join(dir, "ledger"));
    patchLine(path.join(dir, "_memory", "ledger", "ledger.md"), headRe, headLine); // md-only snapshot

    console.log(`  ${root}/${proj}: ${sv.branch} @ ${sv.shortCommit}`);
    patched++;
  }
}
console.log(`patched ${patched} report(s)`);
