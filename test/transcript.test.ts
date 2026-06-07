import { describe, it, expect } from "vitest";
import { renderTranscriptHtml, renderMarkdownHtml } from "../src/transcript";

const rec = (o: Record<string, unknown>) => JSON.stringify(o);

const jsonl = [
  rec({ type: "user", uuid: "u1", timestamp: "2026-06-05T05:00:00.000Z", message: { role: "user", content: "Survey the **attack surface** of `demo`." } }),
  rec({
    type: "assistant",
    uuid: "a1",
    timestamp: "2026-06-05T05:00:05.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Let me read the source first." },
        { type: "text", text: "I'll write a harness.\n\n```c\nint LLVMFuzzerTestOneInput(const uint8_t*d,size_t n){return 0;}\n```" },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls /src", description: "list" } },
      ],
    },
  }),
  rec({ type: "user", uuid: "u2", timestamp: "2026-06-05T05:00:08.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "harness.c\nbuild.sh", is_error: false }] } }),
  // duplicate uuid (should be de-duped), and out-of-order timestamp (should sort before a1)
  rec({ type: "assistant", uuid: "a1", timestamp: "2026-06-05T05:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "dup" }] } }),
  rec({ type: "queue-operation", operation: "x" }),
];

describe("renderTranscriptHtml", () => {
  const html = renderTranscriptHtml(jsonl.join("\n"), "demo — survey");

  it("renders a self-contained chat page with no external requests", () => {
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("demo — survey");
    // no external network references (CDN/script src/link href to http)
    expect(/(src|href)\s*=\s*["']https?:\/\//i.test(html)).toBe(false);
    expect(html).not.toContain("<script");
  });

  it("renders user and assistant bubbles, thinking, tool_use, tool_result", () => {
    expect(html).toContain('class="turn user"');
    expect(html).toContain('class="turn assistant"');
    expect(html).toContain('class="thinking"');
    expect(html).toContain("💭 thinking");
    expect(html).toContain("🔧");
    expect(html).toContain("Bash");
    expect(html).toContain('class="result"');
    expect(html).toContain("harness.c");
  });

  it("applies markdown and syntax highlighting", () => {
    expect(html).toContain("<strong>attack surface</strong>"); // **bold** from user text
    expect(html).toContain("hljs language-c"); // fenced c code block highlighted
    expect(html).toContain("hljs-"); // at least one highlight span
  });

  it("keeps fenced crash dumps readable (block code resists the inline-code background)", () => {
    // The inline `.msg-text code` background must NOT win on block code, or crash dumps render
    // light-on-light (invisible). Assert the higher-specificity reset is present.
    expect(html).toContain(".msg-text pre code");
    expect(html).toMatch(/\.msg-text pre code[^}]*background:transparent/);
    expect(html).toMatch(/\.msg-text pre code[^}]*color:#e6edf3/);
  });

  it("preserves line breaks in multi-line text (breaks:true) so crash traces don't collapse", () => {
    const multi = renderTranscriptHtml(
      rec({ type: "user", uuid: "x", timestamp: "2026-06-05T05:00:00.000Z", message: { role: "user", content: "==1==ERROR: AddressSanitizer: heap-buffer-overflow\n    #0 0x1 in foo a.c:1\n    #1 0x2 in bar b.c:2" } }),
      "crash",
    );
    expect(multi).toContain("<br>");
  });

  it("a ===/--- line inside a fenced crash dump does not break the code block (Setext disabled)", () => {
    // The ASAN banner is a line of '='. As a Setext underline it would fold the opening ``` into a
    // heading and leak the trace out as prose. Disabled Setext keeps the whole dump fenced.
    const trace =
      "head:\n```\n=================================================================\n" +
      "==1==ERROR: AddressSanitizer: heap-buffer-overflow\n    #0 0x1 in foo a.c:1\nSUMMARY: ...\n```\nReturn ONLY the JSON.";
    const h = renderTranscriptHtml(
      rec({ type: "user", uuid: "z", timestamp: "2026-06-05T05:00:00.000Z", message: { role: "user", content: trace } }),
      "crash",
    );
    expect(/<pre>[\s\S]*AddressSanitizer[\s\S]*<\/pre>/.test(h)).toBe(true); // trace stays fenced
    expect(/<pre>[\s\S]*={20,}[\s\S]*<\/pre>/.test(h)).toBe(true); // banner stays fenced
    expect(/<pre>[\s\S]*Return ONLY the JSON[\s\S]*<\/pre>/.test(h)).toBe(false); // post-fence text is prose
    expect(/<h1[^>]*>[^<]*ERROR/.test(h)).toBe(false); // no spurious Setext heading
  });

  it("de-dupes by uuid and ignores non-conversation records", () => {
    expect(html).not.toContain(">dup<");
    expect(html).not.toContain("queue-operation");
    // 3 unique conversation turns
    expect((html.match(/class="turn /g) || []).length).toBe(3);
  });
});

describe("renderMarkdownHtml", () => {
  const md = "# Ledger\n\n| id | status |\n|---|---|\n| a | done |\n\nSee [details](a.md) and `code`.";
  const html = renderMarkdownHtml(md, "demo — ledger");

  it("renders markdown (table, heading) into a self-contained page", () => {
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<table>");
    expect(html).toContain("<td>done</td>");
    expect(html).toContain("<h1"); // heading rendered, not raw '#'
    expect(html).not.toContain("# Ledger");
    expect(/(src|href)\s*=\s*["']https?:\/\//i.test(html)).toBe(false);
  });

  it("rewrites intra-doc .md links to .html so the rendered set stays browsable", () => {
    expect(html).toContain('href="a.html"');
    expect(html).not.toContain('href="a.md"');
  });
});
