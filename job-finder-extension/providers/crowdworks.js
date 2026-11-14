// CrowdWorks: the listing (/public/jobs/search?order=new, 50 per page) keeps its data as JSON in
// div#vue-container[data] → searchResult.job_offers[]. Detail pages (/public/jobs/{id}) have the
// client as JSON in div#client_detail_information_container[data] (isIdentityVerified, …).
// CrowdWorks doesn't publish phone verification. Categories are mapped locally from category_id.
import { fetchPage, text, abs, toInt, multiline } from "./common.js";
import { CROWDWORKS_CATEGORIES } from "./crowdworks-categories.js";

const BASE = "https://crowdworks.jp";

// CrowdWorks' own top-level categories, in the site's order (id = top-level category id;
// ライティング・記事作成 exists twice on the site, 224 and 228).
const CATEGORIES = [
  { id: "367", label: "AI-BPO (AI Business Improvement)", ja: "AI-BPO（AI活用の業務改善）" },
  { id: "226", label: "System Development", ja: "システム開発" },
  { id: "311", label: "AI & Machine Learning", ja: "AI（人工知能）・機械学習" },
  { id: "242", label: "App & Smartphone Development", ja: "アプリ・スマートフォン開発" },
  { id: "230", label: "Website Production & Web Design", ja: "ホームページ制作・Webデザイン" },
  { id: "235", label: "E-commerce Sites", ja: "ECサイト・ネットショップ構築" },
  { id: "223", label: "Design", ja: "デザイン" },
  { id: "297", label: "Video, Film & Animation", ja: "動画・映像・アニメーション" },
  { id: "263", label: "Music, Sound & Narration", ja: "音楽・音響・ナレーション" },
  { id: "225", label: "Business, Marketing & Planning", ja: "ビジネス・マーケティング・企画" },
  { id: "224", label: "Writing & Articles", ja: "ライティング・記事作成", groups: [224, 228] },
  { id: "267", label: "Admin & Simple Tasks", ja: "事務・カンタン作業" },
  { id: "233", label: "Photos & Images", ja: "写真・画像" },
  { id: "255", label: "3D-CG", ja: "3D-CG制作" },
  { id: "254", label: "Naming & Ideas", ja: "ネーミング・アイデア" },
  { id: "238", label: "Translation & Interpreting", ja: "翻訳・通訳サービス" },
  { id: "271", label: "Product Design & Development", ja: "製品設計・開発" },
  { id: "227", label: "Advice, Lifestyle & Society", ja: "相談アドバイス・暮らし・社会" },
  { id: "273", label: "Project & Maintenance Members", ja: "プロジェクト・保守運用メンバー募集" }
];

function listUrl(category, keyword) {
  const url = new URL(`${BASE}/public/jobs/search`);
  url.searchParams.set("order", "new");
  url.searchParams.set("hide_expired", "true");
  if (category) url.searchParams.set("category_id", category);
  if (keyword) url.searchParams.set("search[keywords]", keyword);
  return url.href;
}

export default {
  id: "crowdworks",
  name: "CrowdWorks",
  categories: CATEGORIES,
  // Jobs posted by the site's operator (株式会社クラウドワークス and its official accounts) are excluded;
  // the site also flags official accounts itself (client.official, from the job page).
  operator: /株式会社クラウドワークス|クラウドワークス(事務局|公式|運営)|^クラウドワークス$|^crowdworks($|[_\s(（])/i,

  // Newest-first page 1 of the chosen category ("" = all). Results are also checked against the
  // category locally (each job's category_id → its top-level category), so only that category shows.
  async list({ category, keyword, signal }) {
    const { doc } = await fetchPage(listUrl(category, keyword), signal);
    const jobs = parseListing(doc);
    if (!category) return jobs;
    const groups = CATEGORIES.find(c => c.id === category)?.groups || [Number(category)];
    return jobs.filter(job => groups.includes(job.topCategoryId));
  },

  async detail(job, signal) {
    const { doc } = await fetchPage(`${BASE}/public/jobs/${job.id}`, signal);
    return parseDetail(doc);
  },

  // Recent applicants are listed on the job page itself (kept from the details).
  async bidders(job, signal) {
    if (job.bidders) return job.bidders;
    const { doc } = await fetchPage(`${BASE}/public/jobs/${job.id}`, signal);
    return parseDetail(doc).bidders;
  },

  async profile(job, signal) {
    if (!job.client?.url) throw new Error("Client page not found");
    const { doc } = await fetchPage(job.client.url, signal);
    const profile = parseProfile(doc, job.client.url);
    // The job page carries the client's company description too; use it if the profile has none.
    if (!profile.intro && job.client.intro) profile.intro = job.client.intro;
    return profile;
  }
};

function budgetOf(payment = {}) {
  const [type, p = {}] = Object.entries(payment)[0] || [];
  switch (type) {
    case "fixed_price_payment": return { type: "fixed", min: p.min_budget || null, max: p.max_budget || null };
    case "hourly_payment": return { type: "hourly", min: p.min_hourly_wage || null, max: p.max_hourly_wage || null };
    case "task_payment": return { type: "task", min: p.task_price ?? null, max: p.task_price ?? null };
    case "fixed_price_writing_payment": return { type: "task", min: p.article_price ?? null, max: p.article_price ?? null, note: "per article" };
    case "competition_payment": return { type: "fixed", min: p.competition_price ?? null, max: p.competition_price ?? null, note: "competition" };
    default: return { type: null, min: null, max: null };
  }
}

// Projects state how many people are wanted and how many are already contracted.
function recruitOf(entry = {}) {
  const p = entry.project_entry;
  return p && p.project_contract_hope_number != null && p.num_contracts != null ? { hired: p.num_contracts, wanted: p.project_contract_hope_number } : null;
}

function bidsOf(entry = {}) {
  if (entry.project_entry) return entry.project_entry.num_application_conditions ?? null;
  if (entry.task_entry) return entry.task_entry.num_completed_tasks ?? null;
  if (entry.competition_entry) return entry.competition_entry.num_proposal_products ?? null;
  return null;
}

// The kinds of work CrowdWorks lists as jobs to bid on (project / task / competition). Anything else —
// "JOB" (求人, employment-style) listings — is marked kind: "job" and left out by Job Finder.
const WORK_ENTRIES = ["project_entry", "task_entry", "competition_entry"];
const JOB_LABEL = /^(job|jobs|求人)$/i;
function kindOf(offer, entry) {
  const entryType = Object.keys(entry || {})[0];
  if (entryType && !WORK_ENTRIES.includes(entryType)) return "job";
  const labels = [offer.job_type, offer.type, offer.kind, offer.offer_type, offer.label, ...(Array.isArray(offer.labels) ? offer.labels : [])];
  return labels.some(label => typeof label === "string" && JOB_LABEL.test(label.trim())) ? "job" : "";
}

export function parseListing(doc) {
  const raw = doc.querySelector("#vue-container")?.getAttribute("data");
  if (!raw) throw new Error("listing data not found (blocked or page changed)");
  const offers = JSON.parse(raw)?.searchResult?.job_offers || []; // ads (pr_*) and recommendations are skipped
  return offers.map(({ job_offer: offer = {}, payment, entry, client = {} }) => {
    const budget = budgetOf(payment);
    const [categoryName, topCategoryId] = CROWDWORKS_CATEGORIES[offer.category_id] || [];
    const closes = offer.expired_on ? new Date(`${offer.expired_on}T23:59:59+09:00`) : null;
    const daysLeft = closes ? Math.ceil((closes - Date.now()) / 86400000) : null;
    return {
      site: "crowdworks",
      id: String(offer.id),
      url: `${BASE}/public/jobs/${offer.id}`,
      title: offer.title || "",
      kind: kindOf(offer, entry),
      siteCategory: categoryName || "",
      topCategoryId: topCategoryId ?? null,
      budgetMin: budget.min,
      budgetMax: budget.max,
      budgetType: budget.type,
      budgetText: budget.note || "",
      currency: "JPY",
      bids: bidsOf(entry),
      hired: recruitOf(entry)?.hired ?? null,
      wanted: recruitOf(entry)?.wanted ?? null,
      deadline: closes ? `${offer.expired_on}${daysLeft >= 0 ? ` (${daysLeft} days left)` : ""}` : "",
      closesAt: closes ? closes.toISOString() : null,
      postedAt: offer.last_released_at || null,
      client: {
        name: client.username || "",
        url: client.user_id ? `${BASE}/public/employers/${client.user_id}` : "",
        avatar: client.user_picture_url ? abs(client.user_picture_url, BASE) : "",
        identityVerified: null,
        phoneVerified: null,
        extra: client.is_employer_certification ? ["Certified client"] : []
      }
    };
  }).filter(job => job.id && job.id !== "undefined");
}

export function parseDetail(doc) {
  const detail = { client: {}, rows: [] };

  // Full description: the client's HTML in the detail table; 追記 notes are appended after it.
  detail.description = multiline(doc.querySelector("section.detail_information table.job_offer_detail_table td.confirm_outside_link"));
  const notes = [...doc.querySelectorAll("section.detail_information_appending .discription_container")]
    .map(note => `[Update ${text(note.querySelector(".appended_at"))}]\n${multiline(note.querySelector(".appended_description"))}`);
  if (notes.length) detail.description = [detail.description, ...notes].filter(Boolean).join("\n\n");

  // この仕事の特徴 / 特記事項: a head row, then a row of li.notice_label tags.
  const tableRows = [...doc.querySelectorAll("table.job_offer_detail_table tr")];
  tableRows.forEach((row, i) => {
    if (!row.classList.contains("table_inner_head")) return;
    const labels = [...(tableRows[i + 1]?.querySelectorAll("li.notice_label") || [])].map(text);
    if (labels.length) detail.rows.push(["Features", labels.join("、")]);
  });

  // Summary table: the first row's header is the payment type (固定報酬制 / 時間単価制 / タスク).
  const PAYMENT = { 固定報酬制: "Fixed price", 時間単価制: "Hourly", タスク: "Task", コンペ: "Competition" };
  const SUMMARY = { 稼働時間: "Hours per week", 期間: "Duration", 募集件数: "Tasks wanted", "1人あたり": "Tasks per person" };
  [...doc.querySelectorAll("table.cw-table.summary tr")].forEach((row, i) => {
    const label = row.querySelector("th")?.textContent.trim() || "";
    const value = text(row.querySelector("td"));
    if (i === 0 && label) detail.rows.unshift(["Payment type", PAYMENT[label] || label]);
    if (i === 0 && JOB_LABEL.test(label)) detail.kind = "job";
    if (label.includes("納品希望日") && value && value !== "-") detail.deliveryDate = value;
    else if (label.includes("応募期限") && value) {
      detail.deadline = value;
      const m = value.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
      if (m) detail.closesAt = new Date(`${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}T23:59:59+09:00`).toISOString();
    }
    else {
      const english = Object.entries(SUMMARY).find(([ja]) => label.includes(ja))?.[1];
      if (english && value) detail.rows.push([english, value]);
    }
  });
  for (const row of doc.querySelectorAll("table.application_status_table tr")) {
    const label = text(row.querySelector("th"));
    const value = toInt(text(row.querySelector("td")));
    if (label.includes("応募した人")) detail.bids = value;
    else if (label.includes("契約した人") && value != null) detail.hired = value;
    else if (label.includes("募集人数") && value != null) detail.wanted = value;
  }

  // 最近応募したクラウドワーカー: recent applicants (avatar, name, profile link, date).
  detail.bidders = [...doc.querySelectorAll("table.worker_list tbody tr")].map(row => {
    const link = row.querySelector("a.username");
    return {
      name: text(link),
      url: abs(link?.getAttribute("href"), BASE),
      avatar: abs(row.querySelector(".icon_image img")?.getAttribute("src"), BASE),
      note: text(row.querySelector("td.proposed_at"))
    };
  }).filter(b => b.name);

  const raw = doc.querySelector("#client_detail_information_container")?.getAttribute("data");
  let info = null;
  try { info = raw ? JSON.parse(raw) : null; } catch { /* fall back to the HTML below */ }
  if (info) {
    detail.client.name = info.userDisplayName || "";
    detail.client.url = info.userId ? `${BASE}/public/employers/${info.userId}` : "";
    detail.client.avatar = info.avatarUrl || "";
    detail.client.identityVerified = typeof info.isIdentityVerified === "boolean" ? info.isIdentityVerified : null;
    detail.client.checks = [
      ["Rule check", typeof info.isEmployerRuleCheckSucceeded === "boolean" ? info.isEmployerRuleCheckSucceeded : null],
      ["Certified client", info.isCertifiedEmployer === true ? true : null]
    ];
    detail.client.intro = (info.companyProfileDescription || "").replace(/\r\n/g, "\n").trim();
    if (info.isOfficiallyRecognizedAccount === true) detail.client.official = true;
    const extra = [];
    if (info.averageScore) extra.push(`Rating ${Number(info.averageScore).toFixed(1)}`);
    if (info.jobOfferAchievementCount != null) extra.push(`Jobs posted ${info.jobOfferAchievementCount}`);
    if (info.projectFinishedRate != null) extra.push(`Completion ${info.projectFinishedRate}%`);
    detail.client.extra = extra;
  } else {
    // HTML fallback: <span class="identity_verified"> / <span class="not-identity_verified">
    if (doc.querySelector(".identity_verified")) detail.client.identityVerified = true;
    else if (doc.querySelector(".not-identity_verified")) detail.client.identityVerified = false;
    const nameLink = doc.querySelector("span.client_name a");
    if (nameLink) {
      detail.client.name = text(nameLink);
      detail.client.url = abs(nameLink.getAttribute("href"), BASE);
    }
    detail.client.avatar = abs(doc.querySelector(".client_icon img")?.getAttribute("src"), BASE);
  }
  return detail;
}

// Employer page /public/employers/{id}: rendered by Vue; all data is JSON in div#vue-container[data].
export function parseProfile(doc, url) {
  const raw = doc.querySelector("#vue-container")?.getAttribute("data");
  if (!raw) throw new Error("Profile data not found (blocked, or the page changed)");
  const data = JSON.parse(raw);
  const user = data.employer_profile_json?.employer_user || {};
  const summary = data.employer_profile_summary_json || {};
  const finished = user.project_finished_data || {};
  const flag = value => (typeof value === "boolean" ? value : null);
  // Matches the site's "完了数 / 契約数" (e.g. 253 / 258 = 98%).
  const tiles = [
    ["Jobs posted", user.job_offer_achievement_count ?? "0"],
    ["Completed", finished.total_acceptance_count ?? "0", `of ${finished.total_finished_count ?? 0} contracted`],
    ["Completion rate", finished.rate != null ? `${finished.rate}%` : "—"],
    ["Rating", user.feedback?.average_score ? Number(user.feedback.average_score).toFixed(2) : "—", user.feedback?.total_count ? `${user.feedback.total_count} reviews` : ""]
  ];
  const rows = [
    ["Registered", user.created_at ? (d => `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`)(new Date(user.created_at)) : ""],
    ["Location", user.prefecture_name || ""],
    ["Categories", (summary.job_categories || []).map(c => c.name).join(", ")],
    ["Website", summary.company_profile?.url || ""]
  ].filter(([, value]) => value);
  const checks = [
    ["Identity", flag(user.identity_verified)],
    ["Phone", null], // not published by CrowdWorks
    ["Rule check", flag(user.is_employer_rule_check_succeeded)],
    ["Certified client", user.is_certified_employer === true ? true : null]
  ];
  const intro = [summary.company_profile?.description, user.description, user.introduction, user.self_introduction]
    .find(s => typeof s === "string" && s.trim()) || "";

  return {
    name: user.display_name || "",
    avatar: user.profile_image_src ? abs(user.profile_image_src, BASE) : "",
    url,
    lastSeen: user.last_accessed_at ? `${user.last_accessed_at} ago` : "",
    registeredAt: user.created_at ? new Date(user.created_at).toISOString() : null,
    intro: intro.replace(/\r\n/g, "\n").trim(),
    tiles,
    rows,
    checks
  };
}
