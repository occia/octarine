/* Copyright 2024 Google LLC
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *       http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*
 * Fuzzing harness for the HDF5 dataspace encode/decode round-trip.
 *
 * Attack surface: H5Sdecode parses a serialised dataspace blob — used
 * internally when reading dataset chunks.  Feeding fuzz bytes to H5Sdecode
 * directly exercises the region/point-selection parser with no file-format
 * overhead.
 *
 * Strategy:
 *   1. Feed the raw fuzz input to H5Sdecode.
 *   2. On success, query all interesting properties of the decoded dataspace
 *      (extent type, rank, dims, selection type, npoints, bounds).
 *   3. Re-encode the decoded space with H5Sencode2 and decode the result a
 *      second time, verifying that the round-trip does not crash.
 *   4. Close every handle obtained.
 */

#include "hdf5.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

/* Silence HDF5 diagnostic output so fuzzer logs stay clean. */
static herr_t
null_error_handler(hid_t estack, void *client_data)
{
    (void)estack;
    (void)client_data;
    return 0;
}

int
LLVMFuzzerTestOneInput(const uint8_t *data, size_t size)
{
    /* A valid encoded dataspace is always more than a handful of bytes;
     * skip trivially short inputs early to improve throughput. */
    if (size < 8)
        return 0;

    /* Redirect all HDF5 error output to a no-op handler. */
    H5Eset_auto2(H5E_DEFAULT, null_error_handler, NULL);

    /* ------------------------------------------------------------------ */
    /* Step 1: attempt to decode the fuzz input as a dataspace blob.       */
    /* ------------------------------------------------------------------ */
    hid_t space_id = H5Sdecode(data);
    if (space_id == H5I_INVALID_HID)
        return 0;   /* invalid/unsupported encoding — not a bug */

    /* ------------------------------------------------------------------ */
    /* Step 2: query all interesting properties of the decoded dataspace.  */
    /* ------------------------------------------------------------------ */

    /* Is the space simple (regular N-D array extents)? */
    htri_t is_simple = H5Sis_simple(space_id);

    /* What is the extent class (SCALAR, SIMPLE, NULL, …)? */
    H5S_class_t extent_class = H5Sget_simple_extent_type(space_id);
    (void)extent_class;

    /* For simple dataspaces retrieve rank and dimensions. */
    if (is_simple > 0) {
        int rank = H5Sget_simple_extent_ndims(space_id);
        if (rank > 0 && rank <= H5S_MAX_RANK) {
            hsize_t dims[H5S_MAX_RANK];
            hsize_t maxdims[H5S_MAX_RANK];
            H5Sget_simple_extent_dims(space_id, dims, maxdims);
        }
    }

    /* Retrieve the active selection type (ALL, NONE, POINT, HYPERSLAB). */
    H5S_sel_type sel_type = H5Sget_select_type(space_id);

    /* Number of selected elements. */
    hssize_t npoints = H5Sget_select_npoints(space_id);
    (void)npoints;

    /* Bounding box of the selection (valid for POINT and HYPERSLAB). */
    if (sel_type == H5S_SEL_POINTS || sel_type == H5S_SEL_HYPERSLABS) {
        int rank2 = H5Sget_simple_extent_ndims(space_id);
        if (rank2 > 0 && rank2 <= H5S_MAX_RANK) {
            hsize_t start[H5S_MAX_RANK];
            hsize_t end[H5S_MAX_RANK];
            H5Sget_select_bounds(space_id, start, end);
        }
    }

    /* ------------------------------------------------------------------ */
    /* Step 3: round-trip — encode the decoded space, then decode again.   */
    /* ------------------------------------------------------------------ */
    size_t encode_size = 0;
    herr_t ret = H5Sencode2(space_id, NULL, &encode_size, H5P_DEFAULT);
    if (ret >= 0 && encode_size > 0 && encode_size <= (4 * 1024 * 1024)) {
        void *encode_buf = malloc(encode_size);
        if (encode_buf != NULL) {
            ret = H5Sencode2(space_id, encode_buf, &encode_size, H5P_DEFAULT);
            if (ret >= 0) {
                hid_t space2_id = H5Sdecode(encode_buf);
                if (space2_id != H5I_INVALID_HID) {
                    /* Verify the re-decoded space exposes the same API surface
                     * without crashing — we do not assert equality to avoid
                     * false positives from benign normalisation differences. */
                    H5Sis_simple(space2_id);
                    H5Sget_select_type(space2_id);
                    H5Sget_simple_extent_type(space2_id);
                    H5Sget_select_npoints(space2_id);
                    H5Sclose(space2_id);
                }
            }
            free(encode_buf);
        }
    }

    /* ------------------------------------------------------------------ */
    /* Step 4: release the original decoded dataspace.                     */
    /* ------------------------------------------------------------------ */
    H5Sclose(space_id);
    return 0;
}
