# Contributing

Thanks for helping out. This is a small TypeScript MCP server published to npm — the whole implementation lives in [`src/index.ts`](src/index.ts), so most changes are a single file plus a test.

Issues labelled [`good first issue`](https://github.com/mk-techi/mcp-seo-audit/labels/good%20first%20issue) are the best place to start.

## Requirements

Node.js 18 or newer. The server uses the built-in `fetch` and `AbortSignal.timeout`, so nothing older works.

## Local setup

```bash
git clone https://github.com/<your-username>/mcp-seo-audit
cd mcp-seo-audit
npm install
npm run build   # emits dist/
```

`npm run dev` runs the server straight from TypeScript via `tsx`, which is what you want while iterating.

## Trying it in an MCP client

Point your client at your checkout instead of the published package:

```json
{
  "mcpServers": {
    "seo-audit": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/mcp-seo-audit/src/index.ts"]
    }
  }
}
```

Restart the client after each change — it spawns the server once per session. For `check_vitals`, add `"env": { "CRUX_API_KEY": "your-key" }`; see the [README](README.md#core-web-vitals-crux-api-key) for how to get a free key.

## Tests

```bash
npm test
```

The tests build first, then drive the compiled server over MCP stdio exactly like a real client, against local HTTP servers that reproduce the awkward cases: redirects across origins, dead sockets, a server that never answers, oversized responses, big sitemaps, and a mock of the CrUX API for `check_vitals` (no API key needed). They bind `127.0.0.1` ports 4281-4283 and 4290, and take about a minute — the timeout test really does wait 10 seconds.

Add a case to [`test/e2e-fetching.mjs`](test/e2e-fetching.mjs) or [`test/e2e-vitals.mjs`](test/e2e-vitals.mjs) for anything you fix or add. The bar is that the test fails without your change: a test that passes either way tells nobody anything.

## Commits

[Conventional commits](https://www.conventionalcommits.org), matching the existing history:

```
feat: add crawl_site tool (closes #1)
fix: send the CrUX API key as a header instead of a query parameter
chore: bump to 0.4.0
```

Use `feat:` for a new tool or capability, `fix:` for a bug, `chore:` for releases and plumbing, `docs:` for documentation. Reference the issue with `(closes #N)` when there is one.

## Pull requests

Fork, branch off `main`, open a PR against `main`:

```bash
git checkout -b feat/my-change
# ... work, commit ...
git push origin feat/my-change
```

Keep PRs focused — one fix or one tool per PR reviews far faster than a mixed bag. Make sure `npm test` passes before you open it, say what you tested in the description, and don't bump the version or touch `dist/` (releases are cut separately). If you're planning something substantial, open an issue first so we can agree on the shape before you write it.
