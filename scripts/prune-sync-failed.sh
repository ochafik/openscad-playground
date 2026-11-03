#!/usr/bin/env bash
# Deletes old sync-failed/<date-time> branches on the remote, keeping the newest KEEP (default 5).
#   DRY_RUN=true  only print
set -uo pipefail
KEEP="${KEEP:-5}"
REMOTE="${REMOTE:-origin}"
DRY_RUN="${DRY_RUN:-false}"

# Names embed a sortable UTC timestamp, so lexical order is chronological.
old="$(git ls-remote --heads "${REMOTE}" 'refs/heads/sync-failed/*' | sed 's#.*refs/heads/##' | sort | awk -v k="${KEEP}" '{a[NR]=$0} END{for(i=1;i<=NR-k;i++)print a[i]}')"
[ -z "${old}" ] && { echo "nothing to prune (keeping ${KEEP})"; exit 0; }
while IFS= read -r b; do
  if [ "${DRY_RUN}" = "true" ]; then
    echo "[dry run] would delete ${b}"
  else
    git push "${REMOTE}" --delete "${b}" || echo "warning: could not delete ${b}" >&2
  fi
done <<<"${old}"
exit 0
