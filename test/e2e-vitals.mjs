// End-to-end tests for check_vitals, against a local mock of the CrUX API.
// The server reads its endpoint from CRUX_API_ENDPOINT, which is what makes
// these tests possible without a real API key.
//
// Binds 127.0.0.1 port 4290.
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(REPO, "dist", "index.js");
const CRUX_PORT = 4290;

let lastCruxRequest = null; // { key, body, rawUrl }

// Mock CrUX API, plus one plain HTML page to prove the keyless tools still work
const mock = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/page") {
    res.setHeader("content-type", "text/html");
    return res.end("<html><head><title>A perfectly ordinary test page</title></head><body><h1>ok</h1></body></html>");
  }
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const key = req.headers["x-goog-api-key"] ?? new URL(req.url, "http://x").searchParams.get("key");
    const body = JSON.parse(raw || "{}");
    lastCruxRequest = { key, body, rawUrl: req.url };

    if (req.url.startsWith("/wrongpath")) {
      res.statusCode = 404;
      res.setHeader("content-type", "text/html");
      return res.end("<html><body>404 Not Found — no such API path</body></html>");
    }
    if (key === "proxy-key") {
      res.statusCode = 500;
      res.setHeader("content-type", "text/html");
      return res.end(`Proxy error: the requested URL http://127.0.0.1:${CRUX_PORT}${req.url} could not be retrieved`);
    }
    res.setHeader("content-type", "application/json");
    if (key === "quota-key") {
      res.statusCode = 429;
      return res.end(JSON.stringify({
        error: { code: 429, message: "Quota exceeded for quota metric 'Queries' of service 'chromeuxreport.googleapis.com'.", status: "RESOURCE_EXHAUSTED" },
      }));
    }
    if (key === "forbidden-key") {
      res.statusCode = 403;
      return res.end(JSON.stringify({
        error: { code: 403, message: "Chrome UX Report API has not been used in project 12345 before or it is disabled.", status: "PERMISSION_DENIED" },
      }));
    }
    if (key === "empty-key") return res.end("{}");
    if (key === "bad-key") {
      res.statusCode = 400;
      return res.end(JSON.stringify({
        error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" },
      }));
    }
    if ((body.url ?? body.origin ?? "").includes("nodata")) {
      res.statusCode = 404;
      return res.end(JSON.stringify({
        error: { code: 404, message: "chrome ux report data not found", status: "NOT_FOUND" },
      }));
    }
    res.end(JSON.stringify({
      record: {
        key: body,
        metrics: {
          largest_contentful_paint: { percentiles: { p75: 2400 } },
          cumulative_layout_shift: { percentiles: { p75: "0.25" } },
          interaction_to_next_paint: { percentiles: { p75: 600 } },
          first_contentful_paint: { percentiles: { p75: 1700 } },
          experimental_time_to_first_byte: { percentiles: { p75: 900 } },
        },
        collectionPeriod: {
          firstDate: { year: 2026, month: 7, day: 12 },
          lastDate: { year: 2026, month: 8, day: 8 },
        },
      },
    }));
  });
});
await new Promise((r) => mock.listen(CRUX_PORT, "127.0.0.1", r));

// ---------- minimal MCP stdio client, one per env variant ----------
function spawnMcp(extraEnv) {
  const env = { ...process.env, CRUX_API_ENDPOINT: `http://127.0.0.1:${CRUX_PORT}/crux`, ...extraEnv };
  delete env.CRUX_API_KEY;
  if (extraEnv.CRUX_API_KEY) env.CRUX_API_KEY = extraEnv.CRUX_API_KEY;
  const child = spawn(process.execPath, [SERVER], { cwd: REPO, env, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let nextId = 1;
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  const rpc = (method, params, timeoutMs = 30000) => {
    const id = nextId++;
    const p = new Promise((resolve, reject) => {
      pending.set(id, resolve);
      setTimeout(() => reject(new Error(`RPC timeout for ${method}`)), timeoutMs).unref();
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return p;
  };
  return {
    child,
    async init() {
      await rpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "e2e-vitals", version: "0.0.0" },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    async callTool(name, args) {
      const res = await rpc("tools/call", { name, arguments: args });
      const text = res.result?.content?.[0]?.text ?? JSON.stringify(res.error ?? res);
      return { isError: res.result?.isError ?? !!res.error, text };
    },
  };
}

let failures = 0;
function check(label, cond, evidence) {
  console.log(`${cond ? "PASS" : "FAIL"} | ${label}`);
  console.log(`       ${evidence}`);
  if (!cond) failures++;
}

async function vitalsWith(env, args = { url: "https://site.example.com/" }) {
  const mcp = spawnMcp(env);
  await mcp.init();
  const out = await mcp.callTool("check_vitals", args);
  mcp.child.kill();
  return out;
}

// ---------- no CRUX_API_KEY ----------
{
  const mcp = spawnMcp({});
  await mcp.init();

  const { isError, text } = await mcp.callTool("check_vitals", { url: "https://example.com/" });
  const r = JSON.parse(text);
  check(
    "no key: hasData false plus instructions for getting a free one (not an MCP error)",
    !isError && r.hasData === false && r.error === "missing_api_key" &&
      r.message.includes("CRUX_API_KEY") && r.message.includes("console.cloud.google.com"),
    `error=${r.error} message=${(r.message ?? "").slice(0, 100)}...`
  );

  const audit = await mcp.callTool("audit_page", { url: `http://127.0.0.1:${CRUX_PORT}/page` });
  const a = JSON.parse(audit.text);
  check(
    "no key: the other tools keep working (audit_page against the same server)",
    !audit.isError && a.title.text.includes("ordinary") && a.h1Count === 1,
    `title=${JSON.stringify(a.title)}`
  );
  mcp.child.kill();
}

// ---------- valid key ----------
{
  const mcp = spawnMcp({ CRUX_API_KEY: "good-key" });
  await mcp.init();

  const nod = await mcp.callTool("check_vitals", { url: "https://nodata.example.com/some/page" });
  const n = JSON.parse(nod.text);
  check(
    "no data (404 NOT_FOUND): hasData false, readable explanation, suggests the origin",
    !nod.isError && n.hasData === false && n.error === undefined &&
      n.message.includes("not enough Chrome traffic") && n.message.includes("https://nodata.example.com"),
    `message=${n.message.slice(0, 140)}`
  );
  check(
    "no data: the query sent was page-level {url} with the default PHONE form factor",
    lastCruxRequest.body.url === "https://nodata.example.com/some/page" &&
      lastCruxRequest.body.origin === undefined && lastCruxRequest.body.formFactor === "PHONE",
    `body sent=${JSON.stringify(lastCruxRequest.body)}`
  );
  check(
    "no data: the message also suggests formFactor ALL (records are keyed by form factor)",
    n.message.includes("formFactor ALL"),
    `message=${n.message.slice(0, 200)}`
  );

  const ok = await mcp.callTool("check_vitals", { url: "https://site.example.com/" });
  const v = JSON.parse(ok.text);
  const m = v.metrics;
  check(
    "valid response: a bare origin is queried as the origin aggregate, hasData true, collectionPeriod kept",
    !ok.isError && v.hasData === true && v.level === "origin" &&
      lastCruxRequest.body.origin === "https://site.example.com" && lastCruxRequest.body.url === undefined &&
      v.collectionPeriod?.lastDate?.year === 2026,
    `level=${v.level} body sent=${JSON.stringify(lastCruxRequest.body)}`
  );
  check(
    "valid response: verdicts match the official thresholds (LCP 2400 good, CLS 0.25 needs improvement, INP 600 poor, FCP 1700 good, TTFB 900 needs improvement via experimental_)",
    m.lcp.p75 === 2400 && m.lcp.verdict === "good" &&
      m.cls.p75 === 0.25 && m.cls.verdict === "needs improvement" &&
      m.inp.p75 === 600 && m.inp.verdict === "poor" &&
      m.fcp.p75 === 1700 && m.fcp.verdict === "good" &&
      m.ttfb.p75 === 900 && m.ttfb.verdict === "needs improvement",
    `metrics=${JSON.stringify(m)}`
  );
  check(
    "valid response: summary carries the overall assessment (worst of LCP/CLS/INP -> poor)",
    v.summary.includes("Core Web Vitals assessment: poor"),
    `summary=${v.summary}`
  );

  await mcp.callTool("check_vitals", { url: "https://site.example.com/", formFactor: "ALL" });
  const allBody = { ...lastCruxRequest.body };
  await mcp.callTool("check_vitals", { url: "https://site.example.com/", formFactor: "DESKTOP" });
  const deskBody = { ...lastCruxRequest.body };
  check(
    "formFactor: ALL omits the field (all-devices aggregate); DESKTOP is passed through",
    allBody.formFactor === undefined && deskBody.formFactor === "DESKTOP",
    `ALL=${JSON.stringify(allBody)} DESKTOP=${JSON.stringify(deskBody)}`
  );

  await mcp.callTool("check_vitals", { url: "https://site.example.com/", formFactor: "TABLET" });
  check(
    "formFactor TABLET (supported by the real CrUX API) is passed through",
    lastCruxRequest.body.formFactor === "TABLET",
    `body=${JSON.stringify(lastCruxRequest.body)}`
  );

  await mcp.callTool("check_vitals", { url: "https://site.example.com/page#section" });
  check(
    "the #fragment is stripped before querying (CrUX indexes fragment-less URLs)",
    lastCruxRequest.body.url === "https://site.example.com/page",
    `body=${JSON.stringify(lastCruxRequest.body)}`
  );
  mcp.child.kill();
}

// ---------- error paths (the key is env-level, so one spawn each) ----------
{
  const { text } = await vitalsWith({ CRUX_API_KEY: "bad-key" });
  const r = JSON.parse(text);
  check(
    "invalid key: distinct invalid_api_key error, not a misleading no-data",
    r.hasData === false && r.error === "invalid_api_key" && r.message.includes("API key not valid"),
    `error=${r.error} message=${r.message.slice(0, 110)}`
  );
}
{
  const { text } = await vitalsWith({ CRUX_API_KEY: "quota-key" });
  const r = JSON.parse(text);
  check(
    "quota exceeded (429): distinct quota_exceeded error",
    r.error === "quota_exceeded" && r.message.includes("Quota exceeded"),
    `error=${r.error} message=${r.message.slice(0, 90)}`
  );
}
{
  const { text } = await vitalsWith({ CRUX_API_KEY: "forbidden-key" });
  const r = JSON.parse(text);
  check(
    "API not enabled (403): distinct api_not_enabled error carrying Google's message",
    r.error === "api_not_enabled" && r.message.includes("has not been used in project"),
    `error=${r.error} message=${r.message.slice(0, 110)}`
  );
}
{
  const { text } = await vitalsWith({ CRUX_API_KEY: "proxy-key" });
  const r = JSON.parse(text);
  check(
    "non-JSON body (proxy 500 quoting the URL): api_error, and the key appears nowhere (sent as a header)",
    r.error === "api_error" && r.message.includes("HTTP 500") &&
      !text.includes("proxy-key") && !lastCruxRequest.rawUrl.includes("key="),
    `message=${r.message.slice(0, 130)} rawUrl=${lastCruxRequest.rawUrl}`
  );
}
{
  const { text } = await vitalsWith({ CRUX_API_KEY: "empty-key" });
  const r = JSON.parse(text);
  check(
    "200 without a record: explicit api_error rather than hasData true with an empty summary",
    r.hasData === false && r.error === "api_error" && r.message.includes("without a record"),
    `error=${r.error} message=${r.message.slice(0, 100)}`
  );
}
{
  const { text } = await vitalsWith({
    CRUX_API_KEY: "good-key",
    CRUX_API_ENDPOINT: `http://127.0.0.1:${CRUX_PORT}/wrongpath`,
  });
  const r = JSON.parse(text);
  check(
    "non-CrUX 404 (wrong endpoint, HTML body): a configuration api_error, NOT a misleading low-traffic verdict",
    r.error === "api_error" && r.message.includes("HTTP 404") && !(r.message ?? "").includes("not enough Chrome traffic"),
    `error=${r.error} message=${r.message.slice(0, 110)}`
  );
}
{
  const { isError, text } = await vitalsWith({
    CRUX_API_KEY: "SECRET_LEAK_XYZ",
    CRUX_API_ENDPOINT: "not-a-valid-url",
  });
  check(
    "invalid endpoint: the fetch error surfaces WITHOUT the key (it is no longer in the URL)",
    isError === true && !text.includes("SECRET_LEAK_XYZ"),
    `isError=${isError} text=${text.slice(0, 120)}`
  );
}

mock.close();
mock.closeAllConnections?.();
console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
