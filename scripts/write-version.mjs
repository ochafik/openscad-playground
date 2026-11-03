#!/usr/bin/env node
// Writes dist/version.json ({sha, ref, builtAt}) so deployments can be matched
// to the commit that was tested (scripts/smoke-deployment.mjs --expect-sha).
// Vercel's Git integration provides VERCEL_GIT_COMMIT_SHA / VERCEL_GIT_COMMIT_REF;
// elsewhere fall back to git, then "unknown".
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const git = (...a) => {
  try { return execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return ""; }
};
const version = {
  sha: process.env.VERCEL_GIT_COMMIT_SHA || git("rev-parse", "HEAD") || "unknown",
  ref: process.env.VERCEL_GIT_COMMIT_REF || git("rev-parse", "--abbrev-ref", "HEAD") || "unknown",
  builtAt: new Date().toISOString(),
};
// The pinned wasm2js fallback (scripts/fallback.json), so smoke tests can check
// that the deployed /openscad.fallback.js is exactly that file.
if (existsSync("scripts/fallback.json") && process.env.OPENSCAD_FALLBACK !== "off") {
  const { sha256, inputHash } = JSON.parse(readFileSync("scripts/fallback.json", "utf8"));
  version.fallback = { sha256, inputHash };
}
mkdirSync("dist", { recursive: true });
writeFileSync("dist/version.json", JSON.stringify(version) + "\n");
console.log("dist/version.json:", JSON.stringify(version));
