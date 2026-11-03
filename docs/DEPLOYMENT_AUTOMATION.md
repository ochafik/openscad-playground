# Deployment automation (fork: ochafik/openscad-playground)

Production (https://openscad.ochafik.com) is deployed by Vercel from the
`deploy/vercel` branch of the fork. That branch is `upstream/main` plus a few
deploy-specific commits (`vercel.json`, `.vercelignore`, `api/mcp.ts`,
`server/vercel-entry.ts`, `scripts/vercel-prebuild.sh`,
`scripts/build-mcp-function.sh`) and the automation described here.

## Architecture

```
upstream/main --(every 6 h)--> sync-upstream.yml
                                  merge + build + tests + MCP smoke (local)
                                          | green
                                          v
                                  branch `staging` ----(Vercel Git integration)----> Preview deployment
                                                                                    https://staging.openscad.ochafik.com
                                                                                           |
                                          deployment_status: success (Preview)             v
                                  smoke-deployment.yml: smoke staging + /version.json == tested sha
                                          | green                         | red: issue "Staging smoke failed for <sha>", no promotion
                                          v
                                  promote: fast-forward deploy/vercel to the tested sha (ff-only)
                                          |   (Vercel Production deploy)
                                          v
                                  wait for /version.json == sha on https://openscad.ochafik.com, smoke production
                                          | red: issue "Production smoke failed for <sha>" + rollback instructions
```

Emergency bypass: `fast-track.yml` (below).

1. **`.github/workflows/sync-upstream.yml`** (runs `scripts/sync-upstream.sh`)
   - fetches `upstream/main`; exits if `deploy/vercel` already contains it, or
     if `staging` already contains it (awaiting promotion; `force` input
     overrides). Optionally only considers commits older than `min_age_hours`;
   - merges it (`git merge`, never rebase) into a temporary `sync/candidate`
     branch cut from `deploy/vercel`;
   - checks: `npm ci`, `cd server && npm ci`, `npm run build:all` (with
     `OPENSCAD_MCP_URL=/mcp` as on Vercel), `npx tsc --noEmit`,
     `scripts/build-mcp-function.sh`, size limits (function bundle < 20 MB,
     `dist/` < 120 MB, no file > 50 MB; Vercel's hard limit for a function is
     250 MB unzipped, these catch runaway growth early), server tests, the
     build-version file, an MCP smoke test against a locally started server,
     and the production-mode e2e suite;
   - all green: pushes the candidate to **`staging`** (disposable branch, may
     be replaced with `--force-with-lease`). `deploy/vercel` is never touched
     here;
   - the `staging` branch does not need to exist beforehand; the first green
     candidate creates it. A merge that touches `.github/workflows/*` cannot be
     pushed with the default token (to `staging` either); it is reported as
     `Upstream sync needs a manual merge` unless `SYNC_PUSH_TOKEN` is set;
   - conflict or failed check: nothing is pushed to `staging` or
     `deploy/vercel`. The candidate goes to `sync-failed/<UTC date-time>` (when
     possible) and an issue is opened or commented on (`Upstream sync conflict`
     / `Upstream sync failed`) with the failing step, log tail and run link.
     The run is marked failed. The next successful sync closes the issue.
   - inputs: `dry_run`, `force`, `min_age_hours` (cooling-off; scheduled runs
     use the repository variable `SYNC_MIN_AGE_HOURS`, default 0).
2. **`.github/workflows/smoke-deployment.yml`** (runs `scripts/smoke-deployment.mjs`)
   - job `staging`: on `deployment_status` success for an environment starting
     with `Preview`, or whose `deployment.ref` is `staging`. It only acts if `deployment.sha` is the current head of
     `staging` (other previews are ignored). Smokes
     `https://staging.openscad.ochafik.com` (repo variable `STAGING_URL`
     overrides) and asserts that `/version.json` reports the tested sha, and
     that the MCP CSP and `openscad-base-url` equal the staging origin.
   - job `promote` (needs `staging`, `contents: write`): refuses if staging
     moved or the sha is not a fast-forward of `deploy/vercel`, then
     `git push origin <sha>:deploy/vercel` (no force), waits (up to 20 min) for
     production to serve that sha, and smokes production.
   - job `production`: on a `Production` `deployment_status` (e.g. a manual
     push or a fast-track), a plain smoke with retries.
   - `workflow_dispatch`: inputs `url`, `sha`, `promote`, `dry_run` (default
     true). Smoke any URL; with `promote=true` also promote `sha` after a
     green smoke (this is "promote manually"). `dry_run=true` checks
     everything but pushes nothing.
   - Vercel's exact payload naming (`deployment.environment` is `Preview` /
     `Production`, `deployment.sha`, `deployment.ref`) was not verifiable
     before the integration exists; the staging job deliberately matches on
     sha, not on `ref`, to be robust. Check the first real run's event.
3. **`.github/workflows/fast-track.yml`**: emergency bypass, see below.
4. **`scripts/smoke-deployment.mjs [url] [--origin O] [--host-header H] [--expect-sha S] [--wait-s N] [--skip-static]`**
   checks `/`, `/index.js`, `/openscad.wasm`, `/libraries/index.json`,
   framability (no `X-Frame-Options`/`frame-ancestors`), the `/mcp` help page,
   CORS preflight, `initialize`, `tools/list` (`create`),
   `resources/read ui://openscad/viewer.html` (CSP domains and
   `openscad-base-url` equal the requested origin), a headless-Chrome check
   that the site renders with no `WebAssembly` global (`--js-flags=--jitless`;
   fails on any `pageerror`, waits up to 120 s for "Total rendering time";
   prints SKIP if puppeteer/Chrome are unavailable; the workflow installs
   puppeteer with `--no-save` and uses the runner's `google-chrome`; skipped
   by `--skip-static`) and, with `--expect-sha`,
   that `/version.json` reports that commit (`--wait-s` polls for it first).
   Prints a PASS/FAIL table, exits 1 on any failure.
5. **`scripts/write-version.mjs`** writes `dist/version.json`
   (`{sha, ref, builtAt}`, from `VERCEL_GIT_COMMIT_SHA`); `vercel.json` runs it
   after `build:all`. Note: `vercel deploy` from a local directory has no git
   sha, so such deployments report the local HEAD or `unknown`.
6. **`scripts/upsert-issue.sh`**: open-or-comment / close issues via `gh`.

## The wasm2js fallback (WebAssembly-less browsers)

`openscad.fallback.js` (~22 MB, see `docs/WASM_FALLBACK.md`) needs Docker-class
tooling to build, which Vercel does not have, so it is built in GitHub Actions
and delivered to the Vercel build as a pinned download:

1. **Input hash** (`scripts/fallback-input-hash.sh`): sha256 over the git blobs of
   `scripts/build-wasm-fallback.sh` (pins the OpenSCAD and Binaryen refs) and
   `scripts/patches/**`, the same inputs `build-fallback.yml` caches on.
2. **`publish-fallback.yml`** builds the recipe at a `ref` and publishes the
   GitHub Release `fallback-<first 16 hex of the hash>` (prerelease) with assets
   `openscad.fallback.js`, `.sha256` and `fallback.json`
   (`{url, sha256, inputHash, openscadCommit, builtAt}`). A no-op if the release
   exists; the build is ~25 min cold, a few minutes with warm caches. Run it by
   hand with Actions > "Publish wasm2js fallback" (`force` rebuilds).
3. **`sync-upstream.yml`**: job `plan` merges upstream and asks whether the merged
   recipe has a release. If not, it pushes the candidate to the temporary branch
   `sync-pending`, job `fallback` builds it, and job `sync` then runs as usual.
   `sync-upstream.sh` runs `scripts/pin-fallback.sh`, which commits the release's
   `fallback.json` as `scripts/fallback.json` into the candidate before the
   checks, so staging (and, after promotion, production) is built with that pin.
4. **`scripts/vercel-prebuild.sh`** downloads `url` (`curl -fL --retry 3`) to
   `public/openscad.fallback.js` and verifies `sha256`; a missing pin, 404 or
   mismatch fails the build. `OPENSCAD_FALLBACK=off` skips it,
   `OPENSCAD_FALLBACK_FILE=/path` uses a local copy. webpack copies it to
   `dist/` unminified and out of the service worker precache.
5. **Smoke**: `smoke-deployment.mjs` requires `/openscad.fallback.js` to be a
   200 JavaScript response over 10 MB whose sha256 equals the pin exposed in
   `/version.json` (`fallback.sha256`), and a jitless headless Chrome must render
   the default model through it ("renders with no WebAssembly"). The sync's `fallback-fetch` check runs the
   same prebuild step on the candidate.

The first release can be created by the sync itself (it will wait ~25 min once)
or from the latest CI artifact with `scripts/bootstrap-fallback-release.sh`.
Old `fallback-*` releases can be deleted once no branch pins them.

## One-time owner steps

1. **Merge the automation into `deploy/vercel`** (fast-forward from
   `deploy/automation`).
2. **Settings > General > Default branch**: `deploy/vercel`. Scheduled and
   `deployment_status` workflows only run from the default branch.
3. **Settings > General > Features**: enable **Issues** (disabled on the fork
   today; otherwise failures are only visible as red runs).
4. **Settings > Actions > General**: allow Actions; Workflow permissions:
   "Read and write". Scheduled workflows are disabled after 60 days without
   repository activity; re-enable from the Actions tab if that happens.
5. **Vercel dashboard > project `openscad-playground` > Settings > Git**:
   connect `ochafik/openscad-playground` (install the Vercel GitHub app on the
   fork); **Production Branch** = `deploy/vercel`. Branches other than that
   deploy as Previews; `staging` is one of them. The same `vercel.json` build
   command applies to previews, so `OPENSCAD_MCP_URL=/mcp` is set there too.
   Consider an Ignored Build Step so `sync/*`, `sync-failed/*` and
   `ci-test/*` branches do not build.
6. **Staging domain**: Settings > Domains > add `staging.openscad.ochafik.com`
   and assign it to Git branch `staging` (custom domains are not covered by
   Deployment Protection, so it is public, which the smoke test needs). At the
   DNS provider (Namecheap): CNAME `staging.openscad` to the target Vercel
   shows for the domain (typically `cname.vercel-dns.com`). The app derives its
   base URL from the request host, so no further configuration is needed.
7. Optional: repository variable `SYNC_MIN_AGE_HOURS` (e.g. `24`) for a
   cooling-off period; `STAGING_URL` / `PRODUCTION_URL` to point the smoke
   tests elsewhere.
8. Optional: secret `SYNC_PUSH_TOKEN` (fine-grained PAT with contents and
   workflows write) so merges that change `.github/workflows/*` can be pushed.
   Without it those merges are reported as `Upstream sync needs a manual
   merge`, because `GITHUB_TOKEN` cannot modify workflow files.
9. Optional hardening for the emergency path: create a GitHub Environment
   (e.g. `production`) with required reviewers and add `environment: production`
   to the `ship` job of `fast-track.yml`.

No secret is required, and none is committed.

## Emergency procedure (fast-track)

Actions > "Fast-track to production" > Run workflow:
- `ref`: sha or branch to ship (default `staging`); it must fast-forward
  `deploy/vercel` (the workflow refuses otherwise; no force push);
- `reason`: required; recorded in the run summary along with the actor;
- `skip_checks` (default true): when false, a quick gate (`npm ci`, server
  tests, `tsc`, function bundle) runs first.

It pushes straight to `deploy/vercel` (production deploys), waits for
`/version.json` to report that sha and smokes production, opening an issue
with rollback instructions if that fails. Guardrails: only users with write
access to the repository can dispatch workflows; there is no CODEOWNERS
involvement; the run and its reason are in the Actions log; see step 9 above
to add a required-reviewer gate. To fix a broken commit, push the fix to a
branch, then fast-track its sha.

## When something goes wrong

- **Conflict**: the issue lists the files. Locally:
  `git fetch upstream origin && git checkout deploy/vercel && git merge upstream/main`,
  resolve, push the result to `staging` (it will be smoked and promoted like a
  sync candidate) or fast-track it.
- **Failed check / failed staging smoke**: inspect the issue/run (sync logs
  are uploaded as the `sync-logs` artifact) and the `sync-failed/...` branch.
  A failed staging smoke leaves production untouched; fix forward or re-run
  with `force`. Old `sync-failed/*` branches are pruned automatically (newest 5 kept,
  `scripts/prune-sync-failed.sh`).
- **Bad production deploy**: Vercel dashboard > Deployments > previous
  production deployment > **Instant Rollback**; then `git revert -m 1 <merge>`
  on `deploy/vercel` (a rollback pins production until you promote again).
- **Pause**: disable "Sync upstream" (stops new candidates); disable "Smoke
  test and promote" (staging deploys but nothing is promoted: promotion then
  only happens by hand via `workflow_dispatch` with `promote`, or fast-track);
  or set `SYNC_MIN_AGE_HOURS` very large.
- **Promote manually**: Actions > "Smoke test and promote" > Run workflow with
  `sha`, `promote=true`, `dry_run=false`.
- **Manual deploy fallback**: from a checkout of `deploy/vercel`,
  `vercel deploy --prod`.

## Security notes

- Anything merged upstream goes live on the production domain after only the
  automated checks (including a smoke test of the real staging deployment). Use the cooling-off period to give maintainers time to
  notice and revert bad or malicious upstream commits, and consider reviewing
  the `Merge upstream` commits periodically.
- Third-party actions are pinned by commit SHA; update them deliberately.
- Workflows use minimal permissions (`contents: write` + `issues: write` for
  sync, promote and fast-track; `contents: read` + `issues: write` otherwise) and no secrets.
- Pushes made with `GITHUB_TOKEN` do not trigger other workflows (that is why
  all tests run inside the sync workflow and the smoke/promote chain is driven
  by Vercel's `deployment_status` events, not by the push); Vercel's integration is
  independent and does deploy them.
- Local testing: `DRY_RUN=true BASE_REF=<ref> bash scripts/sync-upstream.sh`
  from a scratch worktree (it switches branches); `SKIP_CHECKS=e2e,...` skips
  checks (e2e needs ports 3000 free).
