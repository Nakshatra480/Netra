#!/usr/bin/env bash
# Builds the demo repository as a real git repository with two commits:
#   1. a safe baseline
#   2. the risky change Netra investigates
#
# Usage: build-fixture.sh <destination>
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dest="${1:?usage: build-fixture.sh <destination>}"

rm -rf "$dest"
mkdir -p "$dest"
cp -R "$here/base/." "$dest/"

git -C "$dest" init --quiet --initial-branch=main
git -C "$dest" config user.name "Orbital CI"
git -C "$dest" config user.email "ci@orbital.example"
git -C "$dest" add -A
git -C "$dest" commit --quiet -m "Set up payments service"

cp -R "$here/head/." "$dest/"
git -C "$dest" add -A
git -C "$dest" commit --quiet -m "Enable direct receipt upload from the browser"

git -C "$dest" log --reverse --format=%H
