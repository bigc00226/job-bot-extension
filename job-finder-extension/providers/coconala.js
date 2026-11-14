// Coconala requests (仕事を探す): server-rendered HTML. Listing: /requests[/categories/{id}]?recruiting=true
// (40 per page, newest first; a page past the end is a 404). Detail: /requests/{id} has 納品希望日 and
// the requester's 本人確認. Coconala doesn't publish phone verification.
import { fetchPage, text, abs, toInt } from "./common.js";

const BASE = "https://coconala.com";

// Coconala's own top-level categories (単発の仕事), in the site's order.
const CATEGORIES = [
  { id: "9", label: "Illustration & Manga", ja: "イラスト作成・漫画制作" },
  { id: "18", label: "Design", ja: "デザイン制作" },
  { id: "22", label: "Website Production & Web Design", ja: "Webサイト制作・Webデザイン" },
  { id: "10", label: "Video Editing & Production", ja: "動画編集・映像制作" },
  { id: "16", label: "Marketing & Customer Acquisition", ja: "集客・マーケティング相談" },
  { id: "13", label: "Business & Admin Services", ja: "ビジネス代行・事務代行" },
  { id: "23", label: "Music & Narration", ja: "音楽制作・ナレーション" },
  { id: "11", label: "IT Consulting & System Development", ja: "IT相談・システム開発" },
  { id: "19", label: "Writing & Translation", ja: "ライティング・翻訳" },
  { id: "27", label: "Consulting & Licensed Professionals", ja: "コンサルティング・士業" },
  { id: "28", label: "Generative AI", ja: "生成AI活用・開発・制作" },
  { id: "12", label: "Tutoring, Qualifications & Careers", ja: "学習指導・資格・キャリア相談" },
  { id: "5", label: "Home, Beauty & Lifestyle", ja: "住まい・美容・生活相談" },
  { id: "26", label: "Online Lessons", ja: "オンラインレッスン・習い事" },
  { id: "1001", label: "Handmade", ja: "ハンドメイド制作" }
];

function listUrl(categoryId, keyword, page) {
  const url = new URL(`${BASE}/requests${categoryId ? `/categories/${categoryId}` : ""}`);
  url.searchParams.set("recruiting", "true"); // otherwise the site's cookie may include finished requests
  if (keyword) url.searchParams.set("keyword", keyword);
  if (page > 1) url.searchParams.set("page", String(page));
  return url.href;
}

export default {
  id: "coconala",
  name: "Coconala",
  categories: CATEGORIES,
  // Jobs posted by the site's operator (株式会社ココナラ and its official accounts) are excluded.
  operator: /株式会社ココナラ|ココナラ(事務局|公式|運営)|^ココナラ$|^coconala($|[_\s(（])/i,

  // Newest-first page 1 of the chosen category ("" = all categories).
  async list({ category, keyword, signal }) {
    try {
      const { doc } = await fetchPage(listUrl(category || null, keyword, 1), signal);
      return parseListing(doc);
    } catch (err) {
      if (/HTTP 404/.test(err.message)) return []; // no results
      throw err;
    }
  },

  async detail(job, signal) {
    const { doc, html } = await fetchPage(`${BASE}/requests/${job.id}`, signal);
    return parseDetail(doc, html);
  },

  // Bidders are listed on the request page itself (kept from the details; read again when fewer were
  // kept than the job's proposal count, e.g. lists saved before the full list was read).
  // ({ fresh: true } always reads the page, e.g. after one of your accounts bid.)
  async bidders(job, signal, { fresh = false } = {}) {
    if (!fresh && job.bidders && !(job.bidders.length < (job.bids || 0))) return job.bidders;
    const { doc, html } = await fetchPage(`${BASE}/requests/${job.id}`, signal);
    return parseDetail(doc, html).bidders;
  },

  async profile(job, signal) {
    if (!job.client?.url) throw new Error("Client page not found (try again once the job details have loaded)");
    const { doc, html } = await fetchPage(job.client.url, signal);
    return parseProfile(doc, html, job.client.url, job.client.buyerTiles || []);
  }
};

// ---- Reading values out of window.__NUXT__ without running it ----
// The payload is "(function(a,b,…){…}(arg1,arg2,…))": a field like requester:{id:jx} names a
// parameter, whose value is the argument at the same position.
function parseNuxtCall(html) {
  const m = html.match(/window\.__NUXT__\s*=\s*\(function\(([^)]*)\)\{/);
  if (!m) return null;
  const params = m[1].split(",");
  const skipString = i => { const q = html[i++]; while (i < html.length && html[i] !== q) { if (html[i] === "\\") i++; i++; } return i; };
  let i = m.index + m[0].length, depth = 1;
  while (i < html.length && depth > 0) {
    const ch = html[i];
    if (ch === '"' || ch === "'") i = skipString(i);
    else if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  if (html[i] !== "(") return null;
  const args = [];
  let start = ++i, d = 0;
  for (; i < html.length; i++) {
    const ch = html[i];
    if (ch === '"' || ch === "'") { i = skipString(i); continue; }
    if ("([{".includes(ch)) d++;
    else if ("]}".includes(ch)) d--;
    else if (ch === ")") { if (d === 0) { args.push(html.slice(start, i).trim()); break; } d--; }
    else if (ch === "," && d === 0) { args.push(html.slice(start, i).trim()); start = i + 1; }
  }
  return { params, args };
}

function literal(raw) {
  if (raw == null) return undefined;
  if (/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(raw)) return Number(raw);
  if (raw === "true" || raw === "!0") return true;
  if (raw === "false" || raw === "!1") return false;
  if (raw === "null" || raw === "void 0") return null;
  if (raw[0] === '"') { try { return JSON.parse(raw); } catch { return raw.slice(1, -1); } }
  return undefined;
}

function nuxtResolver(html) {
  let call;
  return token => {
    if (token == null) return undefined;
    if (/^-?\d/.test(token) || token[0] === '"' || /^(true|false|null|!0|!1|void 0)$/.test(token)) return literal(token);
    call ??= parseNuxtCall(html);
    const index = call ? call.params.indexOf(token) : -1;
    return index < 0 ? undefined : literal(call.args[index]);
  };
}
const NUXT_VALUE = '([\\w$]+|"(?:[^"\\\\]|\\\\.)*")';

// Splits "{a:1,b:"x,y"},{…}" (or "a:1,b:2") at top-level commas, skipping strings and nesting.
function splitTopLevel(source) {
  const parts = [];
  let start = 0, depth = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"' || ch === "'") { for (i++; i < source.length && source[i] !== ch; i++) if (source[i] === "\\") i++; continue; }
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    else if (ch === "," && depth === 0) { parts.push(source.slice(start, i)); start = i + 1; }
  }
  parts.push(source.slice(start));
  return parts.map(p => p.trim()).filter(Boolean);
}

// The full 応募者一覧 from __NUXT__: proposersList:[{id,name,icon,proposalDate,…},…].
const AVATAR_BASE = "https://dplhqivlpbfks.cloudfront.net/resize/coconala_profile/100x100";
const proposalTime = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
function parseProposersList(html) {
  const start = html.indexOf("proposersList:[");
  if (start < 0) return [];
  // The array's end: its matching "]".
  let i = start + "proposersList:[".length, depth = 1;
  const from = i;
  for (; i < html.length && depth > 0; i++) {
    const ch = html[i];
    if (ch === '"' || ch === "'") { for (i++; i < html.length && html[i] !== ch; i++) if (html[i] === "\\") i++; continue; }
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
  }
  const resolve = nuxtResolver(html);
  return splitTopLevel(html.slice(from, i - 1)).map(item => {
    const fields = Object.fromEntries(splitTopLevel(item.replace(/^\{|\}$/g, "")).map(f => {
      const colon = f.indexOf(":");
      return [f.slice(0, colon).trim(), resolve(f.slice(colon + 1).trim())];
    }));
    const id = fields.id, name = typeof fields.name === "string" ? fields.name.trim() : "";
    return {
      name,
      url: id ? `${BASE}/users/${id}` : "",
      avatar: typeof fields.icon === "string" && fields.icon ? `${AVATAR_BASE}${fields.icon.startsWith("/") ? "" : "/"}${fields.icon}` : "",
      note: Number.isFinite(fields.proposalDate) ? proposalTime.format(new Date(fields.proposalDate * 1000)) : ""
    };
  }).filter(b => b.name);
}

// "3万" → 30000, "5千" → 5000, "3,000" → 3000.
function amount(raw) {
  const m = (raw || "").normalize("NFKC").replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*(万|千)?/);
  if (!m) return null;
  return Math.round(Number(m[1]) * (m[2] === "万" ? 10000 : m[2] === "千" ? 1000 : 1));
}

// "3万円 〜 5万円", "3,000円", "5千円未満", "見積り希望"
export function parseBudget(raw) {
  const s = (raw || "").replace(/\s+/g, "");
  if (!s || /見積/.test(s)) return { min: null, max: null };
  if (/未満/.test(s)) return { min: null, max: amount(s) };
  const parts = s.split(/[〜~～]/).map(amount).filter(n => n != null);
  return { min: parts[0] ?? null, max: parts[parts.length - 1] ?? null };
}

const jpDate = raw => {
  const m = (raw || "").match(/(\d{4})年(\d{1,2})月(\d{1,2})日(?:\D*?(\d{1,2}):(\d{2}))?/);
  return m ? new Date(+m[1], m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) : null;
};

export function parseListing(doc) {
  return [...doc.querySelectorAll("div.c-searchItemWrapper")].map(card => {
    if (card.querySelector(".c-itemTileLine_emphasis-remainingFinished")) return null; // 募集終了
    const id = (card.querySelector("a.c-searchItem_detailLink")?.getAttribute("href") || "").match(/\/requests\/(\d+)/)?.[1];
    if (!id) return null;
    const category = card.querySelector("a.c-itemInfo_category");
    // A label before the category reading "JOB" (求人, job-matching listings): marked so Job Finder
    // leaves them out.
    const labelBox = card.querySelector(".c-itemInfo_labelCategory");
    const labels = [...(labelBox?.querySelectorAll("*") || [])].filter(n => !n.closest("a.c-itemInfo_category") && !n.children.length).map(text);
    const isJob = labels.some(l => /^(job|jobs|求人)$/i.test(l)) || !!card.querySelector('a[href*="/job_matching"]');
    const budgetText = text(card.querySelector(".c-itemTile_tile-budget .d-requestBudget"));
    const budget = parseBudget(budgetText);
    const posted = jpDate(card.querySelector(".c-itemInfoUser_created span[title]")?.getAttribute("title"));
    const days = text(card.querySelector(".c-itemTileLine_emphasis-remainingDays"));
    const until = text(card.querySelector(".c-itemTileLine_remainingDate"));
    return {
      site: "coconala",
      id,
      url: `${BASE}/requests/${id}`,
      title: text(card.querySelector(".c-itemInfo_title a")),
      kind: isJob ? "job" : "",
      siteCategory: text(category),
      budgetMin: budget.min,
      budgetMax: budget.max,
      budgetType: "fixed",
      budgetText,
      currency: "JPY",
      bids: toInt(text(card.querySelector(".c-itemTileLine_emphasis-proposalCount"))),
      deadline: [days && `${toInt(days)} days left`, until.replace(/[（(](.*?)まで[）)]/, "(until $1)")].filter(Boolean).join(" "),
      closesAt: days ? new Date(Date.now() + toInt(days) * 86400000).toISOString() : null,
      postedAt: posted ? posted.toISOString() : null,
      client: {
        name: text(card.querySelector(".c-itemInfoUser_name span")),
        url: "",
        avatar: "", // lazy-loaded (empty) on the listing; the detail page has it
        identityVerified: null,
        phoneVerified: null,
        extra: []
      }
    };
  }).filter(Boolean);
}

export function parseDetail(doc, html = "") {
  const detail = { client: {}, rows: [] };

  // 募集内容 (full text is in the DOM; 続きを読む is only a CSS clamp) and any 追記.
  detail.description = (doc.querySelector("#requestContentsDetail .c-detailRowContentText")?.textContent || "").replace(/\n[ \t]+/g, "\n").trim();
  const additions = [...doc.querySelectorAll("#requestContentsAddition .c-contentsAddition")].map(a => a.textContent.replace(/\n[ \t]+/g, "\n").trim()).filter(Boolean);
  if (additions.length) detail.description = [detail.description, ...additions.map(a => `[Update]\n${a}`)].filter(Boolean).join("\n\n");

  // Parent > child category from the first breadcrumb.
  const crumbs = [...(doc.querySelector("nav.c-breadcrumb")?.querySelectorAll('a[href^="/requests/categories/"]') || [])].map(text);
  if (crumbs.length) detail.rows.push(["Category", crumbs.join(" > ")]);
  // Structured summary (ジャンル, 用途・種類, 依頼工程 …) and detail rows (求めるスキル, 特記事項, 添付ファイル …).
  for (const row of doc.querySelectorAll("#requestContentsSummary .c-summaryRow")) {
    const label = text(row.querySelector(".c-summaryRowHeading"));
    const value = text(row.querySelector(".c-summaryRowContent"));
    if (label && value) detail.rows.push([label, value]);
  }
  for (const row of doc.querySelectorAll("#requestContentsDetail .c-detailRow:not(.c-detailRow-headingBlock)")) {
    const label = text(row.querySelector(".c-detailRowHeadingInner"));
    const value = text(row.querySelector(".c-detailRowContent"));
    if (label && value && value !== "ー" && !row.querySelector(".c-detailRowContentEmpty")) detail.rows.push([label, value]);
  }

  // 応募者一覧: the freelancers who applied (avatar, name, profile link, date). The page shows the
  // first 5 until もっと見る is pressed; the whole list is in __NUXT__ (proposersList), so it's read
  // from there, and from the rows when that can't be read.
  const rowBidders = [...doc.querySelectorAll("#requestContentsProposers .c-proposersRow-body")].map(row => {
    const link = row.querySelector(".c-proposersRowName a");
    return {
      name: text(link),
      url: abs(link?.getAttribute("href"), BASE),
      avatar: abs(row.querySelector(".c-proposersRowIcon img")?.getAttribute("src"), BASE),
      note: text(row.querySelector(".c-proposersRowDate"))
    };
  }).filter(b => b.name);
  const allBidders = parseProposersList(html);
  detail.bidders = allBidders.length >= rowBidders.length ? allBidders : rowBidders;

  // The requester box has no profile link; the user id is only in __NUXT__.
  const requesterId = html.match(new RegExp(`requester:\\{id:${NUXT_VALUE}`));
  if (requesterId) {
    const id = nuxtResolver(html)(requesterId[1]);
    if (Number.isInteger(id)) detail.client.url = `${BASE}/users/${id}`;
  }

  const rows = Object.fromEntries([...doc.querySelectorAll(".c-requestOutlineRow")]
    .map(row => [text(row.querySelector(".c-requestOutlineRow_heading")), row.querySelector(".c-requestOutlineRow_content")]));
  const row = label => Object.entries(rows).find(([heading]) => heading.includes(label))?.[1];

  if (row("納品希望日")) detail.deliveryDate = text(row("納品希望日"));
  const deadlineRow = row("募集期限");
  if (deadlineRow) {
    const additional = text(deadlineRow.querySelector(".c-requestOutlineRowContent_additional"));
    const closes = additional.match(/締切日\s*([^/]+)/)?.[1]?.trim();
    if (closes) {
      detail.deadline = closes;
      const date = jpDate(closes);
      if (date) detail.closesAt = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59).toISOString();
    }
    if (/募集終了/.test(text(deadlineRow))) detail.closed = true;
    const posted = jpDate(additional.match(/掲載日\s*(\S+)/)?.[1]);
    if (posted) detail.postedAt = posted.toISOString();
  }
  const proposals = row("応募状況")?.querySelector("a.c-requestOutlineRowContent_emphasis-proposalsLink");
  if (proposals) detail.bids = toInt(text(proposals));
  if (row("予算")) {
    const budget = parseBudget(text(row("予算")));
    if (budget.min != null || budget.max != null) Object.assign(detail, { budgetMin: budget.min, budgetMax: budget.max });
  }

  const requester = doc.querySelector("#requestDetailRequester");
  if (requester) {
    detail.client.name = text(requester.querySelector(".c-infoRequesterName span"));
    detail.client.avatar = abs(requester.querySelector(".c-infoRequesterIcon img.c-userIcon")?.getAttribute("src"), BASE);
    const extra = [], checks = [];
    // 認証状況: ✓ = i.-check, not verified = i.-minus-thin.
    for (const r of requester.querySelectorAll(".c-infoRequesterTable-auth .c-infoRequesterTableRow_heading")) {
      const body = r.nextElementSibling;
      const state = body?.querySelector("i.-check") ? true : body?.querySelector("i.-minus-thin") ? false : null;
      const label = text(r);
      if (label.includes("本人確認")) detail.client.identityVerified = state;
      else if (label.includes("電話")) detail.client.phoneVerified = state;
      else checks.push([label.includes("NDA") ? "NDA" : label, state]);
    }
    detail.client.checks = checks;
    // Buyer stats (発注件数 / 発注率 / 取引完了率, rating) exist only here, not on the profile page,
    // so they are kept as tiles for the client view too.
    const STAT_LABELS = { 発注件数: "Jobs ordered", 発注率: "Hire rate", 取引完了率: "Completion rate" };
    const tiles = [];
    for (const column of requester.querySelectorAll(".c-infoRequesterTable-order .c-infoRequesterTableColumn")) {
      const value = text(column.querySelector(".c-infoRequesterTableColumn_body"));
      const label = text(column).replace(value, "").trim();
      if (value) {
        tiles.push([STAT_LABELS[label] || label, value]);
        extra.push(`${STAT_LABELS[label] || label} ${value}`);
      }
    }
    const rating = text(requester.querySelector(".c-infoRequesterRating_rating"));
    if (rating) {
      const count = text(requester.querySelector(".c-infoRequesterRating_count")).replace(/[（）()]/g, "");
      tiles.push(["Rating", rating, count ? `${count} reviews` : ""]);
      extra.push(`Rating ${rating}`);
    }
    detail.client.extra = extra;
    detail.client.buyerTiles = tiles;
  }
  return detail;
}

// Profile /users/{id}: server-rendered. Buyer stats come from the request page (passed in);
// 最終ログイン / プロフィール作成日 are read exactly from __NUXT__ (the DOM shows relative time only).
// Coconala shows no phone verification and no sign-up date; the profile creation time is the closest.
export function parseProfile(doc, html, url, buyerTiles = []) {
  const tiles = [...buyerTiles], rows = [], checks = [];
  const resolve = nuxtResolver(html);
  const start = html.indexOf("pages:{users:{");
  const userAt = start >= 0 ? html.indexOf("user:{id:", start) : -1;
  const segment = userAt >= 0 ? html.slice(userAt, userAt + 20000) : "";
  const field = key => resolve(segment.match(new RegExp(`[{,]${key}:${NUXT_VALUE}`))?.[1]);
  const profileCreated = resolve(segment.match(new RegExp(`profile:\\{id:[^}]*?createdAt:${NUXT_VALUE}`))?.[1]);
  const lastLogin = field("lastLoginedAt");
  const when = seconds => {
    const d = new Date(seconds * 1000);
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  // Coconala shows no sign-up date; the profile creation time is the closest.
  if (Number.isFinite(profileCreated)) rows.push(["Registered (profile created)", when(profileCreated)]);
  if (Number.isFinite(lastLogin)) rows.push(["Last login", when(lastLogin)]);
  const status = text(doc.querySelector(".c-userStatus_label"));
  if (status) rows.push(["Availability", status]);
  // The profile line holds age range, gender and occupation as separate items (e.g. 20代前半 / 女性).
  const other = [];
  for (const item of [...doc.querySelectorAll(".c-userProfile_text")].map(text).filter(Boolean)) {
    if (/^(男性|女性)$/.test(item)) rows.push(["Gender", { 男性: "Male", 女性: "Female" }[item]]);
    else if (/\d0代/.test(item)) rows.push(["Age", item.replace(/(\d0)代前半/, "early $1s").replace(/(\d0)代後半/, "late $1s").replace(/(\d0)代/, "$1s")]);
    else other.push(item);
  }
  if (other.length) rows.push(["Profile", other.join(" · ")]);
  for (const item of doc.querySelectorAll(".c-dataGroup-performance li.c-dataValue_item-performance")) {
    const label = text(item.querySelector(".c-dataValue_name"));
    const value = text(item.querySelector(".c-dataValue_value"));
    const english = { 販売実績: "Sales as a seller", 評価: "Rating as a seller", フォロワー: "Followers" }[label];
    if (value) rows.push([english || label, value]);
  }

  // 本人確認 / 機密保持契約(NDA) / インボイス: "未登録" marks a missing check.
  for (const item of doc.querySelectorAll(".c-dataGroup:not(.c-dataGroup-performance) li.c-dataValue_item")) {
    const label = text(item.querySelector(".c-dataValue_name"));
    const english = label.includes("本人確認") ? "Identity" : label.includes("NDA") ? "NDA" : label.includes("インボイス") ? "Invoice issuer" : label;
    if (label) checks.push([english, !item.querySelector(".c-dataValue_minusText")]);
  }
  checks.push(["Phone", null]); // not published by Coconala

  const name = text(doc.querySelector("h1.c-userName_text a")) || text(doc.querySelector(".isPC p.c-userName_text a")) ||
    (doc.querySelector('meta[property="og:title"]')?.getAttribute("content") || "").replace(/さん[\s\S]*$/, "");
  // 自己紹介: catchphrase + message; if those elements are missing, the whole #introduction
  // section, then the message stored in the page data.
  let intro = [doc.querySelector("h2.p-introduction_catchphrase"), doc.querySelector(".p-introduction_message")]
    .map(node => node?.textContent.replace(/\n[ \t]+/g, "\n").trim())
    .filter(Boolean)
    .join("\n\n");
  if (!intro) {
    const section = doc.querySelector("#introduction")?.cloneNode(true);
    section?.querySelectorAll("h2.c-sectionHeading, button, label, input, script").forEach(n => n.remove());
    intro = (section?.textContent || "").replace(/もっと見る|閉じる/g, "").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  if (!intro) {
    const message = field("message");
    if (typeof message === "string") intro = message.trim();
  }

  return {
    name,
    avatar: doc.querySelector('meta[property="og:image"]')?.getAttribute("content") || "",
    url,
    lastSeen: text(doc.querySelector(".c-userStatus_text")).replace(/^最終ログイン[:：]\s*/, ""),
    registeredAt: Number.isFinite(profileCreated) ? new Date(profileCreated * 1000).toISOString() : null,
    intro,
    tiles,
    rows,
    checks
  };
}
