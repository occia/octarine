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

Fuzzer for committed (named) datatype open and introspection:
  H5Topen2, H5Tget_class, H5Tget_size, H5Tget_nmembers,
  H5Tget_member_type, H5Tget_member_offset, H5Tis_variable_str, H5Tclose

The entire fuzz input is treated as raw HDF5 file content.  We load it
into the CORE VFD via H5Pset_file_image so that every byte – including
the superblock and object-header regions that encode committed type
descriptors – is reachable by the fuzzer.  No golden-image overlay is
used: if the bytes don't form a valid HDF5 file H5Fopen simply returns
an error and we exit cleanly.
*/

#include "hdf5.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

/* Candidate names that real callers might store committed types under. */
static const char *const CANDIDATE_NAMES[] = {
    "dtype",
    "datatype",
    "type",
    "mytype",
    "compound",
    "enum",
    "vlen",
    "array_type",
    "DT",
    "DT2",
    "DT3",
    "/dtype",
    "/datatype",
    "/type",
    "/mytype",
    "/compound",
    "/DT",
};
static const int NUM_CANDIDATES =
    (int)(sizeof(CANDIDATE_NAMES) / sizeof(CANDIDATE_NAMES[0]));

/* Suppress HDF5 error output to stderr so the fuzzer isn't noisy. */
static void suppress_errors(void)
{
    H5Eset_auto2(H5E_DEFAULT, NULL, NULL);
}

/*
 * Recursively introspect a type id, exercising the target APIs.
 * depth prevents unbounded recursion on pathological compound-of-compound
 * types in a fuzzed file.
 */
static void introspect_type(hid_t tid, int depth)
{
    if (tid < 0 || depth > 8)
        return;

    H5T_class_t cls = H5Tget_class(tid);
    H5Tget_size(tid);
    H5Tis_variable_str(tid);

    if (cls == H5T_COMPOUND) {
        int nmembers = H5Tget_nmembers(tid);
        if (nmembers > 0) {
            /* Cap iterations to avoid spending too much time on huge types. */
            int limit = nmembers < 64 ? nmembers : 64;
            for (int i = 0; i < limit; i++) {
                H5Tget_member_offset(tid, (unsigned)i);
                hid_t mtype = H5Tget_member_type(tid, (unsigned)i);
                if (mtype >= 0) {
                    introspect_type(mtype, depth + 1);
                    H5Tclose(mtype);
                }
            }
        }
    } else if (cls == H5T_ENUM) {
        int nmembers = H5Tget_nmembers(tid);
        if (nmembers > 0) {
            int limit = nmembers < 64 ? nmembers : 64;
            for (int i = 0; i < limit; i++) {
                H5Tget_member_offset(tid, (unsigned)i);
            }
        }
    } else if (cls == H5T_ARRAY || cls == H5T_VLEN) {
        hid_t base = H5Tget_super(tid);
        if (base >= 0) {
            introspect_type(base, depth + 1);
            H5Tclose(base);
        }
    }
}

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size)
{
    if (size == 0)
        return 0;

    suppress_errors();

    /* Build a CORE-backed FAPL seeded with the fuzz bytes as the file image.
     * H5Pset_file_image makes its own copy of the buffer, so we don't need
     * to keep 'data' alive past this call.                                  */
    hid_t fapl = H5Pcreate(H5P_FILE_ACCESS);
    if (fapl < 0)
        return 0;

    /* backing_store=false: don't write to disk */
    if (H5Pset_fapl_core(fapl, (size_t)(64 * 1024), /*backing_store=*/false) < 0) {
        H5Pclose(fapl);
        return 0;
    }

    if (H5Pset_file_image(fapl, (void *)data, size) < 0) {
        H5Pclose(fapl);
        return 0;
    }

    /* Open the in-memory image as an HDF5 file (read-only). */
    hid_t fid = H5Fopen("fuzz_image", H5F_ACC_RDONLY, fapl);
    H5Pclose(fapl);
    if (fid < 0)
        return 0;

    /* Try opening each candidate committed-type name. */
    for (int i = 0; i < NUM_CANDIDATES; i++) {
        hid_t tid = H5Topen2(fid, CANDIDATE_NAMES[i], H5P_DEFAULT);
        if (tid >= 0) {
            introspect_type(tid, 0);
            H5Tclose(tid);
        }
    }

    /* Also walk the root group to find whatever names are actually present
     * and try to open them as committed types.                              */
    hsize_t idx = 0;
    hid_t root = H5Gopen2(fid, "/", H5P_DEFAULT);
    if (root >= 0) {
        hsize_t n = 0;
        H5Gget_num_objs(root, &n);
        /* Cap at 32 to bound work on pathological files. */
        hsize_t limit = n < 32 ? n : 32;
        for (hsize_t j = 0; j < limit; j++) {
            char name[256];
            ssize_t name_len = H5Gget_objname_by_idx(root, j, name, sizeof(name));
            if (name_len > 0) {
                hid_t tid = H5Topen2(fid, name, H5P_DEFAULT);
                if (tid >= 0) {
                    introspect_type(tid, 0);
                    H5Tclose(tid);
                }
            }
        }
        H5Gclose(root);
    }
    (void)idx;

    H5Fclose(fid);
    return 0;
}
