# Attack-surface ledger — hdf5 · develop @ [`e124c36c55bf`](https://github.com/HDFGroup/hdf5/commit/e124c36c55bf69e9087352a91c77e62ad52f4306)  (content-id `af19d9043785`)

covered=2  pending=5  in_progress=0  done=11  failed=0

| id | status | prio | harness | title |
|---|---|---|---|---|
| dataset-read-data | done | 10 | h5_dread_fuzzer | Dataset data read with type/space inspection |
| datatype-parsing | done | 9 | h5_committed_type_fuzzer | Committed datatype open and introspection |
| object-visit-iteration | done | 9 | h5_obj_visit_fuzzer | Object header visiting and iteration |
| filter-pipeline-read | done | 8 | h5_filter_read_fuzzer | Compressed/filtered dataset read |
| attribute-iteration-read | done | 8 | h5_attr_iter_fuzzer | Attribute iteration and data read |
| group-link-iteration | done | 7 | h5_group_link_fuzzer | Group open and link traversal |
| dataspace-encode-decode | done | 7 | h5_dataspace_encode_decode_fuzzer | Dataspace encode/decode round-trip |
| property-list-encode-decode | done | 7 | h5_plist_encode_decode_fuzzer | Property list encode/decode |
| references | done | 6 | h5_ref_fuzzer | Object and region references |
| high-level-lite-api | done | 6 | h5_hlt_fuzzer | High-level Lite API (H5LT) |
| file-open-basic | covered | 5 | - | Basic HDF5 file open (H5Fopen) |
| dataset-attribute-open | covered | 5 | - | Dataset + attribute open |
| image-api | done | 5 | h5im_fuzzer | High-level Image API (H5IM) |
| table-api | pending | 5 | - | High-level Table API (H5TB) |
| onion-vfd | pending | 5 | - | Onion (versioned) virtual file driver |
| swmr-refresh | pending | 4 | - | SWMR dataset refresh |
| vfd-core | pending | 3 | - | Core (in-memory) VFD with backing-store open |
| async-event-set | pending | 3 | - | Asynchronous event-set API |
