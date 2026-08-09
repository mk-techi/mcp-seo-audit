// End-to-end tests for fetching, link extraction and crawling.
// Drives the compiled server over MCP stdio, like a real client, against
// local HTTP servers that reproduce the pathological cases.
//
// Binds 127.0.0.1 ports 4281-4283.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(REPO, "dist", "index.js");
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
const uaVersion = pkg.version.split(".").slice(0, 2).join(".");

const seenUserAgents = new Set();

// A (4281): pages, a dead socket, a tarpit, an oversized body, a big sitemap
// B (4282): redirects to C, a different origin
// C (4283): 3-page site, every page linking back to "/"
const serverA = http.createServer((req, res) => {
  seenUserAgents.add(req.headers["user-agent"] ?? "");
  if (req.url === "/") {
    res.setHeader("content-type", "text/html");
    res.end(`<html><body>
      <a href="/page2">internal ok</a>
      <a href="/dead">internal dead</a>
      <a href="http://127.0.0.1:42810/x">prefix superset origin</a>
      <a href="https://example.com/ext">external</a>
    </body></html>`);
  } else if (req.url === "/page2") {
    res.setHeader("content-type", "text/html");
    res.end("<html><body>page2</body></html>");
  } else if (req.url === "/dead") {
    req.socket.destroy(); // network-level failure, no HTTP status
  } else if (req.url === "/tarpit") {
    // accept the connection, never answer
  } else if (req.url === "/bigmap.xml") {
    res.setHeader("content-type", "application/xml");
    res.write('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    for (let i = 0; i < 50000; i++) {
      res.write(`<url><loc>https://example.com/products/category/item-${i}</loc><lastmod>2026-01-15</lastmod></url>`);
    }
    res.end("</urlset>");
  } else if (req.url === "/huge") {
    res.setHeader("content-type", "text/html");
    const chunk = "a".repeat(64 * 1024);
    let sent = 0;
    const push = () => {
      while (sent < 6 * 1024 * 1024) {
        sent += chunk.length;
        if (!res.write(chunk)) return void res.once("drain", push);
      }
      res.end();
    };
    push();
  } else {
    res.statusCode = 404;
    res.end("not found");
  }
});

const serverB = http.createServer((req, res) => {
  res.statusCode = 301;
  res.setHeader("location", "http://127.0.0.1:4283/");
  res.end();
});

const serverC = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  if (req.url === "/") res.end('<html><body><a href="/">home</a><a href="/p2">p2</a></body></html>');
  else if (req.url === "/p2") res.end('<html><body><a href="/">home</a><a href="/p3">p3</a></body></html>');
  else if (req.url === "/p3") res.end('<html><body><a href="/">home</a>end</body></html>');
  else {
    res.statusCode = 404;
    res.end();
  }
});

await Promise.all([
  new Promise((r) => serverA.listen(4281, "127.0.0.1", r)),
  new Promise((r) => serverB.listen(4282, "127.0.0.1", r)),
  new Promise((r) => serverC.listen(4283, "127.0.0.1", r)),
]);

// ---------- minimal MCP stdio client ----------
const child = spawn(process.execPath, [SERVER], { cwd: REPO, stdio: ["pipe", "pipe", "pipe"] });
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

function rpc(method, params, timeoutMs = 30000) {
  const id = nextId++;
  const p = new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => reject(new Error(`RPC timeout for ${method}`)), timeoutMs).unref();
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return p;
}

await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "e2e-fetching", version: "0.0.0" },
});
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

async function callTool(name, args, timeoutMs = 30000) {
  const res = await rpc("tools/call", { name, arguments: args }, timeoutMs);
  const text = res.result?.content?.[0]?.text ?? JSON.stringify(res.error ?? res);
  return { isError: res.result?.isError ?? !!res.error, text };
}

let failures = 0;
function check(label, cond, evidence) {
  console.log(`${cond ? "PASS" : "FAIL"} | ${label}`);
  console.log(`       ${evidence}`);
  if (!cond) failures++;
}

// origin comparison: a prefix-superset port must land in external
{
  const { text } = await callTool("extract_links", { url: "http://127.0.0.1:4281/" });
  const r = JSON.parse(text);
  check(
    "origin: http://127.0.0.1:42810/x is external (startsWith would call it internal)",
    r.external.includes("http://127.0.0.1:42810/x") && !r.internal.includes("http://127.0.0.1:42810/x"),
    `internal=${JSON.stringify(r.internal)} external=${JSON.stringify(r.external)}`
  );
}

// checkBroken surfaces network-level failures instead of swallowing them
{
  const { text } = await callTool("extract_links", {
    url: "http://127.0.0.1:4281/",
    checkBroken: true,
    checkLimit: 10,
  });
  const r = JSON.parse(text);
  const dead = r.broken.find((b) => b.url.endsWith("/dead"));
  check(
    "checkBroken: a killed socket is reported with status null and an error message",
    dead !== undefined && dead.status === null && typeof dead.error === "string",
    `broken=${JSON.stringify(r.broken)}`
  );
}

// fetch timeout
{
  const t0 = Date.now();
  const { isError, text } = await callTool("audit_page", { url: "http://127.0.0.1:4281/tarpit" }, 25000);
  const elapsed = Date.now() - t0;
  check(
    "timeout: a silent server fails in ~10s instead of hanging",
    isError && elapsed >= 9000 && elapsed <= 15000,
    `elapsed=${elapsed}ms isError=${isError} message=${text.slice(0, 120)}`
  );
}

// response size cap
{
  const { isError, text } = await callTool("audit_page", { url: "http://127.0.0.1:4281/huge" });
  check(
    "size cap: a 6 MB page is rejected with an explicit error",
    isError && /exceeded/i.test(text),
    `isError=${isError} message=${text.slice(0, 120)}`
  );
}

// crawl origin realigns on redirect, without re-crawling the landing page
{
  const { text } = await callTool("crawl_site", { startUrl: "http://127.0.0.1:4282/", maxPages: 10 });
  const r = JSON.parse(text);
  check(
    "crawl: a redirected startUrl (4282 -> 4283) crawls all 3 pages of the final site",
    r.pagesCrawled === 3,
    `pagesCrawled=${r.pagesCrawled} summary=${r.summary}`
  );
  check(
    'crawl: pages self-linking to "/" do not re-crawl the home page or fake a duplicateTitles',
    r.pagesCrawled === 3 && r.duplicateTitles === undefined,
    `pagesCrawled=${r.pagesCrawled} duplicateTitles=${JSON.stringify(r.duplicateTitles ?? null)}`
  );
}

// sitemaps get their own, larger cap
{
  const { isError, text } = await callTool(
    "parse_sitemap",
    { sitemapUrl: "http://127.0.0.1:4281/bigmap.xml", sampleSize: 3 },
    60000
  );
  const r = isError ? null : JSON.parse(text);
  check(
    "sitemap: 50,000 URLs (~6.5 MB, spec-compliant) parses — the 5 MB page cap does not apply",
    !isError && r.urlCount === 50000,
    isError ? `isError message=${text.slice(0, 120)}` : `urlCount=${r.urlCount} sample=${JSON.stringify(r.sample[0])}`
  );
}

// the User-Agent tracks the package version
{
  const uas = [...seenUserAgents];
  check(
    `User-Agent sent to servers matches the package version (mcp-seo-audit/${uaVersion})`,
    uas.length > 0 && uas.every((ua) => ua.includes(`mcp-seo-audit/${uaVersion}`)),
    `user-agents seen: ${JSON.stringify(uas)}`
  );
}

child.kill();
for (const s of [serverA, serverB, serverC]) {
  s.close();
  s.closeAllConnections?.();
}
console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
