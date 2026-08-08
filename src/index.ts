#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as cheerio from "cheerio";
import { z } from "zod";

const USER_AGENT =
  "Mozilla/5.0 (compatible; mcp-seo-audit/0.2; +https://github.com/mk-techi/mcp-seo-audit)";

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

function auditDocument(
  $: cheerio.CheerioAPI,
  requestedUrl: string,
  finalUrl: string,
  status: number
) {
  const title = $("title").first().text().trim();
  const description = $('meta[name="description"]').attr("content")?.trim() ?? null;
  const images = $("img");
  const openGraph: Record<string, string> = {};
  $('meta[property^="og:"]').each((_, el) => {
    openGraph[$(el).attr("property")!] = $(el).attr("content") ?? "";
  });

  return {
    requestedUrl,
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
  };
}

function parseJsonLd($: cheerio.CheerioAPI): { blocks: unknown[]; errors: string[] } {
  const blocks: unknown[] = [];
  const errors: string[] = [];
  $('script[type="application/ld+json"]').each((i, el) => {
    try {
      blocks.push(JSON.parse($(el).contents().text()));
    } catch (err) {
      errors.push(`Block ${i}: ${(err as Error).message}`);
    }
  });
  return { blocks, errors };
}

type SchemaRule = { required: string[]; recommended: string[] };

const ARTICLE_RULE: SchemaRule = {
  required: ["headline"],
  recommended: ["image", "author", "datePublished", "dateModified", "publisher"],
};

const SCHEMA_RULES: Record<string, SchemaRule> = {
  Article: ARTICLE_RULE,
  BlogPosting: ARTICLE_RULE,
  NewsArticle: ARTICLE_RULE,
  Product: {
    required: ["name", "offers|review|aggregateRating"],
    recommended: ["image", "description", "brand", "sku|mpn|gtin|gtin8|gtin13|gtin14"],
  },
  Offer: {
    required: ["price|priceSpecification", "priceCurrency|priceSpecification"],
    recommended: ["availability", "url", "priceValidUntil", "itemCondition"],
  },
  AggregateRating: {
    required: ["ratingValue", "ratingCount|reviewCount"],
    recommended: ["bestRating", "worstRating"],
  },
  Review: {
    required: ["author", "reviewRating"],
    recommended: ["datePublished", "reviewBody"],
  },
  FAQPage: { required: ["mainEntity"], recommended: [] },
  Question: { required: ["name", "acceptedAnswer"], recommended: [] },
  Answer: { required: ["text"], recommended: ["url"] },
  Organization: {
    required: ["name"],
    recommended: ["url", "logo", "sameAs", "description", "address", "contactPoint"],
  },
  LocalBusiness: {
    required: ["name", "address"],
    recommended: [
      "image",
      "telephone",
      "url",
      "openingHoursSpecification|openingHours",
      "geo",
      "priceRange",
    ],
  },
  Person: { required: ["name"], recommended: ["url", "image", "sameAs", "jobTitle"] },
  BreadcrumbList: { required: ["itemListElement"], recommended: [] },
  ListItem: { required: ["position", "name"], recommended: ["item"] },
  WebSite: { required: ["name", "url"], recommended: ["alternateName", "publisher", "inLanguage"] },
  Recipe: {
    required: ["name", "image"],
    recommended: [
      "author",
      "datePublished",
      "description",
      "prepTime",
      "cookTime",
      "totalTime",
      "recipeYield",
      "recipeIngredient",
      "recipeInstructions",
      "nutrition",
      "aggregateRating",
      "video",
    ],
  },
  Event: {
    required: ["name", "startDate", "location"],
    recommended: [
      "description",
      "endDate",
      "eventAttendanceMode",
      "eventStatus",
      "image",
      "offers",
      "organizer",
      "performer",
    ],
  },
  VideoObject: {
    required: ["name", "thumbnailUrl", "uploadDate"],
    recommended: ["description", "duration", "contentUrl|embedUrl", "expires", "interactionStatistic"],
  },
};

type TypedNode = { type: string; node: Record<string, unknown> };
type BlockValidation = { type: string; missingRequired: string[]; missingRecommended: string[] };

function collectTypedNodes(node: unknown): TypedNode[] {
  if (Array.isArray(node)) return node.flatMap(collectTypedNodes);
  if (!node || typeof node !== "object") return [];
  const record = node as Record<string, unknown>;
  const type = record["@type"];
  const own = typeof type === "string" ? [type] : Array.isArray(type) ? (type as string[]) : [];
  return [
    ...own.map((name) => ({ type: name, node: record })),
    ...Object.values(record).flatMap(collectTypedNodes),
  ];
}

function isReference(node: Record<string, unknown>): boolean {
  return "@id" in node && Object.keys(node).every((key) => key === "@id" || key === "@type");
}

function filled(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function hasProperty(node: Record<string, unknown>, property: string): boolean {
  return property.split("|").some((name) => filled(node[name]));
}

function validateSchema(blocks: unknown[]): BlockValidation[] {
  return collectTypedNodes(blocks).flatMap(({ type, node }) => {
    const rule = SCHEMA_RULES[type];
    if (!rule || isReference(node)) return [];
    const missing = (properties: string[]) => properties.filter((p) => !hasProperty(node, p));
    return [
      {
        type,
        missingRequired: missing(rule.required),
        missingRecommended: missing(rule.recommended),
      },
    ];
  });
}

function schemaSummary(validation: BlockValidation[]): string {
  if (validation.length === 0) return "No JSON-LD entity matched a known Google rich result type.";
  const invalid = validation.filter((v) => v.missingRequired.length > 0);
  const incomplete = validation.filter(
    (v) => v.missingRequired.length === 0 && v.missingRecommended.length > 0
  );
  const checked = `Checked ${validation.length} entit${validation.length === 1 ? "y" : "ies"}`;
  if (invalid.length === 0 && incomplete.length === 0) {
    return `${checked}: all required and recommended properties present.`;
  }
  const invalidTypes = [...new Set(invalid.map((v) => v.type))].join(", ");
  const complete = validation.length - invalid.length - incomplete.length;
  return (
    `${checked}: ${invalid.length} invalid for Google` +
    (invalid.length > 0 ? ` (${invalidTypes})` : "") +
    `, ${incomplete.length} missing recommended properties only, ${complete} complete.`
  );
}

function extractPageLinks(
  $: cheerio.CheerioAPI,
  finalUrl: string
): { internal: string[]; external: string[]; nofollow: number } {
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

  return { internal, external, nofollow };
}

const CRAWL_DELAY_MS = 200;
const NON_HTML_EXTENSION =
  /\.(pdf|jpe?g|png|gif|bmp|svg|webp|avif|ico|zip|gz|tgz|tar|rar|7z|mp[34g]|m4a|wav|mov|avi|webm|css|js|mjs|json|xml|rss|txt|csv|docx?|xlsx?|pptx?|woff2?|ttf|otf|eot|dmg|exe|apk)$/i;

type IssueCategory =
  | "missingMetaDescription"
  | "titleTooLong"
  | "titleTooShort"
  | "missingH1"
  | "multipleH1"
  | "duplicateTitles"
  | "imagesWithoutAlt"
  | "missingCanonical"
  | "noJsonLd"
  | "invalidJsonLd";

type FetchFailure = {
  url: string;
  status: number | null;
  foundOn: string | null;
  error: string | null;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
  const { message, cause } = err as { message: string; cause?: unknown };
  return cause instanceof Error ? `${message}: ${cause.message}` : message;
}

function normalizeUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }
  return url.toString();
}

function crawlableUrl(raw: string, origin: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  if (NON_HTML_EXTENSION.test(url.pathname)) return null;
  return normalizeUrl(url.toString());
}

function issueGroup<T>(urls: T[], limit: number) {
  return { count: urls.length, urls: urls.slice(0, limit), truncated: urls.length > limit };
}

function crawlSummary(
  startUrl: string,
  pagesCrawled: number,
  pagesFailed: number,
  issues: Record<IssueCategory, string[]>
): string {
  const nonEmpty = Object.values(issues).filter((urls) => urls.length > 0);
  const categories = nonEmpty.length + (pagesFailed > 0 ? 1 : 0);
  const total = nonEmpty.reduce((sum, urls) => sum + urls.length, 0) + pagesFailed;
  return (
    `Crawled ${pagesCrawled} page(s) from ${startUrl}` +
    (pagesFailed > 0 ? `, ${pagesFailed} failed to fetch` : "") +
    (total > 0
      ? `, and found ${total} issue(s) across ${categories} categor${categories === 1 ? "y" : "ies"}.`
      : ", and found no issues.")
  );
}

const server = new McpServer({ name: "mcp-seo-audit", version: "0.3.0" });

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
    return result(auditDocument(cheerio.load(body), url, finalUrl, status));
  }
);

server.registerTool(
  "extract_schema",
  {
    title: "Extract and validate structured data (JSON-LD)",
    description:
      "Extract every JSON-LD block from a page, list the @type values found, and return " +
      "the parsed objects along with any parse errors. Every entity whose @type has known " +
      "Google Search Central requirements is validated: missingRequired lists properties " +
      "without which Google drops the entity from rich results, missingRecommended lists " +
      "those that only degrade the result. A property written 'a|b' is satisfied by either " +
      "one. Types with no known Google requirements are skipped, not reported as invalid.",
    inputSchema: { url: z.string().url() },
  },
  async ({ url }) => {
    const { body } = await get(url);
    const { blocks, errors } = parseJsonLd(cheerio.load(body));
    const validation = validateSchema(blocks);

    return result({
      url,
      blockCount: blocks.length,
      typesFound: [...new Set(blocks.flatMap(collectTypes))],
      parseErrors: errors,
      validation,
      validationSummary: schemaSummary(validation),
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
    const { internal, external, nofollow } = extractPageLinks(cheerio.load(body), finalUrl);

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

server.registerTool(
  "crawl_site",
  {
    title: "Crawl a site and aggregate SEO issues",
    description:
      "Breadth-first crawl of internal links from a starting URL, auditing every page and " +
      "aggregating the findings by issue type: missing metas, title length, H1 problems, " +
      "duplicate titles, image alt coverage, canonicals, JSON-LD and fetch errors. " +
      "invalidJsonLd lists pages where a JSON-LD entity is missing a property Google " +
      "requires for its rich result; use extract_schema on those pages for the details. " +
      "Fetch errors carry the HTTP status (null for a network-level failure, with the " +
      "message in error) and foundOn, the first page found linking to that URL — not every " +
      "page linking to it, since a dead link in a shared template is fixed once.",
    inputSchema: {
      startUrl: z.string().url(),
      maxPages: z.number().int().min(1).max(100).default(20),
      maxIssuesPerCategory: z.number().int().min(1).max(100).default(10),
    },
  },
  async ({ startUrl, maxPages, maxIssuesPerCategory }) => {
    const origin = new URL(startUrl).origin;
    const queue: string[] = [normalizeUrl(startUrl)];
    const queued = new Set<string>(queue);
    const visited = new Set<string>();

    const issues: Record<IssueCategory, string[]> = {
      missingMetaDescription: [],
      titleTooLong: [],
      titleTooShort: [],
      missingH1: [],
      multipleH1: [],
      duplicateTitles: [],
      imagesWithoutAlt: [],
      missingCanonical: [],
      noJsonLd: [],
      invalidJsonLd: [],
    };
    const fetchErrors: FetchFailure[] = [];
    const titles = new Map<string, string[]>();
    const foundOn = new Map<string, string>();
    let pagesCrawled = 0;

    while (queue.length > 0 && visited.size < maxPages) {
      const current = queue.shift()!;
      visited.add(current);
      if (visited.size > 1) await sleep(CRAWL_DELAY_MS);

      const fail = (status: number | null, error: string | null) =>
        fetchErrors.push({ url: current, status, foundOn: foundOn.get(current) ?? null, error });

      let page: Fetched;
      try {
        page = await get(current);
      } catch (err) {
        fail(null, errorMessage(err));
        continue;
      }
      if (page.status >= 400) {
        fail(page.status, null);
        continue;
      }

      pagesCrawled++;
      const $ = cheerio.load(page.body);
      const audit = auditDocument($, current, page.finalUrl, page.status);

      if (!audit.metaDescription.text) issues.missingMetaDescription.push(current);
      if (audit.title.length > 70) issues.titleTooLong.push(current);
      if (audit.title.length < 30) issues.titleTooShort.push(current);
      if (audit.h1Count === 0) issues.missingH1.push(current);
      if (audit.h1Count > 1) issues.multipleH1.push(current);
      if (audit.images.missingAlt > 0) issues.imagesWithoutAlt.push(current);
      if (!audit.canonical) issues.missingCanonical.push(current);
      const jsonLd = parseJsonLd($);
      if (jsonLd.blocks.length === 0) issues.noJsonLd.push(current);
      else if (validateSchema(jsonLd.blocks).some((v) => v.missingRequired.length > 0)) {
        issues.invalidJsonLd.push(current);
      }
      if (audit.title.text) {
        const sameTitle = titles.get(audit.title.text) ?? [];
        sameTitle.push(current);
        titles.set(audit.title.text, sameTitle);
      }

      for (const link of extractPageLinks($, page.finalUrl).internal) {
        const next = crawlableUrl(link, origin);
        if (!next || queued.has(next)) continue;
        queued.add(next);
        foundOn.set(next, current);
        queue.push(next);
      }
    }

    for (const urls of titles.values()) {
      if (urls.length > 1) issues.duplicateTitles.push(...urls);
    }

    const pagesFailed = fetchErrors.length;
    const report: Record<string, unknown> = {
      startUrl,
      pagesCrawled,
      pagesFailed,
      summary: crawlSummary(startUrl, pagesCrawled, pagesFailed, issues),
    };
    for (const [category, urls] of Object.entries(issues)) {
      if (urls.length > 0) report[category] = issueGroup(urls, maxIssuesPerCategory);
    }
    if (fetchErrors.length > 0) {
      report.fetchErrors = issueGroup(fetchErrors, maxIssuesPerCategory);
    }

    return result(report);
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("mcp-seo-audit ready");
