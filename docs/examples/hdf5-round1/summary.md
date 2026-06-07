# crs-oss-harness-gen-ts run report

- source: hdf5 · develop @ [`e124c36c55bf`](https://github.com/HDFGroup/hdf5/commit/e124c36c55bf69e9087352a91c77e62ad52f4306)  (content-id `af19d9043785`) — commit re-derived 2026-06-07 (upstream HEAD) — the original build used an unpinned shallow clone and did not record the exact commit
- language: c   sanitizer: address
- budget: perFuzzSec=300 maxWallTimeSec=43200 maxSurfaceAttempts=5
- elapsed: 586.7 min
- surfaces: 18 (done=11 pending=5 failed=0 covered=2)
- harnesses submitted: 11

## Surfaces
| id | status | harness | attempts | title |
|---|---|---|---|---|
| file-open-basic | covered | - | 0 | Basic HDF5 file open (H5Fopen) |
| dataset-attribute-open | covered | - | 0 | Dataset + attribute open |
| dataset-read-data | done | h5_dread_fuzzer | 1 | Dataset data read with type/space inspection |
| datatype-parsing | done | h5_committed_type_fuzzer | 3 | Committed datatype open and introspection |
| object-visit-iteration | done | h5_obj_visit_fuzzer | 1 | Object header visiting and iteration |
| filter-pipeline-read | done | h5_filter_read_fuzzer | 1 | Compressed/filtered dataset read |
| attribute-iteration-read | done | h5_attr_iter_fuzzer | 1 | Attribute iteration and data read |
| group-link-iteration | done | h5_group_link_fuzzer | 1 | Group open and link traversal |
| dataspace-encode-decode | done | h5_dataspace_encode_decode_fuzzer | 1 | Dataspace encode/decode round-trip |
| property-list-encode-decode | done | h5_plist_encode_decode_fuzzer | 1 | Property list encode/decode |
| references | done | h5_ref_fuzzer | 1 | Object and region references |
| high-level-lite-api | done | h5_hlt_fuzzer | 1 | High-level Lite API (H5LT) |
| image-api | done | h5im_fuzzer | 1 | High-level Image API (H5IM) |
| table-api | pending | - | 0 | High-level Table API (H5TB) |
| onion-vfd | pending | - | 0 | Onion (versioned) virtual file driver |
| swmr-refresh | pending | - | 0 | SWMR dataset refresh |
| vfd-core | pending | - | 0 | Core (in-memory) VFD with backing-store open |
| async-event-set | pending | - | 0 | Asynchronous event-set API |

## Layout
- run.jsonl                          full orchestrator timeline
- state.json                         final RunState
- ledger/                            attack-surface ledger md set
- surface-<id>/attempt-<n>/          generation.log, build-resp/, verdict.json, assessment.json
- surface-<id>/attempt-<n>/harness-<name>/   fuzz.log, coverage.json, crashes/, crash-*.trace
