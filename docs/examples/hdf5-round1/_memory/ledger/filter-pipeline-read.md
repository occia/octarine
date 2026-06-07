# Compressed/filtered dataset read  (filter-pipeline-read)

- status: done
- priority: 8
- harness: h5_filter_read_fuzzer
- attempts: 1

## APIs
- `H5Dopen2`
- `H5Dget_create_plist`
- `H5Pget_nfilters`
- `H5Pget_filter2`
- `H5Dread`
- `H5Zfilter_avail`

## Rationale
Reading a dataset that has a deflate, shuffle, Fletcher32, or SZIP filter triggers the entire decompression path (zlib, internal codecs). Buffer sizing and chunk reassembly are classic overflow spots.

## Last feedback
The harness correctly drives all six target APIs in proper caller order without hardcoding or short-circuiting any inputs — the entire fuzzer-supplied buffer is used as the HDF5 file content. Buffer allocation honors documented API contracts (element count × type size, 64 MiB cap), so there are no harness-induced false-positive crashes. H5Ovisit3 ensures all datasets in the fuzz input are visited, maximizing the chance of hitting datasets with filter pipelines. Coverage grew steadily to 2305 edges / 2777 features in 5 minutes from a cold start against a complex binary format, and was still incrementing at run end — consistent with gradual structural exploration rather than a stuck harness. No structural barrier prevents the fuzzer from eventually reaching filter decompression paths (H5Z deflate/shuffle/Fletcher32) once valid-enough chunked+filtered dataset inputs are discovered.
