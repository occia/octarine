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
 * Fuzzer for the HDF5 High-Level Image API (H5IM).
 *
 * Exercises H5IMis_image, H5IMget_image_info, H5IMread_image,
 * H5IMget_npalettes, H5IMget_palette_info, and H5IMget_palette the
 * way a real caller would: query dimensions first, allocate correctly-
 * sized buffers, then read.
 */

#include "hdf5.h"
#include "hdf5_hl.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* Hard caps to avoid OOM in the fuzzer process */
#define MAX_IMAGE_BYTES  (4u * 1024u * 1024u)   /* 4 MB */
#define MAX_PAL_ENTRIES  4096u                   /* entries × channels */
#define MAX_PALETTES     8

/*
 * visit_link – H5Literate2 callback.
 *
 * For every direct link in the root group, attempt to use the dataset as
 * an HDF5 image by calling the full H5IM read/query sequence.
 */
static herr_t
visit_link(hid_t loc_id, const char *name, const H5L_info2_t *info, void *op_data)
{
    (void)info;
    (void)op_data;

    /* ------------------------------------------------------------------
     * H5IMis_image: only proceed if the dataset is tagged as an image.
     * ------------------------------------------------------------------ */
    htri_t is_img = H5IMis_image(loc_id, name);
    if (is_img <= 0)
        return 0; /* not an image or error – keep iterating */

    /* ------------------------------------------------------------------
     * H5IMget_image_info: obtain dimensions, interlace, palette count.
     *
     * The interlace buffer is written by H5Aread inside the library with
     * the on-disk attribute type's size; use a heap allocation of 1 KB so
     * that a malformed (oversized) INTERLACE_MODE attribute triggers a
     * library-side overflow rather than corrupting the harness stack.
     * This matches the "large-enough buffer" contract expected of callers.
     * ------------------------------------------------------------------ */
    hsize_t  width     = 0;
    hsize_t  height    = 0;
    hsize_t  planes    = 0;
    hssize_t npals     = 0;
    char    *interlace = (char *)calloc(1, 1024);
    if (!interlace)
        return 0;

    herr_t rc = H5IMget_image_info(loc_id, name,
                                   &width, &height, &planes,
                                   interlace, &npals);
    free(interlace);

    if (rc < 0)
        return 0;

    /* ------------------------------------------------------------------
     * H5IMread_image: allocate a correctly-sized pixel buffer.
     *
     * For 8-bit images, planes == 1.  For 24-bit images, planes == 3.
     * Clamp to MAX_IMAGE_BYTES to keep the fuzzer process alive.
     * ------------------------------------------------------------------ */
    if (width > 0 && height > 0 && planes > 0) {
        /* cap planes (spec says 3 for true-colour; be generous) */
        hsize_t np = (planes > 16) ? 16 : planes;

        /* overflow-safe size computation */
        hsize_t row_bytes = width * np;
        if (width != 0 && row_bytes / width == np) { /* no overflow */
            hsize_t total = height * row_bytes;
            if (height == 0 || total / height == row_bytes) { /* no overflow */
                if (total > 0 && total <= MAX_IMAGE_BYTES) {
                    unsigned char *img_buf = (unsigned char *)malloc((size_t)total);
                    if (img_buf) {
                        H5IMread_image(loc_id, name, img_buf);
                        free(img_buf);
                    }
                }
            }
        }
    }

    /* ------------------------------------------------------------------
     * Palette queries: H5IMget_palette_info + H5IMget_palette.
     * ------------------------------------------------------------------ */
    if (npals <= 0)
        return 0;
    if (npals > MAX_PALETTES)
        npals = MAX_PALETTES;

    for (hssize_t p = 0; p < npals; p++) {
        hsize_t pal_dims[2] = {0, 0};
        if (H5IMget_palette_info(loc_id, name, (int)p, pal_dims) < 0)
            continue;

        /* pal_dims[0] = number of entries, pal_dims[1] = components (e.g. 3) */
        hsize_t pal_total = pal_dims[0] * pal_dims[1];
        if (pal_dims[0] == 0 || pal_dims[1] == 0)
            continue;
        /* overflow check */
        if (pal_dims[1] != 0 && pal_total / pal_dims[1] != pal_dims[0])
            continue;
        if (pal_total == 0 || pal_total > MAX_PAL_ENTRIES)
            continue;

        unsigned char *pal_buf = (unsigned char *)malloc((size_t)pal_total);
        if (pal_buf) {
            H5IMget_palette(loc_id, name, (int)p, pal_buf);
            free(pal_buf);
        }
    }

    return 0;
}

int
LLVMFuzzerTestOneInput(const uint8_t *data, size_t size)
{
    if (size < 8)
        return 0;

    /* Write fuzz bytes to a temp file */
    char filename[256];
    snprintf(filename, sizeof(filename), "/tmp/h5im_fuzzer_%d", getpid());

    FILE *fp = fopen(filename, "wb");
    if (!fp)
        return 0;
    fwrite(data, size, 1, fp);
    fclose(fp);

    /* Silence HDF5 error output */
    H5Eset_auto2(H5E_DEFAULT, NULL, NULL);

    hid_t fid = H5Fopen(filename, H5F_ACC_RDONLY, H5P_DEFAULT);
    if (fid == H5I_INVALID_HID) {
        unlink(filename);
        return 0;
    }

    /* Iterate all direct links in the root group */
    H5Literate2(fid, H5_INDEX_NAME, H5_ITER_INC, NULL, visit_link, NULL);

    H5Fclose(fid);
    unlink(filename);
    return 0;
}
