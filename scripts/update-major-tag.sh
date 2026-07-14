#!/usr/bin/env bash
set -euo pipefail

if [[ ! ${RELEASE_VERSION:-} =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "::error::Refusing to move a major tag for invalid version '${RELEASE_VERSION:-}'."
  exit 1
fi

immutable_tag="v${RELEASE_VERSION}"
major_tag="v${RELEASE_VERSION%%.*}"

git fetch --force --tags origin
release_commit="$(git rev-list -n 1 "refs/tags/${immutable_tag}" 2>/dev/null || true)"

if [[ -z ${release_commit} ]]; then
  echo "::error::Immutable release tag ${immutable_tag} does not exist."
  exit 1
fi

if [[ ${release_commit} != "${GITHUB_SHA}" ]]; then
  echo "::error::${immutable_tag} resolves to ${release_commit}, not verified commit ${GITHUB_SHA}."
  exit 1
fi

remote_url="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}.git"
auth_header="AUTHORIZATION: basic $(printf 'x-access-token:%s' "${GITHUB_TOKEN}" | base64 | tr -d '\n')"

git tag --force "${major_tag}" "${immutable_tag}"
git -c "http.${GITHUB_SERVER_URL}/.extraheader=${auth_header}" \
  push --force "${remote_url}" "refs/tags/${major_tag}:refs/tags/${major_tag}"

echo "Moved ${major_tag} to ${immutable_tag} (${release_commit})."
