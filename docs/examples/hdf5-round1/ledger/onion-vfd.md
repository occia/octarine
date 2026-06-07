# Onion (versioned) virtual file driver  (onion-vfd)

- status: pending
- priority: 5
- harness: -
- attempts: 0

## APIs
- `H5Pset_fapl_onion`
- `H5Fopen`
- `H5Fclose`

## Rationale
The Onion VFD has its own header, history, and index record formats parsed on open. These multi-format parsers are new (HDF5 1.13+) and lightly tested by fuzz infrastructure.

## Last feedback
(none)
