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
 *
 * Fuzzer for the compressed/filtered dataset read path:
 *   H5Dopen2 -> H5Dget_create_plist -> H5Pget_nfilters -> H5Pget_filter2 ->
 *   H5Zfilter_avail -> H5Dread
 *
 * The harness iterates every dataset in the fuzz-supplied HDF5 file, queries
 * the filter pipeline (deflate, shuffle, Fletcher32, SZIP, …), then reads the
 * full dataset through the decompression/filter path.  Buffer sizing honours
 * the dataset dimensions and element type so the harness itself never causes
 * an out-of-bounds access.
 */

#include "hdf5.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <stdio.h>

/* Hard cap on bytes allocated for a single H5Dread call (64 MiB). */
#define MAX_READ_BYTES (64u * 1024u * 1024u)

/* Maximum number of filter parameters we query per filter. */
#define MAX_CD_NELMTS 32

/* State passed through the H5Ovisit3 callback. */
typedef struct {
    hid_t file_id;
} visit_ctx_t;

/*
 * query_and_read_dataset
 *
 * Called for every dataset found by H5Ovisit3.  Opens the dataset, walks its
 * filter pipeline to exercise H5Pget_filter2 / H5Zfilter_avail, then reads
 * the entire dataset through H5Dread to trigger the decompression path.
 */
static void query_and_read_dataset(hid_t file_id, const char *name)
{
    hid_t dset_id  = H5I_INVALID_HID;
    hid_t dcpl_id  = H5I_INVALID_HID;
    hid_t space_id = H5I_INVALID_HID;
    hid_t type_id  = H5I_INVALID_HID;
    void *buf      = NULL;

    dset_id = H5Dopen2(file_id, name, H5P_DEFAULT);
    if (dset_id < 0)
        goto cleanup;

    /* ---- Filter pipeline inspection ---------------------------------- */
    dcpl_id = H5Dget_create_plist(dset_id);
    if (dcpl_id >= 0) {
        int nfilters = H5Pget_nfilters(dcpl_id);
        for (int i = 0; i < nfilters && i < 32; i++) {
            unsigned int  flags      = 0;
            size_t        cd_nelmts  = MAX_CD_NELMTS;
            unsigned int  cd_vals[MAX_CD_NELMTS];
            char          filter_name[256];
            unsigned int  filter_cfg = 0;

            H5Z_filter_t fid = H5Pget_filter2(
                dcpl_id, (unsigned)i,
                &flags, &cd_nelmts,
                cd_vals, sizeof(filter_name), filter_name,
                &filter_cfg);

            if (fid >= 0) {
                /* Exercises the filter registry lookup path. */
                H5Zfilter_avail(fid);
            }
        }
    }

    /* ---- Determine read-buffer dimensions ----------------------------- */
    space_id = H5Dget_space(dset_id);
    if (space_id < 0)
        goto cleanup;

    /* For NULL / scalar dataspaces npoints == 1 is fine; for H5S_NULL it
     * returns 0, which we skip below.                                      */
    hssize_t npoints = H5Sget_simple_extent_npoints(space_id);
    if (npoints <= 0)
        goto cleanup;

    type_id = H5Dget_type(dset_id);
    if (type_id < 0)
        goto cleanup;

    size_t type_size = H5Tget_size(type_id);
    if (type_size == 0)
        goto cleanup;

    /* Guard against multiplication overflow before the cap check. */
    if ((size_t)npoints > MAX_READ_BYTES / type_size)
        goto cleanup;

    size_t total_bytes = (size_t)npoints * type_size;
    if (total_bytes == 0 || total_bytes > MAX_READ_BYTES)
        goto cleanup;

    buf = malloc(total_bytes);
    if (!buf)
        goto cleanup;

    /*
     * H5Dread with:
     *   mem_type_id  = same as file type  (no conversion, raw decompressed bytes)
     *   mem_space_id = H5S_ALL            (select all elements in memory)
     *   file_space_id= H5S_ALL            (read all elements from file)
     *   dxpl_id      = H5P_DEFAULT
     *
     * This drives the full chunk-read → filter → reassembly path for every
     * layout (compact, contiguous, chunked) and every codec registered in the
     * filter pipeline (deflate, shuffle, Fletcher32, SZIP, …).
     */
    H5Dread(dset_id, type_id, H5S_ALL, H5S_ALL, H5P_DEFAULT, buf);

cleanup:
    free(buf);
    if (type_id  >= 0) H5Tclose(type_id);
    if (space_id >= 0) H5Sclose(space_id);
    if (dcpl_id  >= 0) H5Pclose(dcpl_id);
    if (dset_id  >= 0) H5Dclose(dset_id);
}

/* H5Ovisit3 callback: invoked for every object reachable from the root. */
static herr_t object_visitor(hid_t       obj,
                              const char *name,
                              const H5O_info2_t *info,
                              void       *op_data)
{
    (void)obj; /* unused — we use file_id from ctx */
    if (info->type != H5O_TYPE_DATASET)
        return 0;

    visit_ctx_t *ctx = (visit_ctx_t *)op_data;
    query_and_read_dataset(ctx->file_id, name);
    return 0; /* continue visiting */
}

/* ---- Entry point -------------------------------------------------------- */
int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size)
{
    if (size < 8) /* HDF5 superblock is at least 8 bytes */
        return 0;

    /* Write fuzz data to a temp file. */
    char filename[256];
    snprintf(filename, sizeof(filename),
             "/tmp/h5filt_fuzzer_%d.h5", getpid());

    FILE *fp = fopen(filename, "wb");
    if (!fp)
        return 0;
    fwrite(data, size, 1, fp);
    fclose(fp);

    /* Silence the HDF5 error stack so noise is not printed. */
    H5Eset_auto2(H5E_DEFAULT, NULL, NULL);

    hid_t file_id = H5Fopen(filename, H5F_ACC_RDONLY, H5P_DEFAULT);
    if (file_id >= 0) {
        visit_ctx_t ctx = { file_id };
        H5Ovisit3(file_id,
                  H5_INDEX_NAME,
                  H5_ITER_NATIVE,
                  object_visitor,
                  &ctx,
                  H5O_INFO_BASIC);
        H5Fclose(file_id);
    }

    unlink(filename);
    return 0;
}
