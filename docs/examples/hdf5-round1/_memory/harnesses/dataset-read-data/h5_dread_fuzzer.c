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
 * Fuzzing harness for HDF5 dataset data read with type/space inspection.
 *
 * Target APIs: H5Dopen2, H5Dread, H5Dget_type, H5Dget_space,
 *              H5Dget_storage_size, H5Dclose
 *
 * This harness differs from existing ones by actually calling H5Dread to
 * drive data through the decompression, type-conversion, and fill-value
 * pipeline — the richest attack surface for memory-safety bugs.
 */

#include "hdf5.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* Safety caps to prevent enormous allocations from malformed files */
#define MAX_ELEMENTS    4096
#define MAX_MEM_BYTES   (4096 * 1024)  /* 4 MB hard cap */
#define MAX_DATASETS    8

/* ------------------------------------------------------------------ */
/* Object visitor: collect dataset names up to MAX_DATASETS            */
/* ------------------------------------------------------------------ */

typedef struct {
    char **names;
    int    count;
    int    max;
} DatasetList;

static herr_t visit_obj_cb(hid_t obj, const char *name,
                            const H5O_info2_t *info, void *op_data)
{
    (void)obj;
    DatasetList *dl = (DatasetList *)op_data;
    if (info->type == H5O_TYPE_DATASET && dl->count < dl->max) {
        char *copy = strdup(name);
        if (copy)
            dl->names[dl->count++] = copy;
    }
    return 0; /* 0 = continue iteration */
}

/* ------------------------------------------------------------------ */
/* Determine whether a type hierarchy contains VL data (needs reclaim) */
/* ------------------------------------------------------------------ */

static int type_has_vlen(hid_t type_id)
{
    H5T_class_t cls = H5Tget_class(type_id);
    if (cls == H5T_VLEN)
        return 1;
    if (cls == H5T_STRING)
        return (H5Tis_variable_str(type_id) > 0);
    if (cls == H5T_ARRAY) {
        hid_t base = H5Tget_super(type_id);
        int   rc   = (base != H5I_INVALID_HID) ? type_has_vlen(base) : 0;
        if (base != H5I_INVALID_HID)
            H5Tclose(base);
        return rc;
    }
    if (cls == H5T_COMPOUND) {
        int n = H5Tget_nmembers(type_id);
        for (int i = 0; i < n; i++) {
            hid_t mtype = H5Tget_member_type(type_id, (unsigned)i);
            if (mtype == H5I_INVALID_HID)
                continue;
            int rc = type_has_vlen(mtype);
            H5Tclose(mtype);
            if (rc)
                return 1;
        }
    }
    return 0;
}

/* ------------------------------------------------------------------ */
/* Read one dataset: inspect type/space, then call H5Dread             */
/* ------------------------------------------------------------------ */

static void read_dataset(hid_t file_id, const char *name)
{
    hid_t  dset_id   = H5I_INVALID_HID;
    hid_t  file_type = H5I_INVALID_HID;
    hid_t  mem_type  = H5I_INVALID_HID;
    hid_t  space_id  = H5I_INVALID_HID;
    void  *buf       = NULL;

    /* Open the dataset */
    dset_id = H5Dopen2(file_id, name, H5P_DEFAULT);
    if (dset_id == H5I_INVALID_HID)
        goto cleanup;

    /* Inspect the file datatype */
    file_type = H5Dget_type(dset_id);
    if (file_type == H5I_INVALID_HID)
        goto cleanup;

    /* Exercise storage-size query */
    (void)H5Dget_storage_size(dset_id);

    /* Get the dataspace and element count */
    space_id = H5Dget_space(dset_id);
    if (space_id == H5I_INVALID_HID)
        goto cleanup;

    hssize_t npoints = H5Sget_simple_extent_npoints(space_id);
    if (npoints <= 0 || npoints > MAX_ELEMENTS)
        goto cleanup;

    /*
     * Choose a memory type.
     * - For VL/variable-string types we copy the file type directly
     *   (H5Dread will allocate VL buffers that H5Treclaim must free).
     * - For reference types we skip entirely — reading references
     *   requires additional dereference context.
     * - For all other types we request the native platform equivalent
     *   (the usual real-caller pattern for integer/float/enum/compound).
     */
    H5T_class_t cls = H5Tget_class(file_type);
    if (cls == H5T_REFERENCE || cls == H5T_NO_CLASS)
        goto cleanup;

    int has_vlen = type_has_vlen(file_type);

    if (has_vlen) {
        mem_type = H5Tcopy(file_type);
    } else {
        mem_type = H5Tget_native_type(file_type, H5T_DIR_ASCEND);
        if (mem_type == H5I_INVALID_HID)
            mem_type = H5Tcopy(file_type);
    }
    if (mem_type == H5I_INVALID_HID)
        goto cleanup;

    size_t type_size = H5Tget_size(mem_type);
    if (type_size == 0)
        goto cleanup;

    /* Reject if the total allocation would be unreasonably large */
    size_t total_bytes = (size_t)npoints * type_size;
    if (total_bytes == 0 || total_bytes > MAX_MEM_BYTES)
        goto cleanup;

    /*
     * Use calloc so that unwritten VL pointer slots are NULL — safe to
     * pass to H5Treclaim even if H5Dread only partially fills the buffer.
     */
    buf = calloc((size_t)npoints, type_size);
    if (!buf)
        goto cleanup;

    /* -------- THE KEY CALL: pull data through the full pipeline -------- */
    herr_t ret = H5Dread(dset_id, mem_type, H5S_ALL, H5S_ALL,
                         H5P_DEFAULT, buf);

    /* Release VL memory allocated internally by H5Dread */
    if (ret >= 0 && has_vlen)
        H5Treclaim(mem_type, space_id, H5P_DEFAULT, buf);

cleanup:
    if (buf)                           free(buf);
    if (mem_type  != H5I_INVALID_HID)  H5Tclose(mem_type);
    if (file_type != H5I_INVALID_HID)  H5Tclose(file_type);
    if (space_id  != H5I_INVALID_HID)  H5Sclose(space_id);
    if (dset_id   != H5I_INVALID_HID)  H5Dclose(dset_id);
}

/* ------------------------------------------------------------------ */
/* Fuzzer entry point                                                   */
/* ------------------------------------------------------------------ */

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size)
{
    /* Write the fuzz corpus to a temp file */
    char filename[64];
    snprintf(filename, sizeof(filename), "/tmp/hdf5_dread_%d", getpid());

    FILE *fp = fopen(filename, "wb");
    if (!fp)
        return 0;
    fwrite(data, size, 1, fp);
    fclose(fp);

    /* Silence the HDF5 error stack — we expect malformed input */
    H5Eset_auto2(H5E_DEFAULT, NULL, NULL);

    hid_t file_id = H5Fopen(filename, H5F_ACC_RDONLY, H5P_DEFAULT);
    if (file_id == H5I_INVALID_HID) {
        unlink(filename);
        return 0;
    }

    /* Enumerate datasets via a recursive object visit */
    char       *name_ptrs[MAX_DATASETS];
    DatasetList dl;
    memset(name_ptrs, 0, sizeof(name_ptrs));
    dl.names = name_ptrs;
    dl.count = 0;
    dl.max   = MAX_DATASETS;

    H5Ovisit3(file_id, H5_INDEX_NAME, H5_ITER_NATIVE,
               visit_obj_cb, &dl, H5O_INFO_BASIC);

    /* Read each discovered dataset */
    for (int i = 0; i < dl.count; i++) {
        if (dl.names[i]) {
            read_dataset(file_id, dl.names[i]);
            free(dl.names[i]);
        }
    }

    H5Fclose(file_id);
    unlink(filename);
    return 0;
}
