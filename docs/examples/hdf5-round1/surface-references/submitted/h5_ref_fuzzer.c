/*
 * Fuzzing harness for HDF5 object and region references.
 *
 * Attack surface: H5Rcreate_object, H5Rcreate_region, H5Rget_obj_type3,
 *                 H5Ropen_object, H5Ropen_region, H5Rdestroy
 *
 * The fuzz input is treated as a raw HDF5 file.  Two code paths are
 * exercised:
 *
 *  1. CREATION + DEREFERENCE  — for every named object found in the fuzz
 *     file, the harness creates a fresh H5R_ref_t pointing at that object
 *     (object reference) and, for datasets, a region reference over a
 *     minimal hyperslab.  It then calls H5Rget_obj_type3 and
 *     H5Ropen_object / H5Ropen_region to resolve those references, which
 *     exercises the library's file-offset arithmetic.
 *
 *  2. RAW DEREFERENCE  — if the fuzz file contains a dataset whose element
 *     type is H5T_STD_REF (the new packed-reference type), the harness reads
 *     the raw reference bytes from that dataset and dereferences each one.
 *     Those bytes come directly from the fuzzer, so any offset/address
 *     arithmetic done during resolution is performed on attacker-controlled
 *     data.
 *
 * Copyright 2024 Google LLC.
 * Licensed under the Apache License, Version 2.0 (the "License").
 */

#include "hdf5.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <unistd.h>

/* -------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------- */

/* Close an object opened by H5Ropen_object using the right close call. */
static void
close_by_type(hid_t id, H5O_type_t otype)
{
    if (id < 0)
        return;
    switch (otype) {
        case H5O_TYPE_GROUP:          H5Gclose(id); break;
        case H5O_TYPE_DATASET:        H5Dclose(id); break;
        case H5O_TYPE_NAMED_DATATYPE: H5Tclose(id); break;
        default:                      H5Oclose(id); break;
    }
}

/*
 * Dereference one reference and close whatever opens.
 * Exercises H5Rget_obj_type3, H5Ropen_object, H5Ropen_region.
 * The caller is responsible for calling H5Rdestroy on the ref afterwards
 * (unless the ref was read from a dataset, in which case H5Rdestroy must
 * still be called after this function).
 */
static void
exercise_ref(H5R_ref_t *ref)
{
    H5R_type_t rtype = H5Rget_type(ref);
    if (rtype == H5R_BADTYPE)
        return;

    /* Query the referenced object type — touches offset arithmetic. */
    H5O_type_t otype = H5O_TYPE_UNKNOWN;
    H5Rget_obj_type3(ref, H5P_DEFAULT, &otype);

    if (rtype == H5R_OBJECT2) {
        hid_t obj = H5Ropen_object(ref, H5P_DEFAULT, H5P_DEFAULT);
        close_by_type(obj, otype);
    } else if (rtype == H5R_DATASET_REGION2) {
        /* Open the underlying object */
        hid_t obj = H5Ropen_object(ref, H5P_DEFAULT, H5P_DEFAULT);
        close_by_type(obj, otype);

        /* Open the region (a dataspace with a selection) */
        hid_t space = H5Ropen_region(ref, H5P_DEFAULT, H5P_DEFAULT);
        if (space >= 0)
            H5Sclose(space);
    }
}

/* -------------------------------------------------------------------------
 * H5Ovisit3 callback — runs for every named object in the file
 * ---------------------------------------------------------------------- */

typedef struct {
    hid_t fid;
} visit_ctx_t;

static herr_t
visit_cb(hid_t         loc_id,
         const char   *name,
         const H5O_info2_t *info,
         void         *op_data)
{
    visit_ctx_t *ctx = (visit_ctx_t *)op_data;
    (void)loc_id; /* unused; we use ctx->fid to anchor references */

    /* ---- Object reference ---- */
    H5R_ref_t oref;
    memset(&oref, 0, sizeof(oref));
    herr_t ret = H5Rcreate_object(ctx->fid, name, H5P_DEFAULT, &oref);
    if (ret >= 0) {
        exercise_ref(&oref);
        H5Rdestroy(&oref);
    }

    /* ---- Dataset-specific paths ---- */
    if (info->type != H5O_TYPE_DATASET)
        return 0; /* continue visiting */

    hid_t dset = H5Dopen2(ctx->fid, name, H5P_DEFAULT);
    if (dset < 0)
        return 0;

    /* -- Region reference -- */
    hid_t fspace = H5Dget_space(dset);
    if (fspace >= 0) {
        int ndims = H5Sget_simple_extent_ndims(fspace);
        if (ndims >= 1 && ndims <= 32) {
            hsize_t dims[32], start[32], count[32];
            if (H5Sget_simple_extent_dims(fspace, dims, NULL) >= 0) {
                int valid = 1;
                for (int i = 0; i < ndims; i++) {
                    if (dims[i] == 0) { valid = 0; break; }
                    start[i] = 0;
                    count[i] = 1; /* single element */
                }
                if (valid) {
                    if (H5Sselect_hyperslab(fspace, H5S_SELECT_SET,
                                            start, NULL, count, NULL) >= 0) {
                        H5R_ref_t rref;
                        memset(&rref, 0, sizeof(rref));
                        herr_t rr = H5Rcreate_region(ctx->fid, name, fspace,
                                                     H5P_DEFAULT, &rref);
                        if (rr >= 0) {
                            exercise_ref(&rref);
                            H5Rdestroy(&rref);
                        }
                    }
                }
            }
        }
        H5Sclose(fspace);
    }

    /*
     * -- Raw-reference read --
     * If this dataset stores packed H5T_STD_REF values (the new reference
     * type), read the raw bytes and dereference each one.  The payload
     * comes directly from the fuzz input, so every byte of offset arithmetic
     * is attacker-controlled.
     */
    hid_t dtype = H5Dget_type(dset);
    if (dtype >= 0) {
        if (H5Tequal(dtype, H5T_STD_REF) > 0) {
            hid_t rspace = H5Dget_space(dset);
            if (rspace >= 0) {
                hssize_t npts = H5Sget_simple_extent_npoints(rspace);
                /* Cap to avoid excessive memory allocation */
                if (npts > 0 && npts <= 256) {
                    H5R_ref_t *rbuf = calloc((size_t)npts, sizeof(H5R_ref_t));
                    if (rbuf) {
                        herr_t rret = H5Dread(dset, H5T_STD_REF,
                                              H5S_ALL, H5S_ALL,
                                              H5P_DEFAULT, rbuf);
                        if (rret >= 0) {
                            for (hssize_t i = 0; i < npts; i++) {
                                exercise_ref(&rbuf[i]);
                                H5Rdestroy(&rbuf[i]);
                            }
                        }
                        free(rbuf);
                    }
                }
                H5Sclose(rspace);
            }
        }
        H5Tclose(dtype);
    }

    H5Dclose(dset);
    return 0; /* continue visiting */
}

/* -------------------------------------------------------------------------
 * Fuzzer entry point
 * ---------------------------------------------------------------------- */

int
LLVMFuzzerTestOneInput(const uint8_t *data, size_t size)
{
    /* Need at least a plausible HDF5 superblock. */
    if (size < 8)
        return 0;

    /* Suppress library error output — we expect many failures. */
    H5Eset_auto2(H5E_DEFAULT, NULL, NULL);

    /* Write the fuzz payload to a temp file. */
    char fname[64];
    snprintf(fname, sizeof(fname), "/tmp/h5ref_%d.h5", getpid());

    FILE *fp = fopen(fname, "wb");
    if (!fp)
        return 0;
    fwrite(data, 1, size, fp);
    fclose(fp);

    /* Open read-only — the fuzz file is our data source. */
    hid_t fid = H5Fopen(fname, H5F_ACC_RDONLY, H5P_DEFAULT);
    if (fid < 0)
        goto cleanup;

    /*
     * Visit every named object.  H5Ovisit3 is safe to call on a corrupt
     * file; H5Fopen already validated the superblock, so any deeper
     * corruption will surface here.
     */
    visit_ctx_t ctx = { fid };
    H5Ovisit3(fid, H5_INDEX_NAME, H5_ITER_NATIVE, visit_cb, &ctx,
               H5O_INFO_BASIC);

    H5Fclose(fid);

cleanup:
    unlink(fname);
    return 0;
}
