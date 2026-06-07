# Attribute iteration and data read  (attribute-iteration-read)

- status: done
- priority: 8
- harness: h5_attr_iter_fuzzer
- attempts: 1

## APIs
- `H5Aiterate2`
- `H5Aopen_by_idx`
- `H5Aget_type`
- `H5Aget_space`
- `H5Aread`
- `H5Aclose`

## Rationale
Existing harness opens one hardcoded attribute name; no harness iterates all attributes or calls H5Aread to pull attribute data through the type/space layer, missing conversion and vlen-string bugs.

## Last feedback
The harness correctly drives all 6 target APIs: H5Aiterate2 (name-order iteration callback), H5Aopen_by_idx (creation-order with name-order fallback), H5Aget_type, H5Aget_space, H5Aread, and H5Aclose. The entire fuzzer input is fed as an HDF5 file without hardcoding or short-circuiting. Two distinct iteration code paths are exercised per object. H5Ovisit3 walks the full object hierarchy so attributes on groups, datasets, and named types are all reachable. Coverage grew steadily from 0 to 2755 edges / 3479 features with corpus reaching 91 entries; the plateau only appears near the end of the ~5-minute run, consistent with natural exhaustion rather than structural blockage. OOM events (not crashes) indicate the fuzzer is reaching deep parsing paths.
