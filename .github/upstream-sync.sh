#!/usr/bin/env bash
# Brings the original project's changes into this copy as ONE commit.
# Used by .github/workflows/upstream-sync.yml; see the comments there.
#
#   upstream-sync.sh <upstream-ref> <include-workflow-files: true|false>
#
# A copy made with the "Deploy to Cloudflare" button shares no history
# with the original (Cloudflare uploads the files as a new commit), so a
# git merge has nothing to work from. Instead this applies the original's
# changes since the last update (base..upstream) with a three-way apply,
# which keeps the copy's own edits (like the database id Cloudflare wrote
# into wrangler.toml). The commit records which upstream commit it brought
# in ("Upstream-Commit: <sha>"), and that is the next run's base. Before
# the first update the base is the original's main at the moment the copy
# was made.
#
# Leaves the commit in place (no push) and writes key=value lines to
# $GITHUB_OUTPUT: status=current|updated|conflict, plus
# workflows=<files> (workflow changes left out) and conflicts=<files>.
set -euo pipefail
up=$(git rev-parse "$1")
include_workflows=$2
out=${GITHUB_OUTPUT:-/dev/stdout}

base=$(git log --format='%(trailers:key=Upstream-Commit,valueonly,separator=)' | grep -m1 . || true)
if [ -z "$base" ]; then
  # When the copy was made: Cloudflare's upload commit, else the first commit.
  made=$(git log --reverse --format=%cI --author='cloudflare-workers-and-pages' | head -1)
  [ -n "$made" ] || made=$(git log --reverse --format=%cI | head -1)
  base=$(git rev-list -1 --first-parent --before="$made" "$up")
  [ -n "$base" ] || { echo "::error::No upstream commit older than this copy ($made)."; exit 1; }
fi

if [ "$(git rev-parse "$base")" = "$up" ]; then
  echo "status=current" >> "$out"; exit 0
fi

if ! git diff --binary "$base" "$up" -- . ':!.github/workflows' | git apply --3way --index --allow-empty; then
  echo "conflicts=$(git diff --name-only --diff-filter=U | paste -sd ' ' -)" >> "$out"
  git reset -q --hard
  echo "status=conflict" >> "$out"; exit 0
fi

# Workflow files are taken whole from the original, not merged, so ones
# left behind on an earlier run (no token then) catch up too. The copy's
# own extra workflows stay.
if [ "$include_workflows" = true ]; then
  git checkout "$up" -- .github/workflows
  git diff --name-only --diff-filter=D "$base" "$up" -- .github/workflows | xargs -r git rm -q --ignore-unmatch --
else
  echo "workflows=$(git diff --name-only --diff-filter=AM HEAD "$up" -- .github/workflows | paste -sd ' ' -)" >> "$out"
fi

git commit -q --allow-empty -m "Update from the original Arthatula" -m "Upstream-Commit: $up"
echo "status=updated" >> "$out"
