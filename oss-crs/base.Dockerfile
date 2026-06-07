# =============================================================================
# octarine base image (prepare phase)
# =============================================================================
# Built on the OSS-Fuzz base-runner so the run container can EXECUTE freshly
# built libFuzzer/ASAN harness binaries directly (this is the whole point of the
# verifier). Node.js + Claude Code CLI are layered on for generation/analysis.
# =============================================================================
FROM gcr.io/oss-fuzz-base/base-runner

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates git rsync python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Node.js 20 (orchestrator runtime + Claude Code CLI)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

ARG CLAUDE_CODE_CLI_VERSION=2.1.92
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_CLI_VERSION}

RUN git config --global user.email "crs@oss-crs.dev" \
    && git config --global user.name "OSS-CRS Harness Gen" \
    && git config --global --add safe.directory '*'
