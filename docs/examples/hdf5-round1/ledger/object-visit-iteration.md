# Object header visiting and iteration  (object-visit-iteration)

- status: done
- priority: 9
- harness: h5_obj_visit_fuzzer
- attempts: 1

## APIs
- `H5Oopen`
- `H5Oget_info3`
- `H5Ovisit3`
- `H5Oclose`
- `H5Literate2`
- `H5Lget_val`

## Rationale
H5Ovisit3 and H5Literate2 recursively traverse object headers and links. Soft/external link resolution and recursive group traversal stress the object-header parser across many diverse object types from a single fuzzed file.

## Last feedback
The harness drives all six target APIs (H5Oopen, H5Oget_info3, H5Ovisit3, H5Oclose, H5Literate2, H5Lget_val) the way a real caller would, feeding fuzzer-controlled bytes as the raw HDF5 file content. H5Literate2 is called with three distinct index/order combinations and H5Ovisit3 with two, covering the main traversal code paths. Both callbacks open child objects independently, exercising the object-header parser via different internal code paths. Coverage grew from ~2067 to 2305 edges with new functions still appearing at job 43-44, and the corpus reached 54 — consistent with genuine surface exploration rather than a shallow plateau. No major branch families of the target surface are left unreachable by the harness design.
