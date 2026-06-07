# Dataspace encode/decode round-trip  (dataspace-encode-decode)

- status: done
- priority: 7
- harness: h5_dataspace_encode_decode_fuzzer
- attempts: 1

## APIs
- `H5Sget_select_type`
- `H5Sencode2`
- `H5Sdecode`
- `H5Sis_simple`
- `H5Sget_simple_extent_dims`
- `H5Sclose`

## Rationale
H5Sdecode parses a serialised dataspace blob — used internally when reading dataset chunks. Feeding fuzz bytes to H5Sdecode directly exercises the region/point-selection parser with no file-format overhead.

## Last feedback
[redacted — crash / sanitizer detail]
