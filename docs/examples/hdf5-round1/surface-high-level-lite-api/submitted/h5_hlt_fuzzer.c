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
 * Fuzzing harness for the HDF5 High-Level Lite API (H5LT):
 *   H5LTfind_dataset, H5LTget_dataset_ndims, H5LTget_dataset_info,
 *   H5LTread_dataset, H5LTget_attribute_info, H5LTget_attribute_string,
 *   H5LTfind_attribute.
 *
 * Strategy:
 *   1. Open fuzz input as an in-memory HDF5 file image (H5LTopen_file_image,
 *      read-only) — exercises the HL image-open code path.
 *   2. Iterate the root group to discover actual dataset names inside the
 *      (potentially malformed) file.
 *   3. Also probe a small set of hard-coded names to exercise the "not found"
 *      paths.
 *   4. For every candidate name, call the four target APIs in the sequence a
 *      real caller would use:
 *       a. H5LTfind_dataset
 *       b. H5LTget_dataset_ndims  (guards the rank value)
 *       c. H5LTget_dataset_info   (obtains dims + type_size)
 *       d. H5LTread_dataset       (with a correctly-sized harness buffer)
 *       e. H5LTfind_attribute     (for a set of known attribute names)
 *       f. H5LTget_attribute_info (before any read, to size the buffer)
 *       g. H5LTget_attribute_string (with the sized buffer)
 */

#include "hdf5.h"
#include "hdf5_hl.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

/* -------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------- */

/* Maximum HDF5 rank (library limit is 32). */
#define MAX_RANK  32

/* Maximum bytes we are willing to allocate for a single dataset read.     */
#define MAX_READ_BYTES  (4 * 1024 * 1024)   /* 4 MiB */

/* Maximum bytes for an attribute string buffer. */
#define MAX_ATTR_BYTES  (64 * 1024)         /* 64 KiB */

/* Maximum number of dataset names we collect from the file. */
#define MAX_DSETS  8

/* Maximum length of a dataset or attribute name we store. */
#define MAX_NAME   128

/* -------------------------------------------------------------------------
 * Known attribute names to probe on every dataset/group.
 * ---------------------------------------------------------------------- */
static const char * const KNOWN_ATTR_NAMES[] = {
    "CLASS", "TITLE", "units", "description", "attr", "label",
    "version", "scale", "offset", "long_name"
};
#define N_KNOWN_ATTRS  (sizeof(KNOWN_ATTR_NAMES) / sizeof(KNOWN_ATTR_NAMES[0]))

/* -------------------------------------------------------------------------
 * Hard-coded dataset names to probe (exercising "not found" paths).
 * ---------------------------------------------------------------------- */
static const char * const FIXED_DSET_NAMES[] = {
    "dataset", "data", "dset1", "x", "y", "z", "signal", "values"
};
#define N_FIXED_NAMES  (sizeof(FIXED_DSET_NAMES) / sizeof(FIXED_DSET_NAMES[0]))

/* -------------------------------------------------------------------------
 * Collected dataset names.
 * ---------------------------------------------------------------------- */
typedef struct {
    char names[MAX_DSETS][MAX_NAME];
    int  count;
} found_dsets_t;

/* H5Literate2 callback — collect up to MAX_DSETS dataset names. */
static herr_t
collect_datasets(hid_t loc_id, const char *name,
                 const H5L_info2_t *linfo, void *op_data)
{
    found_dsets_t *fd = (found_dsets_t *)op_data;
    H5O_info2_t    oinfo;

    (void)linfo;

    if (fd->count >= MAX_DSETS)
        return 1; /* short-circuit */

    H5E_BEGIN_TRY {
        if (H5Oget_info_by_name3(loc_id, name, &oinfo,
                                 H5O_INFO_BASIC, H5P_DEFAULT) >= 0) {
            if (oinfo.type == H5O_TYPE_DATASET) {
                strncpy(fd->names[fd->count], name, MAX_NAME - 1);
                fd->names[fd->count][MAX_NAME - 1] = '\0';
                fd->count++;
            }
        }
    } H5E_END_TRY

    return 0; /* keep iterating */
}

/* -------------------------------------------------------------------------
 * Exercise H5LTget_attribute_info + H5LTget_attribute_string on one
 * (obj_name, attr_name) pair inside the already-open file.
 * ---------------------------------------------------------------------- */
static void
probe_attribute_string(hid_t file_id,
                       const char *obj_name,
                       const char *attr_name)
{
    /* Check existence first. */
    herr_t found;
    H5E_BEGIN_TRY {
        found = H5LTfind_attribute(file_id, attr_name);
    } H5E_END_TRY
    /* found may be 0 (not found), 1 (found), or <0 (error) — all OK. */
    (void)found;

    /* Query info to size the read buffer correctly. */
    hsize_t     adims[MAX_RANK] = {0};
    H5T_class_t atype_class     = H5T_NO_CLASS;
    size_t      atype_size      = 0;
    herr_t      ainfo;

    H5E_BEGIN_TRY {
        ainfo = H5LTget_attribute_info(file_id, obj_name, attr_name,
                                       adims, &atype_class, &atype_size);
    } H5E_END_TRY

    if (ainfo < 0 || atype_size == 0 || atype_size > MAX_ATTR_BYTES)
        return;

    /* Only proceed for string-class attributes (the specific target API). */
    if (atype_class != H5T_STRING)
        return;

    /* Allocate a buffer large enough for the string (+ NUL guard byte). */
    char *abuf = (char *)calloc(1, atype_size + 1);
    if (!abuf)
        return;

    H5E_BEGIN_TRY {
        H5LTget_attribute_string(file_id, obj_name, attr_name, abuf);
    } H5E_END_TRY

    free(abuf);
}

/* -------------------------------------------------------------------------
 * Exercise H5LT dataset functions on one candidate name.
 * ---------------------------------------------------------------------- */
static void
probe_dataset(hid_t file_id, const char *dset_name)
{
    /* 1. H5LTfind_dataset */
    H5E_BEGIN_TRY {
        H5LTfind_dataset(file_id, dset_name);
    } H5E_END_TRY

    /* 2. H5LTget_dataset_ndims */
    int rank = -1;
    H5E_BEGIN_TRY {
        H5LTget_dataset_ndims(file_id, dset_name, &rank);
    } H5E_END_TRY

    /* Guard: skip if rank is not sane. */
    if (rank < 0 || rank > MAX_RANK)
        return;

    /* 3. H5LTget_dataset_info */
    hsize_t     dims[MAX_RANK] = {0};
    H5T_class_t type_class     = H5T_NO_CLASS;
    size_t      type_size      = 0;
    herr_t      info_ret;

    H5E_BEGIN_TRY {
        info_ret = H5LTget_dataset_info(file_id, dset_name,
                                        dims, &type_class, &type_size);
    } H5E_END_TRY

    /* 4. H5LTread_dataset — only if the dataset info looks sane. */
    if (info_ret >= 0 && type_size > 0) {
        /*
         * Compute total element count, guarding against overflow and
         * excessively large allocations.
         *
         * We read into a native-int buffer (H5T_NATIVE_INT), so the
         * harness buffer size is total_elements * sizeof(int).  HDF5
         * will perform type conversion internally.
         *
         * Scalar datasets have rank 0; treat them as 1 element.
         */
        hsize_t total_elements = 1;
        int     overflow       = 0;

        for (int d = 0; d < rank; d++) {
            if (dims[d] == 0) {
                total_elements = 0;
                break;
            }
            /* Overflow guard: total_elements * dims[d] <= MAX_READ_BYTES */
            if (total_elements > (hsize_t)(MAX_READ_BYTES / sizeof(int) / (dims[d] ? dims[d] : 1))) {
                overflow = 1;
                break;
            }
            total_elements *= dims[d];
        }

        if (!overflow && total_elements > 0) {
            size_t buf_bytes = (size_t)total_elements * sizeof(int);
            if (buf_bytes <= MAX_READ_BYTES) {
                void *buf = calloc(1, buf_bytes);
                if (buf) {
                    H5E_BEGIN_TRY {
                        H5LTread_dataset(file_id, dset_name,
                                         H5T_NATIVE_INT, buf);
                    } H5E_END_TRY
                    free(buf);
                }
            }
        }
    }

    /* 5. Probe known attribute names on this dataset. */
    for (size_t a = 0; a < N_KNOWN_ATTRS; a++)
        probe_attribute_string(file_id, dset_name, KNOWN_ATTR_NAMES[a]);
}

/* -------------------------------------------------------------------------
 * Fuzzer entry point
 * ---------------------------------------------------------------------- */
int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size)
{
    if (size < 8)
        return 0;

    /* Suppress HDF5 diagnostic output during fuzzing. */
    H5Eset_auto2(H5E_DEFAULT, NULL, NULL);

    /*
     * Open the fuzz input as a read-only in-memory HDF5 file image.
     * flags=0 → read-only, HDF5 copies the buffer internally.
     */
    hid_t file_id;
    H5E_BEGIN_TRY {
        file_id = H5LTopen_file_image((void *)(uintptr_t)data, size, 0);
    } H5E_END_TRY

    if (file_id < 0)
        return 0;

    /* Collect actual dataset names from the root group. */
    found_dsets_t fd;
    memset(&fd, 0, sizeof(fd));
    H5E_BEGIN_TRY {
        H5Literate2(file_id, H5_INDEX_NAME, H5_ITER_INC,
                    NULL, collect_datasets, &fd);
    } H5E_END_TRY

    /*
     * Build the full probe list: discovered names first, then the fixed
     * hard-coded names (deduplicating to avoid redundant calls).
     */
    char all_names[MAX_DSETS + N_FIXED_NAMES][MAX_NAME];
    int  all_count = 0;

    /* Copy discovered names. */
    for (int i = 0; i < fd.count; i++) {
        strncpy(all_names[all_count], fd.names[i], MAX_NAME - 1);
        all_names[all_count][MAX_NAME - 1] = '\0';
        all_count++;
    }

    /* Append fixed names if not already present. */
    for (size_t fi = 0; fi < N_FIXED_NAMES; fi++) {
        int dup = 0;
        for (int j = 0; j < all_count; j++) {
            if (strcmp(all_names[j], FIXED_DSET_NAMES[fi]) == 0) {
                dup = 1;
                break;
            }
        }
        if (!dup) {
            strncpy(all_names[all_count], FIXED_DSET_NAMES[fi], MAX_NAME - 1);
            all_names[all_count][MAX_NAME - 1] = '\0';
            all_count++;
        }
    }

    /* Drive the H5LT functions for each candidate name. */
    for (int i = 0; i < all_count; i++)
        probe_dataset(file_id, all_names[i]);

    /* Also probe attribute strings attached directly to the root group. */
    for (size_t a = 0; a < N_KNOWN_ATTRS; a++)
        probe_attribute_string(file_id, ".", KNOWN_ATTR_NAMES[a]);

    H5Fclose(file_id);
    return 0;
}
