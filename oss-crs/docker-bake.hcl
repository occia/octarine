# =============================================================================
# octarine Docker Bake Configuration (prepare phase)
# =============================================================================
variable "REGISTRY" {
  default = "ghcr.io/team-atlanta"
}

variable "VERSION" {
  default = "latest"
}

variable "CLAUDE_CODE_CLI_VERSION" {
  default = "2.1.92"
}

function "tags" {
  params = [name]
  result = [
    "${REGISTRY}/${name}:${VERSION}",
    "${REGISTRY}/${name}:latest",
    "${name}:latest",
  ]
}

group "default" {
  targets = ["prepare"]
}

group "prepare" {
  targets = ["oss-harness-gen-ts-base"]
}

target "oss-harness-gen-ts-base" {
  context    = "."
  dockerfile = "oss-crs/base.Dockerfile"
  tags       = tags("oss-harness-gen-ts-base")
  args = {
    CLAUDE_CODE_CLI_VERSION = CLAUDE_CODE_CLI_VERSION
  }
}
