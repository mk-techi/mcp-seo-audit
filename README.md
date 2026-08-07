# mcp-seo-audit
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

The server returns structured data and leaves the interpretation to the client. The same tools drive a quick audit, a competitor comparison, or a full crawl conversation.

## Install

```bash
git clone https://github.com/mk-techi/mcp-seo-audit
cd mcp-seo-audit
npm install
npm run dev
```

A working server prints `mcp-seo-audit ready` and waits for a client on stdio.

## Usage

Register the server with any MCP client. Example configuration:

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

On Windows, wrap the command in `cmd`:

```json
{
  "mcpServers": {
    "seo-audit": {
      "command": "cmd",
      "args": ["/c", "npx", "tsx", "C:\\path\\to\\mcp-seo-audit\\src\\index.ts"]
    }
  }
}
```

Once connected, the five tools are available. Example prompts:

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
- [ ] [Publish to npm (`npx mcp-seo-audit`)](https://github.com/mk-techi/mcp-seo-audit/issues/4)

## License

MIT
