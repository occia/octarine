# Basic HDF5 file open (H5Fopen)  (file-open-basic)

- status: covered
- priority: 5
- harness: -
- attempts: 0

## APIs
- `H5Fopen`
- `H5Fclose`

## Rationale
h5_read_fuzzer exercises H5Fopen in RDWR mode; covers file superblock and basic metadata parsing.

## Last feedback
(none)
