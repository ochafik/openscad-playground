#!/usr/bin/env node
// Smoke test for a deployed (or locally started) OpenSCAD Playground + MCP server.
//
//   node scripts/smoke-deployment.mjs [url] [--origin ORIGIN] [--host-header HOST]
//                                     [--skip-static] [--timeout-ms N]
//
//   url            Site root (default https://openscad.ochafik.com).
//   --origin       Origin the server is expected to advertise in the MCP CSP and
//                  `openscad-base-url` meta (default: the origin of `url`).
//   --host-header  Send this Host header on every request (emulates a public
//                  host against a local server; the expected origin then
//                  defaults to http(s)://HOST).
//   --skip-static  Only run the MCP checks (e.g. server without OPENSCAD_SERVE_DIST).
//
// Exits 0 when every check passes, 1 otherwise, printing a table either way.

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};

const originOpt = opt("--origin");
const hostHeader = opt("--host-header");
const timeoutMs = Number(opt("--timeout-ms") ?? 30000);
const skipStatic = flag("--skip-static");
const base = new URL(args[0] ?? "https://openscad.ochafik.com");
const root = base.origin;
const expectedOrigin = (
  originOpt ?? (hostHeader ? `${base.protocol}//${hostHeader}` : root)
).replace(/\/+$/, "");

const results = [];

async function check(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail ?? "", ms: Date.now() - t0 });
  } catch (e) {
    results.push({ name, ok: false, detail: String(e?.message ?? e), ms: Date.now() - t0 });
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function http(path, init = {}) {
  const headers = { ...(init.headers ?? {}) };
  if (hostHeader) headers.host = hostHeader;
  const res = await fetch(root + path, {
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
    ...init,
    headers,
  });
  return res;
}

// MCP responses are either plain JSON or an SSE stream with one `data:` event.
async function readRpc(res) {
  const text = await res.text();
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("text/event-stream")) {
    const data = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .pop();
    assert(data, `no SSE data event in: ${text.slice(0, 200)}`);
    return JSON.parse(data);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status}, not JSON: ${text.slice(0, 200)}`);
  }
}

let rpcId = 0;
async function rpc(method, params) {
  const res = await http("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const body = await readRpc(res);
  assert(!body.error, `${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

// ---- static site -----------------------------------------------------------

if (!skipStatic) {
  await check("GET / is 200 html", async () => {
    const res = await http("/");
    assert(res.status === 200, `status ${res.status}`);
    const ct = res.headers.get("content-type") ?? "";
    assert(ct.includes("text/html"), `content-type ${ct}`);
    const html = await res.text();
    assert(/<html|<!doctype/i.test(html), "body is not HTML");
    return `${html.length} bytes`;
  });

  await check("GET /index.js is 200 javascript", async () => {
    const res = await http("/index.js");
    assert(res.status === 200, `status ${res.status}`);
    const ct = res.headers.get("content-type") ?? "";
    assert(/javascript/.test(ct), `content-type ${ct}`);
    await res.arrayBuffer();
    return ct;
  });

  await check("GET /openscad.wasm is 200 application/wasm", async () => {
    const res = await http("/openscad.wasm");
    assert(res.status === 200, `status ${res.status}`);
    const ct = res.headers.get("content-type") ?? "";
    assert(ct.startsWith("application/wasm"), `content-type ${ct}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    assert(buf[0] === 0 && buf[1] === 0x61 && buf[2] === 0x73 && buf[3] === 0x6d, "missing \\0asm magic");
    return `${buf.length} bytes`;
  });

  await check("GET /libraries/index.json has expected shape", async () => {
    const res = await http("/libraries/index.json");
    assert(res.status === 200, `status ${res.status}`);
    const j = await res.json();
    assert(typeof j.version === "number", "no numeric `version`");
    assert(j.libraries && typeof j.libraries === "object", "no `libraries` object");
    const names = Object.keys(j.libraries);
    assert(names.includes("openscad"), "no `openscad` library entry");
    const lib = j.libraries.openscad;
    assert(typeof lib.zipBytes === "number" && Array.isArray(lib.files), "openscad entry lacks zipBytes/files");
    return `${names.length} libraries`;
  });

  await check("GET / is framable (no X-Frame-Options / frame-ancestors)", async () => {
    const res = await http("/");
    assert(res.status === 200, `status ${res.status}`);
    const xfo = res.headers.get("x-frame-options");
    assert(!xfo, `X-Frame-Options: ${xfo}`);
    for (const h of ["content-security-policy", "content-security-policy-report-only"]) {
      const v = res.headers.get(h);
      assert(!v || !/frame-ancestors/i.test(v), `${h}: ${v}`);
    }
    return "no framing blockers";
  });
}

// ---- MCP endpoint ----------------------------------------------------------

await check("GET /mcp (browser Accept) serves html help page", async () => {
  const res = await http("/mcp", { headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" } });
  assert(res.status === 200, `status ${res.status}`);
  const ct = res.headers.get("content-type") ?? "";
  assert(ct.includes("text/html"), `content-type ${ct}`);
  const html = await res.text();
  assert(html.includes(`${expectedOrigin}/mcp`), `page does not mention ${expectedOrigin}/mcp`);
  return `mentions ${expectedOrigin}/mcp`;
});

await check("OPTIONS /mcp preflight", async () => {
  // Local servers reject foreign Origins (DNS-rebinding protection), so use
  // their own origin there; deployments are probed as a browser host would.
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(base.hostname);
  const origin = local ? expectedOrigin : "https://claude.ai";
  const res = await http("/mcp", {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type,accept,mcp-session-id",
    },
  });
  assert(res.status === 204 || res.status === 200, `status ${res.status}`);
  const allow = res.headers.get("access-control-allow-origin");
  assert(allow === "*" || allow === origin, `allow-origin ${allow}`);
  const methods = res.headers.get("access-control-allow-methods") ?? "";
  assert(/POST/i.test(methods), `allow-methods ${methods}`);
  return `allow-origin ${allow}`;
});

await check("initialize -> serverInfo.name", async () => {
  const r = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke-deployment", version: "1" },
  });
  assert(r.serverInfo?.name === "OpenSCAD Playground", `serverInfo ${JSON.stringify(r.serverInfo)}`);
  return `${r.serverInfo.name} ${r.serverInfo.version ?? ""}`.trim();
});

await check("tools/list contains `create`", async () => {
  const r = await rpc("tools/list", {});
  const names = r.tools.map((t) => t.name);
  assert(names.includes("create"), `tools: ${names.join(", ")}`);
  return names.join(", ");
});

await check("resources/read viewer: CSP + base-url match origin", async () => {
  const r = await rpc("resources/read", { uri: "ui://openscad/viewer.html" });
  const c = r.contents?.[0];
  assert(c, "no contents");
  const csp = c._meta?.ui?.csp;
  assert(csp, `no _meta.ui.csp (meta: ${JSON.stringify(c._meta)})`);
  assert(csp.resourceDomains?.includes(expectedOrigin), `resourceDomains ${JSON.stringify(csp.resourceDomains)} lacks ${expectedOrigin}`);
  for (const d of [expectedOrigin, "blob:", "data:"]) {
    assert(csp.connectDomains?.includes(d), `connectDomains ${JSON.stringify(csp.connectDomains)} lacks ${d}`);
  }
  // The first domain is the asset origin; anything else must be the known CDN.
  for (const d of [...csp.resourceDomains, ...csp.connectDomains]) {
    assert(d === expectedOrigin || d === "blob:" || d === "data:" || d === "https://cdn.jsdelivr.net", `unexpected CSP domain ${d}`);
  }
  const m = /<meta\s+name="openscad-base-url"\s+content="([^"]*)"/.exec(c.text ?? "");
  assert(m, "no openscad-base-url meta in viewer html");
  assert(m[1] === `${expectedOrigin}/`, `openscad-base-url ${m[1]} != ${expectedOrigin}/`);
  return `base-url ${m[1]}`;
});

// ---- report ----------------------------------------------------------------

const w = Math.max(...results.map((r) => r.name.length));
console.log(`\nSmoke test: ${root}${hostHeader ? ` (Host: ${hostHeader})` : ""}, expected origin ${expectedOrigin}\n`);
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(w)}  ${String(r.ms).padStart(5)}ms  ${r.detail}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("\nFailures:\n" + failed.map((r) => `  - ${r.name}: ${r.detail}`).join("\n"));
  process.exit(1);
}
