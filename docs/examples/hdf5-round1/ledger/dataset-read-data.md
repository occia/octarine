# Dataset data read with type/space inspection  (dataset-read-data)

- status: done
- priority: 10
- harness: h5_dread_fuzzer
- attempts: 1

## APIs
- `H5Dopen2`
- `H5Dread`
- `H5Dget_type`
- `H5Dget_space`
- `H5Dget_storage_size`
- `H5Dclose`

## Rationale
Existing harnesses only open datasets; no harness actually calls H5Dread to pull data through the type-conversion and filter pipeline. This is the richest attack surface for memory-safety bugs in decompression, type conversion, and fill-value logic.

## Last feedback
The harness drives all six target APIs in correct real-caller order: H5Dopen2 → H5Dget_type → H5Dget_storage_size → H5Dget_space → H5Dread → H5Dclose. The entire fuzzer input is used as the HDF5 file (no hardcoding), H5Ovisit3 enumerates all datasets, VL types are handled properly with H5Treclaim, and H5Tget_native_type exercises the type-conversion pipeline. Coverage grew steadily to 2299 edges / 2761 features / 41 corpus items before plateauing — a pattern consistent with the HDF5 format complexity limiting valid file generation rather than any harness shortcut. The harness thoroughly exercises the attack surface.
