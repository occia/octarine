# High-level Table API (H5TB)  (table-api)

- status: pending
- priority: 5
- harness: -
- attempts: 0

## APIs
- `H5TBread_table`
- `H5TBread_records`
- `H5TBget_table_info`
- `H5TBget_field_info`

## Rationale
H5TB maps compound datasets to named columns. Field-offset and row-size arithmetic uses caller-supplied type sizes that could be fuzz-controlled.

## Last feedback
(none)
