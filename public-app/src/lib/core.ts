import dns from "node:dns/promises";
import net from "node:net";

const UA = "CATFISH-Public/0.1 (+https://github.com/hopeless-t/catfish)";
const MAX_FETCH_BYTES = 1_500_000;
const MAX_REDIRECTS = 4;
type SearchProvider = "bing" | "yahoo" | "brave";

const PROVIDER_COOLDOWN_MS = 5 * 60_000;
const SEARCH_UA = "Mozilla/5.0 AppleWebKit/537.36 CATFISH-Public/0.1 (+https://github.com/hopeless-t/catfish)";
const ASCII_SEARCH_ORDER: readonly SearchProvider[] = ["bing", "yahoo", "brave"];
const CJK_SEARCH_ORDER: readonly SearchProvider[] = ["yahoo", "bing", "brave"];
const SEARCH_CACHE_TTL_MS = 2 * 60_000;
const SEARCH_CACHE_MAX = 128;
const providerCooldownUntil = new Map<SearchProvider, number>();
const searchCache = new Map<string, { expiresAt: number; storedAt: number; value: any }>();
const searchInFlight = new Map<string, Promise<any>>();

function decodeHtml(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => {
      const cp = Number.parseInt(hex, 16);
      return Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : _m;
    })
    .replace(/&#(\d+);/g, (_m, dec) => {
      const cp = Number.parseInt(dec, 10);
      return Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : _m;
    })
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function stripTags(s: string): string {
  return decodeHtml(
    s
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<!--([\s\S]*?)-->/g, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function isPrivateIp(address: string): boolean {
  if (net.isIPv4(address)) {
    const p = address.split(".").map(Number);
    return (
      p[0] === 10 ||
      p[0] === 127 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      p[0] === 0 ||
      p[0] >= 224
    );
  }
  if (net.isIPv6(address)) {
    const a = address.toLowerCase();
    return a === "::1" || a === "::" || a.startsWith("fc") || a.startsWith("fd") || a.startsWith("fe8") || a.startsWith("fe9") || a.startsWith("fea") || a.startsWith("feb");
  }
  return true;
}

async function assertPublicUrl(input: string): Promise<URL> {
  const u = new URL(input);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error("Only http/https URLs are supported");
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error("Local/private targets are not allowed");
  const rows = await dns.lookup(host, { all: true, verbatim: true });
  if (!rows.length || rows.some((r) => isPrivateIp(r.address))) throw new Error("Local/private targets are not allowed");
  return u;
}

async function readBodyLimited(res: Response): Promise<{ text: string; bodyBytes: number }> {
  if (!res.body) return { text: "", bodyBytes: 0 };
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let text = "";
  let bodyBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    bodyBytes += value.byteLength;
    if (bodyBytes > MAX_FETCH_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error(`Response exceeds ${MAX_FETCH_BYTES} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return { text, bodyBytes };
}

export async function safeFetchText(input: string): Promise<{url: string; status: number; contentType: string; contentEncoding: string | null; contentLength: number | null; bodyBytes: number; text: string}> {
  let u = await assertPublicUrl(input);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const res = await fetch(u, {
      redirect: "manual",
      headers: {
        "user-agent": UA,
        "accept": "text/html,text/plain,application/xhtml+xml,application/json;q=0.8,*/*;q=0.3",
      },
      signal: AbortSignal.timeout(12_000),
    });
    if ([301,302,303,307,308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error(`Redirect ${res.status} without Location`);
      u = await assertPublicUrl(new URL(loc, u).toString());
      continue;
    }
    const body = await readBodyLimited(res);
    const raw = body.text;
    const ct = res.headers.get("content-type") || "";
    let text = raw;
    if (ct.includes("html") || /<html[\s>]/i.test(raw)) text = stripTags(raw);
    else if (ct.includes("json")) {
      try { text = JSON.stringify(JSON.parse(raw), null, 2); } catch { /* keep raw */ }
    }
    return {
      url: u.toString(),
      status: res.status,
      contentType: ct,
      contentEncoding: res.headers.get("content-encoding"),
      contentLength: Number(res.headers.get("content-length")) || null,
      bodyBytes: body.bodyBytes,
      text,
    };
  }
  throw new Error("Too many redirects");
}

function decodeBingRedirect(href: string): string {
  try {
    const u = new URL(href);
    if (!u.hostname.endsWith("bing.com") || !u.pathname.startsWith("/ck/")) return href;
    const token = u.searchParams.get("u") || "";
    if (!token.startsWith("a1")) return href;
    const b64 = token.slice(2).replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    return /^https?:\/\//i.test(decoded) ? decoded : href;
  } catch { return href; }
}

function anchors(html: string): Array<{href: string; title: string; cls: string; inner: string}> {
  const out: Array<{href: string; title: string; cls: string; inner: string}> = [];
  const re = /<a\b([^>]*?)href=["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) {
    const attrs = `${m[1]} ${m[3]}`;
    const cls = attrs.match(/class=["']([^"']*)["']/i)?.[1] || "";
    const title = stripTags(m[4]).trim();
    out.push({ href: decodeHtml(m[2]), title, cls, inner: m[4] });
  }
  return out;
}

function bingResults(html: string, limit: number) {
  const out: Array<{title: string; url: string}> = [];
  const seen = new Set<string>();
  const blocks = /<li\b[^>]*class=["'][^"']*\bb_algo\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;
  for (const block of html.matchAll(blocks)) {
    const match = block[1].match(/<h2[^>]*>\s*<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!match) continue;
    const title = stripTags(match[2]).trim();
    const href = decodeBingRedirect(decodeHtml(match[1]));
    let u: URL;
    try { u = new URL(href); } catch { continue; }
    if (!title || !['http:','https:'].includes(u.protocol)) continue;
    u.hash = "";
    const key = u.toString().replace(/\/$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title, url: u.toString() });
    if (out.length >= limit) break;
  }
  return out;
}

function genericResults(html: string, provider: "brave"|"yahoo", limit: number) {
  const seen = new Set<string>();
  const out: Array<{title: string; url: string}> = [];
  for (const a of anchors(html)) {
    let title = a.title;
    if (provider === "yahoo") {
      if (!a.cls.split(/\s+/).includes("sw-Card__titleInner")) continue;
      const titleMain = a.inner.match(/<h3\b[^>]*class=["'][^"']*\bsw-Card__titleMain\b[^"']*["'][^>]*>([\s\S]*?)<\/h3>/i);
      if (titleMain) title = stripTags(titleMain[1]).trim();
    }
    if (!title || title.length > 500) continue;
    if (provider === "brave" && !a.cls.split(/\s+/).some((x) => x === "l1" || x === "title")) continue;
    let u: URL;
    try { u = new URL(a.href); } catch { continue; }
    if (!['http:','https:'].includes(u.protocol)) continue;
    const host = u.hostname.toLowerCase();
    if (provider === "brave" && (host.endsWith(".brave.com") || host === "search.brave.com")) continue;
    if (provider === "yahoo" && (host.endsWith(".yahoo.co.jp") || host.endsWith(".yahoo.com") || host.endsWith(".yimg.jp") || host.endsWith(".yahoo-net.jp"))) continue;
    u.hash = "";
    const key = u.toString().replace(/\/$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title, url: u.toString() });
    if (out.length >= limit) break;
  }
  return out;
}

function normalizeResults(html: string, provider: SearchProvider, limit: number) {
  if (provider === "bing") return bingResults(html, limit);
  return genericResults(html, provider, limit);
}

const QUERY_STOPWORDS = new Set(["a","an","and","are","as","at","by","for","from","how","in","is","of","on","or","the","to","what","when","where","which","while","with"]);

function containsCjk(text: string) {
  return /[\u3040-\u30ff\u3400-\u9fff]/u.test(text);
}

function wordTokens(text: string) {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((x) => x.length >= 2 && !QUERY_STOPWORDS.has(x));
}

function cjkQueryTerms(text: string) {
  const chunks = text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[\s,.;:!?、。！？・／/\()[\]{}「」『』]+/u)
    .map((x) => x.trim())
    .filter(Boolean);
  if (chunks.length > 1) return chunks;
  const only = chunks[0] ?? "";
  const chars = [...only];
  if (chars.length <= 2) return only ? [only] : [];
  const grams: string[] = [];
  for (let i = 0; i < chars.length - 1; i++) grams.push(chars[i] + chars[i + 1]);
  return grams;
}

function relevanceCoverage(query: string, results: Array<{title: string; url: string}>) {
  const haystack = results.slice(0, 5).map((r) => `${r.title} ${r.url}`).join(" ").normalize("NFKC").toLowerCase();
  const queryTerms = containsCjk(query)
    ? [...new Set(cjkQueryTerms(query))]
    : [...new Set(wordTokens(query))];
  if (!queryTerms.length) return results.length ? 1 : 0;
  const resultTerms = containsCjk(query) ? null : new Set(wordTokens(haystack));
  const matched = queryTerms.filter((term) => resultTerms ? resultTerms.has(term) : haystack.includes(term)).length;
  return matched / queryTerms.length;
}

function providerCoolingDown(provider: SearchProvider, now = Date.now()) {
  const until = providerCooldownUntil.get(provider) ?? 0;
  if (until <= now) {
    providerCooldownUntil.delete(provider);
    return 0;
  }
  return until - now;
}

function coolDownProvider(provider: SearchProvider, status: number) {
  if (status === 403 || status === 429) providerCooldownUntil.set(provider, Date.now() + PROVIDER_COOLDOWN_MS);
}

function likelyHasEnoughResults(html: string, provider: SearchProvider, limit: number) {
  const marker = provider === "yahoo" ? "sw-Card__titleInner" : provider === "bing" ? "b_algo" : "result";
  let count = 0;
  let at = 0;
  while (count < limit) {
    at = html.indexOf(marker, at);
    if (at < 0) return false;
    count += 1;
    at += marker.length;
  }
  return true;
}

async function readSearchResults(res: Response, provider: SearchProvider, limit: number) {
  if (!res.body) return { results: [], bodyBytes: 0, earlyStop: false };
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let html = "";
  let bodyBytes = 0;
  let nextCheckAt = 64 * 1024;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    bodyBytes += value.byteLength;
    if (bodyBytes > MAX_FETCH_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error(`Response exceeds ${MAX_FETCH_BYTES} bytes`);
    }
    html += decoder.decode(value, { stream: true });
    if (bodyBytes >= nextCheckAt) {
      nextCheckAt = bodyBytes + 64 * 1024;
      if (likelyHasEnoughResults(html, provider, limit)) {
        const results = normalizeResults(html, provider, limit);
        if (results.length >= limit) {
          await reader.cancel().catch(() => {});
          return { results, bodyBytes, earlyStop: true };
        }
      }
    }
  }
  html += decoder.decode();
  return { results: normalizeResults(html, provider, limit), bodyBytes, earlyStop: false };
}

async function searchProvider(provider: SearchProvider, query: string, limit: number) {
  const q = encodeURIComponent(query);
  const url = provider === "brave"
    ? `https://search.brave.com/search?q=${q}&source=web`
    : provider === "yahoo"
      ? `https://search.yahoo.co.jp/search?p=${q}`
      : containsCjk(query)
        ? `https://www.bing.com/search?q=${q}`
        : `https://www.bing.com/search?q=${q}&mkt=en-US&setlang=en-US&cc=US`;
  const started = Date.now();
  const res = await fetch(url, {
    headers: { "user-agent": SEARCH_UA, "accept": "text/html" },
    signal: AbortSignal.timeout(10_000),
  });
  const contentLength = Number(res.headers.get("content-length")) || null;
  const parsed = await readSearchResults(res, provider, limit);
  return { provider, status: res.status, elapsedMs: Date.now() - started, contentLength, contentEncoding: res.headers.get("content-encoding"), ...parsed };
}

function pruneSearchCache(now = Date.now()) {
  for (const [key, entry] of searchCache) {
    if (entry.expiresAt <= now) searchCache.delete(key);
  }
  while (searchCache.size > SEARCH_CACHE_MAX) {
    const oldest = searchCache.keys().next().value;
    if (oldest === undefined) break;
    searchCache.delete(oldest);
  }
}

async function performWebSearch(q: string, n: number) {
  const tried: any[] = [];
  const order = containsCjk(q) ? CJK_SEARCH_ORDER : ASCII_SEARCH_ORDER;
  let best: { provider: SearchProvider; results: Array<{title: string; url: string}>; quality: number } | null = null;

  for (const provider of order) {
    const cooldownRemainingMs = providerCoolingDown(provider);
    if (cooldownRemainingMs) {
      tried.push({ provider, skipped: "cooldown", cooldownRemainingMs });
      continue;
    }
    try {
      const r = await searchProvider(provider, q, n);
      coolDownProvider(provider, r.status);
      const quality = relevanceCoverage(q, r.results);
      tried.push({ provider, status: r.status, elapsedMs: r.elapsedMs, results: r.results.length, quality, bodyBytes: r.bodyBytes, contentLength: r.contentLength, contentEncoding: r.contentEncoding, earlyStop: r.earlyStop });
      if (r.results.length) {
        if (!best || quality > best.quality) best = { provider, results: r.results, quality };
        // Every fallback must preserve the query's meaning; a provider response alone is not success.
        if (quality < 0.6) continue;
        return { ok: true, query: q, provider, results: r.results, tried };
      }
    } catch (e) {
      tried.push({ provider, error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (best && best.quality >= 0.5) {
    return { ok: true, query: q, provider: best.provider, results: best.results, tried, degraded: true };
  }
  return {
    ok: false,
    query: q,
    provider: null,
    results: [],
    tried,
    reason: best ? "no_relevant_results" : "no_results",
  };
}

export async function webSearch(query: string, limit = 8) {
  const q = query.trim().replace(/\s+/g, " ");
  if (!q) throw new Error("query is required");
  const n = Math.max(1, Math.min(20, Math.trunc(limit || 8)));
  const key = `${n}\n${q.toLowerCase()}`;
  const now = Date.now();
  pruneSearchCache(now);

  const cached = searchCache.get(key);
  if (cached && cached.expiresAt > now) {
    // Refresh insertion order so frequently reused queries survive the bounded cache.
    searchCache.delete(key);
    searchCache.set(key, cached);
    return { ...cached.value, cache: { hit: true, ageMs: now - cached.storedAt } };
  }

  const existing = searchInFlight.get(key);
  if (existing) {
    const value = await existing;
    return { ...value, cache: { hit: true, coalesced: true } };
  }

  const work = performWebSearch(q, n);
  searchInFlight.set(key, work);
  try {
    const value = await work;
    if (value.ok && !value.degraded) {
      const storedAt = Date.now();
      searchCache.set(key, { storedAt, expiresAt: storedAt + SEARCH_CACHE_TTL_MS, value });
      pruneSearchCache(storedAt);
    }
    return { ...value, cache: { hit: false } };
  } finally {
    searchInFlight.delete(key);
  }
}

