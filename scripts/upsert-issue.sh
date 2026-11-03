#!/usr/bin/env bash
# Opens an issue with the given title, or comments on the open one with that title.
#
#   scripts/upsert-issue.sh open  "<title>" <body-file>
#   scripts/upsert-issue.sh close "<title>" "<comment>"
#
# Needs `gh` and GH_TOKEN with issues: write. With DRY_RUN=true it only prints.
# Never fails the caller just because issues are unavailable (e.g. disabled on
# the fork): the run itself is already red, the issue is a convenience.
set -uo pipefail

mode="${1:?mode}"; title="${2:?title}"; arg="${3:-}"
DRY_RUN="${DRY_RUN:-false}"

if [ "${DRY_RUN}" = "true" ]; then
  echo "[dry run] would ${mode} issue: ${title}"
  [ "${mode}" = open ] && [ -f "${arg}" ] && sed 's/^/    /' "${arg}"
  exit 0
fi

number="$(gh issue list --state open --search "in:title \"${title}\"" --json number,title \
  --jq "[.[] | select(.title == \"${title}\")][0].number // empty")" || {
  echo "warning: cannot list issues (disabled or no permission)" >&2; exit 0; }

case "${mode}" in
  open)
    if [ -n "${number}" ]; then
      gh issue comment "${number}" --body-file "${arg}" || echo "warning: comment failed" >&2
    else
      gh issue create --title "${title}" --body-file "${arg}" || echo "warning: issue creation failed" >&2
    fi ;;
  close)
    [ -n "${number}" ] && { gh issue close "${number}" --comment "${arg}" || echo "warning: close failed" >&2; } ;;
  *) echo "unknown mode ${mode}" >&2; exit 2 ;;
esac
exit 0
