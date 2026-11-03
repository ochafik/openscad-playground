# Deployment automation (fork: ochafik/openscad-playground)

Production (https://openscad.ochafik.com) is deployed by Vercel from the
`deploy/vercel` branch of the fork. That branch is `upstream/main` plus a few
deploy-specific commits (`vercel.json`, `.vercelignore`, `api/mcp.ts`,
`server/vercel-entry.ts`, `scripts/vercel-prebuild.sh`,
`scripts/build-mcp-function.sh`) and the automation described here.

## Architecture

```
upstream/main --(every 6 h)--> sync-upstream.yml --(all checks green, push)--> deploy/vercel
                                                                                   |
                                      Vercel GitHub integration (production branch) v
                                                                              Production deploy
                                                                                   |
                                   deployment_status: success --> smoke-deployment.yml
```

1. **`.github/workflows/sync-upstream.yml`** (runs `scripts/sync-upstream.sh`)
   - fetches `upstream/main`; exits if the deploy branch already contains it
     (optionally only considering commits older than `min_age_hours`);
   - merges it (`git merge`, never rebase, never force-push) into a temporary
     `sync/candidate` branch cut from `deploy/vercel`;
   - checks: `npm ci`, `cd server && npm ci`, `npm run build:all` (with
     `OPENSCAD_MCP_URL=/mcp` as on Vercel), `npx tsc --noEmit`,
     `scripts/build-mcp-function.sh`, size limits (function bundle < 20 MB,
     `dist/` < 120 MB, no file > 50 MB; Vercel's hard limit for a function is
     250 MB unzipped, these catch runaway growth early), server tests, an MCP
     smoke test against a locally started server
     (`scripts/smoke-deployment.mjs`), and the production-mode e2e suite;
   - all green: fast-forward push of the merge commit to `deploy/vercel`;
   - conflict or failed check: nothing is pushed to `deploy/vercel`. The
     candidate is pushed to `sync-failed/<UTC date-time>` (when possible) and an
     issue is opened (or commented on): `Upstream sync conflict` /
     `Upstream sync failed`, with the failing step, log tail and run link. The
     run is also marked failed. The issue is closed automatically by the next
     successful sync.
   - inputs: `dry_run` (everything except pushes, branches and issues),
     `min_age_hours` (cooling-off; scheduled runs use the repository variable
     `SYNC_MIN_AGE_HOURS`, default 0).
2. **`.github/workflows/smoke-deployment.yml`** (runs `scripts/smoke-deployment.mjs`)
   triggers on `deployment_status` with state `success` and an environment
   starting with `Production` (Vercel reports `Production`, or
   `Production – <project>` when a repo has several projects), or manually with
   a `url`. It always tests the production alias (the per-deployment URL may
   be behind deployment protection), retrying 3 times for alias lag. On
   failure it opens `Smoke test failed for <sha>`.
3. **`scripts/smoke-deployment.mjs [url] [--origin O] [--host-header H] [--skip-static]`**
   checks `/`, `/index.js`, `/openscad.wasm`, `/libraries/index.json`,
   framability (no `X-Frame-Options`/`frame-ancestors`), the `/mcp` help page,
   CORS preflight, `initialize`, `tools/list` (`create`) and
   `resources/read ui://openscad/viewer.html` (CSP domains and
   `openscad-base-url` equal the requested origin). Prints a PASS/FAIL table,
   exits 1 on any failure. `--origin` sets the expected origin when it differs
   from the URL; `--host-header` sends a custom `Host`.
4. **`scripts/upsert-issue.sh`**: open-or-comment / close issues via `gh`.

## One-time owner steps

1. **Merge the automation into `deploy/vercel`** (fast-forward from
   `deploy/automation`), **without** the temporary `ci-test/*` push trigger
   (already removed in the final commit).
2. **Settings > General > Default branch**: change to `deploy/vercel`.
   Scheduled workflows and `deployment_status` workflows only run from the
   default branch.
3. **Settings > General > Features**: enable **Issues** (disabled on the fork
   today; without it failures are only visible as red runs).
4. **Settings > Actions > General**: allow Actions; under Workflow permissions
   choose "Read and write permissions" (the workflows also declare their own
   minimal `permissions:`). Confirm scheduled workflows are enabled (GitHub
   disables them after 60 days without repository activity; the sync pushes
   keep it alive, or re-enable them from the Actions tab).
5. **Vercel dashboard > project `openscad-playground` > Settings > Git**:
   connect the GitHub repository `ochafik/openscad-playground` (install the
   Vercel GitHub app on the fork), set **Production Branch** to `deploy/vercel`.
   Other branches then produce Preview deployments (consider disabling
   previews for `sync-failed/*` and `sync/*`, via Ignored Build Step or
   Settings > Git).
6. Optional: set repository variable `SYNC_MIN_AGE_HOURS` (e.g. `24`) for a
   cooling-off period.
7. Optional: secret `SYNC_PUSH_TOKEN` (fine-grained PAT, contents + workflows
   write) so merges that change `.github/workflows/*` can be pushed. Without
   it those merges are reported as `Upstream sync needs a manual merge`,
   because `GITHUB_TOKEN` is not allowed to modify workflow files.

No secret is required, and none is committed.

## When something goes wrong

- **Conflict**: the issue lists the files. Locally:
  `git fetch upstream origin && git checkout deploy/vercel && git merge upstream/main`,
  resolve, run the checks (or run `DRY_RUN=true bash scripts/sync-upstream.sh`),
  push. Until then every 6 h run retries and updates the same issue.
- **Failed check**: inspect the issue/run (logs are also uploaded as the
  `sync-logs` artifact) and the `sync-failed/...` branch.
  Delete old `sync-failed/*` branches when done.
- **Bad deploy**: Vercel dashboard > Deployments > previous production
  deployment > **Instant Rollback**; then `git revert -m 1 <merge>` on
  `deploy/vercel` (a rollback pins production until you promote again).
- **Pause**: Actions > "Sync upstream" > "..." > Disable workflow (or set
  repository variable `SYNC_MIN_AGE_HOURS` very large).
- **Manual deploy fallback**: from a checkout of `deploy/vercel`,
  `vercel deploy --prod`.

## Security notes

- Anything merged upstream goes live on the production domain after only the
  automated checks. Use the cooling-off period to give maintainers time to
  notice and revert bad or malicious upstream commits, and consider reviewing
  the `Merge upstream` commits periodically.
- Third-party actions are pinned by commit SHA; update them deliberately.
- Workflows use minimal permissions (`contents: write` and `issues: write`
  for sync, `contents: read` and `issues: write` for smoke) and no secrets.
- Pushes made with `GITHUB_TOKEN` do not trigger other workflows (that is why
  all tests run inside the sync workflow); Vercel's integration is
  independent and does deploy them.
- Local testing: `DRY_RUN=true BASE_REF=<ref> bash scripts/sync-upstream.sh`
  from a scratch worktree (it switches branches); `SKIP_CHECKS=e2e,...` skips
  checks (e2e needs ports 3000 free).
