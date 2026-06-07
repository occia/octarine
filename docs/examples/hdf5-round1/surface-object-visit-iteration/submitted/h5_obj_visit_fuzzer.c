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
 * Fuzzing harness for HDF5 object-header visiting and link iteration:
 *   H5Oopen, H5Oget_info3, H5Ovisit3, H5Oclose, H5Literate2, H5Lget_val
 *
 * Strategy:
 *  1. Write fuzz data to a temp file and open it read-only.
 *  2. Retrieve info on the root object via H5Oget_info3.
 *  3. Iterate links in the root group via H5Literate2 (name and creation-order
 *     indices, both directions).  For each soft link call H5Lget_val; for hard
 *     and soft links open the target with H5Oopen + H5Oget_info3 + H5Oclose.
 *  4. Recursively visit every reachable object via H5Ovisit3 (two index types).
 *     Inside the visitor, open each visited object by path and read its info.
 */

#include "hdf5.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* Hard cap on callbacks to avoid spending forever on highly-connected graphs */
#define MAX_CB_CALLS 2000

/* Soft-link value buffer cap – large enough to be interesting, small enough to
 * avoid gigantic allocations on crafted val_size fields.                      */
#define MAX_LVAL_BUF 65536

/* -------------------------------------------------------------------------
 * Shared state threaded through callbacks
 * ---------------------------------------------------------------------- */
typedef struct {
    hid_t file_id;   /* The open file – used to re-open objects by path */
    int   calls;     /* Running callback count (rate-limiting guard)     */
} cb_state_t;

/* -------------------------------------------------------------------------
 * H5Ovisit3 callback
 *
 *  obj  – the starting object passed to H5Ovisit3 (stays constant)
 *  name – path from starting object to the currently-visited object
 *  info – pre-filled info struct for the current object
 * ---------------------------------------------------------------------- */
static herr_t
obj_visit_cb(hid_t obj, const char *name, const H5O_info2_t *info,
             void *op_data)
{
    cb_state_t *st = (cb_state_t *)op_data;
    if (st->calls++ >= MAX_CB_CALLS)
        return 1; /* non-zero stops iteration */

    /* Consume all info fields so the parser path is exercised */
    (void)info->type;
    (void)info->rc;
    (void)info->num_attrs;
    (void)info->atime;
    (void)info->mtime;

    /* "." is the starting object itself – skip the re-open to avoid an
     * open-on-self cycle, but the info was already consumed above.     */
    if (!name || name[0] == '\0' || strcmp(name, ".") == 0)
        return 0;

    /* Open the visited object by path relative to the starting object,
     * fetch its info independently, then close it.  This exercises the
     * object-header parser on the same header via a different code path. */
    hid_t child = H5Oopen(obj, name, H5P_DEFAULT);
    if (child != H5I_INVALID_HID) {
        H5O_info2_t ci;
        H5Oget_info3(child, &ci, H5O_INFO_ALL);
        H5Oclose(child);
    }

    return 0;
}

/* -------------------------------------------------------------------------
 * H5Literate2 callback
 *
 *  group – the group being iterated
 *  name  – link name within that group
 *  info  – link metadata
 * ---------------------------------------------------------------------- */
static herr_t
link_iter_cb(hid_t group, const char *name, const H5L_info2_t *info,
             void *op_data)
{
    cb_state_t *st = (cb_state_t *)op_data;
    if (st->calls++ >= MAX_CB_CALLS)
        return 1;

    /* Consume link metadata */
    (void)info->corder_valid;
    (void)info->corder;
    (void)info->cset;

    /* For soft links: retrieve the link value (target path string).
     * val_size comes from the fuzzed file – cap allocation defensively. */
    if (info->type == H5L_TYPE_SOFT) {
        size_t vsz = info->u.val_size;
        if (vsz > 0 && vsz <= MAX_LVAL_BUF) {
            char *buf = (char *)malloc(vsz + 1);
            if (buf) {
                buf[vsz] = '\0';
                H5Lget_val(group, name, buf, vsz + 1, H5P_DEFAULT);
                free(buf);
            }
        }
    }

    /* Open the target object for hard and soft links.
     * Skip external links to avoid touching the filesystem beyond /tmp.  */
    if (info->type == H5L_TYPE_HARD || info->type == H5L_TYPE_SOFT) {
        hid_t obj = H5Oopen(group, name, H5P_DEFAULT);
        if (obj != H5I_INVALID_HID) {
            H5O_info2_t oinfo;
            H5Oget_info3(obj, &oinfo, H5O_INFO_ALL);
            H5Oclose(obj);
        }
    }

    return 0;
}

/* -------------------------------------------------------------------------
 * Fuzz entry point
 * ---------------------------------------------------------------------- */
int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size)
{
    char filename[256];

    /* Suppress HDF5 error output – it's noisy and not useful for fuzzing */
    H5Eset_auto2(H5E_DEFAULT, NULL, NULL);

    snprintf(filename, sizeof(filename), "/tmp/h5_obj_visit_%d", getpid());

    FILE *fp = fopen(filename, "wb");
    if (!fp)
        return 0;
    fwrite(data, size, 1, fp);
    fclose(fp);

    /* Open read-only: we must not inadvertently mutate file metadata and
     * thereby introduce harness-side state that obscures real bugs.      */
    hid_t file_id = H5Fopen(filename, H5F_ACC_RDONLY, H5P_DEFAULT);
    if (file_id == H5I_INVALID_HID) {
        unlink(filename);
        return 0;
    }

    cb_state_t state = {file_id, 0};

    /* ---- 1. Root-object info ---------------------------------------- */
    H5O_info2_t root_info;
    H5Oget_info3(file_id, &root_info, H5O_INFO_ALL);

    /* ---- 2. Link iteration (name index, native order) ---------------- */
    hsize_t idx = 0;
    H5Literate2(file_id, H5_INDEX_NAME, H5_ITER_NATIVE, &idx,
                link_iter_cb, &state);

    /* ---- 3. Link iteration (creation-order index, increasing) -------- */
    idx = 0;
    H5Literate2(file_id, H5_INDEX_CRT_ORDER, H5_ITER_INC, &idx,
                link_iter_cb, &state);

    /* ---- 4. Link iteration (name index, decreasing) ------------------ */
    idx = 0;
    H5Literate2(file_id, H5_INDEX_NAME, H5_ITER_DEC, &idx,
                link_iter_cb, &state);

    /* ---- 5. Object visit (name index) -------------------------------- */
    state.calls = 0;
    H5Ovisit3(file_id, H5_INDEX_NAME, H5_ITER_NATIVE,
               obj_visit_cb, &state, H5O_INFO_ALL);

    /* ---- 6. Object visit (creation-order index, increasing) ---------- */
    state.calls = 0;
    H5Ovisit3(file_id, H5_INDEX_CRT_ORDER, H5_ITER_INC,
               obj_visit_cb, &state, H5O_INFO_ALL);

    H5Fclose(file_id);
    unlink(filename);
    return 0;
}
