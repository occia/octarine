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
 * Fuzzing harness for HDF5 attribute iteration and data read:
 *   H5Aiterate2, H5Aopen_by_idx, H5Aget_type, H5Aget_space,
 *   H5Aread, H5Aclose
 *
 * Strategy:
 *   1. Open the fuzz input as an HDF5 file (read-only).
 *   2. Use H5Ovisit3 to walk every object (group, dataset, named type).
 *   3. For each object with attributes, exercise two code paths:
 *        a. H5Aiterate2 (name order) → H5Aopen → read
 *        b. H5Aopen_by_idx loop (creation-order fallback to name-order) → read
 *   4. For each open attribute: H5Aget_type, H5Aget_space, H5Aread,
 *      then H5Treclaim to release any VLen-managed heap memory.
 */

#include "hdf5.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <stdio.h>

/* Safety caps to avoid OOM / excessive CPU in the fuzzer */
#define MAX_ATTRS_PER_OBJ  64u
#define MAX_NPOINTS        4096
#define MAX_TOTAL_BYTES    (32u * 1024u * 1024u)   /* 32 MB read buffer cap */

/* --------------------------------------------------------------------------
 * read_attribute_data: opens the type/space, allocates a buffer, calls
 * H5Aread, reclaims VLen memory, then frees the buffer.
 * -------------------------------------------------------------------------- */
static void read_attribute_data(hid_t attr_id)
{
    hid_t ftype = H5Aget_type(attr_id);
    if (ftype < 0)
        return;

    hid_t space = H5Aget_space(attr_id);
    if (space < 0) {
        H5Tclose(ftype);
        return;
    }

    /* Determine element count from dataspace class */
    H5S_class_t sc = H5Sget_simple_extent_type(space);
    hssize_t npoints = 0;
    if (sc == H5S_SCALAR) {
        npoints = 1;
    } else if (sc == H5S_SIMPLE) {
        npoints = H5Sget_simple_extent_npoints(space);
        if (npoints < 0)
            npoints = 0;
    }
    /* H5S_NULL dataspace: npoints = 0, skip read */

    if (npoints > 0 && npoints <= MAX_NPOINTS) {
        /* H5Tget_size returns the in-memory element size:
         *   - VLen arrays (H5T_VLEN): sizeof(hvl_t)
         *   - VLen strings (H5T_STRING + is_variable): sizeof(char *)
         *   - Fixed types: actual byte size
         */
        size_t elem_size = H5Tget_size(ftype);
        if (elem_size > 0) {
            size_t total = (size_t)npoints * elem_size;
            /* Guard against overflow and enforce total cap */
            if (total / elem_size == (size_t)npoints &&
                total <= MAX_TOTAL_BYTES) {
                void *buf = calloc((size_t)npoints, elem_size);
                if (buf) {
                    if (H5Aread(attr_id, ftype, buf) >= 0) {
                        /*
                         * H5Treclaim walks the buffer and frees any
                         * heap memory allocated by HDF5 for VLen types
                         * (H5T_VLEN and variable-length strings).
                         * It is a no-op for fixed-size types.
                         */
                        H5Treclaim(ftype, space, H5P_DEFAULT, buf);
                    }
                    free(buf);
                }
            }
        }
    }

    H5Sclose(space);
    H5Tclose(ftype);
}

/* --------------------------------------------------------------------------
 * attr_iterate_cb: H5Aiterate2 callback.
 * Opens the attribute by name (as supplied by the iterator) and reads it.
 * -------------------------------------------------------------------------- */
static herr_t attr_iterate_cb(hid_t loc_id, const char *attr_name,
                               const H5A_info_t *ainfo, void *op_data)
{
    (void)ainfo;
    (void)op_data;

    hid_t attr_id = H5Aopen(loc_id, attr_name, H5P_DEFAULT);
    if (attr_id >= 0) {
        read_attribute_data(attr_id);
        H5Aclose(attr_id);
    }
    return 0; /* 0 = continue iteration */
}

/* --------------------------------------------------------------------------
 * obj_visit_cb: H5Ovisit3 callback, called for every object in the file.
 * -------------------------------------------------------------------------- */
static herr_t obj_visit_cb(hid_t obj_id, const char *name,
                            const H5O_info2_t *info, void *op_data)
{
    (void)name;
    (void)op_data;

    hsize_t num_attrs = info->num_attrs;
    if (num_attrs == 0)
        return 0;

    /* --- Code path A: H5Aiterate2 (discovers names, opens by name) --- */
    hsize_t iter_idx = 0;
    H5Aiterate2(obj_id, H5_INDEX_NAME, H5_ITER_INC, &iter_idx,
                 attr_iterate_cb, NULL);

    /* --- Code path B: H5Aopen_by_idx loop --- */
    hsize_t cap = num_attrs < MAX_ATTRS_PER_OBJ ? num_attrs : MAX_ATTRS_PER_OBJ;
    for (hsize_t i = 0; i < cap; i++) {
        /* Try creation-order index first (exercises that code path);
         * fall back to name index if creation order is not tracked. */
        hid_t attr_id = H5Aopen_by_idx(obj_id, ".",
                                        H5_INDEX_CRT_ORDER, H5_ITER_INC,
                                        i, H5P_DEFAULT, H5P_DEFAULT);
        if (attr_id < 0) {
            attr_id = H5Aopen_by_idx(obj_id, ".",
                                      H5_INDEX_NAME, H5_ITER_INC,
                                      i, H5P_DEFAULT, H5P_DEFAULT);
        }
        if (attr_id >= 0) {
            read_attribute_data(attr_id);
            H5Aclose(attr_id);
        }
    }

    return 0;
}

/* --------------------------------------------------------------------------
 * LLVMFuzzerTestOneInput
 * -------------------------------------------------------------------------- */
int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size)
{
    char filename[256];
    snprintf(filename, sizeof(filename), "/tmp/h5_attr_fuzz_%d", getpid());

    FILE *fp = fopen(filename, "wb");
    if (!fp)
        return 0;
    fwrite(data, size, 1, fp);
    fclose(fp);

    /* Silence HDF5 error output; fuzzer-induced errors are expected. */
    H5Eset_auto2(H5E_DEFAULT, NULL, NULL);

    hid_t file_id = H5Fopen(filename, H5F_ACC_RDONLY, H5P_DEFAULT);
    if (file_id >= 0) {
        H5Ovisit3(file_id, H5_INDEX_NAME, H5_ITER_INC,
                  obj_visit_cb, NULL,
                  H5O_INFO_BASIC | H5O_INFO_NUM_ATTRS);
        H5Fclose(file_id);
    }

    unlink(filename);
    return 0;
}
