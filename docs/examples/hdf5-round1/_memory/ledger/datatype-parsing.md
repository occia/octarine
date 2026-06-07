# Committed datatype open and introspection  (datatype-parsing)

- status: done
- priority: 9
- harness: h5_committed_type_fuzzer
- attempts: 3

## APIs
- `H5Topen2`
- `H5Tget_class`
- `H5Tget_size`
- `H5Tget_nmembers`
- `H5Tget_member_type`
- `H5Tget_member_offset`
- `H5Tis_variable_str`
- `H5Tclose`

## Rationale
Committed (named) datatypes are stored in the file and decoded on H5Topen2. Compound, enum, vlen, and array type descriptors are deeply nested and hand-parsed; historically a rich source of OOB/UAF bugs.

## Last feedback
The harness drives all 8 target APIs correctly. It loads the full fuzz input as an HDF5 file image (H5Pset_file_image + CORE VFD), tries both hardcoded candidate names and a dynamic root-group walk via H5Gget_objname_by_idx to call H5Topen2, then recursively calls H5Tget_class/H5Tget_size/H5Tis_variable_str and descends into compound members (H5Tget_nmembers, H5Tget_member_type, H5Tget_member_offset) and super-types for array/vlen. The fuzz log shows healthy coverage growth (edges 2905, features 3754, corpus 92) with new functions discovered well into the run and 3 crashes found, indicating genuine depth of exploration rather than an early plateau.
