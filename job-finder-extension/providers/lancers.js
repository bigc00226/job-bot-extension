// Lancers: server-rendered HTML. Listing: /work/search[/{category}]?open=1&sort=started.
// Detail pages need ?purpose=lancer to include the client box (checks, 希望納期).
import { fetchPage, text, abs, parseAmount, toInt } from "./common.js";

const BASE = "https://www.lancers.jp";

// Lancers' own top-level categories (カテゴリーから探す), in the site's order.
const CATEGORIES = [
  { id: "salesmarketing", label: "Marketing, Sales, Research & PR", ja: "マーケティング・営業・リサーチ・広報" },
  { id: "system", label: "AI & System Development", ja: "AI・システム開発・運用" },
  { id: "business", label: "Consulting & Back Office", ja: "コンサルティング・バックオフィス" },
  { id: "multimedia", label: "Video, Photo & Narration", ja: "動画制作・写真撮影・ナレーション" },
  { id: "web", label: "Web Production & Web Design", ja: "Web制作・Webデザイン" },
  { id: "design", label: "Design", ja: "デザイン制作" },
  { id: "writing", label: "Writing & Naming", ja: "ライティング・ネーミング" },
  { id: "task", label: "Tasks & Simple Work", ja: "タスク・作業" },
  { id: "translation", label: "Translation & Interpreting", ja: "翻訳・通訳サービス" }
];

function searchUrl(slug, keyword) {
  const url = new URL(`${BASE}/work/search${slug ? `/${slug}` : ""}`);
  url.searchParams.set("open", "1");
  url.searchParams.set("sort", "started");
  // Without these, category pages are mostly external tech-agent ads.
  for (const type of ["project", "task", "competition"]) url.searchParams.append("type[]", type);
  if (keyword) url.searchParams.set("keyword", keyword);
  return url.href;
}

export default {
  id: "lancers",
  name: "Lancers",
  categories: CATEGORIES,
  // Jobs posted by the site's operator (ランサーズ株式会社 and its official accounts) are excluded.
  operator: /ランサーズ株式会社|ランサーズ(事務局|公式|運営)|^ランサーズ$|^lancers($|[_\s(（])/i,

  // Newest-first page 1 of one category ("" = all categories).
  async list({ category, keyword, signal }) {
    const { doc } = await fetchPage(searchUrl(category || null, keyword), signal);
    return parseListing(doc);
  },

  async detail(job, signal) {
    const { doc } = await fetchPage(`${BASE}/work/detail/${job.id}?purpose=lancer`, signal);
    return parseDetail(doc);
  },

  async profile(job, signal) {
    if (!job.client?.url) throw new Error("The client is hidden on this job");
    const { doc } = await fetchPage(job.client.url, signal);
    return parseProfile(doc, job.client.url);
  },

  // The freelancers who sent proposals, from the job's 提案一覧 page.
  async bidders(job, signal) {
    const { doc } = await fetchPage(`${BASE}/work/proposals/${job.id}`, signal);
    return parseBidders(doc);
  }
};

export function parseBidders(doc) {
  return [...doc.querySelectorAll(".p-proposal-list__proposer")].map(box => {
    const link = box.querySelector("a.p-proposal-list__proposer-heading__displayname");
    return {
      name: text(link),
      url: abs(link?.getAttribute("href"), BASE),
      avatar: abs(box.querySelector("img.p-proposal-list__proposer-figure__img")?.getAttribute("src"), BASE),
      note: text(box.querySelector(".p-proposal-list__proposer-heading__username"))
    };
  }).filter(b => b.name);
}

export function parseListing(doc) {
  return [...doc.querySelectorAll("div.p-search-job-media.c-media--item")]
    .filter(item => !item.closest(".p-search-job__latest-carousel-item") && !item.matches("[data-external-modal]"))
    .map(item => {
      const id = (item.getAttribute("data-onclick") || item.getAttribute("onclick") || "").match(/goToLjpWorkDetail\((\d+)\)/)?.[1];
      if (!id) return null; // external ads and onsite recruits

      const titleLink = item.querySelector("a.p-search-job-media__title")?.cloneNode(true);
      titleLink?.querySelector("ul.p-search-job-media__tags")?.remove();

      const division = item.querySelector("a.p-search-job__division-link");

      const price = item.querySelector("span.p-search-job-media__price");
      const numbers = [...(price?.querySelectorAll(".p-search-job-media__number") || [])].map(n => parseAmount(text(n)));
      const priceText = text(price);
      const workType = text(item.querySelector("[class*='c-badge--worktype-'] .c-badge__text"));
      // "JOB" (求人) listings are marked so Job Finder leaves them out (work type badge or a tag).
      const tags = [...item.querySelectorAll(".p-search-job-media__tag, .p-search-job-media__tags li")].map(text);
      const isJob = /^(job|求人)$/i.test(workType) || !!item.querySelector("[class*='c-badge--worktype-job'], [class*='worktype-recruit']") || tags.some(t => /^(job|求人)$/i.test(t));

      const proposals = item.querySelector(".p-search-job-media__proposals");
      const proposalLabel = text(proposals?.querySelector("span"));
      const bids = /提案数|作業数/.test(proposalLabel) ? toInt(text(proposals.querySelector(".p-search-job-media__propose-number"))) : null;
      // "当選者数 N 人 / 募集人数 M 人": hired so far and the number wanted.
      const counts = [...(proposals?.querySelectorAll(".p-search-job-media__propose-number") || [])].map(n => toInt(text(n)));
      const recruit = /当選者数/.test(text(proposals)) && /募集人数/.test(text(proposals)) && counts.length >= 2 ? { hired: counts[0], wanted: counts[1] } : null;

      const clientLink = item.querySelector(".p-search-job-media__avatar-note a");
      const avatar = item.querySelector(".p-search-job-media__avatar img.c-avatar__image, img.c-avatar__image");
      // "発注 1,381 評価 4.8"
      const stats = text(item.querySelector(".c-avatar__subnote"));
      const extra = [];
      const orders = stats.match(/発注\s*([\d,]+)/)?.[1];
      const rating = stats.match(/評価\s*([\d.]+)/)?.[1];
      if (orders) extra.push(`Orders ${orders}`);
      if (rating) extra.push(`Rating ${rating}`);

      return {
        site: "lancers",
        id,
        url: `${BASE}/work/detail/${id}`,
        title: text(titleLink),
        kind: isJob ? "job" : "",
        siteCategory: text(division),
        budgetMin: numbers[0] ?? null,
        budgetMax: numbers[numbers.length - 1] ?? null,
        budgetType: /時間/.test(priceText) ? "hourly" : workType === "タスク" ? "task" : "fixed",
        budgetText: priceText,
        currency: "JPY",
        bids,
        hired: recruit?.hired ?? null,
        wanted: recruit?.wanted ?? null,
        deadline: text(item.querySelector(".p-search-job-media__time-remaining")).replace(/^あと(\d+)日$/, "$1 days left").replace(/^あと(\d+)時間$/, "$1 hours left"),
        closesAt: closesFromRemaining(text(item.querySelector(".p-search-job-media__time-remaining"))),
        client: {
          name: text(clientLink),
          url: abs(clientLink?.getAttribute("href"), BASE),
          avatar: abs(avatar?.getAttribute("src"), BASE),
          identityVerified: null,
          phoneVerified: null,
          extra
        }
      };
    })
    .filter(Boolean);
}

const jpDate = (raw, { endOfDay = false } = {}) => {
  const m = (raw || "").match(/(\d{4})年(\d{1,2})月(\d{1,2})日(?:\s*(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  return m[4] ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5]) : new Date(+m[1], m[2] - 1, +m[3], endOfDay ? 23 : 0, endOfDay ? 59 : 0);
};
// "あと4日" / "あと23時間" → approximate closing time (ISO), so finished jobs can be marked.
function closesFromRemaining(raw) {
  const days = raw.match(/あと(\d+)日/)?.[1], hours = raw.match(/あと(\d+)時間/)?.[1];
  if (days) return new Date(Date.now() + days * 86400000).toISOString();
  if (hours) return new Date(Date.now() + hours * 3600000).toISOString();
  return /募集終了|終了/.test(raw) ? new Date(Date.now() - 1000).toISOString() : null;
}
const WORK_TYPES = { プロジェクト: "Project", タスク: "Task", コンペ: "Competition" };

export function parseDetail(doc) {
  if (/閲覧制限/.test(doc.title)) throw new Error("Restricted job (visible only when logged in to Lancers)");
  const detail = { client: {}, rows: [] };

  // Labelled rows (依頼概要, 生成AI使用可否, 追記, 添付ファイル …): <dt> label, next <dd> value.
  // The description keeps its line breaks in textContent (the site writes newlines after <br>).
  const notes = [];
  for (const dt of doc.querySelectorAll("dt.p-work-detail-lancer__postscript-term")) {
    const dd = dt.nextElementSibling;
    if (!dd) continue;
    const label = dt.cloneNode(true);
    label.querySelectorAll(".p-work-detail__definition-list-term-sub, .c-tooltip, .c-tooltip__text").forEach(n => n.remove());
    const name = text(label);
    const value = dd.textContent.replace(/\n[ \t]+/g, "\n").trim();
    if (name === "依頼概要") detail.description = value;
    else if (name === "追記") notes.push(`[Update ${text(dt.querySelector(".p-work-detail__definition-list-term-sub"))}]\n${value}`);
    else if (name === "添付ファイル") {
      const files = [...dd.querySelectorAll('a[href^="/file/work/"]')].map(a => a.getAttribute("title") || text(a));
      if (files.length) detail.rows.push(["Attachments", files.join(", ")]);
    } else if (name === "生成AI使用可否") detail.rows.push(["Generative AI", text(dd)]);
    else if (name) detail.rows.push([name, text(dd)]);
  }
  if (notes.length) detail.description = [detail.description, ...notes].filter(Boolean).join("\n\n");

  const workType = text(doc.querySelector(".tableSummary__col--compensation [class^='c-badge--worktype-'] .c-badge__text"));
  if (workType) detail.rows.unshift(["Work type", WORK_TYPES[workType] || workType]);
  if (/^(job|求人)$/i.test(workType)) detail.kind = "job";
  // "[ <a>チラシ作成…</a> の仕事 / 広告・イベント・プロモーション ]" → category link + industry after the last "/"
  const sub = doc.querySelector("h1 .c-heading__sub");
  if (sub) {
    const industry = text(sub).split("/").pop().replace(/[\]\s]+$/, "").trim();
    if (industry && sub.textContent.includes("/")) detail.rows.push(["Client industry", industry]);
    const leaf = text(sub.querySelector("a"));
    if (leaf) detail.siteCategory = leaf;
  }

  const posted = [...doc.querySelectorAll(".p-work-detail-sub-heading__content")].find(el => text(el).includes("募集開始"));
  const postedDate = jpDate(text(posted?.querySelector(".p-work-detail-sub-heading__item") || posted));
  if (postedDate) detail.postedAt = postedDate.toISOString();

  for (const item of doc.querySelectorAll(".p-work-detail-schedule__item")) {
    const label = text(item.querySelector("[class*='__item__title']"));
    const value = text(item.querySelector(".p-work-detail-schedule__text"));
    if (label.includes("希望納期")) detail.deliveryDate = value;
    if (label.includes("締切")) {
      detail.deadline = value;
      const closes = jpDate(value, { endOfDay: true });
      if (closes) detail.closesAt = closes.toISOString();
    }
    if (label.includes("開始")) detail.rows.push(["Recruiting since", value]);
  }

  const bids = text(doc.querySelector(".work_detail__proposal-status-number")) ||
    text(doc.querySelector(".tableSummary__col--worksNum .c-heading--lv5"));
  if (bids) detail.bids = toInt(bids);

  const compensation = doc.querySelector(".tableSummary__col--compensation");
  const numbers = [...(compensation?.querySelectorAll(".price-number") || [])].map(n => parseAmount(text(n))).filter(n => n != null);
  if (numbers.length) {
    detail.budgetMin = numbers[0];
    detail.budgetMax = numbers[numbers.length - 1];
  }

  const box = doc.querySelector(".p-work-detail-client-box");
  if (box) {
    const nameLink = box.querySelector(".client_name > a, .client_name a");
    const avatar = box.querySelector("img.c-avatar__image");
    detail.client.name = text(nameLink);
    detail.client.url = abs(nameLink?.getAttribute("href"), BASE);
    detail.client.avatar = abs(avatar?.getAttribute("src"), BASE);

    // Each check is <dt>(✓ icon or "--")</dt><dd>label</dd>.
    const checks = {};
    for (const list of box.querySelectorAll("dl.p-work-detail-client-box-work-status__content-list")) {
      checks[text(list.querySelector("dd"))] = !!list.querySelector("dt .c-icon--circle-check");
    }
    if ("本人確認" in checks) detail.client.identityVerified = checks["本人確認"];
    if ("電話確認" in checks) detail.client.phoneVerified = checks["電話確認"];
    detail.client.checks = [["NDA", checks["機密保持確認"] ?? null], ["Lancers Check", checks["ランサーズチェック"] ?? null]];

    const extra = [];
    const rate = text(box.querySelector(".p-work-detail-client-box-feedback-info__percent"));
    if (rate) extra.push(`Hire rate ${rate}`);
    const good = text(box.querySelector(".p-work-detail-client-box-feedback-info__number-good"));
    const bad = text(box.querySelector(".p-work-detail-client-box-feedback-info__number-bad"));
    if (good || bad) extra.push(`Reviews 👍${good || 0} 👎${bad || 0}`);
    detail.client.extra = extra;
  }
  return detail;
}

const ORGANIZATION_LABELS = { 代表者: "Representative", 従業員数: "Employees", 資本金: "Capital", 年商: "Annual sales", 住所: "Address", 事業内容: "Business" };

// Client page /client/{username}. Lancers has no completed-jobs count; its 発注率 (awarded / posted)
// is the closest measure and is shown as the hire rate.
export function parseProfile(doc, url) {
  const tiles = [], rows = [], checks = [];
  const notes = [...doc.querySelectorAll("ul.p-profile-media__notes > li.p-profile-media__note")].map(text);
  if (notes[1]) rows.push(["Type", { 法人: "Company", 個人: "Individual" }[notes[1]] || notes[1]]);
  if (notes[2] && !/男性|女性|\d0代/.test(notes[2])) rows.push(["Location", notes[2]]);
  // Gender / age, when the client lists them among the profile notes.
  const gender = notes.find(n => /^(男性|女性)$/.test(n));
  const age = notes.find(n => /\d0代/.test(n));
  if (gender) rows.push(["Gender", { 男性: "Male", 女性: "Female" }[gender]]);
  if (age) rows.push(["Age", age.replace(/(\d0)代前半/, "early $1s").replace(/(\d0)代後半/, "late $1s").replace(/(\d0)代/, "$1s")]);

  for (const col of doc.querySelectorAll(".p-profile-header-summary .c-table-summary__col")) {
    const head = text(col.querySelector(".c-table-summary__col-head"));
    const value = text(col.querySelector(".p-profile-header-summary__description-text span:first-child"));
    if (head.includes("発注数")) tiles.push(["Jobs ordered", value || "0"]);
    else if (head.includes("発注率")) {
      const note = text(col.querySelector("p.c-table-summary__col-note")); // "235 / 267" = awarded / posted
      tiles.push(["Hire rate", `${value || 0}%`, note ? `${note} hired / posted` : ""]);
    } else if (head.includes("評価")) {
      const count = icon => text(col.querySelector(`.p-profile-header-summary__description-item:has(${icon}) span:first-child`));
      tiles.push(["Reviews", `👍 ${count(".c-icon--r-face-smile-wink") || 0}  👎 ${count(".c-icon--r-face-sad-tear") || 0}`]);
    } else if (head.includes("継続ランサー")) tiles.push(["Repeat freelancers", value && value !== "---" ? value : "—"]);
  }

  let registeredAt = null; // Lancers shows the sign-up day only (no time)
  const recent = [...doc.querySelectorAll("h2")].map(text).find(t => t.includes("最近の仕事"))?.match(/\(([\d,]+)件\)/)?.[1];
  if (recent) rows.push(["Jobs posted", recent]);

  // 登録日, 24時間以内のメッセージ返信率, 発注したい業種 … (label = the dt's first text node; the dt also holds tooltips)
  const LIST_LABELS = { 登録日: "Registered", 発注したい業種: "Industries", 発注したいカテゴリー: "Categories", "24時間以内のメッセージ返信率": "Replies within 24h" };
  for (const dt of doc.querySelectorAll("dl.p-profile-introduction__list dt.p-profile-introduction__list-term")) {
    const label = (dt.firstChild?.textContent || "").trim() || text(dt);
    const dd = dt.nextElementSibling;
    const links = [...(dd?.querySelectorAll("a.p-profile-introduction__list-description-link div, .js-introduction-list-link") || [])].map(text);
    const value = links.length ? [...new Set(links)].join(", ") : text(dd);
    const english = Object.entries(LIST_LABELS).find(([ja]) => label.includes(ja))?.[1];
    const date = english === "Registered" ? jpDate(value) : null;
    if (date) registeredAt = date.toISOString();
    if (english && value) rows.push([english, date ? `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}` : value]);
  }

  const login = text(doc.querySelector("p.c-login-status")).replace(/^最終ログイン[:：]\s*/, "");
  const STATUS_LABELS = { 本人確認: "Identity", 電話確認: "Phone", 機密保持確認: "NDA", ランサーズチェック: "Lancers Check" };
  for (const status of doc.querySelectorAll("ul.p-profile-header__status-list li.p-profile-header__status")) {
    const label = text(status);
    checks.push([STATUS_LABELS[label] || label, !!status.querySelector(".c-icon--check")]);
  }

  // 会社情報 (companies only); skip rows already shown in the summary.
  for (const list of doc.querySelectorAll("dl.p-profile-organization__list")) {
    const label = text(list.querySelector(".p-profile-organization__list-title-label"));
    const value = text(list.querySelector("dd.p-profile-organization__list-description"));
    if (ORGANIZATION_LABELS[label] && value && !/^(非公開|未入力)$/.test(value)) rows.push([ORGANIZATION_LABELS[label], value]);
  }

  // 自己紹介: catchphrase + body. If the usual elements are missing, fall back to the whole
  // introduction section minus its info list, so a bio in a different element still shows.
  let intro = [doc.querySelector("h2.p-profile-introduction__heading"), doc.querySelector(".p-profile-introduction__text")]
    .map(node => node?.textContent.replace(/\n[ \t]+/g, "\n").trim())
    .filter(Boolean)
    .join("\n\n");
  if (!intro) {
    const section = doc.querySelector(".p-profile-introduction")?.cloneNode(true);
    section?.querySelectorAll("dl, h2.c-heading, .c-tooltip, script, button").forEach(n => n.remove());
    intro = (section?.textContent || "").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  return {
    name: text(doc.querySelector("h1.p-profile-media__heading")) || notes[0] || "",
    avatar: abs(doc.querySelector("img.p-profile-media__avatar-image")?.getAttribute("src"), BASE),
    url,
    lastSeen: login,
    registeredAt,
    registeredDayOnly: true,
    clientType: { 法人: "company", 個人: "individual" }[notes[1]] || null,
    intro,
    tiles,
    rows,
    checks
  };
}
