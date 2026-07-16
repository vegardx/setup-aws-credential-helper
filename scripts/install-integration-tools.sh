#!/usr/bin/env bash
set -euo pipefail

TOOLCHAIN_FILE="$(cd "$(dirname "${1:-tests/integration/toolchain.json}")" && pwd)/$(basename "${1:-tests/integration/toolchain.json}")"
INSTALL_DIR="${2:-${RUNNER_TEMP:-/tmp}/credential-helper-tools}"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) DIST_ARCH=amd64; JSON_ARCH=Amd64 ;;
  aarch64|arm64) DIST_ARCH=arm64; JSON_ARCH=Arm64 ;;
  *) echo "Unsupported integration architecture: $ARCH" >&2; exit 1 ;;
esac

node_value() {
  node -e 'const v=require(process.argv[1]); console.log(process.argv.slice(2).reduce((x,k)=>x[k],v))' "$TOOLCHAIN_FILE" "$@"
}

TF_VERSION="$(node_value terraform)"
TOFU_VERSION="$(node_value opentofu)"
TF_SHA="$(node_value checksums terraformLinux${JSON_ARCH})"
TOFU_SHA="$(node_value checksums opentofuLinux${JSON_ARCH})"
mkdir -p "$INSTALL_DIR"
chmod 0700 "$INSTALL_DIR"

download() {
  local url="$1" output="$2" expected="$3"
  curl --fail --location --silent --show-error --retry 3 --connect-timeout 15 --max-time 180 "$url" --output "$output"
  printf '%s  %s\n' "$expected" "$output" | sha256sum --check --status
}

TF_ZIP="$INSTALL_DIR/terraform.zip"
TOFU_ZIP="$INSTALL_DIR/tofu.zip"
download "https://releases.hashicorp.com/terraform/${TF_VERSION}/terraform_${TF_VERSION}_linux_${DIST_ARCH}.zip" "$TF_ZIP" "$TF_SHA"
download "https://github.com/opentofu/opentofu/releases/download/v${TOFU_VERSION}/tofu_${TOFU_VERSION}_linux_${DIST_ARCH}.zip" "$TOFU_ZIP" "$TOFU_SHA"
unzip -qo "$TF_ZIP" terraform -d "$INSTALL_DIR"
unzip -qo "$TOFU_ZIP" tofu -d "$INSTALL_DIR"
rm -f "$TF_ZIP" "$TOFU_ZIP"
chmod 0755 "$INSTALL_DIR/terraform" "$INSTALL_DIR/tofu"
printf '%s\n' "$INSTALL_DIR" >> "${GITHUB_PATH:-/dev/null}"
"$INSTALL_DIR/terraform" version
"$INSTALL_DIR/tofu" version
