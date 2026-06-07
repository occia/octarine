# High-level Lite API (H5LT)  (high-level-lite-api)

- status: done
- priority: 6
- harness: h5_hlt_fuzzer
- attempts: 1

## APIs
- `H5LTread_dataset`
- `H5LTget_dataset_info`
- `H5LTfind_dataset`
- `H5LTget_attribute_string`

## Rationale
The HL Lite API is a thin but heavily-used wrapper. It calls the core stack through a different code path and does its own size calculations; worth fuzzing independently to catch HL-specific bugs.

## Last feedback
The harness correctly sequences all four target APIs (H5LTread_dataset, H5LTget_dataset_info, H5LTfind_dataset, H5LTget_attribute_string) in contract-honoring order, with the fuzzer controlling the entire HDF5 file image as input. Dataset names are discovered dynamically from fuzz input via H5Literate2, and buffer sizes are properly derived from API return values. Coverage grew to 3023 edges/3925 features/97 corpus items and plateaued in a pattern consistent with thorough exploration. Many type-conversion paths are reached despite using H5T_NATIVE_INT as the read type, because the on-disk dataset type varies with the fuzz input. The minor gaps (10 hardcoded attribute names, non-recursive group iteration) do not block core API surface coverage.
