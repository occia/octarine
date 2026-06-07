#!/usr/bin/env node
/**
 * Re-render every collected agent-conversation transcript (*.jsonl with a sibling *.html) in the
 * given report roots, using the current renderer (dist/transcript). Used to apply renderer/CSS fixes
 * to already-collected reports without re-running the CRS. The page <title> is preserved from the
 * existing html so titles don't change.
 *
 * Usage: node tools/rerender-transcripts.cjs <report-root> [<report-root> ...]
 */
const fs = require("fs");
const path = require("path");
const { renderTranscriptHtml } = require("../dist/transcript");

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error("usage: rerender-transcripts.cjs <report-root>...");
  process.exit(2);
}

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    console.warn(`  skip unreadable dir (${e.code}): ${dir}`); // e.g. root-owned .claude/sessions
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
}

function titleOf(html, fallback) {
  const m = html.match(/<title>([^<]*)<\/title>/);
  return m ? m[1] : fallback;
}

let rendered = 0, skipped = 0;
for (const root of roots) {
  const jsonls = [];
  walk(root, jsonls);
  for (const jl of jsonls) {
    const htmlPath = jl.replace(/\.jsonl$/, ".html");
    if (!fs.existsSync(htmlPath)) { skipped++; continue; } // e.g. run.jsonl (no transcript html)
    const jsonlText = fs.readFileSync(jl, "utf8");
    const title = titleOf(fs.readFileSync(htmlPath, "utf8"), path.basename(htmlPath, ".html"));
    fs.writeFileSync(htmlPath, renderTranscriptHtml(jsonlText, title));
    rendered++;
  }
}
console.log(`re-rendered ${rendered} transcript(s); skipped ${skipped} non-transcript jsonl(s)`);
