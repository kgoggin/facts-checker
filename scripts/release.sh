#!/usr/bin/env bash
# Stages the current version on npm, then creates its git tag and GitHub release.
# CI can only stage: the version goes live once a maintainer approves it with 2FA,
# on npmjs.com or with `npm stage approve`.
set -euo pipefail

name=$(node -p "require('./package.json').name")
version=$(node -p "require('./package.json').version")
tag="v$version"

# OIDC tokens can't run `npm stage list`, so the tag is how a later run knows
# this version was already staged.
if git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null; then
  echo "$tag already exists, nothing to stage."
  exit 0
fi

if [ -n "$(npm view "$name@$version" version 2>/dev/null)" ]; then
  echo "$name@$version is already on npm, skipping stage."
else
  npm run build
  npm stage publish --provenance
  echo "Staged $name@$version. Approve it on npmjs.com or with \`npm stage approve\`."
fi

git tag "$tag"
git push origin "$tag"

notes=$(awk -v heading="## $version" '$0 == heading { found = 1; next } /^## / && found { exit } found' CHANGELOG.md)
gh release create "$tag" --title "$tag" --notes "$notes"
