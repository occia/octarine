# Asynchronous event-set API  (async-event-set)

- status: pending
- priority: 3
- harness: -
- attempts: 0

## APIs
- `H5EScreate`
- `H5ESinsert_request`
- `H5ESwait`
- `H5ESget_err_info`
- `H5ESclose`

## Rationale
The async event-set infrastructure is entirely new in HDF5 1.13 and has almost no existing fuzz coverage. Error-path handling across async completions could expose race or UAF bugs.

## Last feedback
(none)
