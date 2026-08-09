#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as cheerio from "cheerio";
import { z } from "zod";

const USER_AGENT =
  "Mozilla/5.0 (compatible; mcp-seo-audit/0.4; +https://github.com/mk-techi/mcp-seo-audit)";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
// The sitemap protocol itself allows 50 MB uncompressed, and both limits count
// decompressed bytes (fetch inflates gzip before the body stream is read).
const SITEMAP_TIMEOUT_MS = 30_000;
const MAX_SITEMAP_BYTES = 50 * 1024 * 1024;

type Fetched = { status: number; body: string; finalUrl: string };
type FetchLimits = { timeoutMs?: number; maxBytes?: number; headers?: Record<string, string> };

async function readBody(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      // cancel() rejects if the stream errored meanwhile; the size error must win
      await reader.cancel().catch(() => {});
      throw new Error(`Response exceeded ${maxBytes / 1024 / 1024} MB limit`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function get(url: string, limits: FetchLimits = {}, postJson?: string): Promise<Fetched> {
  const res = await fetch(url, {
    method: postJson === undefined ? "GET" : "POST",
    headers: {
      "User-Agent": USER_AGENT,
      ...(postJson === undefined ? {} : { "Content-Type": "application/json" }),
      ...limits.headers,
    },
    body: postJson,
    redirect: "follow",
    signal: AbortSignal.timeout(limits.timeoutMs ?? FETCH_TIMEOUT_MS),
  });
  const body = await readBody(res, limits.maxBytes ?? MAX_RESPONSE_BYTES);
  return { status: res.status, body, finalUrl: res.url };
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
    (new URL(absolute).origin === origin ? internal : external).push(absolute);
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

// Overridable so tests can point at a local mock of the CrUX API ("||" so an
// empty value also falls back to the real endpoint).
const CRUX_ENDPOINT =
  process.env.CRUX_API_ENDPOINT || "https://chromeuxreport.googleapis.com/v1/records:queryRecord";
const CRUX_KEY_HELP =
  "check_vitals needs a free Google API key in the CRUX_API_KEY environment variable. " +
  "Create one at https://console.cloud.google.com/apis/credentials and enable the " +
  "Chrome UX Report API for its project (https://developer.chrome.com/docs/crux/api) — " +
  "no billing account required. All other tools work without it.";

type VitalVerdict = "good" | "needs improvement" | "poor";
type Vital = { p75: number; unit: "ms" | "unitless"; verdict: VitalVerdict };

// Official Core Web Vitals thresholds: good is <= the first bound, poor is > the second.
const VITAL_METRICS: {
  name: string;
  apiName: string;
  good: number;
  poor: number;
  unit: "ms" | "unitless";
}[] = [
  { name: "lcp", apiName: "largest_contentful_paint", good: 2500, poor: 4000, unit: "ms" },
  { name: "cls", apiName: "cumulative_layout_shift", good: 0.1, poor: 0.25, unit: "unitless" },
  { name: "inp", apiName: "interaction_to_next_paint", good: 200, poor: 500, unit: "ms" },
  { name: "fcp", apiName: "first_contentful_paint", good: 1800, poor: 3000, unit: "ms" },
  { name: "ttfb", apiName: "time_to_first_byte", good: 800, poor: 1800, unit: "ms" },
];

type CruxResponse = {
  record?: { metrics?: Record<string, unknown>; collectionPeriod?: unknown };
  urlNormalizationDetails?: { originalUrl?: string; normalizedUrl?: string };
  error?: { message?: string; status?: string };
};

function extractVitals(metrics: Record<string, unknown>): Record<string, Vital> {
  const vitals: Record<string, Vital> = {};
  for (const { name, apiName, good, poor, unit } of VITAL_METRICS) {
    // TTFB is still reported as experimental_time_to_first_byte by the API
    const metric = (metrics[apiName] ?? metrics[`experimental_${apiName}`]) as
      | { percentiles?: { p75?: number | string } }
      | undefined;
    const raw = metric?.percentiles?.p75;
    if (raw === undefined) continue;
    const p75 = Number(raw);
    if (!Number.isFinite(p75)) continue;
    vitals[name] = {
      p75,
      unit,
      verdict: p75 <= good ? "good" : p75 <= poor ? "needs improvement" : "poor",
    };
  }
  return vitals;
}

function vitalsSummary(vitals: Record<string, Vital>): string {
  const names = Object.keys(vitals);
  if (names.length === 0) return "CrUX returned a record but none of the known metrics.";
  const order: VitalVerdict[] = ["good", "needs improvement", "poor"];
  const core = ["lcp", "cls", "inp"].flatMap((n) => (vitals[n] ? [vitals[n].verdict] : []));
  const overall =
    core.length > 0 ? order[Math.max(...core.map((v) => order.indexOf(v)))] : null;
  const parts = names.map((n) => {
    const v = vitals[n];
    return `${n.toUpperCase()} ${v.p75}${v.unit === "ms" ? " ms" : ""} (${v.verdict})`;
  });
  return parts.join(", ") + (overall ? `. Core Web Vitals assessment: ${overall}.` : ".");
}

const server = new McpServer({ name: "mcp-seo-audit", version: "0.4.1" });

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
    const { status, body } = await get(sitemapUrl, {
      timeoutMs: SITEMAP_TIMEOUT_MS,
      maxBytes: MAX_SITEMAP_BYTES,
    });
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
      "Optionally HEAD-checks internal links to find broken ones: status >= 400, or " +
      "status null with the message in error for a network-level failure — including " +
      "links that took longer than 10 s and timed out.",
    inputSchema: {
      url: z.string().url(),
      checkBroken: z.boolean().default(false),
      checkLimit: z.number().int().min(1).max(50).default(20),
    },
  },
  async ({ url, checkBroken, checkLimit }) => {
    const { body, finalUrl } = await get(url);
    const { internal, external, nofollow } = extractPageLinks(cheerio.load(body), finalUrl);

    type BrokenLink = { url: string; status: number | null; error?: string };
    let broken: BrokenLink[] = [];
    if (checkBroken) {
      const toCheck = internal.slice(0, checkLimit);
      const checks = await Promise.allSettled(
        toCheck.map(async (link) => {
          const res = await fetch(link, {
            method: "HEAD",
            headers: { "User-Agent": USER_AGENT },
            redirect: "follow",
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          });
          return { url: link, status: res.status };
        })
      );
      broken = checks.flatMap((c, i): BrokenLink[] =>
        c.status === "fulfilled"
          ? c.value.status >= 400
            ? [c.value]
            : []
          : [{ url: toCheck[i], status: null, error: errorMessage(c.reason) }]
      );
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
    let origin = new URL(startUrl).origin;
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
      // The start URL may redirect to another origin (http→https, apex→www):
      // follow the site where it actually lives, or every link gets rejected.
      // Mark the landing URL as queued too, or the site's self-links (logo,
      // nav "/") would re-crawl the same page under its post-redirect name.
      if (visited.size === 1) {
        origin = new URL(page.finalUrl).origin;
        queued.add(normalizeUrl(page.finalUrl));
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

server.registerTool(
  "check_vitals",
  {
    title: "Check real-user Core Web Vitals (CrUX)",
    description:
      "Query Google's Chrome UX Report API for the Core Web Vitals real Chrome users " +
      "experienced over the last 28 days: LCP, CLS and INP (plus FCP and TTFB when " +
      "reported), each as its 75th-percentile value with a good / needs improvement / " +
      "poor verdict against Google's official thresholds. A bare origin is queried as " +
      "the site-wide aggregate; a URL with a path or query as that page only. Requires " +
      "a free API key in the CRUX_API_KEY environment variable; every other tool works " +
      "without it.",
    inputSchema: {
      url: z.string().url(),
      formFactor: z
        .enum(["PHONE", "DESKTOP", "TABLET", "ALL"])
        .default("PHONE")
        .describe("PHONE by default — Google indexes mobile-first"),
    },
  },
  async ({ url, formFactor }) => {
    const key = process.env.CRUX_API_KEY;
    if (!key) {
      return result({ url, hasData: false, error: "missing_api_key", message: CRUX_KEY_HELP });
    }

    const parsed = new URL(url);
    parsed.hash = ""; // CrUX indexes fragment-less URLs
    const level = parsed.pathname === "/" && !parsed.search ? "origin" : "url";
    const query: Record<string, string> =
      level === "origin" ? { origin: parsed.origin } : { url: parsed.toString() };
    if (formFactor !== "ALL") query.formFactor = formFactor;

    // The key travels in a header, never in the URL: fetch errors quote the
    // URL verbatim in their message, which flows back to the client.
    const { status, body } = await get(
      CRUX_ENDPOINT,
      { headers: { "X-Goog-Api-Key": key } },
      JSON.stringify(query)
    );

    let response: CruxResponse = {};
    try {
      response = JSON.parse(body) as CruxResponse;
    } catch {
      // non-JSON error body: fall through with the raw text below
    }
    const apiMessage = response.error?.message ?? body.slice(0, 200);

    // Only the API's own NOT_FOUND means "no data" — any other 404 (wrong
    // endpoint, intercepting proxy) is a configuration error, not low traffic.
    if (status === 404 && response.error?.status === "NOT_FOUND") {
      const suggestions = [
        ...(level === "url"
          ? [
              `try the bare origin (${parsed.origin}) — the site-wide aggregate needs ` +
                "far less traffic than any single page",
            ]
          : []),
        ...(formFactor !== "ALL"
          ? [
              `try formFactor ALL — ${formFactor} data alone can be missing even when ` +
                "the site has enough traffic overall",
            ]
          : []),
      ];
      return result({
        url,
        formFactor,
        level,
        hasData: false,
        message:
          `CrUX has no field data for this ${level === "origin" ? "origin" : "URL"} ` +
          `on ${formFactor}: not enough Chrome traffic over the last 28 days.` +
          (suggestions.length > 0 ? ` Suggestions: ${suggestions.join("; ")}.` : ""),
      });
    }
    if (status >= 400) {
      const [error, message] = /API key not valid/i.test(apiMessage)
        ? ["invalid_api_key", `The CRUX_API_KEY is not valid: ${apiMessage}`]
        : status === 429
          ? ["quota_exceeded", `CrUX API quota exceeded, retry in a minute: ${apiMessage}`]
          : status === 403
            ? [
                "api_not_enabled",
                "Access denied — the Chrome UX Report API is probably not enabled for " +
                  `this key's project, or the key's restrictions block it: ${apiMessage}`,
              ]
            : ["api_error", `CrUX API error (HTTP ${status}): ${apiMessage}`];
      return result({ url, hasData: false, error, message });
    }

    if (!response.record) {
      return result({
        url,
        hasData: false,
        error: "api_error",
        message: `CrUX API answered HTTP ${status} without a record — unexpected response shape.`,
      });
    }

    const vitals = extractVitals(response.record.metrics ?? {});
    return result({
      url,
      formFactor,
      level,
      hasData: true,
      collectionPeriod: response.record.collectionPeriod ?? null,
      ...(response.urlNormalizationDetails
        ? { urlNormalizationDetails: response.urlNormalizationDetails }
        : {}),
      metrics: vitals,
      summary: vitalsSummary(vitals),
    });
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("mcp-seo-audit ready");
