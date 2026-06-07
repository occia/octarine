/**
 * Parse a sanitizer / libFuzzer crash log into a normalized CrashSignature used
 * for grouping. Frame attribution (harness vs target) is left to the LLM
 * analysis step; here we only drop obvious runtime/sanitizer noise so that two
 * reports of the same underlying crash produce the same signature.
 */

import { CrashFrame, CrashSignature } from "../types";

const FRAME_RE = /^\s*#(\d+)\s+0x[0-9a-fA-F]+\s+in\s+(.+?)\s*$/;

/** Runtime/sanitizer frames that carry no signal for grouping. */
function isNoiseFrame(func: string, file?: string): boolean {
  if (/^(__|_+Z?N?\d*__)?(asan|ubsan|lsan|tsan|msan|interceptor|sanitizer)/i.test(func)) return true;
  if (/^__(interceptor_|asan_|ubsan_|sanitizer_|lsan_)/.test(func)) return true;
  if (/^(fuzzer::|.*::Fuzzer::)/.test(func)) return true;
  if (/(^|\W)(malloc|calloc|realloc|free|operator new|operator delete)(\W|$)/.test(func)) return true;
  if (file && /(libfuzzer|FuzzerLoop|FuzzerDriver|compiler-rt|sanitizer_common)/i.test(file)) return true;
  if (func === "main" && file && /(FuzzerMain|libfuzzer)/i.test(file)) return true;
  return false;
}

function parseFrameRest(rest: string): CrashFrame {
  // "func /src/x.c:42:5"  (path excludes ':' so the line:col isn't swallowed)
  let m = rest.match(/^(.*\S)\s+([^\s():]+):(\d+)(?::\d+)?$/);
  if (m) return { func: m[1], file: m[2], line: parseInt(m[3], 10) };
  // "func (/out/bin+0x123)"
  m = rest.match(/^(.*\S)\s+\(([^)]+)\)$/);
  if (m) return { func: m[1], file: m[2] };
  return { func: rest };
}

function detectErrorType(stderr: string): { errorType: string; rawSummary?: string } | null {
  const summary = stderr.match(/SUMMARY:\s*\w+:\s*([a-zA-Z0-9_-]+)/);
  if (summary) {
    const line = stderr.match(/^.*SUMMARY:.*$/m)?.[0];
    return { errorType: summary[1].toLowerCase(), rawSummary: line };
  }
  let m = stderr.match(/ERROR:\s*AddressSanitizer:\s*([a-zA-Z0-9_-]+)/);
  if (m) return { errorType: m[1].toLowerCase() };
  if (/SEGV on unknown address/.test(stderr)) return { errorType: "segv" };
  if (/ERROR:\s*LeakSanitizer|detected memory leaks/.test(stderr)) return { errorType: "memory-leak" };
  m = stderr.match(/ERROR:\s*libFuzzer:\s*(timeout|out-of-memory|deadly signal)/);
  if (m) return { errorType: m[1].replace(/\s+/g, "-").toLowerCase() };
  if (/runtime error:/.test(stderr)) return { errorType: "undefined-behavior" };
  return null;
}

/** Returns null when the text is not a recognizable crash report. */
export function parseSanitizerStderr(stderr: string, maxFrames = 5): CrashSignature | null {
  const err = detectErrorType(stderr);
  const frames: CrashFrame[] = [];
  for (const raw of stderr.split("\n")) {
    const m = raw.match(FRAME_RE);
    if (!m) continue;
    const f = parseFrameRest(m[2]);
    if (isNoiseFrame(f.func, f.file)) continue;
    frames.push(f);
    if (frames.length >= maxFrames) break;
  }
  if (!err && frames.length === 0) return null;
  return {
    errorType: err?.errorType ?? "unknown",
    topFrames: frames,
    rawSummary: err?.rawSummary,
  };
}
