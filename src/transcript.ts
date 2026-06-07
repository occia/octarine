/**
 * Render a Claude-Code session transcript (the canonical `.claude/projects/<proj>/<id>.jsonl`
 * format) into a self-contained, offline HTML chat view: user/assistant bubbles, collapsible
 * thinking, tool-call cards, collapsible tool results, markdown + syntax highlighting.
 *
 * Used both in-container (snapshot each agent's conversation into the run report) and on-host
 * (the patch tool that enriches already-collected reports). Output has no external requests:
 * markdown and code highlighting are rendered server-side (marked + highlight.js) and a compact
 * highlight.js theme is inlined; collapsing uses native <details>, so no JavaScript is needed.
 */

import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { marked } from "marked";
import hljs from "highlight.js";
import { mkdirp, writeFileAtomic } from "./util/fs";

marked.setOptions({
  highlight: (code: string, lang: string): string => {
    const language = lang && hljs.getLanguage(lang) ? lang : "plaintext";
    try {
      return hljs.highlight(code, { language }).value;
    } catch {
      return esc(code);
    }
  },
  langPrefix: "hljs language-",
  // GitHub-style: a single newline becomes <br>. Keeps multi-line content (crash traces an agent
  // paraphrases inline, not inside a ``` fence) from collapsing into one run-on line.
  breaks: true,
  mangle: false,
  headerIds: false,
} as Parameters<typeof marked.setOptions>[0]);

// Disable Setext (underline) headings. A line of === or --- in log/crash output — e.g. the ASAN
// banner line of '=' that precedes "==PID==ERROR" — is otherwise read as a heading UNDERLINE: marked
// retroactively folds the preceding lines (including an opening ``` fence) into one heading, which
// destroys the code block (the crash trace leaks out as prose, the text after the fence becomes code).
// Agents write ATX headings (`# Title`), which are unaffected.
// Must return undefined (NOT false): marked's use()-wrapper falls back to the ORIGINAL tokenizer on a
// `false` return, which would re-enable Setext. The cast satisfies marked's (false | Heading) type while
// returning undefined at runtime, which suppresses the token entirely.
marked.use({ tokenizer: { lheading: (() => undefined) as unknown as (src: string) => false } });

const MAX_BLOCK = 20000; // cap any single tool input/result block so one huge file-read can't bloat the page

export const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]!));

const md = (text: string): string => {
  try {
    return marked.parse(text) as string;
  } catch {
    return `<p>${esc(text)}</p>`;
  }
};

const codeBlock = (text: string, lang: string): string => {
  const clipped = text.length > MAX_BLOCK ? text.slice(0, MAX_BLOCK) + `\n… (${text.length - MAX_BLOCK} more chars)` : text;
  const language = lang && hljs.getLanguage(lang) ? lang : "plaintext";
  let body: string;
  try {
    body = hljs.highlight(clipped, { language }).value;
  } catch {
    body = esc(clipped);
  }
  return `<pre><code class="hljs language-${esc(language)}">${body}</code></pre>`;
};

interface Item {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  is_error?: boolean;
}
interface Record_ {
  type?: string;
  uuid?: string;
  timestamp?: string;
  isSidechain?: boolean;
  message?: { role?: string; content?: unknown };
}

/** Normalize a message's content to a list of content items. */
function items(content: unknown): Item[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content as Item[];
  return [];
}

/** Flatten a tool_result content (string | array of {type:text,text}) to plain text. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : c && typeof c === "object" && "text" in c ? String((c as Item).text ?? "") : JSON.stringify(c)))
      .join("\n");
  }
  if (content == null) return "";
  return JSON.stringify(content, null, 2);
}

function itemHtml(it: Item): string {
  switch (it.type) {
    case "text":
      return it.text ? `<div class="msg-text">${md(it.text)}</div>` : "";
    case "thinking":
      return it.thinking
        ? `<details class="thinking"><summary>💭 thinking</summary><div class="msg-text">${md(it.thinking)}</div></details>`
        : "";
    case "tool_use": {
      const inputStr =
        it.input == null ? "" : typeof it.input === "string" ? it.input : JSON.stringify(it.input, null, 2);
      const lang = typeof it.input === "string" ? "bash" : "json";
      return (
        `<div class="tool"><div class="tool-head">🔧 <b>${esc(it.name ?? "tool")}</b></div>` +
        (inputStr ? `<details open><summary>input</summary>${codeBlock(inputStr, lang)}</details>` : "") +
        `</div>`
      );
    }
    case "tool_result": {
      const txt = resultText(it.content);
      if (!txt.trim()) return `<details class="result"><summary>↳ result (empty)</summary></details>`;
      const cls = it.is_error ? "result err" : "result";
      const label = it.is_error ? "↳ result · error" : "↳ result";
      return `<details class="${cls}"><summary>${label}</summary>${codeBlock(txt, "plaintext")}</details>`;
    }
    default:
      return "";
  }
}

function recordHtml(r: Record_): string {
  const role = r.message?.role === "assistant" ? "assistant" : "user";
  const body = items(r.message?.content).map(itemHtml).join("");
  if (!body.trim()) return "";
  const side = r.isSidechain ? `<span class="side">subagent</span>` : "";
  const who = role === "assistant" ? "Claude" : "User / tool";
  const ts = r.timestamp ? `<span class="ts">${esc(r.timestamp.replace("T", " ").replace(/\.\d+Z$/, "Z"))}</span>` : "";
  return `<div class="turn ${role}"><div class="who">${esc(who)}${side}${ts}</div>${body}</div>`;
}

/** Parse the canonical jsonl (possibly several concatenated sessions), de-dupe by uuid, order by time. */
function parseRecords(jsonlText: string): Record_[] {
  const seen = new Set<string>();
  const recs: Record_[] = [];
  for (const line of jsonlText.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    let r: Record_;
    try {
      r = JSON.parse(s) as Record_;
    } catch {
      continue;
    }
    if (r.type !== "user" && r.type !== "assistant") continue;
    if (r.uuid && seen.has(r.uuid)) continue;
    if (r.uuid) seen.add(r.uuid);
    recs.push(r);
  }
  recs.sort((a, b) => String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? "")));
  return recs;
}

export function renderTranscriptHtml(jsonlText: string, title: string): string {
  const recs = parseRecords(jsonlText);
  const turns = recs.map(recordHtml).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
 body{font:14px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#f6f7f9;color:#1c2128}
 .wrap{max-width:900px;margin:0 auto;padding:20px}
 h1{font-size:17px;margin:0 0 4px} .sub{color:#636c76;margin-bottom:16px;font-size:12px}
 .turn{background:#fff;border:1px solid #d0d7de;border-radius:8px;margin:10px 0;padding:10px 14px;overflow:hidden}
 .turn.assistant{border-left:3px solid #0969da} .turn.user{border-left:3px solid #8c959f;background:#fbfcfd}
 .who{font-size:11px;font-weight:700;color:#636c76;text-transform:uppercase;letter-spacing:.03em;margin-bottom:6px}
 .who .side{margin-left:8px;background:#fff1e5;color:#bc4c00;padding:1px 6px;border-radius:999px;font-size:10px}
 .who .ts{margin-left:8px;font-weight:400;color:#a0a8b0;text-transform:none;letter-spacing:0}
 .msg-text{font-size:14px} .msg-text p{margin:6px 0} .msg-text h1,.msg-text h2,.msg-text h3{font-size:15px;margin:10px 0 4px}
 .msg-text ul,.msg-text ol{margin:6px 0 6px 22px} .msg-text code{background:#eff1f3;padding:1px 5px;border-radius:5px;font-size:12.5px}
 .thinking{margin:6px 0;background:#fffbf0;border:1px solid #f0e6c8;border-radius:6px;padding:2px 10px}
 .thinking>summary{cursor:pointer;color:#9a6700;font-size:12.5px;font-weight:600;padding:4px 0}
 .thinking .msg-text{color:#6f5b1e;font-size:13px}
 .tool{margin:8px 0;border:1px solid #d0d7de;border-radius:6px;overflow:hidden}
 .tool-head{background:#ddf4ff;color:#0550ae;padding:5px 10px;font-size:12.5px;font-family:ui-monospace,Menlo,monospace}
 .tool details>summary,.result>summary{cursor:pointer;font-size:12px;color:#636c76;padding:5px 10px;user-select:none}
 .result{margin:8px 0;border:1px solid #d0d7de;border-radius:6px;background:#f6f8fa}
 .result.err{border-color:#ff818266;background:#fff5f5} .result.err>summary{color:#cf222e}
 pre{margin:0;padding:10px 12px;overflow-x:auto;background:#0d1117;color:#e6edf3;font-size:12px;line-height:1.45}
 pre code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:none;padding:0;color:inherit;white-space:pre}
 .msg-text pre{border-radius:6px;margin:8px 0}
 /* Block code (crash dumps / logs) must stay light-on-dark: the inline .msg-text code rule below
    has higher specificity than the bare pre-code reset and would otherwise paint the code element
    with a light inline-code background -- light-on-light (invisible until selected). Re-assert here. */
 .msg-text pre code,.thinking .msg-text pre code{background:transparent;color:#e6edf3;font-size:12px;padding:0;border-radius:0}
 /* compact highlight.js (github-dark subset) */
 .hljs-comment,.hljs-quote{color:#8b949e} .hljs-keyword,.hljs-selector-tag,.hljs-type{color:#ff7b72}
 .hljs-string,.hljs-attr,.hljs-template-tag{color:#a5d6ff} .hljs-number,.hljs-literal{color:#79c0ff}
 .hljs-title,.hljs-function .hljs-title,.hljs-section{color:#d2a8ff} .hljs-built_in,.hljs-builtin-name{color:#ffa657}
 .hljs-name,.hljs-tag{color:#7ee787} .hljs-meta{color:#79c0ff} .hljs-symbol,.hljs-bullet,.hljs-variable{color:#ffa657}
 .foot{margin-top:18px;color:#636c76;font-size:12px}
</style></head><body><div class="wrap">
 <h1>${esc(title)}</h1>
 <div class="sub">${recs.length} turn(s) · Claude-Code conversation</div>
 ${turns || "<div class=turn>No conversation content.</div>"}
 <div class="foot">Rendered offline from the raw session JSONL. Thinking / tool I/O are collapsed — click to expand.</div>
</div></body></html>`;
}

/** Render a markdown document (ledger / summary) to a self-contained HTML page. Browsers show
 *  raw `.md` as plain text over file://; this gives the same offline-self-contained treatment as
 *  the transcripts. Intra-doc links to other `*.md` are rewritten to `*.html` so a rendered ledger
 *  set stays browsable. */
export function renderMarkdownHtml(mdText: string, title: string): string {
  let body: string;
  try {
    body = marked.parse(mdText) as string;
  } catch {
    body = `<pre>${esc(mdText)}</pre>`;
  }
  body = body.replace(/href="([^"]+?)\.md(#[^"]*)?"/g, 'href="$1.html$2"');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
 body{font:14px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#f6f7f9;color:#1c2128}
 .md{max-width:900px;margin:0 auto;padding:28px 24px;background:#fff;min-height:100vh;border-left:1px solid #eaeef2;border-right:1px solid #eaeef2}
 .md h1{font-size:22px;border-bottom:1px solid #d0d7de;padding-bottom:8px} .md h2{font-size:18px;margin-top:24px;border-bottom:1px solid #eaeef2;padding-bottom:5px}
 .md h3{font-size:15px} .md p,.md li{font-size:14px}
 .md table{border-collapse:collapse;width:100%;margin:12px 0;font-size:13px}
 .md th,.md td{border:1px solid #d0d7de;padding:6px 10px;text-align:left} .md th{background:#f6f8fa}
 .md tr:nth-child(2n) td{background:#fbfcfd}
 .md code{background:#eff1f3;padding:1px 5px;border-radius:5px;font-size:12.5px;font-family:ui-monospace,Menlo,monospace}
 .md pre{background:#0d1117;color:#e6edf3;padding:12px;border-radius:6px;overflow-x:auto} .md pre code{background:none;padding:0}
 .md a{color:#0969da;text-decoration:none} .md a:hover{text-decoration:underline}
 .md blockquote{margin:8px 0;padding:4px 14px;border-left:3px solid #d0d7de;color:#57606a}
 .hljs-comment,.hljs-quote{color:#8b949e} .hljs-keyword,.hljs-selector-tag,.hljs-type{color:#cf222e}
 .hljs-string,.hljs-attr{color:#0a3069} .hljs-number,.hljs-literal{color:#0550ae} .hljs-title{color:#6639ba}
</style></head><body><article class="md">${body}</article></body></html>`;
}

/** Render a markdown file to a sibling `*.html`. Returns the html path, or undefined on failure. */
export function renderMarkdownFile(absMdPath: string, title: string): string | undefined {
  try {
    const out = absMdPath.replace(/\.md$/i, ".html");
    writeFileAtomic(out, renderMarkdownHtml(fs.readFileSync(absMdPath, "utf8"), title));
    return out;
  } catch {
    return undefined;
  }
}

/** Render every `*.md` under a directory tree to a sibling `*.html` (best-effort). */
export function renderMarkdownTree(dirAbs: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dirAbs, e.name);
    if (e.isDirectory()) renderMarkdownTree(p);
    else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) renderMarkdownFile(p, e.name.replace(/\.md$/i, ""));
  }
}

/** Read + concatenate the canonical session jsonl files for the given session ids (from ~/.claude/projects/*). */
export function loadSessionsJsonl(sessionIds: string[], home: string = os.homedir()): string {
  const root = path.join(home, ".claude", "projects");
  let projects: string[];
  try {
    projects = fs.readdirSync(root).map((d) => path.join(root, d));
  } catch {
    return "";
  }
  const parts: string[] = [];
  for (const id of sessionIds) {
    for (const proj of projects) {
      const f = path.join(proj, `${id}.jsonl`);
      if (fs.existsSync(f)) {
        try {
          parts.push(fs.readFileSync(f, "utf8"));
        } catch {
          /* skip */
        }
        break;
      }
    }
  }
  return parts.join("\n");
}

/** Write `<name>.jsonl` (raw) + `<name>.html` (rendered) into destDir. Returns true if anything was written. */
export function writeTranscriptFiles(destDirAbs: string, name: string, jsonlText: string, title: string): boolean {
  if (!jsonlText.trim()) return false;
  try {
    mkdirp(destDirAbs);
    writeFileAtomic(path.join(destDirAbs, `${name}.jsonl`), jsonlText);
    writeFileAtomic(path.join(destDirAbs, `${name}.html`), renderTranscriptHtml(jsonlText, title));
    return true;
  } catch {
    return false;
  }
}
