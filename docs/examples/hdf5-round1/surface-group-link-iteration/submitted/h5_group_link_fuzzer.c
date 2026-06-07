/* Copyright 2024 Google LLC
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at
      http://www.apache.org/licenses/LICENSE-2.0
Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

/*
 * Fuzzing harness targeting group open and link traversal in HDF5.
 *
 * Attack surface: Group B-tree / fractal heap parsing and link table decoding.
 * Dense vs. compact storage transitions and external-link targets are exercised
 * by H5Gopen2, H5Gget_info, H5Giterate, H5Lvisit2, H5Lget_info2, H5Gclose.
 */

#include "hdf5.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* ------------------------------------------------------------------ */
/* Callback for H5Giterate (deprecated path, exercises old B-tree)     */
/* ------------------------------------------------------------------ */
static herr_t
giterate_cb(hid_t group, const char *name, void *op_data)
{
    (void)op_data;

    /* For each link name encountered, query its link info via the modern API. */
    H5L_info2_t linfo;
    memset(&linfo, 0, sizeof(linfo));
    H5Lget_info2(group, name, &linfo, H5P_DEFAULT);

    /* If it is a group, do NOT recurse – H5Giterate is not recursive and
     * recursing manually here would risk unbounded depth on crafted input. */
    return 0; /* 0 = continue iteration */
}

/* ------------------------------------------------------------------ */
/* Callback for H5Lvisit2 (modern path, exercises fractal-heap / v2   */
/* B-tree link storage)                                                */
/* ------------------------------------------------------------------ */
static herr_t
lvisit2_cb(hid_t group, const char *name, const H5L_info2_t *info, void *op_data)
{
    (void)group;
    (void)name;
    (void)info;
    (void)op_data;
    return 0; /* 0 = continue */
}

/* ------------------------------------------------------------------ */
/* Main fuzzer entry point                                             */
/* ------------------------------------------------------------------ */
int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size)
{
    char filename[256];
    snprintf(filename, sizeof(filename), "/tmp/h5_group_link_fuzz_%d", getpid());

    /* Write fuzz data to a temp file. */
    FILE *fp = fopen(filename, "wb");
    if (!fp)
        return 0;
    fwrite(data, size, 1, fp);
    fclose(fp);

    /* Suppress HDF5 error output so fuzzer output stays clean. */
    H5Eset_auto2(H5E_DEFAULT, NULL, NULL);

    hid_t file_id = H5Fopen(filename, H5F_ACC_RDONLY, H5P_DEFAULT);
    if (file_id == H5I_INVALID_HID) {
        unlink(filename);
        return 0;
    }

    /* -------------------------------------------------------------- */
    /* 1. Open the root group via H5Gopen2                             */
    /* -------------------------------------------------------------- */
    hid_t root_id = H5Gopen2(file_id, "/", H5P_DEFAULT);
    if (root_id != H5I_INVALID_HID) {

        /* ---------------------------------------------------------- */
        /* 2. Retrieve group metadata (storage type, nlinks, etc.)    */
        /* ---------------------------------------------------------- */
        H5G_info_t ginfo;
        memset(&ginfo, 0, sizeof(ginfo));
        H5Gget_info(root_id, &ginfo);

        /* ---------------------------------------------------------- */
        /* 3. Iterate with the legacy H5Giterate (old symbol-table /  */
        /*    B-tree code path).  Start at index 0.                   */
        /* ---------------------------------------------------------- */
        int idx = 0;
        H5Giterate(file_id, "/", &idx, giterate_cb, NULL);

        /* ---------------------------------------------------------- */
        /* 4. Visit all links recursively via H5Lvisit2 (modern path, */
        /*    exercises fractal-heap / v2 B-tree).  Try both index    */
        /*    types and both orders to maximise code coverage.        */
        /* ---------------------------------------------------------- */
        H5Lvisit2(root_id, H5_INDEX_NAME,    H5_ITER_INC,  lvisit2_cb, NULL);
        H5Lvisit2(root_id, H5_INDEX_CRT_ORDER, H5_ITER_INC, lvisit2_cb, NULL);

        /* ---------------------------------------------------------- */
        /* 5. Query link info for "." (the root group itself) – this  */
        /*    exercises H5Lget_info2's code path for hard links.      */
        /* ---------------------------------------------------------- */
        H5L_info2_t linfo_root;
        memset(&linfo_root, 0, sizeof(linfo_root));
        H5Lget_info2(file_id, ".", &linfo_root, H5P_DEFAULT);

        /* ---------------------------------------------------------- */
        /* 6. If there are any links, get info for the first one by   */
        /*    index (compact vs. dense storage transitions happen      */
        /*    during such traversals).                                 */
        /* ---------------------------------------------------------- */
        if (ginfo.nlinks > 0) {
            H5L_info2_t linfo_idx;
            memset(&linfo_idx, 0, sizeof(linfo_idx));
            H5Lget_info_by_idx2(file_id, "/", H5_INDEX_NAME,
                                H5_ITER_INC, (hsize_t)0,
                                &linfo_idx, H5P_DEFAULT);
        }

        H5Gclose(root_id);
    }

    /* -------------------------------------------------------------- */
    /* 7. Also try opening a named sub-group "group" (common name in  */
    /*    HDF5 test files) to exercise non-root group open paths.     */
    /* -------------------------------------------------------------- */
    hid_t sub_id = H5Gopen2(file_id, "group", H5P_DEFAULT);
    if (sub_id != H5I_INVALID_HID) {
        H5G_info_t sub_ginfo;
        memset(&sub_ginfo, 0, sizeof(sub_ginfo));
        H5Gget_info(sub_id, &sub_ginfo);

        H5Lvisit2(sub_id, H5_INDEX_NAME, H5_ITER_INC, lvisit2_cb, NULL);

        H5Gclose(sub_id);
    }

    H5Fclose(file_id);
    unlink(filename);
    return 0;
}
