# Group open and link traversal  (group-link-iteration)

- status: done
- priority: 7
- harness: h5_group_link_fuzzer
- attempts: 1

## APIs
- `H5Gopen2`
- `H5Gget_info`
- `H5Giterate`
- `H5Lvisit2`
- `H5Lget_info2`
- `H5Gclose`

## Rationale
Group B-tree / fractal heap parsing and link table decoding happen on H5Gopen2 and H5Giterate. Dense vs. compact storage transitions and external-link targets are exercised here.

## Last feedback
The harness correctly drives all 6 specified APIs (H5Gopen2, H5Gget_info, H5Giterate, H5Lvisit2, H5Lget_info2, H5Gclose) on fuzzer-controlled bytes written to a temp file. It exercises both the legacy B-tree iteration path (H5Giterate) and the modern fractal-heap/v2-B-tree path (H5Lvisit2), with two index types (H5_INDEX_NAME, H5_INDEX_CRT_ORDER) and two orderings. H5Lget_info2 is called both by name (in the giterate callback for each link) and by index. Coverage grew steadily from ~2717 edges at 81s to 2788 edges at ~300s, reaching 3573 features and 94 corpus entries, with 6 OOM crashes — all consistent with real HDF5 group/link parsing bugs being triggered. The plateau in the final ~80s is natural for a short run. The only minor gap is the hardcoded sub-group name "group" for the non-root group open path, but all substantive group/link parsing code is exercised through the root group traversal. The surface is thoroughly reachable as written.
