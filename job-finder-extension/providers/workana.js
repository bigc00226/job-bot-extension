// Workana: the listing URL returns JSON when requested with X-Requested-With: XMLHttpRequest
// ({ results: { results[], pagination } }). Budgets are USD text. Workana doesn't publish
// identity / phone verification — only "payment method verified", shown as an extra.
import { fetchPage, parseHtml, text, abs, toInt, multiline } from "./common.js";

const BASE = "https://www.workana.com";

// Workana's own top-level categories (slug = the site's category filter).
const CATEGORIES = [
  { id: "it-programming", label: "IT & Programming" },
  { id: "design-multimedia", label: "Design & Multimedia" },
  { id: "writing-translation", label: "Writing & Translation" },
  { id: "sales-marketing", label: "Sales & Marketing" },
  { id: "admin-support", label: "Admin Support" },
  { id: "legal", label: "Legal" },
  { id: "finance-management", label: "Finance & Management" },
  { id: "engineering-manufacturing", label: "Engineering & Manufacturing" }
];

function listUrl(category, keyword) {
  const url = new URL(`${BASE}/jobs`);
  url.searchParams.set("language", "xx"); // projects in any language
  if (category) url.searchParams.set("category", category);
  if (keyword) url.searchParams.set("query", keyword);
  return url.href;
}

export default {
  id: "workana",
  name: "Workana",
  categories: CATEGORIES,
  // Jobs posted by the site's operator (Workana's own accounts) are excluded.
  operator: /^workana($|[\s._-])/i,

  // Newest-first page 1 of the chosen category ("" = all categories).
  async list({ category, keyword, signal }) {
    const data = await fetchPage(listUrl(category, keyword), signal, { json: true });
    const label = CATEGORIES.find(c => c.id === category)?.label;
    return parseResults(data).map(job => (label ? { ...job, siteCategory: label } : job));
  },

  async detail(job, signal) {
    const { doc } = await fetchPage(`${BASE}/job/${encodeURIComponent(job.id)}`, signal);
    return parseDetail(doc);
  },

  // light: skip the extra ratings request (used for the background sign-up-date check).
  async profile(job, signal, { light = false } = {}) {
    if (!job.client?.url) throw new Error("Client page not found (try again once the job details have loaded)");
    const { doc } = await fetchPage(job.client.url, signal);
    const profile = parseProfile(doc, job.client.url);
    // The rating count comes from the ratings endpoint (JSON), not the profile page.
    const hash = job.client.url.match(/\/e\/([^/?#]+)/)?.[1];
    if (hash && !light) {
      try {
        const ratings = await fetchPage(`${BASE}/employer/${hash}/ratings`, signal, { json: true });
        const tile = profile.tiles.find(t => t[0] === "Rating");
        if (tile && ratings?.initial?.total != null) tile[2] = `${ratings.initial.total} reviews`;
      } catch { /* the count is optional */ }
    }
    return profile;
  }
};

const fragment = html => parseHtml(html).body;

// "USD 1,000 - 3,000", "Less than USD 50", "USD 15 - 45 / hour", "Over USD 45 / hour"
// (Spanish/Portuguese locales use "." for thousands). Amounts are whole dollars.
export function parseBudget(raw) {
  const s = (raw || "").replace(/(\d)[.,](?=\d{3}\b)/g, "$1");
  const numbers = (s.match(/\d+/g) || []).map(Number);
  const hourly = /hour|hora/i.test(s);
  if (!numbers.length) return { min: null, max: null, hourly };
  if (/less than|menos de|até|hasta/i.test(s)) return { min: null, max: numbers[0], hourly };
  if (/over|más de|mais de/i.test(s)) return { min: numbers[0], max: null, hourly };
  return { min: numbers[0], max: numbers[numbers.length - 1], hourly };
}

export function parseResults(data) {
  return (data?.results?.results || []).map(item => {
    const titleEl = fragment(item.title);
    const country = fragment(item.country).querySelector("img.flag");
    const budget = parseBudget(item.budget);
    const skills = (item.skills || []).map(s => s.anchorText).filter(Boolean);
    const extra = [];
    if (item.rating?.value) extra.push(`Rating ${item.rating.value}`);
    if (country?.getAttribute("title")) extra.push(country.getAttribute("title"));
    return {
      site: "workana",
      id: item.slug,
      url: `${BASE}/job/${item.slug}`,
      title: titleEl.querySelector("span[title]")?.getAttribute("title") || text(titleEl),
      siteCategory: skills.slice(0, 3).join(", "),
      budgetMin: budget.min,
      budgetMax: budget.max,
      budgetType: item.isHourly || budget.hourly ? "hourly" : "fixed",
      budgetText: item.budget || "",
      currency: "USD",
      bids: toInt(item.totalBids),
      deadline: item.deadlineValue || "",
      postedText: item.postedDate || "",
      client: {
        name: item.authorName || "",
        url: "",
        avatar: fragment(item.profileLogo).querySelector("img")?.getAttribute("src") || "",
        identityVerified: null,
        phoneVerified: null,
        // Workana's only client check (it doesn't publish identity / phone verification).
        paymentVerified: typeof item.hasVerifiedPaymentMethod === "boolean" ? item.hasVerifiedPaymentMethod : null,
        extra
      }
    };
  }).filter(job => job.id);
}

export function parseDetail(doc) {
  const detail = { client: {}, rows: [] };

  // The source is <p class="specification"><div class="expander">…</div></p>; the parser closes the
  // <p> before the <div>, so select the div directly. Full text is in the HTML ("Read more" is client-side).
  const description = doc.querySelector("section.block-detail div.expander") || doc.querySelector("p.specification + div.expander");
  if (description) detail.description = multiline(description);

  const statusLabel = doc.querySelector("header#productName > span.label, #productName .label");
  const status = text(statusLabel);
  if (status) detail.rows.push(["Status", status]);
  // Open projects carry the "open" class on their status label (e.g. "Evaluating bids").
  if (statusLabel && !statusLabel.classList.contains("open")) detail.closed = true;
  // Rows like "Category <b>…</b><br>Subcategory <b>…</b><br>What do you need? <b>…</b>"
  const labelled = [...doc.querySelectorAll("section.block-detail article p.mt20")].find(p => p.querySelector("b"));
  if (labelled) {
    let label = "";
    for (const node of labelled.childNodes) {
      if (node.nodeName === "B") {
        if (label) detail.rows.push([label.replace(/[:：]\s*$/, ""), text(node)]);
        label = "";
      } else if (node.nodeType === Node.TEXT_NODE) {
        label += node.textContent.trim();
      }
    }
  }
  const skills = [...doc.querySelectorAll("section.block-detail .skills a.skill")].map(text).filter(Boolean);
  if (skills.length) detail.rows.push(["Skills", skills.join(", ")]);
  const since = [...doc.querySelectorAll("aside p, aside span")].map(text).find(t => /Member since|Miembro desde|Membro desde/i.test(t));

  // "Published on the October 22, 2026 in Sales & Marketing"
  const published = text(doc.querySelector("#productName p.h4"));
  const date = published.match(/([A-Z][a-z]+ \d{1,2}, \d{4})/)?.[1];
  if (date && !Number.isNaN(Date.parse(date))) {
    detail.postedAt = new Date(date).toISOString();
    detail.postedText = new Date(date).toLocaleDateString("ja-JP");
  }

  const category = [...doc.querySelectorAll("p.mt20")].find(p => /^(Category|Categoría|Categoria)/.test(text(p)));
  if (category) detail.siteCategory = text(category.querySelector("b"));

  const delivery = [...doc.querySelectorAll("p.mt20")].find(p => /Delivery term|Plazo de entrega|Prazo de entrega/i.test(text(p)));
  if (delivery) detail.deliveryDate = text(delivery).replace(/^[^:]*:\s*/, "");

  for (const item of doc.querySelectorAll(".item-data")) {
    if (/^(Bids|Propuestas|Propostas)/i.test(text(item).replace(/^\d+\s*/, ""))) detail.bids = toInt(text(item.querySelector("p.h4")));
  }

  const info = doc.querySelector("aside .wk-user-info") || doc.querySelector(".wk-user-info");
  if (info) {
    const link = info.querySelector("a.user-name");
    detail.client.name = text(link?.querySelector("span") || link);
    detail.client.url = abs(link?.getAttribute("href"), BASE);
    detail.client.avatar = abs(info.querySelector(".profile-photo img")?.getAttribute("src"), BASE);
  }
  const extra = [];
  detail.client.paymentVerified = /Verified payment method|Pago verificado|Pagamento verificado|Método de pago verificado|Método de pagamento verificado/i.test(doc.body.textContent);
  const stars = (doc.querySelector(".stars-fill")?.getAttribute("style") || "").match(/width:\s*([\d.]+)%/)?.[1];
  if (stars) extra.push(`Rating ${(Number(stars) / 20).toFixed(1)}`);
  for (const item of doc.querySelectorAll(".item-data")) {
    const label = text(item).replace(text(item.querySelector("p.h4")), "").trim();
    if (/Published projects|Proyectos publicados|Projetos publicados/i.test(label)) extra.push(`Projects posted ${text(item.querySelector("p.h4"))}`);
    if (/Projects paid|Proyectos pagos|Proyectos pagados|Projetos pagos/i.test(label)) extra.push(`Projects paid ${text(item.querySelector("p.h4"))}`);
  }
  if (since) extra.push(since.replace(/^[^:：]*[:：]\s*/, "Member since "));
  detail.client.extra = extra;
  return detail;
}

// Client page /e/{hash}: a Vue shell whose data is JSON in <profile-employer :initials="…">.
// Logged out, Workana masks the name ("J. S.") and photo; the real name in the data is not used.
export function parseProfile(doc, url) {
  const raw = doc.querySelector("profile-employer")?.getAttribute(":initials");
  if (!raw) throw new Error("Profile data not found");
  const data = JSON.parse(raw);
  const personal = data.personalDataInitials || {};
  const stats = personal.stats || {};
  const stat = html => fragment(html);
  const tiles = [], rows = [];

  const published = stat(stats.published).querySelector("strong");
  tiles.push(["Projects posted", published ? text(published) : "0"]);
  const paid = stat(stats.paid);
  const rate = text(paid.querySelector("span"));
  tiles.push(["Projects paid", paid.querySelector("strong") ? text(paid.querySelector("strong")) : "0"]);
  tiles.push(["Completion rate", rate || "—", "paid ÷ posted"]);
  const rating = personal.profileStarsInitials?.rating;
  tiles.push(["Rating", rating != null ? Number(rating).toFixed(2) : "—"]);

  const registered = stat(stats.registeredSince).querySelector("strong");
  // English title like "June 29, 2025 08:47" (other languages don't parse; the date is then shown as text).
  const registeredDate = registered ? new Date(registered.getAttribute("title") || "") : null;
  const registeredAt = registeredDate && !Number.isNaN(registeredDate.getTime()) ? registeredDate.toISOString() : null;
  if (registered) rows.push(["Registered", registeredAt
    ? `${registeredDate.getFullYear()}/${registeredDate.getMonth() + 1}/${registeredDate.getDate()}`
    : registered.getAttribute("title") || text(registered)]);
  const login = stat(stats.lastLogin).querySelector("strong");
  if (login?.getAttribute("title")) rows.push(["Last login", login.getAttribute("title")]);
  if (personal.country?.name) rows.push(["Country", personal.country.name]);

  return {
    name: personal.visibleName || "",
    avatar: data.profileLogo?.url || data.viewLogoInitials?.image?.url || "",
    url,
    lastSeen: login ? text(login) : "",
    registeredAt,
    intro: [data.descriptionSectionInitials?.description, data.companyDescription, personal.tagline].filter(Boolean).join("\n\n"),
    tiles,
    rows,
    // Workana publishes only the payment-method check.
    checks: [
      ["Payment method", typeof personal.hasVerifiedPaymentMethod === "boolean" ? personal.hasVerifiedPaymentMethod : null],
      ["Identity", null],
      ["Phone", null]
    ]
  };
}
