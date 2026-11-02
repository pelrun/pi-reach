#!/usr/bin/env bash
set -Eeuo pipefail

# Usage: publish-npm.sh
# Publishes the Extension (@pelrun/pi-reach) to GitHub Packages (npm.pkg.github.com).
# GitHub Packages has no staged publishing or approval flow: npm publish goes live immediately,
# and a published version can never be reused.
# - The package scope must match the repository owner that owns the GitHub Packages namespace.
# - Authentication, in order: NODE_AUTH_TOKEN / GH_TOKEN / GITHUB_TOKEN (written to a temporary
#   npmrc that only references the variable, so the token never lands in the repo or in command
#   arguments), or an npm session already logged in to npm.pkg.github.com.

registry="https://npm.pkg.github.com"
expected_name="@pelrun/pi-reach"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
temp_npmrc=""
pack_dir=""

cleanup() {
  unset NODE_AUTH_TOKEN
  if [[ -n "$temp_npmrc" ]]; then
    rm -f "$temp_npmrc"
  fi
  if [[ -n "$pack_dir" ]]; then
    rm -rf "$pack_dir"
  fi
}

trap cleanup EXIT

fail() {
  printf 'Publish aborted: %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "command not found: $1"
}

for arg in "$@"; do
  case "$arg" in
    *) fail "unknown argument: ${arg} (usage: publish-npm.sh)" ;;
  esac
done

cd "$script_dir"
require_command node
require_command npm
require_command pnpm

token="${NODE_AUTH_TOKEN:-${GH_TOKEN:-${GITHUB_TOKEN:-}}}"
if [[ -n "$token" ]]; then
  # The npmrc references ${NODE_AUTH_TOKEN} so the token value only lives in the environment.
  export NODE_AUTH_TOKEN="$token"
  temp_npmrc="$(mktemp "${TMPDIR:-/tmp}/pi-reach-npmrc.XXXXXX")"
  chmod 600 "$temp_npmrc"
  printf '%s\n' \
    "@pelrun:registry=$registry" \
    '//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}' \
    >"$temp_npmrc"
  export NPM_CONFIG_USERCONFIG="$temp_npmrc"
  printf 'Using a GitHub token through a temporary npmrc; credentials never enter the repo or command arguments.\n'
elif ! npm whoami --registry="$registry" >/dev/null 2>&1; then
  fail "not authenticated to $registry; set NODE_AUTH_TOKEN (a GitHub token with read:packages, plus write:packages to publish) or run npm login --scope=@pelrun --registry=$registry"
fi

package_name="$(node -e 'const fs=require("fs"); process.stdout.write(JSON.parse(fs.readFileSync("package.json", "utf8")).name)')"
package_version="$(node -e 'const fs=require("fs"); process.stdout.write(JSON.parse(fs.readFileSync("package.json", "utf8")).version)')"

[[ "$package_name" == "$expected_name" ]] || fail "the name in package.json is not $expected_name: $package_name"
[[ "$package_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "the version must be an exact X.Y.Z: $package_version"

set +e
version_output="$(npm view "$package_name@$package_version" version --registry="$registry" 2>&1)"
version_status=$?
set -e

if (( version_status == 0 )); then
  fail "$package_name@$package_version already exists and cannot be republished"
fi

case "$version_output" in
  *E404*|*404*|*"No match found"*) ;;
  *)
    printf '%s\n' "$version_output" >&2
    fail "cannot confirm whether the version already exists; check the registry and network"
    ;;
esac

printf 'Preparing to publish %s@%s to GitHub Packages\n' "$package_name" "$package_version"
printf 'Cleaning stale dist/ build output...\n'
rm -rf dist

printf 'Running pnpm verify...\n'
pnpm verify

printf 'Checking the npm tarball contents...\n'
pack_dir="$(mktemp -d "${TMPDIR:-/tmp}/pi-reach-pack.XXXXXX")"
set +e
pack_output="$(pnpm pack --json --pack-destination "$pack_dir" 2>&1)"
pack_status=$?
set -e
printf '%s\n' "$pack_output"
(( pack_status == 0 )) || fail "pnpm pack failed"

if [[ "$pack_output" =~ dist/.*(mesh|rooms|broker|pi_forward|peer_inventory|leader_election) ]]; then
  fail "the npm tarball still contains legacy Mesh/cross-Pi build output; check dist/"
fi

# Verification and packing stay on pnpm; the npm CLI performs only the final upload.
# pnpm pack converts catalog references to real versions; upload the inspected tarball,
# never repack from the source directory.
tarballs=("$pack_dir"/*.tgz)
[[ ${#tarballs[@]} -eq 1 && -f "${tarballs[0]}" ]] || fail "no single npm tarball in the pack directory"

npm publish "${tarballs[0]}" --access public --ignore-scripts

verification_attempts=12
verification_delay_seconds=5
published_version=""

for ((attempt = 1; attempt <= verification_attempts; attempt++)); do
  published_version="$(npm view "$package_name@$package_version" version --registry="$registry" --prefer-online 2>/dev/null || true)"
  if [[ "$published_version" == "$package_version" ]]; then
    printf 'Publish succeeded: %s@%s\n' "$package_name" "$package_version"
    exit 0
  fi
  if (( attempt < verification_attempts )); then
    printf 'The registry has not confirmed %s@%s yet (%d/%d), retrying in %d seconds...\n' \
      "$package_name" "$package_version" "$attempt" "$verification_attempts" "$verification_delay_seconds" >&2
    sleep "$verification_delay_seconds"
  fi
done

printf 'Warning: npm publish succeeded, but the registry did not confirm %s@%s within about 60 seconds.\n' \
  "$package_name" "$package_version" >&2
printf 'Check manually later: npm view %s@%s version --prefer-online\n' \
  "$package_name" "$package_version" >&2
exit 0
