#!/usr/bin/env bash
set -Eeuo pipefail

# Usage:
#   extension-github-release.sh tag <X.Y.Z> <commit>   Create the extension-vX.Y.Z annotated tag on
#                                                      the commit just published by the Extension
#                                                      publish workflow
#   extension-github-release.sh release [X.Y.Z]        Once the version is published to GitHub
#                                                      Packages, create the GitHub Release (the
#                                                      Extension GitHub Release workflow calls this)
# The tag must be created at publish time: the workflow GITHUB_TOKEN has no workflows scope, and
# GitHub rejects tagging a commit whose .github/workflows differ from the latest commit on main
# (HTTP 403). The release subcommand therefore does not backfill tags and fails when one is missing.
# release uses the current pi-extension/package.json version when no version is passed; a historical
# version can be passed to backfill, and backfilled releases are not marked Latest.
# Requires full history and tags (actions/checkout fetch-depth: 0), plus GH_TOKEN and
# GITHUB_REPOSITORY; the release subcommand additionally needs a token that can read GitHub Packages
# (GH_TOKEN or GITHUB_TOKEN). RUN_URL, GITHUB_STEP_SUMMARY and RUNNER_TEMP are optional.

package_name="@pelrun/pi-reach"
package_id="@pelrun%2Fpi-reach"
package_json="pi-extension/package.json"
registry="https://npm.pkg.github.com"
packages_page="https://github.com/pelrun/pi-reach/packages"
# The Extension tarball vendors the shared protocol; release notes list commits from both places.
change_paths=(pi-extension packages/protocol)
semver_pattern='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'

fail() {
  printf '✗ %s\n' "$*" >&2
  exit 1
}

summary() {
  printf '%s\n' "$*"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf '%s\n' "$*" >> "$GITHUB_STEP_SUMMARY"
  fi
}

require_version() {
  [[ "$1" =~ $semver_pattern ]] || fail "Invalid version format: $1"
}

tag_commit() {
  git rev-parse -q --verify "refs/tags/$1^{commit}" || true
}

# Returns 200, 404, or another HTTP status; 000 on network failure. GitHub Packages requires
# authentication for every request, even for public packages, so the packument is fetched with a
# token and 200 is reported only when the requested version exists in it.
npm_status() {
  local version="$1" response status body
  response="$(curl -sS --retry 3 --max-time 30 -w '\n%{http_code}' \
    -H "Authorization: Bearer ${GH_TOKEN:-${GITHUB_TOKEN:-}}" "$registry/$package_id")" || { printf '000'; return; }
  status="${response##*$'\n'}"
  body="${response%$'\n'*}"
  case "$status" in
    200)
      if jq -e --arg v "$version" '.versions | has($v)' <<<"$body" >/dev/null 2>&1; then
        printf '200'
      else
        printf '404'
      fi
      ;;
    *) printf '%s' "$status" ;;
  esac
}

# Returns the most recent tag before the commit whose version is published. Tags are created at
# publish time, including for versions never consumed, so walk versions from high to low and skip
# tags whose version is missing from GitHub Packages.
previous_published_tag() {
  local commit="$1" candidate status
  while read -r candidate; do
    [[ -n "$candidate" ]] || continue
    status="$(npm_status "${candidate#extension-v}")"
    case "$status" in
      200)
        printf '%s' "$candidate"
        return
        ;;
      404) ;;
      *) fail "Cannot determine whether $candidate is published to GitHub Packages (HTTP ${status:-no response})" ;;
    esac
  done < <(git tag --merged "$commit^" --list 'extension-v*' --sort=-version:refname 2>/dev/null || true)
}

write_notes() {
  local version="$1" commit="$2" file="$3" previous changes
  previous="$(previous_published_tag "$commit")"
  changes="$(git log --no-merges --format='- %s' "${previous:+$previous..}$commit" -- "${change_paths[@]}" \
    | grep -vE '^- chore(\(release\))?: 发布' || true)"
  {
    echo "GitHub Packages: [\`$package_name@$version\`]($packages_page)"
    echo
    if [[ -n "${RUN_URL:-}" ]]; then
      echo "Workflow run: [view run]($RUN_URL)"
      echo
    fi
    echo "## Changes"
    echo
    echo "${changes:-- No commits touching the Extension since ${previous:-the first release}.}"
  } > "$file"
}

create_tag() {
  local version="$1" commit="$2" tag="extension-v$1" existing manifest_version tag_sha
  require_version "$version"
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || fail "the commit must be a full 40-character SHA: $commit"
  manifest_version="$(git show "$commit:$package_json" | jq -r '.version')"
  [[ "$manifest_version" == "$version" ]] || fail "commit ${commit:0:7} has $package_json version $manifest_version, not $version"

  existing="$(tag_commit "$tag")"
  if [[ -n "$existing" ]]; then
    [[ "$existing" == "$commit" ]] || fail "$tag already points to a different commit ${existing:0:7}"
    summary "$tag already exists, skipping."
    return
  fi
  tag_sha="$(gh api "repos/$GITHUB_REPOSITORY/git/tags" -f tag="$tag" -f message="Extension $version" \
    -f object="$commit" -f type=commit --jq .sha)"
  gh api "repos/$GITHUB_REPOSITORY/git/refs" -f ref="refs/tags/$tag" -f sha="$tag_sha" >/dev/null
  summary "- Created $tag on commit ${commit:0:7}; the Extension GitHub Release workflow creates the GitHub Release after publishing."
}

create_release() {
  local current version tag commit status notes latest
  current="$(jq -r '.version' "$package_json")"
  # Manual runs easily pick up leading/trailing whitespace in the version input.
  version="$(printf '%s' "${1:-$current}" | tr -d '[:space:]')"
  require_version "$version"
  tag="extension-v$version"
  commit="$(tag_commit "$tag")"

  if [[ -n "$commit" ]] && gh release view "$tag" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
    summary "The Release for $tag already exists, skipping."
    return
  fi

  status="$(npm_status "$version")"
  case "$status" in
    200) ;;
    404)
      summary "$package_name@$version is not published to GitHub Packages yet, skipping."
      return
      ;;
    *) fail "Cannot determine whether $package_name@$version is already published (HTTP ${status:-no response})" ;;
  esac
  [[ -n "$commit" ]] || fail "$package_name@$version is published but the tag $tag is missing; the workflow cannot backfill it, tag it manually per docs/DEPLOYMENT.md「版本标签与 GitHub Release」and re-run"

  notes="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/$tag.md"
  write_notes "$version" "$commit" "$notes"
  latest="--latest=false"
  if [[ "$version" == "$current" ]]; then
    latest="--latest"
  fi
  gh release create "$tag" --repo "$GITHUB_REPOSITORY" --verify-tag --title "Extension $version" \
    --notes-file "$notes" "$latest"
  summary "- Extension $version: created the GitHub Release from $tag (commit ${commit:0:7})."
}

cd "$(git rev-parse --show-toplevel)"
[[ -n "${GITHUB_REPOSITORY:-}" ]] || fail "GITHUB_REPOSITORY is missing"

case "${1:-}" in
  tag)
    [[ $# -eq 3 ]] || fail "Usage: $0 tag <X.Y.Z> <commit>"
    create_tag "$2" "$3"
    ;;
  release)
    [[ $# -le 2 ]] || fail "Usage: $0 release [X.Y.Z]"
    [[ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]] || fail "GH_TOKEN (or GITHUB_TOKEN) is required to query GitHub Packages"
    create_release "${2:-}"
    ;;
  *) fail "Usage: $0 tag <X.Y.Z> <commit> | release [X.Y.Z]" ;;
esac
