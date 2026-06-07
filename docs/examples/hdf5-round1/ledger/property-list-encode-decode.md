# Property list encode/decode  (property-list-encode-decode)

- status: done
- priority: 7
- harness: h5_plist_encode_decode_fuzzer
- attempts: 1

## APIs
- `H5Pencode2`
- `H5Pdecode`
- `H5Pget_filter2`
- `H5Pclose`

## Rationale
H5Pdecode parses a binary property-list blob. Property lists are used everywhere (creation, access, transfer); bugs in their parser affect every HDF5 operation.

## Last feedback
The harness correctly feeds raw fuzzer bytes to H5Pdecode (the primary parser), re-encodes successful decodes with H5Pencode2, iterates any filter pipeline with H5Pget_filter2, and closes with H5Pclose. The version byte is H5P_ENCODE_VERS=0 (trivially discoverable), and the type field is a small integer range — both easily handled by coverage-guided fuzzing. The log confirms the fuzzer DID get past these checks: coverage grew from 0 to 1951 edges, a corpus of 58 inputs was built, and 1054 crashes were triggered (real library bugs). The plateau is consistent with having explored the reachable decode/encode surface. All four target APIs are exercised on the data-dependent path.
