# mcp-seo-audit
[![npm version](https://img.shields.io/npm/v/mcp-seo-audit)](https://www.npmjs.com/package/mcp-seo-audit)
[![npm downloads](https://img.shields.io/npm/dm/mcp-seo-audit)](https://www.npmjs.com/package/mcp-seo-audit)
[![CI](https://github.com/mk-techi/mcp-seo-audit/actions/workflows/ci.yml/badge.svg)](https://github.com/mk-techi/mcp-seo-audit/actions/workflows/ci.yml)
![demo](https://github.com/mk-techi/mcp-seo-audit/raw/main/demo.gif)

**On-page SEO analysis as MCP tools.**

An [MCP](https://modelcontextprotocol.io) server that exposes on-page SEO analysis — metas, structured data, robots.txt, sitemaps and links — as tools any MCP-compatible client can call. The six core tools need no API keys and no accounts: everything runs off plain public-page fetches. `check_vitals` optionally adds real-user Core Web Vitals with a [free API key](#core-web-vitals-crux-api-key).

## Tools

| Tool | Returns |
|---|---|
| `audit_page` | Title/meta lengths, canonical, robots meta, Open Graph & Twitter cards, headings outline, image alt coverage, word count, lang, hreflang |
| `extract_schema` | Every JSON-LD block parsed, `@type` values, parse errors, and validation against Google's rich result requirements (missing required vs. recommended properties) |
| `check_robots` | robots.txt user-agent groups, allow/disallow rules, declared sitemaps |
| `parse_sitemap` | URL counts, `lastmod` sample, nested sitemap indexes |
| `extract_links` | Internal/external/nofollow split, optional broken-link check |
| `crawl_site` | Breadth-first crawl of internal links, auditing every page and aggregating findings by issue category |
| `check_vitals` | Real-user Core Web Vitals from the Chrome UX Report: LCP, CLS, INP (plus FCP and TTFB) at the 75th percentile with Google's good / needs improvement / poor verdicts — needs a [free API key](#core-web-vitals-crux-api-key) |

The server returns structured data and leaves the interpretation to the client. The same tools drive a quick audit, a competitor comparison, or a full crawl conversation.

## Install

Requires Node.js 20.18.1 or newer — cheerio pulls in undici 7, which needs the `File` global introduced in Node 20. On older versions the server fails to start.

No install step — register the server with any MCP client and `npx` fetches it on first run:

```json
{
  "mcpServers": {
    "seo-audit": {
      "command": "npx",
      "args": ["mcp-seo-audit"]
    }
  }
}
```

On Windows, wrap the command in `cmd`:

```json
{
  "mcpServers": {
    "seo-audit": {
      "command": "cmd",
      "args": ["/c", "npx", "mcp-seo-audit"]
    }
  }
}
```

To try it outside a client, `npx mcp-seo-audit` prints `mcp-seo-audit ready` and waits for a client on stdio.

### From source

For contributors, or to run an unreleased change:

```bash
git clone https://github.com/mk-techi/mcp-seo-audit
cd mcp-seo-audit
npm install
npm run dev
```

Then point the client at the local checkout instead of the published package:

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

### Core Web Vitals (CrUX) API key

`check_vitals` queries Google's [Chrome UX Report API](https://developer.chrome.com/docs/crux/api) — the Core Web Vitals real Chrome users experienced over the last 28 days, the same field data Google Search uses. It reads a key from the `CRUX_API_KEY` environment variable:

```json
{
  "mcpServers": {
    "seo-audit": {
      "command": "npx",
      "args": ["mcp-seo-audit"],
      "env": { "CRUX_API_KEY": "your-key" }
    }
  }
}
```

The key is free and needs no billing account: create an API key in the [Google Cloud console](https://console.cloud.google.com/apis/credentials) and enable the **Chrome UX Report API** for its project. Without the key, `check_vitals` explains how to get one and every other tool keeps working.

## Usage

Once connected, the tools are available. Example prompts:

- *Audit example.com and give me a prioritized fix list.*
- *Does this page have valid JSON-LD? Which types, and what's missing for rich results?*
- *Compare the on-page SEO of my landing page against a competitor's.*
- *Find broken internal links on the homepage.*
- *How are my real-user Core Web Vitals on mobile, and which metric should I fix first?*

## Build

```bash
npm run build   # emits dist/
npm start       # runs the compiled server
```

## Roadmap

- [x] [`crawl_site` - follow internal links up to N pages and aggregate issues](https://github.com/mk-techi/mcp-seo-audit/issues/1)
- [x] [Core Web Vitals via the public CrUX API](https://github.com/mk-techi/mcp-seo-audit/issues/2)
- [x] [Schema validation against Google's rich results requirements](https://github.com/mk-techi/mcp-seo-audit/issues/3)
- [x] [Publish to npm (`npx mcp-seo-audit`)](https://github.com/mk-techi/mcp-seo-audit/issues/4)

## License

MIT
