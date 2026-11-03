#!/usr/bin/env bash
# Merges upstream/main into the deploy branch, verifies the result, and pushes the
# green candidate to the STAGING branch (promotion to production is done by
# .github/workflows/smoke-deployment.yml after the staging deployment is smoked).
#
#   bash scripts/sync-upstream.sh
#
# Never rebases and never force-pushes: the candidate is a merge commit on top of
# the deploy branch, pushed only if every check passes. `staging` is disposable
# (it may hold an older, unpromoted candidate), so it is replaced with
# --force-with-lease; deploy/vercel itself is never pushed here.
# Used by .github/workflows/sync-upstream.yml; see docs/DEPLOYMENT_AUTOMATION.md.
#
# Environment (all optional):
#   DRY_RUN=true          do everything except the final push
#   MIN_AGE_HOURS=0       only merge upstream commits older than N hours
#   TARGET_BRANCH         deploy branch name (default deploy/vercel)
#   STAGING_BRANCH        where green candidates go (default staging)
#   FORCE=true            re-run even if staging already has this upstream commit
#   BASE_REF              what to merge into (default origin/$TARGET_BRANCH)
#   UPSTREAM_URL          added as remote `upstream` if missing
#   LOG_DIR               where logs, result.env and issue.md go (default: mktemp)
#   SKIP_CHECKS           comma-separated check names to skip (local debugging)
#   ALLOW_WORKFLOW_CHANGES=true  allow pushing merges that touch .github/workflows
#                         (needs a token with the `workflow` scope; GITHUB_TOKEN can't)
#   RUN_URL               link to the CI run, included in issue.md
#
# Exit codes: 0 up to date / synced / pushed; 10 merge conflict; 11 a check
# failed; 12 merge touches workflow files without permission to push it;
# 1 unexpected error. LOG_DIR/result.env always records STATUS, FAILED_STEP, ...

set -uo pipefail

TARGET_BRANCH="${TARGET_BRANCH:-deploy/vercel}"
ORIGIN_REMOTE="${ORIGIN_REMOTE:-origin}"
STAGING_BRANCH="${STAGING_BRANCH:-staging}"
FORCE="${FORCE:-false}"
BASE_REF="${BASE_REF:-${ORIGIN_REMOTE}/${TARGET_BRANCH}}"
UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/openscad/openscad-playground.git}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-main}"
DRY_RUN="${DRY_RUN:-false}"
MIN_AGE_HOURS="${MIN_AGE_HOURS:-0}"
SKIP_CHECKS="${SKIP_CHECKS:-}"
ALLOW_WORKFLOW_CHANGES="${ALLOW_WORKFLOW_CHANGES:-false}"
CANDIDATE_BRANCH="sync/candidate"
# Conservative internal limits (Vercel: serverless function 250 MB unzipped;
# static files are served from the CDN, these just catch runaway growth).
MAX_FUNCTION_BUNDLE_MB="${MAX_FUNCTION_BUNDLE_MB:-20}"
MAX_DIST_TOTAL_MB="${MAX_DIST_TOTAL_MB:-120}"
MAX_DIST_FILE_MB="${MAX_DIST_FILE_MB:-50}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}" || exit 1
LOG_DIR="${LOG_DIR:-$(mktemp -d)}"
mkdir -p "${LOG_DIR}"
RESULT_FILE="${LOG_DIR}/result.env"
ISSUE_FILE="${LOG_DIR}/issue.md"

STATUS="error"
FAILED_STEP=""
CONFLICTS=""
UPSTREAM_SHA=""
MERGED_SHA=""
CANDIDATE_SHA=""
ISSUE_TITLE=""
FAILED_LOG=""

log() { printf '\n==> %s\n' "$*"; }

write_result() {
  {
    echo "status=${STATUS}"
    echo "failed_step=${FAILED_STEP}"
    echo "conflicts=${CONFLICTS}"
    echo "upstream_sha=${UPSTREAM_SHA}"
    echo "merged_sha=${MERGED_SHA}"
    echo "candidate_sha=${CANDIDATE_SHA}"
    echo "issue_title=${ISSUE_TITLE}"
    echo "log_dir=${LOG_DIR}"
  } >"${RESULT_FILE}"
}
trap write_result EXIT

run_url_line() { [ -n "${RUN_URL:-}" ] && echo "Run: ${RUN_URL}"; return 0; }

# shellcheck disable=SC2016  # literal backticks (markdown)
bullets() { local f; for f in $1; do printf -- '- `%s`\n' "$f"; done; }

write_issue() { # title, then body on stdin
  ISSUE_TITLE="$1"
  { cat; echo; run_url_line; } >"${ISSUE_FILE}"
}

# ---------------------------------------------------------------- remotes
git config user.name  >/dev/null 2>&1 || git config user.name  "github-actions[bot]"
git config user.email >/dev/null 2>&1 || git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

if ! git remote get-url upstream >/dev/null 2>&1; then
  git remote add upstream "${UPSTREAM_URL}"
fi

log "Fetching upstream/${UPSTREAM_BRANCH} and ${BASE_REF}"
git fetch --no-tags upstream "${UPSTREAM_BRANCH}:refs/remotes/upstream/${UPSTREAM_BRANCH}" || { echo "fetch failed" >&2; exit 1; }
if [ "${BASE_REF}" = "${ORIGIN_REMOTE}/${TARGET_BRANCH}" ]; then
  git fetch --no-tags "${ORIGIN_REMOTE}" "${TARGET_BRANCH}:refs/remotes/${ORIGIN_REMOTE}/${TARGET_BRANCH}" || { echo "fetch of base failed" >&2; exit 1; }
fi
BASE_SHA="$(git rev-parse --verify "${BASE_REF}^{commit}")" || exit 1

# ---------------------------------------------------------------- pick the upstream commit
if [ "${MIN_AGE_HOURS}" -gt 0 ] 2>/dev/null; then
  # Newest first-parent commit that is at least MIN_AGE_HOURS old (cooling-off).
  UPSTREAM_SHA="$(git rev-list -n1 --first-parent --before="${MIN_AGE_HOURS} hours ago" "upstream/${UPSTREAM_BRANCH}")"
else
  UPSTREAM_SHA="$(git rev-parse "upstream/${UPSTREAM_BRANCH}")"
fi
if [ -z "${UPSTREAM_SHA}" ]; then
  echo "No upstream commit is older than ${MIN_AGE_HOURS}h; nothing to do."
  STATUS="up-to-date"; exit 0
fi
if git merge-base --is-ancestor "${UPSTREAM_SHA}" "${BASE_SHA}"; then
  echo "Already contains upstream ${UPSTREAM_SHA:0:9}; nothing to do."
  STATUS="up-to-date"; exit 0
fi
STAGING_SHA=""
if git fetch --no-tags "${ORIGIN_REMOTE}" "${STAGING_BRANCH}:refs/remotes/${ORIGIN_REMOTE}/${STAGING_BRANCH}" 2>/dev/null; then
  STAGING_SHA="$(git rev-parse "refs/remotes/${ORIGIN_REMOTE}/${STAGING_BRANCH}")"
  if [ "${FORCE}" != "true" ] && git merge-base --is-ancestor "${UPSTREAM_SHA}" "${STAGING_SHA}" \
     && git merge-base --is-ancestor "${BASE_SHA}" "${STAGING_SHA}"; then
    echo "${STAGING_BRANCH} (${STAGING_SHA:0:9}) already contains upstream ${UPSTREAM_SHA:0:9}; awaiting promotion."
    STATUS="up-to-date"; exit 0
  fi
fi
NEW_COMMITS="$(git rev-list --count "${BASE_SHA}..${UPSTREAM_SHA}")"
log "Merging ${NEW_COMMITS} upstream commit(s) up to ${UPSTREAM_SHA:0:9} into ${BASE_REF} (${BASE_SHA:0:9})"

# ---------------------------------------------------------------- merge
git checkout -q -B "${CANDIDATE_BRANCH}" "${BASE_SHA}" || exit 1
if ! git merge --no-edit -m "Merge upstream/${UPSTREAM_BRANCH} (${UPSTREAM_SHA:0:9}) into ${TARGET_BRANCH}" "${UPSTREAM_SHA}" >"${LOG_DIR}/merge.log" 2>&1; then
  CONFLICTS="$(git diff --name-only --diff-filter=U | tr '\n' ' ' | sed 's/ $//')"
  git merge --abort 2>/dev/null || true
  git checkout -q "${BASE_SHA}" 2>/dev/null || true
  STATUS="conflict"; FAILED_STEP="merge"
  cat "${LOG_DIR}/merge.log"
  write_issue "Upstream sync conflict" <<MD
Merging \`upstream/${UPSTREAM_BRANCH}\` (${UPSTREAM_SHA}) into \`${TARGET_BRANCH}\` (${BASE_SHA:0:9}) conflicts.

Conflicting files:
$(bullets "${CONFLICTS}")

Resolve locally, then push to \`${TARGET_BRANCH}\`:

\`\`\`
git fetch upstream origin
git checkout ${TARGET_BRANCH} && git merge upstream/${UPSTREAM_BRANCH}
# fix conflicts, run the checks, commit, push
\`\`\`
MD
  exit 10
fi
CANDIDATE_SHA="$(git rev-parse HEAD)"
MERGED_SHA="${CANDIDATE_SHA}"

# GITHUB_TOKEN may not create/update files under .github/workflows.
WORKFLOW_FILES="$(git diff --name-only "${BASE_SHA}" HEAD -- .github/workflows | tr '\n' ' ' | sed 's/ $//')"
if [ -n "${WORKFLOW_FILES}" ] && [ "${ALLOW_WORKFLOW_CHANGES}" != "true" ]; then
  STATUS="blocked-workflows"; FAILED_STEP="workflow-files"; CONFLICTS="${WORKFLOW_FILES}"
  echo "Merge changes workflow files (${WORKFLOW_FILES}); GITHUB_TOKEN cannot push those."
  write_issue "Upstream sync needs a manual merge" <<MD
The upstream merge (${UPSTREAM_SHA}) changes workflow files, which the default \`GITHUB_TOKEN\` is not allowed to push:

$(bullets "${WORKFLOW_FILES}")

Merge manually (\`git fetch upstream && git merge upstream/${UPSTREAM_BRANCH}\`) and push, or add a \`SYNC_PUSH_TOKEN\` secret (PAT with \`workflow\` scope) to let the sync workflow do it.
MD
  exit 12
fi

# ---------------------------------------------------------------- checks
skipped() { case ",${SKIP_CHECKS}," in *",$1,"*) return 0;; esac; return 1; }

# run_check <name> <command...>: logs to LOG_DIR/<name>.log, stops the sync on failure.
run_check() {
  local name="$1"; shift
  if skipped "${name}"; then log "Check ${name}: SKIPPED"; return 0; fi
  log "Check ${name}: $*"
  local t0=$SECONDS
  if "$@" >"${LOG_DIR}/${name}.log" 2>&1; then
    echo "    ok (${name}, $((SECONDS - t0))s)"
  else
    echo "    FAILED (${name}, $((SECONDS - t0))s); last lines:"
    tail -n 40 "${LOG_DIR}/${name}.log" | sed 's/^/    | /'
    STATUS="failed"; FAILED_STEP="${name}"; FAILED_LOG="${LOG_DIR}/${name}.log"
    write_issue "Upstream sync failed" <<MD
Merging \`upstream/${UPSTREAM_BRANCH}\` (${UPSTREAM_SHA}) into \`${TARGET_BRANCH}\` (${BASE_SHA:0:9}) produced a candidate that fails the check **${name}**. Nothing was pushed to \`${STAGING_BRANCH}\` or \`${TARGET_BRANCH}\`.

Last lines of the log:

\`\`\`
$(tail -n 60 "${FAILED_LOG}")
\`\`\`
MD
    exit 11
  fi
}

check_sizes() {
  local fn_kb dist_kb big
  fn_kb="$(du -k api/_server.mjs | cut -f1)"
  dist_kb="$(du -sk dist | cut -f1)"
  echo "function bundle: $((fn_kb / 1024)) MB (limit ${MAX_FUNCTION_BUNDLE_MB}); dist: $((dist_kb / 1024)) MB (limit ${MAX_DIST_TOTAL_MB})"
  [ "${fn_kb}" -le $((MAX_FUNCTION_BUNDLE_MB * 1024)) ] || { echo "function bundle too large"; return 1; }
  [ "${dist_kb}" -le $((MAX_DIST_TOTAL_MB * 1024)) ] || { echo "dist too large"; return 1; }
  big="$(find dist -type f -size +"${MAX_DIST_FILE_MB}"M)"
  [ -z "${big}" ] || { echo "files over ${MAX_DIST_FILE_MB} MB:"; echo "${big}"; return 1; }
}

mcp_smoke() {
  local port="${SMOKE_PORT:-9187}" pid rc=0
  (cd server && OPENSCAD_SERVE_DIST=1 PORT="${port}" HOST=127.0.0.1 exec npx tsx index.ts) >"${LOG_DIR}/server.log" 2>&1 &
  pid=$!
  for _ in $(seq 1 60); do
    curl -fsS -o /dev/null "http://127.0.0.1:${port}/index.js" 2>/dev/null && break
    kill -0 "${pid}" 2>/dev/null || { echo "server exited early"; cat "${LOG_DIR}/server.log"; return 1; }
    sleep 1
  done
  node scripts/smoke-deployment.mjs "http://127.0.0.1:${port}" --host-header "127.0.0.1:${port}" \
    --expect-sha "$(git rev-parse HEAD)" || rc=$?
  # tsx runs node as a child of npx; stop the whole group.
  pkill -P "${pid}" 2>/dev/null || true
  kill "${pid}" 2>/dev/null || true
  wait "${pid}" 2>/dev/null || true
  return "${rc}"
}

e2e() { CI=true NODE_ENV=production npm run test:e2e -- --runInBand; }

run_check npm-ci             npm ci
run_check server-install     bash -c 'cd server && npm ci'
run_check build-all          env OPENSCAD_MCP_URL=/mcp npm run build:all
run_check typecheck          npx tsc --noEmit
run_check mcp-function       bash scripts/build-mcp-function.sh
run_check sizes              check_sizes
run_check server-tests       bash -c 'cd server && npm test'
run_check version-file       env VERCEL_GIT_COMMIT_SHA="$(git rev-parse HEAD)" node scripts/write-version.mjs
run_check mcp-smoke          mcp_smoke
run_check e2e                e2e

# ---------------------------------------------------------------- publish
if [ "${DRY_RUN}" = "true" ]; then
  STATUS="synced"
  log "DRY RUN: all checks passed; would push ${CANDIDATE_SHA:0:9} to ${ORIGIN_REMOTE}/${STAGING_BRANCH}"
  exit 0
fi
log "Pushing ${CANDIDATE_SHA:0:9} to ${ORIGIN_REMOTE}/${STAGING_BRANCH}"
if [ -n "${STAGING_SHA}" ]; then
  lease="--force-with-lease=refs/heads/${STAGING_BRANCH}:${STAGING_SHA}"
else
  lease="--force-with-lease=refs/heads/${STAGING_BRANCH}:"
fi
if git push "${lease}" "${ORIGIN_REMOTE}" "${CANDIDATE_BRANCH}:refs/heads/${STAGING_BRANCH}"; then
  STATUS="pushed"
else
  STATUS="failed"; FAILED_STEP="push"
  write_issue "Upstream sync failed" <<MD
All checks passed for the merge of \`upstream/${UPSTREAM_BRANCH}\` (${UPSTREAM_SHA}), but pushing to \`${STAGING_BRANCH}\` was rejected (the branch moved concurrently, or the token lacks permission).
MD
  exit 11
fi
