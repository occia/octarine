import { describe, it, expect } from "vitest";
import { parseSanitizerStderr } from "../src/verifier/crash-parser";

const ASAN_HEAP_BOF = `=================================================================
==17==ERROR: AddressSanitizer: heap-buffer-overflow on address 0x602000000071 at pc 0x4f1b
READ of size 1 at 0x602000000071 thread T0
    #0 0x4f1b in parse_token /src/proj/parser.c:88:12
    #1 0x4a2c in run_parser /src/proj/parser.c:140:7
    #2 0x5d3e in LLVMFuzzerTestOneInput /work/harness-proj/fuzz-proj/parser_fuzzer.c:15:3
    #3 0x7f11 in fuzzer::Fuzzer::ExecuteCallback(unsigned char*, unsigned long) /src/libfuzzer/FuzzerLoop.cpp:611
    #4 0x1234 in __interceptor_malloc /src/llvm/compiler-rt/asan_malloc_linux.cpp:69
SUMMARY: AddressSanitizer: heap-buffer-overflow /src/proj/parser.c:88:12 in parse_token
`;

const UBSAN = `/src/proj/math.c:22:9: runtime error: signed integer overflow
    #0 0x55 in do_add /src/proj/math.c:22:9
    #1 0x66 in LLVMFuzzerTestOneInput /work/harness-proj/fuzz-proj/math_fuzzer.c:9:3
SUMMARY: UndefinedBehaviorSanitizer: undefined-behavior /src/proj/math.c:22:9 in do_add
`;

const LIBFUZZER_TIMEOUT = `==1==ERROR: libFuzzer: timeout after 30 seconds
    #0 0x99 in slow_loop /src/proj/loop.c:10:3
`;

describe("parseSanitizerStderr", () => {
  it("parses ASAN heap overflow and drops runtime noise", () => {
    const sig = parseSanitizerStderr(ASAN_HEAP_BOF)!;
    expect(sig.errorType).toBe("heap-buffer-overflow");
    // fuzzer:: and __interceptor frames are dropped; the harness/target frames remain.
    expect(sig.topFrames.map((f) => f.func)).toEqual(["parse_token", "run_parser", "LLVMFuzzerTestOneInput"]);
    expect(sig.topFrames[0]).toMatchObject({ file: "/src/proj/parser.c", line: 88 });
    expect(sig.rawSummary).toContain("SUMMARY");
  });

  it("classifies UBSan as undefined-behavior", () => {
    const sig = parseSanitizerStderr(UBSAN)!;
    expect(sig.errorType).toBe("undefined-behavior");
    expect(sig.topFrames[0].func).toBe("do_add");
  });

  it("classifies a libFuzzer timeout", () => {
    const sig = parseSanitizerStderr(LIBFUZZER_TIMEOUT)!;
    expect(sig.errorType).toBe("timeout");
    expect(sig.topFrames[0].func).toBe("slow_loop");
  });

  it("returns null for non-crash output", () => {
    expect(parseSanitizerStderr("Running 1 inputs 1 time(s) each.\nDone.\n")).toBeNull();
  });
});
