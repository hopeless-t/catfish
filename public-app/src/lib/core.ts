import dns from "node:dns/promises";
import net from "node:net";

const UA = "CATFISH-Public/0.1 (+https://github.com/hopeless-t/catfish)";
const MAX_FETCH_BYTES = 1_500_000;
const MAX_REDIRECTS = 4;

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
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

async function readBodyLimited(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_FETCH_BYTES) throw new Error(`Response exceeds ${MAX_FETCH_BYTES} bytes`);
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.byteLength; }
  return new TextDecoder("utf-8", { fatal: false }).decode(all);
}

export async function safeFetchText(input: string): Promise<{url: string; status: number; contentType: string; text: string}> {
  let u = await assertPublicUrl(input);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const res = await fetch(u, {
      redirect: "manual",
      headers: {
        "user-agent": UA,
        "accept": "text/html,text/plain,application/xhtml+xml,application/json;q=0.8,*/*;q=0.3",
        "accept-encoding": "identity",
      },
      signal: AbortSignal.timeout(12_000),
    });
    if ([301,302,303,307,308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error(`Redirect ${res.status} without Location`);
      u = await assertPublicUrl(new URL(loc, u).toString());
      continue;
    }
    const raw = await readBodyLimited(res);
    const ct = res.headers.get("content-type") || "";
    let text = raw;
    if (ct.includes("html") || /<html[\s>]/i.test(raw)) text = stripTags(raw);
    else if (ct.includes("json")) {
      try { text = JSON.stringify(JSON.parse(raw), null, 2); } catch { /* keep raw */ }
    }
    return { url: u.toString(), status: res.status, contentType: ct, text };
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

function anchors(html: string): Array<{href: string; title: string; cls: string}> {
  const out: Array<{href: string; title: string; cls: string}> = [];
  const re = /<a\b([^>]*?)href=["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) {
    const attrs = `${m[1]} ${m[3]}`;
    const cls = attrs.match(/class=["']([^"']*)["']/i)?.[1] || "";
    const title = stripTags(m[4]).trim();
    out.push({ href: decodeHtml(m[2]), title, cls });
  }
  return out;
}

function normalizeResults(html: string, provider: "brave"|"bing", limit: number) {
  const reject = new Set(["search.brave.com","cdn.search.brave.com","imgs.search.brave.com","tiles.search.brave.com","www.bing.com","bing.com","r.bing.com","go.microsoft.com","support.microsoft.com","account.microsoft.com"]);
  const seen = new Set<string>();
  const out: Array<{title: string; url: string}> = [];
  for (const a of anchors(html)) {
    if (!a.title || a.title.length > 500) continue;
    if (provider === "brave" && !a.cls.split(/\s+/).some((x) => x === "l1" || x === "title")) continue;
    if (provider === "bing" && a.cls.split(/\s+/).includes("tilk")) continue;
    let href = provider === "bing" ? decodeBingRedirect(a.href) : a.href;
    let u: URL;
    try { u = new URL(href); } catch { continue; }
    if (!['http:','https:'].includes(u.protocol)) continue;
    const host = u.hostname.toLowerCase();
    if (reject.has(host) || host.endsWith(".bing.com") || host.endsWith(".brave.com")) continue;
    const key = u.toString().replace(/\/$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title: a.title, url: u.toString() });
    if (out.length >= limit) break;
  }
  return out;
}

async function searchProvider(provider: "brave"|"bing", query: string, limit: number) {
  const q = encodeURIComponent(query);
  const url = provider === "brave"
    ? `https://search.brave.com/search?q=${q}&source=web`
    : `https://www.bing.com/search?q=${q}`;
  const started = Date.now();
  const res = await fetch(url, {
    headers: { "user-agent": UA, "accept-encoding": "identity", "accept": "text/html" },
    signal: AbortSignal.timeout(10_000),
  });
  const html = await readBodyLimited(res);
  const results = normalizeResults(html, provider, limit);
  return { provider, status: res.status, elapsedMs: Date.now() - started, results };
}

export async function webSearch(query: string, limit = 8) {
  const q = query.trim().replace(/\s+/g, " ");
  if (!q) throw new Error("query is required");
  const n = Math.max(1, Math.min(20, Math.trunc(limit || 8)));
  const tried: any[] = [];
  for (const provider of ["brave","bing"] as const) {
    try {
      const r = await searchProvider(provider, q, n);
      tried.push({ provider, status: r.status, elapsedMs: r.elapsedMs, results: r.results.length });
      if (r.results.length) return { ok: true, query: q, provider, results: r.results, tried };
    } catch (e) {
      tried.push({ provider, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { ok: false, query: q, provider: null, results: [], tried };
}
