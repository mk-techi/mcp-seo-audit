#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as cheerio from "cheerio";
import { z } from "zod";

const USER_AGENT =
  "Mozilla/5.0 (compatible; mcp-seo-audit/0.1; +https://github.com/mk-techi/mcp-seo-audit)";

type Fetched = { status: number; body: string; finalUrl: string };

async function get(url: string): Promise<Fetched> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, redirect: "follow" });
  return { status: res.status, body: await res.text(), finalUrl: res.url };
}

function result(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function collectTypes(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(collectTypes);
  if (node && typeof node === "object") {
    const type = (node as Record<string, unknown>)["@type"];
    const own = typeof type === "string" ? [type] : Array.isArray(type) ? (type as string[]) : [];
    return [...own, ...Object.values(node).flatMap(collectTypes)];
  }
  return [];
}

const server = new McpServer({ name: "mcp-seo-audit", version: "0.1.0" });

server.registerTool(
  "audit_page",
  {
    title: "Audit a page's on-page SEO",
    description:
      "Fetch a URL and return structured on-page SEO data: title and meta description " +
      "with lengths, canonical, robots meta, Open Graph and Twitter cards, headings " +
      "outline, image alt coverage, word count, lang and hreflang.",
    inputSchema: { url: z.string().url() },
  },
  async ({ url }) => {
    const { status, body, finalUrl } = await get(url);
    const $ = cheerio.load(body);

    const title = $("title").first().text().trim();
    const description = $('meta[name="description"]').attr("content")?.trim() ?? null;
    const images = $("img");
    const openGraph: Record<string, string> = {};
    $('meta[property^="og:"]').each((_, el) => {
      openGraph[$(el).attr("property")!] = $(el).attr("content") ?? "";
    });

    return result({
      requestedUrl: url,
      finalUrl,
      httpStatus: status,
      title: { text: title, length: title.length },
      metaDescription: { text: description, length: description?.length ?? 0 },
      canonical: $('link[rel="canonical"]').attr("href") ?? null,
      metaRobots: $('meta[name="robots"]').attr("content") ?? null,
      viewport: $('meta[name="viewport"]').attr("content") ?? null,
      lang: $("html").attr("lang") ?? null,
      hreflang: $('link[rel="alternate"][hreflang]')
        .map((_, el) => ({ hreflang: $(el).attr("hreflang"), href: $(el).attr("href") }))
        .get(),
      h1Count: $("h1").length,
      headings: $("h1, h2, h3")
        .map((_, el) => ({ tag: el.tagName.toLowerCase(), text: $(el).text().trim().slice(0, 120) }))
        .get(),
      images: {
        total: images.length,
        missingAlt: images.filter((_, el) => !$(el).attr("alt")?.trim()).length,
      },
      openGraph,
      twitterCard: $('meta[name="twitter:card"]').attr("content") ?? null,
      wordCount: $("body").text().replace(/\s+/g, " ").trim().split(" ").length,
    });
  }
);

server.registerTool(
  "extract_schema",
  {
    title: "Extract structured data (JSON-LD)",
    description:
      "Extract every JSON-LD block from a page, list the @type values found, and return " +
      "the parsed objects along with any parse errors.",
    inputSchema: { url: z.string().url() },
  },
  async ({ url }) => {
    const { body } = await get(url);
    const $ = cheerio.load(body);

    const blocks: unknown[] = [];
    const errors: string[] = [];
    $('script[type="application/ld+json"]').each((i, el) => {
      try {
        blocks.push(JSON.parse($(el).contents().text()));
      } catch (err) {
        errors.push(`Block ${i}: ${(err as Error).message}`);
      }
    });

    return result({
      url,
      blockCount: blocks.length,
      typesFound: [...new Set(blocks.flatMap(collectTypes))],
      parseErrors: errors,
      blocks,
    });
  }
);

server.registerTool(
  "check_robots",
  {
    title: "Fetch and parse robots.txt",
    description:
      "Fetch a site's robots.txt and return user-agent groups with their rules, " +
      "declared sitemaps and crawl-delay directives.",
    inputSchema: { siteUrl: z.string().url().describe("Any URL on the site") },
  },
  async ({ siteUrl }) => {
    const origin = new URL(siteUrl).origin;
    const { status, body } = await get(`${origin}/robots.txt`);
    if (status >= 400) return result({ origin, status, exists: false });

    type Group = { userAgents: string[]; rules: { directive: string; path: string }[] };
    const groups: Group[] = [];
    const sitemaps: string[] = [];
    let current: Group | null = null;

    for (const line of body.split("\n")) {
      const clean = line.replace(/#.*$/, "").trim();
      const match = clean.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
      if (!match) continue;
      const key = match[1].toLowerCase();
      const value = match[2];

      if (key === "user-agent") {
        if (!current || current.rules.length > 0) {
          current = { userAgents: [], rules: [] };
          groups.push(current);
        }
        current.userAgents.push(value);
      } else if (key === "sitemap") {
        sitemaps.push(value);
      } else if (current && ["allow", "disallow", "crawl-delay"].includes(key)) {
        current.rules.push({ directive: key, path: value });
      }
    }

    return result({ origin, status, exists: true, groups, sitemaps });
  }
);

server.registerTool(
  "parse_sitemap",
  {
    title: "Parse a sitemap",
    description:
      "Fetch a sitemap.xml or sitemap index and return the URL count, a sample of " +
      "entries with lastmod, and any nested sitemaps.",
    inputSchema: {
      sitemapUrl: z.string().url(),
      sampleSize: z.number().int().min(1).max(100).default(20),
    },
  },
  async ({ sitemapUrl, sampleSize }) => {
    const { status, body } = await get(sitemapUrl);
    if (status >= 400) return result({ sitemapUrl, status, exists: false });

    const $ = cheerio.load(body, { xmlMode: true });
    const nested = $("sitemapindex sitemap loc").map((_, el) => $(el).text().trim()).get();
    const urls = $("urlset url")
      .map((_, el) => ({
        loc: $(el).find("loc").text().trim(),
        lastmod: $(el).find("lastmod").text().trim() || null,
      }))
      .get();

    return result({
      sitemapUrl,
      status,
      isIndex: nested.length > 0,
      nestedSitemaps: nested,
      urlCount: urls.length,
      sample: urls.slice(0, sampleSize),
    });
  }
);

server.registerTool(
  "extract_links",
  {
    title: "Extract and check links",
    description:
      "List a page's links split into internal and external with nofollow counts. " +
      "Optionally HEAD-checks internal links to find broken ones.",
    inputSchema: {
      url: z.string().url(),
      checkBroken: z.boolean().default(false),
      checkLimit: z.number().int().min(1).max(50).default(20),
    },
  },
  async ({ url, checkBroken, checkLimit }) => {
    const { body, finalUrl } = await get(url);
    const $ = cheerio.load(body);
    const origin = new URL(finalUrl).origin;

    const seen = new Set<string>();
    const internal: string[] = [];
    const external: string[] = [];
    let nofollow = 0;

    $("a[href]").each((_, el) => {
      const href = $(el).attr("href")!;
      if (/^(#|mailto:|tel:)/.test(href)) return;

      let absolute: string;
      try {
        absolute = new URL(href, finalUrl).toString();
      } catch {
        return;
      }
      if (seen.has(absolute)) return;
      seen.add(absolute);

      if (($(el).attr("rel") ?? "").includes("nofollow")) nofollow++;
      (absolute.startsWith(origin) ? internal : external).push(absolute);
    });

    let broken: { url: string; status: number }[] = [];
    if (checkBroken) {
      const checks = await Promise.allSettled(
        internal.slice(0, checkLimit).map(async (link) => {
          const res = await fetch(link, {
            method: "HEAD",
            headers: { "User-Agent": USER_AGENT },
            redirect: "follow",
          });
          return { url: link, status: res.status };
        })
      );
      broken = checks
        .flatMap((c) => (c.status === "fulfilled" ? [c.value] : []))
        .filter((c) => c.status >= 400);
    }

    return result({
      url: finalUrl,
      internalCount: internal.length,
      externalCount: external.length,
      nofollowCount: nofollow,
      internal: internal.slice(0, 100),
      external: external.slice(0, 50),
      brokenChecked: checkBroken,
      broken,
    });
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("mcp-seo-audit ready");
