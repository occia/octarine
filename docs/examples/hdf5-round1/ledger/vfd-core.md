# Core (in-memory) VFD with backing-store open  (vfd-core)

- status: pending
- priority: 3
- harness: -
- attempts: 0

## APIs
- `H5Pset_fapl_core`
- `H5Fopen`
- `H5Fflush`
- `H5Fclose`

## Rationale
The core VFD can back to disk; opening a fuzzed file with it exercises a different I/O code path and buffer-management logic than the default sec2 driver.

## Last feedback
(none)
