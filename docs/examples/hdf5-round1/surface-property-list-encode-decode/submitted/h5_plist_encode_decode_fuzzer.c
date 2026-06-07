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
 * Fuzzing harness for the HDF5 property-list encode/decode surface.
 *
 * Attack surface: H5Pdecode / H5Pencode2 / H5Pget_filter2 / H5Pclose
 *
 * Strategy:
 *  1. Feed raw fuzzer bytes directly to H5Pdecode() – this is the primary
 *     parser target.  A valid encoded plist starts with a recognisable
 *     header; invalid blobs should be rejected cleanly, not crash.
 *  2. On success, exercise the decoded plist:
 *     a. Re-encode with H5Pencode2() (size query, then fill).
 *     b. For plists that carry a filter pipeline (DCPL / GCPL / OCPL),
 *        iterate every filter with H5Pget_filter2().
 *  3. Always release with H5Pclose().
 *
 * The harness never violates API contracts:
 *  - cd_nelmts is initialised before each H5Pget_filter2 call (required).
 *  - name buffer is always namelen bytes large.
 *  - We only call H5Pget_filter2 when H5Pget_nfilters() returns > 0.
 *  - H5Pencode2 is called with H5P_DEFAULT as fapl_id (documented as valid).
 */

#include "hdf5.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

/* Maximum number of filter cd_values we will allocate per filter. */
#define MAX_CD_NELMTS 64
/* Name buffer length passed to H5Pget_filter2. */
#define FILTER_NAME_LEN 256

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size)
{
    /* Silence HDF5 error output – we expect lots of malformed input. */
    H5Eset_auto2(H5E_DEFAULT, NULL, NULL);

    if (size == 0)
        return 0;

    /* ------------------------------------------------------------------ */
    /* 1.  Attempt to decode the fuzzer-supplied blob as a property list.  */
    /* ------------------------------------------------------------------ */
    hid_t plist_id = H5Pdecode(data);
    if (plist_id == H5I_INVALID_HID)
        return 0; /* malformed input – expected, not a bug */

    /* ------------------------------------------------------------------ */
    /* 2a. Re-encode: first query the required buffer size.                */
    /* ------------------------------------------------------------------ */
    size_t enc_size = 0;
    if (H5Pencode2(plist_id, NULL, &enc_size, H5P_DEFAULT) >= 0 && enc_size > 0) {
        void *enc_buf = malloc(enc_size);
        if (enc_buf) {
            /* Fill the buffer with the encoded plist. */
            (void)H5Pencode2(plist_id, enc_buf, &enc_size, H5P_DEFAULT);
            free(enc_buf);
        }
    }

    /* ------------------------------------------------------------------ */
    /* 2b. Query filter pipeline (only valid for OCPL subclasses).         */
    /*     H5Pget_nfilters returns a negative value for non-filter plists  */
    /*     so we guard on > 0.                                             */
    /* ------------------------------------------------------------------ */
    int nfilters = H5Pget_nfilters(plist_id);
    for (int i = 0; i < nfilters; i++) {
        unsigned int  flags       = 0;
        size_t        cd_nelmts   = MAX_CD_NELMTS; /* in/out: must be set by caller */
        unsigned      cd_values[MAX_CD_NELMTS];
        char          name[FILTER_NAME_LEN];
        unsigned int  filter_config = 0;

        memset(cd_values, 0, sizeof(cd_values));
        memset(name, 0, sizeof(name));

        H5Z_filter_t fid = H5Pget_filter2(plist_id,
                                           (unsigned)i,
                                           &flags,
                                           &cd_nelmts,
                                           cd_values,
                                           FILTER_NAME_LEN,
                                           name,
                                           &filter_config);
        (void)fid; /* result used only to drive coverage */
    }

    /* ------------------------------------------------------------------ */
    /* 3.  Release resources.                                               */
    /* ------------------------------------------------------------------ */
    H5Pclose(plist_id);

    return 0;
}
