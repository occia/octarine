# Dataset + attribute open  (dataset-attribute-open)

- status: covered
- priority: 5
- harness: -
- attempts: 0

## APIs
- `H5Fopen`
- `H5Dopen2`
- `H5Aopen_name`
- `H5Aclose`
- `H5Dclose`
- `H5Fclose`

## Rationale
h5_extended_fuzzer opens a dataset by hardcoded name and reads an attribute from it.

## Last feedback
(none)
