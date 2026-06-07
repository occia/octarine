# =============================================================================
# octarine Harness Generation Module (run phase)
# =============================================================================
# Compiles the TypeScript app and runs it on the base-runner-derived base image,
# so the verifier can fuzz freshly built harness binaries in this same container.
# =============================================================================
ARG target_base_image
ARG crs_version

FROM oss-harness-gen-ts-base

# libCRS (CLI used by the orchestrator/verifier as a subprocess)
COPY --from=libcrs . /libCRS
RUN /libCRS/install.sh

# Build the TypeScript app, then drop dev deps + sources. The runtime keeps only the
# production deps (marked + highlight.js, used to render agent-conversation transcripts).
WORKDIR /opt/crs
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm install && npm run build && npm prune --omit=dev && rm -rf src tsconfig.json

COPY bin ./bin
RUN chmod +x bin/run_harness_gen
ENV PATH="/opt/crs/bin:${PATH}"

CMD ["run_harness_gen"]
