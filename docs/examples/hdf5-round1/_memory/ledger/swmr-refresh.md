# SWMR dataset refresh  (swmr-refresh)

- status: pending
- priority: 4
- harness: -
- attempts: 0

## APIs
- `H5Fopen (H5F_ACC_RDONLY|H5F_ACC_SWMR_READ)`
- `H5Dopen2`
- `H5Drefresh`
- `H5Fstart_swmr_write`

## Rationale
SWMR mode has its own file-consistency checks and metadata refresh paths that differ from normal open; fuzz bytes in the SWMR superblock extension could trigger distinct parsing bugs.

## Last feedback
(none)
