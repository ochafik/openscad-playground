#!/usr/bin/env node
// Writes dist/version.json ({sha, ref, builtAt}) so deployments can be matched
// to the commit that was tested (scripts/smoke-deployment.mjs --expect-sha).
// Vercel's Git integration provides VERCEL_GIT_COMMIT_SHA / VERCEL_GIT_COMMIT_REF;
// elsewhere fall back to git, then "unknown".
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const git = (...a) => {
  try { return execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return ""; }
};
const version = {
  sha: process.env.VERCEL_GIT_COMMIT_SHA || git("rev-parse", "HEAD") || "unknown",
  ref: process.env.VERCEL_GIT_COMMIT_REF || git("rev-parse", "--abbrev-ref", "HEAD") || "unknown",
  builtAt: new Date().toISOString(),
};
mkdirSync("dist", { recursive: true });
writeFileSync("dist/version.json", JSON.stringify(version) + "\n");
console.log("dist/version.json:", JSON.stringify(version));
