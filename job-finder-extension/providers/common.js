// Helpers shared by the site adapters. Each adapter exports
//   { id, name, list({ keyword, categories, pages, signal }) → Job[], detail(job, signal) → Partial<Job> }
// where a Job is
//   { site, id, url, title, siteCategory, budgetMin, budgetMax, budgetType ("fixed"|"hourly"|"task"),
//     budgetText, currency ("JPY"|"USD"), bids, deliveryDate, deadline, postedAt (ISO), postedText,
//     client: { name, url, avatar, identityVerified (true|false|null), phoneVerified, extra: [] } }

const REQUEST_GAP_MS = 700;   // pause between requests to the same site
const lastRequest = new Map();

// Fetches a page with this browser's cookies, spacing requests to the same host.
export async function fetchPage(url, signal, { json = false } = {}) {
  const host = new URL(url).host;
  const wait = (lastRequest.get(host) || 0) + REQUEST_GAP_MS - Date.now();
  lastRequest.set(host, Date.now() + Math.max(0, wait));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  if (signal?.aborted) throw new Error("cancelled");

  const res = await fetch(url, {
    credentials: "include",
    signal,
    headers: json ? { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" } : {}
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${new URL(url).pathname}`);
  if (json) return res.json();
  const html = await res.text();
  return { html, doc: parseHtml(html), url: res.url };
}

// Parses a fetched page with its inline handlers renamed (onclick="…" → data-onclick="…"): they never
// run in a parsed page, but Chrome still reports each one as a CSP violation on the extension's errors
// page. Their text stays readable (Lancers' listing keeps the job id only in onclick).
export const parseHtml = html => new DOMParser().parseFromString(
  (html || "").replace(/<[a-z](?:[^>"']|"[^"]*"|'[^']*')*>/gi,
    tag => tag.replace(/(\s)(on[a-z]+\s*=)/gi, "$1data-$2")),
  "text/html");

export const text = node => (node?.textContent || "").replace(/\s+/g, " ").trim();

// Text of a block with its line breaks kept (<br> → newline), for descriptions and introductions.
export function multiline(node, { brIsNewline = true } = {}) {
  if (!node) return "";
  const copy = node.cloneNode(true);
  if (brIsNewline) copy.querySelectorAll("br").forEach(br => br.replaceWith("\n"));
  copy.querySelectorAll("p, div, li").forEach(block => block.append("\n"));
  return copy.textContent.replace(/[ \t ]+\n/g, "\n").replace(/\n[ \t ]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
export const abs = (href, base) => {
  try { return href ? new URL(href, base).href : ""; } catch { return ""; }
};

// "5,000円" → 5000, "1.5万円" → 15000, "10万円以上" → 100000, "$250" → 250. Null if no number.
export function parseAmount(raw) {
  const s = (raw || "").normalize("NFKC").replace(/[,，\s]/g, "");
  const m = s.match(/(\d+(?:\.\d+)?)(万)?/);
  if (!m) return null;
  return Math.round(Number(m[1]) * (m[2] ? 10000 : 1));
}

// "5,000円 〜 10,000円" → [5000, 10000]; a single amount gives [n, n].
export function parseRange(raw) {
  const parts = (raw || "").normalize("NFKC").split(/[〜~～\-–—]|から/).map(parseAmount).filter(n => n != null);
  if (!parts.length) return [null, null];
  return [parts[0], parts[parts.length - 1]];
}

export const toInt = raw => {
  const m = (raw ?? "").toString().normalize("NFKC").replace(/,/g, "").match(/\d+/);
  return m ? Number(m[0]) : null;
};

// Runs `fn` over the pages 1..n, stopping early when a page returns nothing.
export async function collectPages(pages, fn) {
  const all = [];
  for (let page = 1; page <= pages; page++) {
    const jobs = await fn(page);
    all.push(...jobs);
    if (!jobs.length) break;
  }
  return all;
}
