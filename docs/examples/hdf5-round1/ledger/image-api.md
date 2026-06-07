# High-level Image API (H5IM)  (image-api)

- status: done
- priority: 5
- harness: h5im_fuzzer
- attempts: 1

## APIs
- `H5IMread_image`
- `H5IMget_image_info`
- `H5IMis_image`

## Rationale
H5IM parses image-type datasets with specific attribute conventions. Malformed image metadata (palette, interlace mode) could bypass dimension checks.

## Last feedback
The harness correctly sequences H5IMis_image → H5IMget_image_info → H5IMread_image on every dataset in the root group of an HDF5 file whose bytes come entirely from the fuzzer. Both interlace modes (INTERLACE_PIXEL/INTERLACE_PLANE) are reachable via the on-disk attribute, buffer sizes are derived from queried dimensions, and palette sub-APIs are also exercised. Coverage grew steadily to 2788 edges / 3529 features / 101 corpus entries then plateaued, which is expected for a thin HL wrapper API — the fuzzer has exhausted the main branching paths in H5IM. The high OOM count (102) confirms large-image inputs are being generated and hitting internal size guards, not merely failing at file-open. No significant code path in the three target APIs is left structurally unreachable by this harness.
