# mcp-seo-audit
[![npm version](https://img.shields.io/npm/v/mcp-seo-audit)](https://www.npmjs.com/package/mcp-seo-audit)
[![npm downloads](https://img.shields.io/npm/dm/mcp-seo-audit)](https://www.npmjs.com/package/mcp-seo-audit)
![demo](https://github.com/mk-techi/mcp-seo-audit/raw/main/demo.gif)

**On-page SEO analysis as MCP tools.**

An [MCP](https://modelcontextprotocol.io) server that exposes on-page SEO analysis — metas, structured data, robots.txt, sitemaps and links — as tools any MCP-compatible client can call. No API keys, no accounts: everything runs off plain public-page fetches.

## Tools

| Tool | Returns |
|---|---|
| `audit_page` | Title/meta lengths, canonical, robots meta, Open Graph & Twitter cards, headings outline, image alt coverage, word count, lang, hreflang |
| `extract_schema` | Every JSON-LD block parsed, `@type` values, parse errors |
| `check_robots` | robots.txt user-agent groups, allow/disallow rules, declared sitemaps |
| `parse_sitemap` | URL counts, `lastmod` sample, nested sitemap indexes |
| `extract_links` | Internal/external/nofollow split, optional broken-link check |
| `crawl_site` | Breadth-first crawl of internal links, auditing every page and aggregating findings by issue category |

The server returns structured data and leaves the interpretation to the client. The same tools drive a quick audit, a competitor comparison, or a full crawl conversation.

## Install

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

## Usage

Once connected, the six tools are available. Example prompts:

- *Audit example.com and give me a prioritized fix list.*
- *Does this page have valid JSON-LD? Which types?*
- *Compare the on-page SEO of my landing page against a competitor's.*
- *Find broken internal links on the homepage.*

## Build

```bash
npm run build   # emits dist/
npm start       # runs the compiled server
```

## Roadmap

- [x] [`crawl_site` - follow internal links up to N pages and aggregate issues](https://github.com/mk-techi/mcp-seo-audit/issues/1)
- [ ] [Core Web Vitals via the public CrUX API](https://github.com/mk-techi/mcp-seo-audit/issues/2)
- [ ] [Schema validation against schema.org definitions](https://github.com/mk-techi/mcp-seo-audit/issues/3)
- [x] [Publish to npm (`npx mcp-seo-audit`)](https://github.com/mk-techi/mcp-seo-audit/issues/4)

## License

MIT
