#!/usr/bin/env node
/**
 * Redact every crash / sanitizer detail from a copied run report so it can be published as a demo.
 * Crash repro INPUTS (the harness crashes/ dirs) must already be deleted before running this. Strategy: redact
 * the SOURCE artifacts (jsonl / json / md / log), then RE-RENDER every HTML page from the redacted
 * source, so a rendered page can never contain anything the source doesn't. Verify afterwards by
 * grepping the tree for residual signatures.
 *
 * Usage: node tools/redact-report.cjs <report-dir>
 */
const fs = require("fs");
const path = require("path");
const { renderTranscriptHtml, renderMarkdownFile, renderMarkdownTree } = require("../dist/transcript");
const { renderEntryHtml } = require("../dist/entry-html");

const ROOT = process.argv[2];
if (!ROOT || !fs.existsSync(ROOT)) {
  console.error("usage: redact-report.cjs <report-dir>");
  process.exit(2);
}

// Any text matching this is crash / sanitizer / repro material → redact.
const STRONG = /AddressSanitizer|LeakSanitizer|MemorySanitizer|ThreadSanitizer|UndefinedBehaviorSanitizer|ERROR:\s*libFuzzer|heap-buffer-overflow|heap-use-after-free|stack-buffer-overflow|stack-buffer-underflow|global-buffer-overflow|stack-overflow|use-after-free|use-after-poison|double-free|alloc-dealloc-mismatch|attempting free|container-overflow|negative-size-param|dynamic-stack-buffer-overflow|out-of-memory|out of memory|rss_limit|allocator is out of memory|\bSEGV\b|SIGSEGV|SIGABRT|SIGBUS|SIGFPE|DEADLYSIGNAL|deadly signal|SUMMARY:\s|#\d+\s+0x[0-9a-f]+|==\d+==|Shadow bytes|Shadow byte legend|DEDUP_TOKEN|artifact_prefix|Test unit written|MS:\s+\d|redzone|0x[0-9a-f]+:\s+[0-9a-f]{2}\b|crash-[0-9a-f]{8,}/i;

const MARK = "[redacted — crash / sanitizer detail]";

const isCrashy = (s) => typeof s === "string" && STRONG.test(s);

/** Line-level redaction: blank crash-bearing lines, collapse runs, keep the rest (for logs / md). */
function redactLines(s) {
  if (!isCrashy(s)) return s;
  const out = [];
  let prev = false;
  for (const line of s.split("\n")) {
    if (STRONG.test(line)) { if (!prev) out.push(MARK); prev = true; }
    else { out.push(line); prev = false; }
  }
  return out.join("\n");
}

/** Deep-redact string values inside a parsed JSON value (for *.json + stream-json log lines). */
function redactDeep(v) {
  if (typeof v === "string") return isCrashy(v) ? MARK : v;
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) o[k] = redactDeep(v[k]);
    return o;
  }
  return v;
}

/** Redact one canonical transcript record (user/assistant): blank any crash-bearing text block whole. */
function redactRecord(rec) {
  const msg = rec && rec.message;
  if (!msg) return rec;
  const c = msg.content;
  if (typeof c === "string") {
    if (isCrashy(c)) msg.content = MARK;
  } else if (Array.isArray(c)) {
    for (const it of c) {
      if (!it || typeof it !== "object") continue;
      if (isCrashy(it.text)) it.text = MARK;
      if (isCrashy(it.thinking)) it.thinking = MARK;
      if ("content" in it) {
        if (typeof it.content === "string") { if (isCrashy(it.content)) it.content = MARK; }
        else if (Array.isArray(it.content)) it.content = it.content.map((x) =>
          x && typeof x === "object" && isCrashy(x.text) ? { ...x, text: MARK } : x);
        else if (isCrashy(JSON.stringify(it.content))) it.content = MARK;
      }
      if (it.input && isCrashy(JSON.stringify(it.input))) it.input = MARK;
    }
  }
  return rec;
}

function readTitle(htmlPath, fallback) {
  try { const m = fs.readFileSync(htmlPath, "utf8").match(/<title>([^<]*)<\/title>/); return m ? m[1] : fallback; }
  catch { return fallback; }
}

let counts = { trace: 0, crashJson: 0, attribution: 0, transcript: 0, json: 0, md: 0, log: 0, other: 0, html: 0 };

function walk(dir, fn) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, fn);
    else if (e.isFile()) fn(p, e.name);
  }
}

// ---- pass 1: redact every non-HTML source ----------------------------------------------------------
walk(ROOT, (p, base) => {
  const ext = path.extname(base).toLowerCase();
  if (/^crash-.*\.trace$/.test(base)) { fs.writeFileSync(p, MARK + "\n"); counts.trace++; return; }
  if (base === "crash-groups.json" || base === "attributions.json") { fs.writeFileSync(p, '{ "redacted": true }\n'); counts.crashJson++; return; }
  if (base === "attribution-conversation.jsonl") {
    fs.writeFileSync(p, JSON.stringify({ type: "user", uuid: "redacted", timestamp: "", message: { role: "user", content: MARK } }) + "\n");
    counts.attribution++; return;
  }
  if (ext === ".jsonl") {
    const lines = fs.readFileSync(p, "utf8").split("\n");
    const out = lines.map((ln) => {
      const s = ln.trim(); if (!s.startsWith("{")) return ln;
      let r; try { r = JSON.parse(s); } catch { return isCrashy(ln) ? JSON.stringify({ redacted: true }) : ln; }
      // Deep-redact the ENTIRE record — canonical claude jsonl duplicates tool output in a top-level
      // `toolUseResult` field (which the renderer ignores, but the raw jsonl must not leak), so redacting
      // only message.content is not enough. The renderer reads message.content, kept clean by the same pass.
      return JSON.stringify(redactDeep(r));
    });
    fs.writeFileSync(p, out.join("\n"));
    counts.transcript++; return;
  }
  if (ext === ".json") {
    try { const o = JSON.parse(fs.readFileSync(p, "utf8")); fs.writeFileSync(p, JSON.stringify(redactDeep(o), null, 2) + "\n"); counts.json++; }
    catch { /* leave non-JSON */ } return;
  }
  if (base === "fuzz.log") { // keep run progress, cut everything from the first crash marker on
    const t = fs.readFileSync(p, "utf8");
    if (isCrashy(t)) { const lines = t.split("\n"); const i = lines.findIndex((l) => STRONG.test(l)); fs.writeFileSync(p, (i >= 0 ? lines.slice(0, i).join("\n") + "\n" : "") + MARK + "\n"); }
    counts.log++; return;
  }
  if (ext === ".log") { // generation.log etc. — stream-json or text, redact per line
    const out = fs.readFileSync(p, "utf8").split("\n").map((ln) => {
      const s = ln.trim();
      if (s.startsWith("{")) { try { return JSON.stringify(redactDeep(JSON.parse(s))); } catch { /* fall */ } }
      return isCrashy(ln) ? MARK : ln;
    });
    fs.writeFileSync(p, out.join("\n")); counts.log++; return;
  }
  if (ext === ".md") { fs.writeFileSync(p, redactLines(fs.readFileSync(p, "utf8"))); counts.md++; return; }
  if (ext === ".html") return; // re-rendered in pass 2
  // harness source / build scripts / yaml: keep, but blank any stray crash text (defensive)
  try { const t = fs.readFileSync(p, "utf8"); if (isCrashy(t)) { fs.writeFileSync(p, redactLines(t)); counts.other++; } } catch { /* binary */ }
});

// ---- pass 2: re-render every HTML from its (now-redacted) source ------------------------------------
walk(ROOT, (p, base) => {
  if (base !== "entry.html") return;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(path.dirname(p), "journal.json"), "utf8"));
    fs.writeFileSync(p, renderEntryHtml(j)); counts.html++;
  } catch (e) { console.warn("entry.html re-render failed:", e.message); }
});
walk(ROOT, (p, base) => {
  const ext = path.extname(base).toLowerCase();
  if (ext !== ".jsonl") return;
  const html = p.replace(/\.jsonl$/, ".html");
  if (!fs.existsSync(html)) return; // run.jsonl etc. have no transcript html
  fs.writeFileSync(html, renderTranscriptHtml(fs.readFileSync(p, "utf8"), readTitle(html, base)));
  counts.html++;
});
// summary.html + ledger/*.html from their redacted markdown
const summaryMd = path.join(ROOT, "summary.md");
if (fs.existsSync(summaryMd)) renderMarkdownFile(summaryMd, "hdf5 — run summary");
for (const d of [path.join(ROOT, "ledger"), path.join(ROOT, "_memory", "ledger")]) if (fs.existsSync(d)) renderMarkdownTree(d);

console.log("redacted:", JSON.stringify(counts));
