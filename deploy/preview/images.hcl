variable "IMAGE_PREFIX" {
  default = ""
}
variable "REVISION" {
  default = ""
}
variable "IMAGE_TAG" {
  default = ""
}
variable "IMAGE_SOURCE" {
  default = ""
}

variable "BUILD_CACHE" {
  default = ""
}
function "registry_cache" {
  params = [tag]
  result = BUILD_CACHE == "" ? [] : ["type=registry,ref=${BUILD_CACHE}:${tag}"]
}

group "default" {
  targets = ["server", "registry", "web", "db-migrate", "seed", "scheduler"]
}

target "common" {
  context = "."
  platforms = ["linux/amd64"]
  labels = {
    "org.opencontainers.image.revision" = REVISION
    "org.opencontainers.image.source" = IMAGE_SOURCE
    "kq.preview.tag" = IMAGE_TAG
  }
}
target "server" {
  cache-from = registry_cache("production-server")
  inherits = ["common"]
  dockerfile = "packages/server/Dockerfile"
  args = { KQ_BUILD_REVISION = REVISION }
  tags = ["${IMAGE_PREFIX}-server:${IMAGE_TAG}"]
}
target "registry" {
  cache-from = registry_cache("production-registry")
  inherits = ["common"]
  dockerfile = "packages/registry/Dockerfile"
  tags = ["${IMAGE_PREFIX}-registry:${IMAGE_TAG}"]
}
target "web" {
  cache-from = registry_cache("production-web")
  inherits = ["common"]
  dockerfile = "packages/web/Dockerfile"
  args = { VITE_PREVIEW_LOGIN = "true" }
  tags = ["${IMAGE_PREFIX}-web:${IMAGE_TAG}"]
}
target "db-migrate" {
  cache-from = registry_cache("production-db-migrate")
  inherits = ["common"]
  dockerfile = "packages/db/Dockerfile"
  tags = ["${IMAGE_PREFIX}-db-migrate:${IMAGE_TAG}"]
}
target "seed" {
  inherits = ["common"]
  dockerfile = "deploy/seed/Dockerfile"
  tags = ["${IMAGE_PREFIX}-seed:${IMAGE_TAG}"]
}
target "scheduler-base" {
  cache-from = registry_cache("scheduler-base")
  context = "./deploy/schedulers"
  dockerfile = "base/Dockerfile"
  platforms = ["linux/amd64"]
  args = { SPACK_REF = "v1.0.0" }
}
target "scheduler-runtime" {
  cache-from = registry_cache("runtime-slurm")
  context = "./deploy/schedulers"
  dockerfile = "slurm/Dockerfile"
  platforms = ["linux/amd64"]
  contexts = { scheduler-base = "target:scheduler-base" }
}
target "scheduler-workspace" {
  inherits = ["common"]
  dockerfile = "deploy/preview/scheduler-workspace.Dockerfile"
  contexts = { scheduler-base = "target:scheduler-base" }
}
target "scheduler" {
  inherits = ["common"]
  dockerfile = "deploy/preview/scheduler.Dockerfile"
  contexts = {
    scheduler-runtime = "target:scheduler-runtime"
    preview-workspace = "target:scheduler-workspace"
  }
  tags = ["${IMAGE_PREFIX}-scheduler:${IMAGE_TAG}"]
}
