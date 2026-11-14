// Job Finder: searches the selected platforms/categories/keywords on an interval, loads each new
// job's details (client checks, delivery date, description) and its client's profile (sign-up date,
// company or individual), and lists them newest first. The interface is in Japanese.
// Runs as this extension's page (tab or app window), so it can fetch the sites directly with this
// browser's sign-ins.
import { PROVIDERS } from "./providers/index.js";
import { ownAccountOf, ownBidLabels, ownBidEntries, showProposal, proposalPageUrl } from "./bidding.js";
import { initSlack, bidButton, dmButton, bidTag, bidSignature, bidStats, isBidCompleted, completedEntries, dismissCompleted, bidJobSnapshot } from "./bidding.js";
import { showAlert } from "./alert.js";
import { helperSend, helperStatus, onHelperMessage } from "./helper.js";

const MAX_JOBS = 400;              // unpinned jobs kept (oldest dropped first)
const MAX_TRASH = 1000;            // deleted jobs kept for restoring
const MAX_SEEN = 20000;            // jobs remembered as already found (so a job is only ever new once)
const DETAIL_TRIES = 4;            // a job page that fails to load is tried this often (30 s, 1 min, 1.5 min apart)
const BUSY_BIDS = 50;              // proposal counts above this are shown in red
const RENDER_STEP = 60;            // cards shown at first; scrolling to the bottom adds this many more
const SAVE_EVERY_MS = 4000;        // saving is batched (writing the whole list is expensive)
const ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6, 1.8, 2];
const HOUR = 3600000, DAY = 24 * HOUR;
const DEFAULT_PASSWORD = "Assassin";

const $ = id => document.getElementById(id);
const key = job => `${job.site}:${job.id}`;
const providerOf = siteId => PROVIDERS.find(p => p.id === siteId);
const displayName = p => p.name.charAt(0).toUpperCase() + p.name.slice(1).toLowerCase();
const siteIconUrl = siteId => chrome.runtime.getURL(`icons/site-${siteId}.png`);

// The site readers label things in English; the interface shows them in Japanese.
const LABEL_JA = {
  "Work type": "仕事の種類", Attachments: "添付ファイル", "Generative AI": "生成AIの使用", "Client industry": "クライアントの業種",
  "Recruiting since": "募集開始", Category: "カテゴリー", "Payment type": "支払い方式", Features: "特徴", "Hours per week": "稼働時間/週",
  Duration: "期間", "Tasks wanted": "募集件数", "Tasks per person": "1人あたりの作業件数", Status: "状態", Skills: "必要なスキル",
  Subcategory: "サブカテゴリー", "What do you need?": "依頼内容の種類", "Project size": "案件規模",
  Type: "種別", Location: "所在地", "Jobs posted": "募集実績", Industries: "業種", Categories: "依頼カテゴリー",
  "Replies within 24h": "24時間以内の返信率", Registered: "登録日", "Registered (profile created)": "登録日（プロフィール作成日）",
  "Last login": "最終ログイン", Availability: "稼働状況", Profile: "プロフィール", Gender: "性別", Age: "年齢",
  "Sales as a seller": "販売実績（出品者）", "Rating as a seller": "評価（出品者）", Followers: "フォロワー", Country: "国",
  Website: "ウェブサイト", Employees: "従業員数", Capital: "資本金", "Annual sales": "年商", Address: "住所", Business: "事業内容",
  Representative: "代表者",
  // stat tiles
  "Jobs ordered": "発注数", "Hire rate": "発注率", Reviews: "評価", "Repeat freelancers": "継続ランサー", "Completion rate": "完了率",
  Rating: "評価", Completed: "完了数", "Projects posted": "公開プロジェクト数", "Projects paid": "支払い済みプロジェクト",
  // checks
  Identity: "本人確認", Phone: "電話確認", NDA: "機密保持", "Lancers Check": "ランサーズチェック", "Rule check": "発注ルールチェック",
  "Certified client": "認定クライアント", "Payment method": "支払い方法確認", "Invoice issuer": "インボイス発行事業者"
};
// Workana is shown in English throughout; everything else in Japanese.
const isEn = siteOrJob => (typeof siteOrJob === "string" ? siteOrJob : siteOrJob?.site) === "workana";
const tx = (siteOrJob, jaText, enText) => (isEn(siteOrJob) ? enText : jaText);
const ja = (label, siteOrJob) => (isEn(siteOrJob) ? label : LABEL_JA[label] || label);
function valueJa(value, siteOrJob) {
  if (isEn(siteOrJob)) return String(value);
  return String(value)
    .replace(/^Company$/, "法人").replace(/^Individual$/, "個人").replace(/^Male$/, "男性").replace(/^Female$/, "女性")
    .replace(/^early (\d0)s$/, "$1代前半").replace(/^late (\d0)s$/, "$1代後半").replace(/^(\d0)s$/, "$1代")
    .replace(/ hired \/ posted$/, "（発注 / 募集）").replace(/^of (\d+) contracted$/, "契約 $1件中").replace(/^(\d+) reviews$/, "$1件")
    .replace(/^paid ÷ posted$/, "支払い済み ÷ 公開").replace(/ ago$/, "前");
}
function extraJa(text, siteOrJob) {
  if (isEn(siteOrJob)) return text;
  return text.replace(/^Orders /, "発注 ").replace(/^Rating /, "評価 ").replace(/^Hire rate /, "発注率 ").replace(/^Reviews /, "評価 ")
    .replace(/^Jobs posted /, "募集実績 ").replace(/^Completion /, "完了率 ").replace(/^Projects posted /, "公開プロジェクト ")
    .replace(/^Projects paid /, "支払い済み ").replace(/^Member since /, "登録 ").replace(/^Certified client$/, "認定クライアント");
}

const defaults = {
  // Per platform: on/off, categories ([] = all), per-category price ranges, and its own keyword.
  sites: Object.fromEntries(PROVIDERS.map(p => [p.id, { on: true, categories: [], prices: {}, keyword: "" }])),
  keyword: "",              // all-platforms keyword (used by platforms without their own)
  verifiedOnly: true,
  priceMin: "",
  priceMax: "",
  usdRate: 150,
  auto: true,
  intervalSec: 10,
  translatorOpen: true,
  translatorWidth: 380,
  translateTo: "ja",
  translatorFont: 14,
  translatorInput: true,    // show the translator's input field
  engine: "google",         // "google" | "deepl"
  deeplKey: "",
  zoom: 1,
  view: "all",              // "all" | "pinned" | "deleted" | "completed" (Bid completed)
  selected: "",             // platform whose jobs are shown ("" = all platforms)
  settingsOpen: false
};
let settings = structuredClone(defaults);
const jobs = new Map();          // key → job
const trash = new Map();         // key → deleted job (restorable)
let deleted = new Set();         // keys never to show again from searches (deleted or permanently deleted)
let seen = new Set();            // keys of every job the searches have returned (oldest first)
let seenLoaded = false;          // whether `seen` is complete (false right after updating from a version without it)
const firstSearchDone = new Set(); // "site|category|keyword" searched before (later arrivals are new)
let lastUpdate = {};             // "site|category|keyword" → time of its last search (kept between sessions)
const FIRST_RUN_LIMIT = 20;      // jobs taken from a search's very first run
const queues = {};               // site → [{ k, kind: "detail" | "profile" }]
const working = {};              // site → worker running
const profiles = new Map();      // client profile cache
const statuses = {};             // site → { message, error }
const controller = new AbortController();
let panelSite = null;            // platform whose search settings are open ("" = all platforms, null = closed)
let renderLimit = RENDER_STEP;
let timer = null, nextAt = 0, searching = false;
let detailKey = null, showBiddersFor = null;

start();

// ---------- password, then the app ----------

async function hashPassword(password) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`jobfinder:${password}`));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function passwordHash() {
  const { jfPasswordHash } = await chrome.storage.local.get("jfPasswordHash");
  return jfPasswordHash || hashPassword(DEFAULT_PASSWORD);
}

// Asked once per browser session (the unlock is kept until the browser is closed).
// Chrome's Memory Saver unloads tabs left alone for a while, which stopped the searches until the tab
// was clicked (and reloaded). This page asks not to be unloaded; if it is anyway, background.js
// reloads it at once.
async function keepLoaded() {
  const tab = await chrome.tabs.getCurrent().catch(() => null);
  if (tab) await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
}

async function start() {
  keepLoaded();
  const session = await chrome.storage.session?.get("jfUnlocked").catch(() => ({})) || {};
  if (!session.jfUnlocked) await waitForUnlock();
  $("topnav").hidden = false;
  showPage("proposals");
  bindNavigation();
  await init();
  // Slack: Accounts page, BID, results of sent proposals, clearing channels.
  // When a bid's status changes, the cards and the open detail window show it.
  initSlack({
    onBidsChanged: () => {
      scheduleRender();
      const open = detailKey && findJob(detailKey);
      if (open) renderDetail(open);
    },
    showPage,
    findJob,
    // Clicking a History entry: that job's detail window on the Proposals page.
    openJob: (k, url) => {
      if (!findJob(k)) { if (url) window.open(url, "_blank", "noopener"); return; }
      showPage("proposals");
      openDetail(k);
    }
  });
}

function waitForUnlock() {
  return new Promise(resolve => {
    $("lock").hidden = false;
    $("lockPassword").focus();
    $("lockForm").addEventListener("submit", async e => {
      e.preventDefault();
      if (await hashPassword($("lockPassword").value) === await passwordHash()) {
        await chrome.storage.session?.set({ jfUnlocked: true }).catch(() => {});
        $("lock").hidden = true;
        $("lockPassword").value = "";
        resolve();
      } else {
        $("lockError").hidden = false;
        $("lockPassword").select();
      }
    });
  });
}

function bindNavigation() {
  for (const item of document.querySelectorAll(".topnav-item")) item.addEventListener("click", () => showPage(item.dataset.page));
  bindHelperSettings();
}

function showPage(page) {
  $("app").hidden = page !== "proposals";
  $("pageAccounts").hidden = page !== "accounts";
  $("pageHistory").hidden = page !== "history";
  $("pageSettings").hidden = page !== "settings";
  for (const item of document.querySelectorAll(".topnav-item")) {
    if (item.dataset.page === page) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  }
}

async function init() {
  const stored = await chrome.storage.local.get(["jfSettings", "jfJobs", "jfDeleted", "jfTrash", "jfLastUpdate", "jfSeen"]);
  settings = mergeSettings(stored.jfSettings || {});
  lastUpdate = stored.jfLastUpdate || {};
  deleted = new Set(stored.jfDeleted || []);
  seenLoaded = Array.isArray(stored.jfSeen);
  seen = new Set(stored.jfSeen || []);
  for (const job of stored.jfTrash || []) trash.set(key(job), job);
  for (const job of stored.jfJobs || []) {
    if (deleted.has(key(job))) continue;
    job.searches ||= (job.searchCategories || [job.searchCategory ?? ""]).map(c => searchKey(c, settings.keyword));
    jobs.set(key(job), job);
    seen.add(key(job));
    // Jobs that appeared while Job Finder was closed count as new on the first search.
    for (const k of job.searches) firstSearchDone.add(`${job.site}|${k}`);
  }
  for (const job of jobs.values()) {
    // (Details that failed to load before get another try.)
    if (job.detail === "error") { job.detail = "pending"; job.detailTries = 0; }
    if (job.detail === "pending") enqueue(job, "detail");
    else if (needsProfile(job)) enqueue(job, "profile");
  }

  bindControls();
  applyZoom();
  applyTranslatorLayout();
  render();
  setInterval(updateCountdown, 500);
  setInterval(flushSave, SAVE_EVERY_MS);
  document.addEventListener("visibilitychange", () => { if (document.hidden) flushSave(); });
  window.addEventListener("pagehide", flushSave);
  search();
}

function mergeSettings(saved) {
  const merged = { ...defaults, ...saved };
  merged.sites = Object.fromEntries(PROVIDERS.map(p => {
    const old = saved.sites?.[p.id] || {};
    const categories = old.categories || (old.category ? [old.category] : []);
    return [p.id, { on: old.on ?? true, categories, prices: old.prices || {}, keyword: old.keyword || "" }];
  }));
  if (!["all", "pinned", "deleted", "completed"].includes(merged.view)) merged.view = "all";
  if (merged.selected && !providerOf(merged.selected)) merged.selected = "";
  return merged;
}

function saveSettings() {
  chrome.storage.local.set({ jfSettings: settings });
}

let dirty = false;
const saveJobs = () => { dirty = true; };
function flushSave() {
  if (!dirty) return;
  dirty = false;
  chrome.storage.local.set({
    jfJobs: [...jobs.values()],
    jfTrash: [...trash.values()].slice(-MAX_TRASH),
    jfDeleted: [...deleted].slice(-5000),
    ...(seenLoaded && { jfSeen: [...seen].slice(-MAX_SEEN) })
  });
}

// ---------- what each platform searches ----------

const searchKey = (category, keyword) => `${category}|${(keyword || "").trim()}`;
const keywordFor = siteId => (settings.sites[siteId].keyword || settings.keyword || "").trim();
// A keyword searches across all of the platform's categories; otherwise one search per ticked category.
const searchCategoriesFor = siteId => {
  const conf = settings.sites[siteId];
  return keywordFor(siteId) || !conf.categories.length ? [""] : [...conf.categories];
};
const activeSearches = siteId => searchCategoriesFor(siteId).map(c => searchKey(c, keywordFor(siteId)));

// ---------- sidebar: platforms (icons), read / pin / deleted ----------

const categoryLabel = cat => cat.ja || cat.label;
const labelOf = (provider, id) => { const cat = provider.categories.find(c => c.id === id); return cat ? categoryLabel(cat) : id; };
const categorySummary = (provider, conf) =>
  conf.categories.length === 0 ? "すべてのカテゴリー" : conf.categories.length === 1 ? labelOf(provider, conf.categories[0]) : `${conf.categories.length}カテゴリー`;

function siteIcon(siteId, className = "site-icon") {
  const img = el("img", className);
  img.src = siteIconUrl(siteId);
  img.alt = displayName(providerOf(siteId));
  img.title = displayName(providerOf(siteId));
  return img;
}

function renderSidebar(counts, unread) {
  const items = [{ id: "" }, ...PROVIDERS.map(p => ({ id: p.id, provider: p }))];
  $("platforms").replaceChildren(...items.map(item => {
    const conf = item.provider ? settings.sites[item.id] : null;
    const row = el("div", "platform-row");
    if (item.id) row.style.setProperty("--site", `var(--${item.id})`);

    // The row shows only that platform's jobs. Icons stand in for the platform names.
    const b = el("button", `platform${item.id ? "" : " all"}${settings.selected === item.id ? " selected" : ""}${conf && !conf.on ? " off" : ""}${statuses[item.id]?.error ? " error" : ""}`);
    b.type = "button";
    const name = el("span", "name");
    name.append(item.id ? siteIcon(item.id) : el("span", "all-icon", "All"));
    const newCount = item.id ? unread[item.id] || 0 : Object.values(unread).reduce((a, n) => a + n, 0);
    if (newCount) {
      const pill = el("span", "new-pill", `${newCount}`);
      pill.title = `${newCount} new job${newCount === 1 ? "" : "s"} not viewed yet`;
      name.append(pill);
    }
    const count = item.id ? counts[item.id] || 0 : Object.values(counts).reduce((a, n) => a + n, 0);
    b.append(name, el("span", "count", String(count)));
    let sub;
    if (!item.id) sub = settings.keyword.trim() ? `Keyword: "${settings.keyword.trim()}"` : "All platforms";
    else if (!conf.on) sub = "Off — not searched";
    else if (statuses[item.id]?.error) sub = statuses[item.id].message;
    else if (keywordFor(item.id)) sub = `"${keywordFor(item.id)}" · all categories`;
    else sub = conf.categories.length === 0 ? "All categories"
      : conf.categories.length === 1 ? item.provider.categories.find(c => c.id === conf.categories[0])?.label
      : `${conf.categories.length} categories`;
    b.append(el("span", "sub", sub));
    b.setAttribute("aria-pressed", String(settings.selected === item.id));
    b.title = item.id ? `Show only ${displayName(item.provider)} jobs` : "Show jobs from all platforms";
    b.addEventListener("click", () => selectPlatform(item.id));

    // The gear (shown after hovering ~2 seconds) opens this platform's search settings.
    const gear = button("⚙", `gear${panelSite === item.id ? " open" : ""}`, () => toggleSettingsPanel(item.id));
    gear.title = item.id ? `${displayName(item.provider)} search settings` : "Search settings for all platforms";
    gear.setAttribute("aria-label", gear.title);
    row.append(b, gear);
    return row;
  }));
  $("deletedCount").textContent = String(trash.size);
  $("deletedView").classList.toggle("active", settings.view === "deleted");
  $("completedCount").textContent = String(completedEntries().length);
  $("completedView").classList.toggle("active", settings.view === "completed");
}

function selectPlatform(siteId) {
  settings.selected = siteId;
  if (settings.view === "deleted") settings.view = "all";
  renderLimit = RENDER_STEP;
  saveSettings();
  closeDetail();
  render();
}

function toggleSettingsPanel(siteId) {
  panelSite = panelSite === siteId ? null : siteId;
  renderPanel();
  scheduleRender();
}

// ---------- search settings panel (one platform, or all platforms) ----------

// Search settings are always in English.
const PANEL_LANG = "workana";

function renderPanel() {
  const panel = $("catPanel");
  if (panelSite == null) { panel.hidden = true; panel.replaceChildren(); return; }
  panel.hidden = false;
  const close = button("×", "icon", () => toggleSettingsPanel(panelSite));
  close.setAttribute("aria-label", "Close search settings");

  if (panelSite === "") {
    panel.style.removeProperty("--site");
    const head = el("div", "head");
    head.append(el("h2", "", "All platforms — search settings"), close);
    const keyword = keywordField(settings.keyword, "Searched on every platform across all categories (whatever categories are ticked); every job the site finds for it is shown. A platform's own keyword replaces it.", value => {
      settings.keyword = value;
    }, PANEL_LANG);
    const switches = el("div", "platform-switches");
    for (const p of PROVIDERS) {
      const label = el("label");
      label.style.setProperty("--site", `var(--${p.id})`);
      const box = el("input");
      box.type = "checkbox";
      box.checked = settings.sites[p.id].on;
      box.addEventListener("change", () => setPlatformOn(p.id, box.checked));
      label.append(box, siteIcon(p.id), el("span", "", settings.sites[p.id].on ? "Searching" : "Off"));
      switches.append(label);
    }
    panel.replaceChildren(head, keyword, el("h2", "", "Platforms"), switches,
      el("p", "hint", "Use a platform's ⚙ to choose its job categories and price ranges."));
    return;
  }

  const provider = providerOf(panelSite);
  const site = provider.id; // Workana's panel is in English
  const conf = settings.sites[site];
  panel.style.setProperty("--site", `var(--${site})`);
  const head = el("div", "head");
  const title = el("h2");
  title.append(siteIcon(site), tx(PANEL_LANG, " 検索設定", " search settings"));
  head.append(title, close);

  const power = el("label", `power${conf.on ? "" : " off"}`);
  const powerBox = el("input");
  powerBox.type = "checkbox";
  powerBox.checked = conf.on;
  powerBox.addEventListener("change", () => setPlatformOn(site, powerBox.checked));
  power.append(el("span", "", conf.on
    ? tx(PANEL_LANG, `${displayName(provider)} を検索中`, `Searching ${displayName(provider)}`)
    : tx(PANEL_LANG, `${displayName(provider)} はオフ（検索しない）`, `${displayName(provider)} is off (not searched)`)), powerBox);

  const shared = settings.keyword.trim();
  const keyword = keywordField(conf.keyword, true
    ? `Searched across all categories, whatever categories are ticked below; every job the site finds for it is shown.${shared ? ` Leave empty to use the all-platforms keyword "${shared}".` : ""}`
    : `チェックしたカテゴリーに関係なく、すべてのカテゴリーで検索し、見つかった案件をすべて表示します。${shared ? `空欄なら全体のキーワード「${shared}」を使います。` : ""}`, value => {
    conf.keyword = value;
  }, PANEL_LANG);

  const status = el("div", `site-status${statuses[site]?.error ? " error" : ""}`, statuses[site]?.message || "");
  status.id = `status-${site}`;

  const all = el("label", "cat-row all");
  const allBox = el("input");
  allBox.type = "checkbox";
  allBox.checked = conf.categories.length === 0;
  allBox.addEventListener("change", () => { conf.categories = []; searchSettingsChanged(); });
  all.append(allBox, el("span", "", tx(PANEL_LANG, "すべてのカテゴリー", "All categories")));

  const columns = el("div", "cat-cols");
  columns.append(el("span"), el("span", "", tx(PANEL_LANG, "カテゴリー", "Category")), el("span", "", tx(PANEL_LANG, "下限（円）", "Min (JPY)")), el("span", "", tx(PANEL_LANG, "上限（円）", "Max (JPY)")));

  const rows = provider.categories.map(cat => {
    const row = el("div", "cat-row");
    const check = el("input");
    check.type = "checkbox";
    check.checked = conf.categories.includes(cat.id);
    check.id = `cat-${provider.id}-${cat.id}`;
    check.addEventListener("change", () => {
      conf.categories = provider.categories.map(c => c.id).filter(id => id === cat.id ? check.checked : conf.categories.includes(id));
      searchSettingsChanged();
    });
    const label = el("label");
    label.htmlFor = check.id;
    label.append(el("span", "", true ? cat.label : categoryLabel(cat)));
    const price = field => {
      const input = el("input");
      input.type = "number";
      input.min = "0";
      input.step = "1000";
      input.placeholder = field === "min" ? tx(PANEL_LANG, "下限", "Min") : tx(PANEL_LANG, "上限", "Max");
      input.value = conf.prices[cat.id]?.[field] ?? "";
      input.title = tx(PANEL_LANG, `${categoryLabel(cat)} の${field === "min" ? "下限" : "上限"}価格（円）。全体の価格帯の代わりに使われます`,
        `${field === "min" ? "Minimum" : "Maximum"} price for ${cat.label} (JPY); replaces the default range`);
      input.addEventListener("input", () => {
        conf.prices[cat.id] = { ...conf.prices[cat.id], [field]: input.value };
        if (!conf.prices[cat.id].min && !conf.prices[cat.id].max) delete conf.prices[cat.id];
        saveSettings();
        scheduleRender();
      });
      return input;
    };
    row.append(check, label, price("min"), price("max"));
    return row;
  });

  const parts = [head, power, keyword, status, el("h2", "", tx(PANEL_LANG, "カテゴリー", "Categories"))];
  if (keywordFor(site)) parts.push(el("div", "disabled-note", tx(PANEL_LANG,
    "キーワードが設定されているため、すべてのカテゴリーを検索しています。キーワードを消すと下のチェックが使われます。",
    "A keyword is set, so all categories are searched. The ticks below apply again once the keyword is cleared.")));
  parts.push(el("p", "hint", tx(PANEL_LANG,
    "複数選べます（何も選ばなければすべて）。カテゴリーの価格帯は全体の価格帯より優先されます。",
    "Tick one or more (none ticked = all). A category's own price range replaces the default range.")), all, columns, ...rows);
  panel.replaceChildren(...parts);
}

// A keyword box that triggers a new search once typing pauses.
function keywordField(value, hint, onChange, site) {
  const box = el("div", "keyword-box");
  const input = el("input");
  input.type = "search";
  input.placeholder = tx(PANEL_LANG, "キーワード（スペース区切り）", "Keywords (space-separated)");
  input.value = value;
  let typing;
  input.addEventListener("input", () => {
    onChange(input.value);
    saveSettings();
    clearTimeout(typing);
    typing = setTimeout(() => searchSettingsChanged({ keepPanel: true }), 900);
  });
  box.append(el("span", "field-label", tx(PANEL_LANG, "キーワード検索", "Keyword search")), input, el("span", "hint", hint));
  return box;
}

function setPlatformOn(siteId, on) {
  settings.sites[siteId].on = on;
  if (!on) queues[siteId] = [];
  saveSettings();
  scheduleRender();
  renderPanel();
  if (on) search();
}

function searchSettingsChanged({ keepPanel = false } = {}) {
  saveSettings();
  scheduleRender();
  if (!keepPanel) renderPanel();
  clearTimeout(searchSettingsChanged.timer);
  searchSettingsChanged.timer = setTimeout(search, 500);
}

// ---------- controls ----------

function bindControls() {
  $("settingsBox").open = settings.settingsOpen;
  $("settingsBox").addEventListener("toggle", () => { settings.settingsOpen = $("settingsBox").open; saveSettings(); });

  $("autoToggle").checked = settings.auto;
  $("autoToggle").addEventListener("change", () => {
    settings.auto = $("autoToggle").checked;
    saveSettings();
    if (settings.auto) search(); else { clearTimeout(timer); nextAt = 0; }
    updateCountdown();
  });
  $("interval").value = String(settings.intervalSec);
  $("interval").addEventListener("change", () => {
    settings.intervalSec = Number($("interval").value);
    saveSettings();
    if (settings.auto && !searching) scheduleNext();
  });
  $("refreshNow").addEventListener("click", search);
  $("markRead").addEventListener("click", () => {
    for (const job of jobs.values()) job.unread = false;
    saveJobs();
    render();
  });

  $("verifiedOnly").checked = settings.verifiedOnly;
  $("verifiedOnly").addEventListener("change", () => { settings.verifiedOnly = $("verifiedOnly").checked; saveSettings(); render(); });
  for (const id of ["priceMin", "priceMax", "usdRate"]) {
    $(id).value = settings[id];
    $(id).addEventListener("input", () => {
      settings[id] = id === "usdRate" ? Number($(id).value) || defaults.usdRate : $(id).value;
      saveSettings();
      scheduleRender();
      updateConverter();
    });
  }
  $("convUsd").addEventListener("input", updateConverter);
  updateConverter();

  $("tabAll").addEventListener("click", () => setView("all"));
  $("tabPinned").addEventListener("click", () => setView("pinned"));
  $("deletedView").addEventListener("click", () => setView(settings.view === "deleted" ? "all" : "deleted"));
  $("completedView").addEventListener("click", () => setView(settings.view === "completed" ? "all" : "completed"));
  $("listSearch").addEventListener("input", () => { renderLimit = RENDER_STEP; scheduleRender(); });
  // Bid completed: tick cards, then delete the ticked ones or all shown.
  $("completedSelectAll").addEventListener("change", () => {
    const shown = completedShown().map(job => key(job));
    if ($("completedSelectAll").checked) shown.forEach(k => completedSelected.add(k));
    else shown.forEach(k => completedSelected.delete(k));
    render();
  });
  $("completedDeleteSelected").addEventListener("click", () => removeCompleted([...completedSelected]));
  $("completedDeleteAll").addEventListener("click", () => removeCompleted(completedShown().map(job => key(job))));
  // All jobs / Pinned: move every job the list shows (selected platform, search box) to 削除済み.
  $("deleteAllShown").addEventListener("click", () => {
    const list = listShown();
    const where = settings.selected ? ` from ${displayName(providerOf(settings.selected))}` : "";
    if (!list.length || !confirm(`Delete all ${list.length} job${list.length === 1 ? "" : "s"}${where} in this list? They move to Deleted items, where you can restore them.`)) return;
    for (const job of list) deleteJob(job, { quiet: true });
    saveJobs();
    render();
  });
  $("restoreAll").addEventListener("click", () => {
    for (const k of [...trash.keys()]) if (inSelectedPlatform(trash.get(k))) restoreJob(k, { quiet: true });
    saveJobs();
    render();
  });
  $("purgeAll").addEventListener("click", () => {
    const list = [...trash.values()].filter(inSelectedPlatform);
    if (!list.length || !confirm(`Permanently delete ${list.length} job${list.length === 1 ? "" : "s"}? They can't be restored and won't appear in searches again.`)) return;
    for (const job of list) trash.delete(key(job));
    saveJobs();
    render();
  });

  $("pinWindow").addEventListener("click", togglePinWindow);
  $("zoomIn").addEventListener("click", () => stepZoom(1));
  $("zoomOut").addEventListener("click", () => stepZoom(-1));
  $("zoomReset").addEventListener("click", () => { settings.zoom = 1; saveSettings(); applyZoom(); });
  document.addEventListener("keydown", e => {
    if (e.ctrlKey && (e.key === "+" || e.key === "=")) { e.preventDefault(); stepZoom(1); }
    else if (e.ctrlKey && e.key === "-") { e.preventDefault(); stepZoom(-1); }
    else if (e.ctrlKey && e.key === "0") { e.preventDefault(); settings.zoom = 1; saveSettings(); applyZoom(); }
    else if (e.key === "Escape") {
      if (detailKey) closeDetail();
      else if (panelSite != null) toggleSettingsPanel(panelSite);
    }
  });

  $("toggleTranslator").addEventListener("click", () => { settings.translatorOpen = !settings.translatorOpen; saveSettings(); applyTranslatorLayout(); });
  $("closeTranslator").addEventListener("click", () => { settings.translatorOpen = false; saveSettings(); applyTranslatorLayout(); });
  $("openWindow").addEventListener("click", openAppWindow);
  $("detail").addEventListener("click", e => { if (e.target === $("detail")) closeDetail(); });
  $("detailBody").addEventListener("mouseup", () => setTimeout(translateSelection, 0));

  bindTranslator();
}

function updateConverter() {
  const usd = Number($("convUsd").value) || 0;
  $("convJpy").textContent = `¥${Math.round(usd * settings.usdRate).toLocaleString()}`;
}

function setView(view) {
  settings.view = view;
  renderLimit = RENDER_STEP;
  saveSettings();
  closeDetail();
  render();
}

// Zoom enlarges or shrinks the whole window's content (also Ctrl + / Ctrl − / Ctrl 0).
function stepZoom(direction) {
  const index = ZOOM_STEPS.findIndex(z => z >= settings.zoom - 0.001);
  settings.zoom = ZOOM_STEPS[Math.min(Math.max((index < 0 ? 2 : index) + direction, 0), ZOOM_STEPS.length - 1)];
  saveSettings();
  applyZoom();
}

function applyZoom() {
  document.documentElement.style.setProperty("--zoom", String(settings.zoom));
  $("zoomReset").textContent = `${Math.round(settings.zoom * 100)}%`;
}

// ---------- search cycle ----------

async function search() {
  if (searching) return;
  searching = true;
  clearTimeout(timer);
  updateCountdown();
  const active = PROVIDERS.filter(p => settings.sites[p.id].on);
  const runAt = Date.now(); // every job found in this round counts as found at the same moment (see matchingJobs' order)

  await Promise.all(active.map(async p => {
    const keyword = keywordFor(p.id);
    setStatus(p.id, "Searching…");
    let checked = 0, added = 0;
    try {
      for (const category of searchCategoriesFor(p.id)) {
        // The keyword goes to the site's own search, so it covers all of the platform's jobs.
        const found = await p.list({ category, keyword, signal: controller.signal });
        const sk = searchKey(category, keyword);
        const searchId = `${p.id}|${sk}`;
        const firstTime = !firstSearchDone.has(searchId);
        const since = lastUpdate[searchId];
        let taken = 0;
        // The whole page is gone through: a job the search hasn't returned before is new, wherever it
        // is on the page. (Coconala lists a request under the time it was written, but it can appear
        // only later, once approved, below jobs already seen; stopping at known jobs or skipping by
        // date missed those.)
        for (const job of found) {
          const k = key(job);
          const existing = jobs.get(k);
          if (existing && !existing.searches.includes(sk)) existing.searches.push(sk);
          const known = !!existing || deleted.has(k) || seen.has(k);
          seen.delete(k);
          seen.add(k); // (kept newest-last, so the oldest are dropped first)
          if (known) continue;
          checked++;
          // Jobs posted by the platform's own operating company, and "JOB" (求人) listings, are always left out.
          if (isOperatorJob(job) || isJobListing(job)) continue;
          // Right after updating from a version without the list of seen jobs: jobs posted before the
          // last update aren't new (once, until the list has been filled).
          if (!seenLoaded && since && job.postedAt && Date.parse(job.postedAt) < since - 10 * 60000) continue;
          // The very first search only takes the newest jobs, so startup stays light
          // (a keyword search takes everything the site returned for it). The rest count as seen.
          if (firstTime && !keyword && taken >= FIRST_RUN_LIMIT) continue;
          // Jobs found on a search's first run are the starting list; later ones are new.
          jobs.set(k, { ...job, searches: [sk], firstSeen: runAt, isNew: !firstTime, detail: "pending" });
          enqueue(jobs.get(k), "detail");
          taken++;
          if (!firstTime) added++;
        }
        firstSearchDone.add(searchId);
        lastUpdate[searchId] = Date.now();
        await new Promise(r => setTimeout(r, 0)); // let the page breathe between searches
      }
      setStatus(p.id, `${added} new · ${fmtTime(new Date())}`);
    } catch (err) {
      setStatus(p.id, `Error: ${err.message}`, true);
    }
  }));

  // Keep the list bounded: drop the oldest unpinned arrivals first (jobs with a completed bid stay).
  const unpinned = [...jobs.entries()].filter(([k, job]) => !job.pinned && !isBidCompleted(k));
  if (unpinned.length > MAX_JOBS) {
    unpinned.sort((a, b) => a[1].firstSeen - b[1].firstSeen).slice(0, unpinned.length - MAX_JOBS).forEach(([k]) => jobs.delete(k));
  }
  chrome.storage.local.set({ jfLastUpdate: lastUpdate });
  seenLoaded = true;
  saveJobs();
  render();
  searching = false;
  if (settings.auto) scheduleNext();
  updateCountdown();
}

function scheduleNext() {
  clearTimeout(timer);
  nextAt = Date.now() + settings.intervalSec * 1000;
  timer = setTimeout(search, settings.intervalSec * 1000);
}

function setStatus(siteId, message, isError = false) {
  const wasError = !!statuses[siteId]?.error;
  statuses[siteId] = { message, error: isError };
  const node = $(`status-${siteId}`);
  if (node) {
    node.textContent = message;
    node.classList.toggle("error", isError);
  }
  if (wasError !== isError) scheduleRender();
}

function updateCountdown() {
  $("countdown").textContent = searching ? "Searching…"
    : settings.auto && nextAt ? `Next search in ${Math.max(0, Math.ceil((nextAt - Date.now()) / 1000))}s`
    : "Auto-search off";
}

// ---------- background work: job details, then the client's profile (one worker per site) ----------

const needsProfile = job => !!providerOf(job.site).profile && !!job.client?.url && !job.client.profileChecked && job.detail !== "pending";

function enqueue(job, kind) {
  const queue = (queues[job.site] ||= []);
  // A new job's details (which decide whether it's shown) go before client profiles still waiting.
  const at = kind === "detail" ? queue.findIndex(item => item.kind !== "detail") : -1;
  queue.splice(at < 0 ? queue.length : at, 0, { k: key(job), kind });
  runQueue(job.site);
}

async function runQueue(siteId) {
  if (working[siteId]) return;
  working[siteId] = true;
  while (queues[siteId]?.length) {
    const { k, kind } = queues[siteId].shift();
    const job = jobs.get(k);
    if (!job) continue;
    if (kind === "detail" && job.detail === "pending") await loadDetail(job);
    else if (kind === "profile" && needsProfile(job)) await loadProfile(job, { light: true });
  }
  working[siteId] = false;
}

async function loadDetail(job) {
  try {
    mergeDetail(job, await providerOf(job.site).detail(job, controller.signal));
    job.detail = "done";
    delete job.detailTries;
    delete job.detailError;
  } catch (err) {
    // A page that failed to load (busy site, network) is tried again a little later; the job waits
    // as "checking" meanwhile rather than being hidden as unverified.
    job.detailTries = (job.detailTries || 0) + 1;
    job.detailError = err.message;
    if (job.detailTries < DETAIL_TRIES && !/Restricted job/.test(err.message)) {
      setTimeout(() => { if (jobs.get(key(job)) === job && job.detail === "pending") enqueue(job, "detail"); }, 30000 * job.detailTries);
      saveJobs();
      return;
    }
    job.detail = "error";
  }
  saveJobs();
  scheduleRender();
  if (detailKey === key(job)) renderDetail(job);
  // The client's sign-up date and company/individual come from their profile.
  if (needsProfile(job)) enqueue(job, "profile");
}

function mergeDetail(job, detail) {
  for (const [field, value] of Object.entries(detail || {})) {
    if (value == null || value === "") continue;
    if (field === "client") {
      job.client = { ...job.client, ...Object.fromEntries(Object.entries(value).filter(([, v]) => v != null && v !== "" && !(Array.isArray(v) && !v.length))) };
    } else {
      job[field] = value;
    }
  }
}

const profileKey = job => `${job.site}:${job.client?.url || job.client?.name || job.id}`;
const profileLoading = new Map();

async function loadProfile(job, { light = false } = {}) {
  const k = profileKey(job);
  if (!profiles.has(k)) {
    if (!profileLoading.has(k)) {
      profileLoading.set(k, providerOf(job.site).profile(job, controller.signal, { light })
        .then(profile => profiles.set(k, profile), err => profiles.set(k, { error: err.message }))
        .finally(() => profileLoading.delete(k)));
    }
    await profileLoading.get(k);
  }
  const profile = profiles.get(k);
  // Keep what the list needs on the job itself (saved with it).
  job.client = { ...job.client, profileChecked: true };
  if (profile && !profile.error) {
    if (profile.registeredAt) job.client.registeredAt = profile.registeredAt;
    if (profile.registeredDayOnly) job.client.registeredDayOnly = true;
    if (profile.clientType) job.client.clientType = profile.clientType;
  }
  saveJobs();
  scheduleRender();
  if (detailKey === key(job)) renderClient($("clientCol"), job, profile);
}

// true = the client passed at least one of 本人確認 / 電話確認 (Workana: its payment-method check);
// false = checked and none passed; null = details not loaded yet.
function verifiedState(job) {
  const c = job.client || {};
  const flags = job.site === "workana" ? [c.paymentVerified] : [c.identityVerified, c.phoneVerified];
  if (flags.some(f => f === true)) return true;
  return job.detail === "pending" ? null : false;
}

// Posted by the site's own operating company: the client's name matches the platform's operator
// pattern, or the site flags the client as its official account. Always excluded.
function isOperatorJob(job) {
  const c = job.client || {};
  if (c.official === true) return true;
  const pattern = providerOf(job.site)?.operator;
  return !!pattern && [c.name, c.url?.split("/").pop()].some(name => name && pattern.test(name.normalize("NFKC").trim()));
}

// A "JOB" (求人, employment-style) listing rather than work to bid on: the site readers mark these
// kind: "job" (from the listing's type label, or the job page once its details load). Always excluded.
const isJobListing = job => job.kind === "job";

// Finished: the site marks it closed, or its application deadline has passed.
const isClosed = job => job.closed === true || (!!job.closesAt && Date.parse(job.closesAt) < Date.now());

// Company or individual: Lancers says so; otherwise it's estimated from the name.
const COMPANY_NAME = /株式会社|有限会社|合同会社|合資会社|合名会社|社団法人|財団法人|NPO法人|学校法人|医療法人|[(（]株[)）]|[(（]有[)）]|\b(inc|llc|ltd|corp|corporation|limited|gmbh|ltda|s\.?a\.?|s\.?r\.?l)\b\.?/i;
const typeFromName = name => (name ? { type: COMPANY_NAME.test(name.normalize("NFKC")) ? "company" : "individual", estimated: true } : null);
function clientType(job, profile) {
  const explicit = profile?.clientType || job.client?.clientType;
  return explicit ? { type: explicit, estimated: false } : typeFromName(profile?.name || job.client?.name || "");
}
function typeBadge(type, job) {
  const label = type.type === "company" ? tx(job, "🏢 法人", "🏢 Company") : tx(job, "👤 個人", "👤 Individual");
  const span = el("span", `ctype ${type.type}`, `${label}${type.estimated ? tx(job, "（推定）", " (est.)") : ""}`);
  span.title = type.estimated ? tx(job, "名前から推定しています", "Estimated from the name") : tx(job, "サイトの表示によります", "As stated by the site");
  return span;
}

// ---------- filtering & views ----------

const normalize = s => (s || "").normalize("NFKC").toLowerCase();
const toYen = (n, currency) => (n == null ? null : currency === "USD" ? n * settings.usdRate : n);
const inSelectedPlatform = job => !settings.selected || job.site === settings.selected;

// The price range for a job: its category's own range if one is set, otherwise the default.
function priceRangeFor(job) {
  const conf = settings.sites[job.site];
  // (A keyword search covers every category, so the categories' own ranges don't apply to it.)
  const categories = keywordFor(job.site) ? [] : (job.searches || []).map(s => s.split("|")[0]);
  const cat = categories.find(c => conf.categories.includes(c) && conf.prices[c]);
  const range = cat ? conf.prices[cat] : { min: settings.priceMin, max: settings.priceMax };
  return { min: range.min ?? "", max: range.max ?? "" };
}

// Jobs matching the current searches and filters on every platform (pinned jobs live in Pinned).
function matchingJobs() {
  const counts = { pending: 0, unverified: 0 };
  const active = Object.fromEntries(PROVIDERS.map(p => [p.id, activeSearches(p.id)]));
  const list = [...jobs.values()].filter(job => {
    const conf = settings.sites[job.site];
    if (!conf?.on || job.pinned) return false;
    if (isBidCompleted(key(job))) return false; // moved to Bid completed
    if (isOperatorJob(job) || isJobListing(job)) return false;
    // With a keyword, every job the site's own keyword search returned is shown, from all categories
    // (the site matches titles and descriptions); the ticked categories only apply without a keyword.
    if (!(job.searches || []).some(s => active[job.site].includes(s))) return false;
    const { min, max } = priceRangeFor(job);
    const low = toYen(job.budgetMin ?? job.budgetMax, job.currency);
    const high = toYen(job.budgetMax ?? job.budgetMin, job.currency);
    if (min !== "" && (high == null || high < Number(min))) return false;
    if (max !== "" && (low == null || low > Number(max))) return false;
    if (settings.verifiedOnly) {
      const state = verifiedState(job);
      if (state === null) { if (inSelectedPlatform(job)) counts.pending++; return false; }
      if (state === false) { if (inSelectedPlatform(job)) counts.unverified++; return false; }
    }
    return true;
  });
  // Newly found jobs first — the latest search round at the very top, whatever date the site gives
  // them — then the starting list; within a round, the most recently posted first.
  const arrival = job => (job.isNew ? job.firstSeen || 0 : 0);
  const posted = job => Date.parse(job.postedAt) || job.firstSeen || 0;
  list.sort((a, b) => arrival(b) - arrival(a) || posted(b) - posted(a));
  return { list, counts };
}

let renderTimer = null;
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => { renderTimer = null; render(); }, 150);
}

function render() {
  clearTimeout(renderTimer);
  renderTimer = null;
  const { list, counts } = matchingJobs();

  // A new job is announced once, when it first passes the filters (i.e. after its client was checked).
  const announce = list.filter(job => job.isNew && !job.announced && !isClosed(job));
  for (const job of announce) { job.announced = true; job.unread = true; }
  if (announce.length) { notifyNewJobs(announce); saveJobs(); }

  const perPlatform = {}, unreadPerPlatform = {};
  for (const job of list) perPlatform[job.site] = (perPlatform[job.site] || 0) + 1;
  // (Only jobs the list shows: a count with nothing behind it — jobs the filters hide — was confusing.)
  for (const job of list) if (job.unread) unreadPerPlatform[job.site] = (unreadPerPlatform[job.site] || 0) + 1;
  renderSidebar(perPlatform, unreadPerPlatform);
  renderPip(perPlatform, unreadPerPlatform);

  // The search box narrows whichever list is shown.
  const shownAll = list.filter(inSelectedPlatform).filter(matchesSearch);
  const pinned = [...jobs.values()].filter(job => job.pinned && !isBidCompleted(key(job)) && inSelectedPlatform(job) && matchesSearch(job))
    .sort((a, b) => (b.pinnedAt || 0) - (a.pinnedAt || 0));
  const trashed = [...trash.values()].filter(inSelectedPlatform).filter(matchesSearch).sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
  const done = settings.view === "completed" ? completedShown() : [];

  $("tabAll").textContent = `All jobs (${shownAll.length})`;
  $("tabPinned").textContent = `📌 Pinned (${pinned.length})`;
  $("tabAll").setAttribute("aria-selected", String(settings.view === "all"));
  $("tabPinned").setAttribute("aria-selected", String(settings.view === "pinned"));
  // すべて復元 / すべて完全に削除 belong to 削除済み only; selecting and deleting to Bid completed.
  listShown = () => settings.view === "pinned" ? pinned : settings.view === "all" ? shownAll : [];
  $("listActions").hidden = !listShown().length;
  $("trashActions").hidden = settings.view !== "deleted" || !trashed.length;
  $("completedActions").hidden = settings.view !== "completed" || !done.length;
  for (const k of [...completedSelected]) if (!isBidCompleted(k)) completedSelected.delete(k);
  const selectedShown = done.filter(job => completedSelected.has(key(job))).length;
  $("completedSelectAll").checked = done.length > 0 && selectedShown === done.length;
  $("completedDeleteSelected").disabled = !selectedShown;
  $("completedDeleteSelected").textContent = `Delete selected${selectedShown ? ` (${selectedShown})` : ""}`;

  const viewTitle = $("viewTitle");
  const titleParts = [];
  if (settings.view === "deleted") titleParts.push("🗑 削除済み");
  if (settings.view === "completed") titleParts.push("✅ Bid completed");
  if (settings.selected) {
    viewTitle.style.setProperty("--site", `var(--${settings.selected})`);
    titleParts.push(siteIcon(settings.selected, "tag-icon"), " のみ表示");
  } else {
    viewTitle.style.removeProperty("--site");
  }
  viewTitle.replaceChildren(...titleParts);

  let shown, emptyText, summary = "";
  if (settings.view === "completed") {
    shown = done;
    summary = done.length ? "Jobs with a successful bid. Tick cards to delete them (their bids stay in History)." : "";
    emptyText = searchWords().length ? "No completed bids match the search." : "No completed bids yet — a job moves here once a bid on it succeeds.";
  } else if (settings.view === "deleted") {
    shown = trashed;
    summary = trashed.length ? "「復元」で一覧に戻すか、完全に削除できます。" : "";
    emptyText = "削除した案件はありません。";
  } else if (settings.view === "pinned") {
    shown = pinned;
    summary = pinned.length ? "ピン留めした案件はここにだけ表示されます（絞り込みに関係なく）。" : "";
    emptyText = "ピン留めした案件はまだありません。案件の「📌 ピン留め」で追加できます。";
  } else {
    shown = shownAll;
    const parts = [];
    if (settings.verifiedOnly) {
      if (counts.pending) parts.push(`クライアント確認中 ${counts.pending}件`);
      if (counts.unverified) parts.push(`未確認のため非表示 ${counts.unverified}件`);
    }
    summary = parts.join(" · ");
    emptyText = settings.selected && !settings.sites[settings.selected].on
      ? `${displayName(providerOf(settings.selected))} はオフです。⚙ からオンにすると検索します。`
      : jobs.size ? "条件に合う案件はまだありません。" : "検索中…";
  }
  if (searchWords().length && settings.view !== "completed" && !shown.length) emptyText = "No jobs match the search.";
  $("summary").textContent = summary;

  paintList(shown, settings.view === "deleted", emptyText);
  updateBadge(unreadPerPlatform);
}

// ---------- search box ----------

const searchWords = () => normalize($("listSearch").value).split(/\s+/).filter(Boolean);
function matchesSearch(job) {
  const words = searchWords();
  if (!words.length) return true;
  const haystack = normalize([job.title, job.description, job.client?.name, job.siteCategory, job.id].join(" "));
  return words.every(w => haystack.includes(w));
}

// ---------- Bid completed ----------

const completedSelected = new Set(); // job keys ticked in Bid completed
let listShown = () => [];            // the jobs All jobs / Pinned shows now (set by render)

// Jobs with a successful bid: the live job when it's still in the list, otherwise as it was when bid on.
function completedShown() {
  return completedEntries().map(entry => jobs.get(entry.key) || entry.job).filter(job => inSelectedPlatform(job) && matchesSearch(job));
}

// Deleting from Bid completed removes the job for good (it won't come back from searches);
// its bids stay in History.
async function removeCompleted(keys) {
  if (!keys.length || !confirm(`Delete ${keys.length} completed job${keys.length === 1 ? "" : "s"}? Their bids stay in History.`)) return;
  for (const k of keys) {
    jobs.delete(k);
    deleted.add(k);
    completedSelected.delete(k);
  }
  await dismissCompleted(keys);
  if (detailKey && keys.includes(detailKey)) closeDetail();
  saveJobs();
  render();
}

// Draws the list a small batch at a time (yielding between batches), updating the cards already on
// screen in place instead of rebuilding the list, so even very long lists never freeze the window.
// More cards are added automatically when the bottom of the list scrolls into view.
const PAINT_BATCH = 25;
let paintRun = 0;
let moreSentinel = null, moreObserver = null;

function paintList(shown, inTrash, emptyText) {
  const run = ++paintRun;
  const container = $("results");
  if (!shown.length) {
    container.replaceChildren(el("div", "empty", emptyText));
    return;
  }
  const total = Math.min(shown.length, renderLimit);
  let i = 0;
  const step = () => {
    if (run !== paintRun) return; // a newer render took over
    const end = Math.min(i + PAINT_BATCH, total);
    for (; i < end; i++) {
      const node = cardFor(shown[i], inTrash);
      const current = container.children[i];
      if (current !== node) container.insertBefore(node, current || null);
    }
    if (i < total) { setTimeout(step, 0); return; }
    // Done: remove leftovers from the previous list, and add the "load more" marker if needed.
    while (container.children.length > total) container.lastElementChild.remove();
    if (total < shown.length) container.append(loadMoreSentinel(shown.length - total));
  };
  step();
}

function loadMoreSentinel(remaining) {
  if (!moreSentinel) {
    moreSentinel = el("div", "empty load-more");
    moreObserver = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) { renderLimit += RENDER_STEP; render(); }
    }, { root: $("results"), rootMargin: "400px" });
    moreObserver.observe(moreSentinel);
  }
  moreSentinel.textContent = `読み込み中…（残り ${remaining}件）`;
  return moreSentinel;
}

// Cards are rebuilt only when something they show has changed (keeps big lists responsive).
const cardCache = new Map();
function cardFor(job, inTrash) {
  const k = key(job);
  const minute = Math.floor(Date.now() / 60000);
  const c = job.client || {};
  const signature = JSON.stringify([inTrash, job.title, job.detail, job.bids, ownBidders(job).size, job.hired, job.wanted, job.deadline, job.closesAt ? minute : 0, isClosed(job),
    job.unread, job.viewed, job.pinned, c.identityVerified, c.phoneVerified, c.paymentVerified, c.registeredAt ? minute : 0,
    c.avatar, c.name, job.siteCategory, job.budgetMin, job.budgetMax, job.postedAt, job.deliveryDate, bidSignature(job),
    settings.view === "completed", completedSelected.has(k)]);
  const cached = cardCache.get(k);
  if (cached?.signature === signature) return cached.node;
  const node = renderCard(job, inTrash);
  cardCache.set(k, { signature, node });
  if (cardCache.size > 1500) cardCache.delete(cardCache.keys().next().value);
  return node;
}

function renderCard(job, inTrash = false) {
  const closed = isClosed(job);
  const classes = ["job"];
  if (closed) classes.push("closed");
  else if (job.unread && !inTrash) classes.push("unread");
  if (job.viewed) classes.push("viewed");
  if (job.pinned && !inTrash) classes.push("pinned");
  if (inTrash) classes.push("trashed");
  if (!inTrash && isBidCompleted(key(job))) classes.push("completed");
  const card = el("article", classes.join(" "));
  card.style.setProperty("--site", `var(--${job.site})`);
  card.tabIndex = 0;
  card.setAttribute("aria-label", `${displayName(providerOf(job.site))}: ${job.title}`);
  // Clicking anywhere on the card (except its links/buttons) opens the detail window.
  card.addEventListener("click", e => { if (!e.target.closest("a, button")) openDetail(key(job)); });
  card.addEventListener("keydown", e => { if (e.key === "Enter" && e.target === card) openDetail(key(job)); });

  const main = el("div");
  const tags = el("div", "tags");
  tags.append(siteIcon(job.site, "tag-icon"));
  if (closed) tags.append(el("span", "tag closed", tx(job, "✖ 募集終了", "✖ CLOSED")));
  else if (job.unread && !inTrash) tags.append(el("span", "tag new", tx(job, "新着", "NEW")));
  if (job.pinned && !inTrash) tags.append(el("span", "tag pinned", tx(job, "📌 ピン留め", "📌 Pinned")));
  const bid = bidTag(job); // ✅ BID COMPLETED / ⏳ Proposing… / ❌ Bid failed
  if (bid) tags.append(bid);
  if (job.viewed) tags.append(el("span", "tag", tx(job, "閲覧済み", "Viewed")));
  if (job.siteCategory) tags.append(el("span", "tag", job.siteCategory));

  const titleRow = el("div", "title-row");
  const title = el("a", "title", job.title);
  title.href = safeUrl(job.url);
  title.target = "_blank";
  title.rel = "noopener noreferrer";
  titleRow.append(title, translateButton(job.title, job));
  main.append(tags, titleRow, facts(job));
  // Accounts that can still bid on it / bids placed (Lancers, Coconala, CrowdWorks).
  const stats = inTrash ? null : bidStats(job);
  if (stats) main.append(stats);

  const foot = el("div", "job-foot");
  // (Company / individual is shown only in the detail window.)
  foot.append(avatar(job.client?.avatar), el("span", "client-name", job.client?.name || tx(job, "クライアント", "Client")), verificationIcons(job), ...signupFlags(job));
  const actions = el("div", "card-actions");
  if (inTrash) {
    const restore = button("↩ Restore", "restore", () => restoreJob(key(job)));
    restore.title = tx(job, "一覧に戻す", "Put back in the list");
    const purge = button("Delete permanently", "purge", () => purgeJob(key(job)));
    purge.title = tx(job, "完全に削除（今後の検索にも表示されません）", "Remove for good (won't come back in searches)");
    actions.append(restore, purge);
  } else if (settings.view === "completed") {
    // Bid completed: tick for bulk delete, or delete just this one.
    const pick = el("label", "switch pick-box");
    const check = el("input");
    check.type = "checkbox";
    check.checked = completedSelected.has(key(job));
    check.addEventListener("change", () => { check.checked ? completedSelected.add(key(job)) : completedSelected.delete(key(job)); render(); });
    pick.append(check, el("span", "", "Select"));
    actions.append(pick, button("Delete", "delete", () => removeCompleted([key(job)])));
  } else {
    const pin = button(job.pinned ? "📌 Unpin" : "📌 Pin", `pin${job.pinned ? " on" : ""}`, () => togglePin(job));
    pin.title = job.pinned ? tx(job, "「すべての案件」に戻す", "Move back to all jobs") : tx(job, "「ピン留め」に移動", "Move to Pinned");
    const remove = button("Delete", "delete", () => deleteJob(job));
    remove.title = tx(job, "「削除済み」に移動（そこから復元できます）", "Move to Deleted (you can restore it from there)");
    // Bid / DM the client straight from the card.
    actions.append(...[bidButton(job), dmButton(job)].filter(Boolean), pin, remove);
  }
  foot.append(actions);

  card.append(main, el("div", "budget", budgetText(job)), foot);
  return card;
}

const recruitText = job => (job.hired != null && job.wanted != null ? `${job.hired} / ${job.wanted}${tx(job, "人", "")}` : null);
// The proposal count leaves out your own accounts (those on the Accounts page): the ones found among
// the job's bidders, and those whose proposal on it went through in History.
const ownBidders = job => {
  const list = bidderLists.get(key(job))?.list || [];
  return new Set([...list.map(b => ownAccountOf(job.site, b)?.label).filter(Boolean), ...ownBidLabels(job)]);
};
const othersBids = job => Math.max(0, job.bids - ownBidders(job).size);
const bidsText = job => {
  if (job.bids == null) return null;
  const own = ownBidders(job).size;
  return `${othersBids(job).toLocaleString()}${tx(job, "件", "")}${own ? tx(job, `（自分の${own}件を除く）`, ` (+${own} yours)`) : ""}`;
};

function facts(job) {
  const box = el("div", "facts");
  const add = (label, value, extraClass = "") => {
    if (value == null || value === "") return null;
    const span = el("span", `fact ${extraClass}`.trim());
    span.append(el("span", "label", label), el("b", "", String(value)));
    box.append(span);
    return span;
  };
  // The proposal count opens the job with its bidders shown (no re-search).
  const bids = add(tx(job, "提案数", "Proposals"), bidsText(job), `${job.bids > BUSY_BIDS ? "busy " : ""}clickable`);
  if (bids) {
    bids.title = tx(job, "クリックで提案者を表示", "Click to see who bid");
    bids.addEventListener("click", e => { e.stopPropagation(); openDetail(key(job), { bidders: true }); });
  }
  // Hired so far / number wanted — only when the site gives both.
  add(tx(job, "採用 / 募集", "Hired / Wanted"), recruitText(job));
  add(tx(job, "希望納期", "Delivery"), niceDate(job.deliveryDate, job));
  add(tx(job, "募集期限", "Deadline"), deadlineText(job));
  add(tx(job, "掲載日", "Posted"), postedText(job));
  return box;
}

// ID / phone (Workana: payment method) as icons — green only when verified.
// id: an ID card with a person; phone: a handset; card: a payment card.
const ICONS = {
  id: "M3 5h18v14H3z M8.5 9a2 2 0 1 0 0 4 2 2 0 0 0 0-4z M5.5 17c.5-1.7 1.7-2.6 3-2.6s2.5.9 3 2.6 M14 9.5h5 M14 12.5h5 M14 15.5h3",
  phone: "M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2",
  card: "M3 6h18v12H3z M3 10h18 M6 15h4"
};

// A larger verification icon for the detail window, with a green check badge when verified.
function verifyBadge(name, value, label, job) {
  const badge = el("span", `vbadge${value === true ? " yes" : ""}`);
  badge.append(svgIcon(name));
  if (value === true) badge.append(el("span", "tick", "✓"));
  badge.title = `${label}: ${value === true ? tx(job, "確認済み", "verified") : value === false ? tx(job, "未確認", "not verified") : tx(job, "非公開", "not published")}`;
  return badge;
}
function svgIcon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2.2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}
function verificationIcons(job) {
  const c = job.client || {};
  const box = el("span", "vicons");
  const icon = (name, value, label) => {
    const span = el("span", `vicon${value === true ? " yes" : ""}`);
    span.append(svgIcon(name));
    span.title = `${label}: ${value === true ? tx(job, "確認済み", "verified") : value === false ? tx(job, "未確認", "not verified") : job.detail === "pending" ? tx(job, "確認中…", "checking…") : tx(job, "サイトで非公開", "not published by the site")}`;
    return span;
  };
  if (job.site === "workana") box.append(icon("card", c.paymentVerified, "Payment method"));
  else box.append(icon("id", c.identityVerified, "本人確認"), icon("phone", c.phoneVerified, "電話確認"));
  return box;
}

// Recent sign-ups: blinking blue dot (within 1 hour) and a yellow warning with the time (within 24 hours).
function signupAge(job) {
  const at = job.client?.registeredAt;
  if (!at) return null;
  if (job.client.registeredDayOnly) {
    // Only the day is known (Lancers): treat "signed up today" as within 24 hours.
    return new Date(at).toDateString() === new Date().toDateString() ? { dayOnly: true } : null;
  }
  const age = Date.now() - Date.parse(at);
  return age >= 0 ? { ms: age } : null;
}
function signupFlags(job) {
  const flags = [];
  const age = signupAge(job);
  if (age?.dayOnly) {
    const warn = el("span", "signup-warning", "⚠ 今日");
    warn.title = "このクライアントは今日登録しました";
    flags.push(warn);
  } else if (age && age.ms < DAY) {
    // (Within the last hour, the details also show a blinking green dot beside the registration time.)
    const label = age.ms < HOUR
      ? `${Math.max(1, Math.round(age.ms / 60000))}${tx(job, "分", "m")}`
      : `${Math.floor(age.ms / HOUR)}${tx(job, "時間", "h")}`;
    const warn = el("span", "signup-warning", `⚠ ${label}`);
    warn.title = tx(job, `このクライアントは${label}前に登録しました`, `This client signed up ${label} ago`);
    flags.push(warn);
  }
  return flags;
}

function togglePin(job) {
  job.pinned = !job.pinned;
  job.pinnedAt = job.pinned ? Date.now() : undefined;
  saveJobs();
  render();
  if (detailKey === key(job)) renderDetail(job);
}

// Delete moves the job to 削除済み (restorable); it stays out of later searches.
function deleteJob(job, { quiet = false } = {}) {
  const k = key(job);
  if (detailKey === k) closeDetail();
  deleted.add(k);
  jobs.delete(k);
  trash.set(k, { ...job, pinned: false, pinnedAt: undefined, unread: false, deletedAt: Date.now() });
  if (!quiet) { saveJobs(); render(); }
}

function restoreJob(k, { quiet = false } = {}) {
  const job = trash.get(k);
  if (!job) return;
  trash.delete(k);
  deleted.delete(k);
  delete job.deletedAt;
  jobs.set(k, job);
  if (job.detail === "pending") enqueue(job, "detail");
  if (!quiet) { saveJobs(); render(); }
}

// Permanently deleted jobs are forgotten but stay blocked from future searches.
function purgeJob(k) {
  if (detailKey === k) closeDetail();
  trash.delete(k);
  saveJobs();
  render();
}

// ---------- new jobs: alert window + badges ----------

// New jobs are announced in the alert window in the top-right corner of the screen (alert.js).
function notifyNewJobs(list) {
  const groups = PROVIDERS.map(p => {
    const items = list.filter(job => job.site === p.id);
    if (!items.length) return null;
    return {
      site: p.id,
      title: tx(p.id, `${displayName(p)} — 新着案件 ${items.length}件`, `${displayName(p)} — ${items.length} new job${items.length === 1 ? "" : "s"}`),
      items: items.slice(0, 3).map(job => ({ title: job.title, category: job.siteCategory || "" }))
    };
  }).filter(Boolean);
  showAlert({ total: list.length, groups });
}

let lastBadgeCount = -1;
function updateBadge(unreadPerPlatform) {
  const n = Object.values(unreadPerPlatform).reduce((a, b) => a + b, 0);
  $("navNewCount").hidden = !n;
  $("navNewCount").textContent = String(n);
  // (Only when the count changes: the title and icon are the taskbar button's, redrawn on every change.)
  const title = n ? `(${n}) Job Finder` : "Job Finder";
  if (document.title !== title) document.title = title;
  setFaviconBadge(n);
  if (n === lastBadgeCount) return;
  lastBadgeCount = n;
  chrome.action.setBadgeBackgroundColor({ color: "#3cb043" });
  chrome.action.setBadgeText({ text: n ? String(Math.min(n, 999)) : "" });
}

// The window/taskbar icon is the page icon: redraw it with the new-job count when there are new jobs.
let baseIcon, lastFaviconCount = -1;
function setFaviconBadge(n) {
  if (n === lastFaviconCount) return;
  lastFaviconCount = n;
  const link = $("favicon");
  if (!n) { link.href = "icons/icon32.png"; return; }
  const draw = () => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(baseIcon, 0, 0, 64, 64);
    const label = n > 99 ? "99+" : String(n);
    ctx.fillStyle = "#d1242f";
    ctx.beginPath();
    ctx.arc(42, 22, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = `bold ${label.length > 2 ? 18 : 28}px Segoe UI, Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, 42, 23);
    link.href = canvas.toDataURL("image/png");
  };
  if (baseIcon?.complete) draw();
  else {
    baseIcon = new Image();
    baseIcon.onload = draw;
    baseIcon.src = "icons/icon128.png";
  }
}

// ---------- Settings → Desktop helper (helper.js) ----------

function bindHelperSettings() {
  $("extensionId").textContent = chrome.runtime.id;
  $("copyExtensionId").addEventListener("click", async () => {
    await navigator.clipboard.writeText(chrome.runtime.id).catch(() => {});
    $("copyExtensionId").textContent = "Copied";
    setTimeout(() => { $("copyExtensionId").textContent = "Copy"; }, 1500);
  });
  const show = async force => {
    const status = await helperStatus({ force });
    $("helperStatus").className = `pw-message ${status.installed ? "ok" : "bad"}`;
    $("helperStatus").textContent = status.installed
      ? `Installed (version ${status.version}): notifications show above every window, and the 📌 pinned window on every desktop.`
      : `Not installed${status.error && status.error !== "Not installed" ? ` (${status.error})` : ""} — notifications open in a Chrome window.`;
  };
  show(false);
  window.addEventListener("focus", () => show(true));
  $("testAlert").addEventListener("click", async () => {
    await show(true);
    showAlert({ total: 2, groups: [
      { site: "coconala", title: "Coconala: 1 new job", items: [{ title: "テスト通知 — LP制作のお願い", category: "Webサイト制作" }] },
      { site: "lancers", title: "Lancers: 1 new message", items: [{ title: "テスト通知 — ご提案ありがとうございます", category: "" }] }
    ] });
  });
}

// ---------- 最前面に固定: a small always-on-top window; the main window is minimised meanwhile ----------

let pipWindow = null, mainWindowId = null;
let pinProblem = "";              // why the pinned window isn't on every desktop (shown as ⚠ in it)
const HELPER_VERSION = "1.1.0";   // the helper that finds the pinned window by its title

const olderThan = (a, b) => {
  const x = String(a || "0").split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== y[i]) return (x[i] || 0) < y[i];
  return false;
};

// The helper's answer to "pin": shown on the 📌 button, and as ⚠ in the small window when it failed.
onHelperMessage(message => {
  if (message?.type !== "pinned" || !pipWindow) return;
  $("pinWindow").title = message.ok ? "Pinned on top, on every desktop — click to unpin"
    : `Pinned on top — click to unpin (not on every desktop: ${message.reason})`;
  pinProblem = message.ok ? "" : `Not shown on every desktop: ${message.reason}. Click to open Settings → Desktop helper.`;
  render();
});

async function togglePinWindow() {
  if (pipWindow) { pipWindow.close(); return; }
  if (!window.documentPictureInPicture) {
    alert("This browser can't open always-on-top windows (Chrome or Edge 116 or later is needed).");
    return;
  }
  const active = PROVIDERS.filter(p => settings.sites[p.id].on);
  const size = { width: Math.max(120, 16 + active.length * 48), height: 64 }; // one row of platform icons
  try {
    pipWindow = await documentPictureInPicture.requestWindow(size);
  } catch (err) {
    alert(`Couldn't open the always-on-top window: ${err.message}`);
    return;
  }
  // Job Finder Helper puts it on every virtual desktop, so switching desktops doesn't leave it behind.
  // (Chrome titles the window with this page's title, which is how the helper finds it.)
  pinProblem = "";
  helperStatus().then(status => {
    if (!status.installed) pinProblem = "Job Finder Helper isn't installed, so this window stays on this desktop only. Click to open Settings → Desktop helper.";
    else if (olderThan(status.version, HELPER_VERSION)) pinProblem = `Job Finder Helper ${status.version} is out of date: run native\\install.cmd again so this window shows on every desktop. Click to open Settings.`;
    else helperSend({ type: "pin", ...size, scale: window.devicePixelRatio || 1, title: document.title });
    if (pinProblem) render();
  });
  const link = pipWindow.document.createElement("link");
  link.rel = "stylesheet";
  link.href = chrome.runtime.getURL("finder.css");
  pipWindow.document.head.append(link);
  pipWindow.document.title = "";
  pipWindow.document.body.className = "pip";
  pipWindow.addEventListener("pagehide", () => {
    pipWindow = null;
    pinProblem = "";
    helperSend({ type: "unpin" });
    $("pinWindow").classList.remove("active");
    $("pinWindow").title = "Pin on top: shrink to a small always-on-top window";
    restoreMainWindow();
  });
  $("pinWindow").classList.add("active");
  $("pinWindow").title = "Pinned on top — click to unpin";
  render();
  // Hide the main interface: only the small window stays on screen.
  try {
    const win = await chrome.windows.getCurrent();
    mainWindowId = win.id;
    await chrome.windows.update(win.id, { state: "minimized" });
  } catch { /* the main window just stays visible */ }
}

async function restoreMainWindow() {
  if (mainWindowId == null) return;
  try { await chrome.windows.update(mainWindowId, { state: "normal", focused: true }); } catch { /* window was closed */ }
  mainWindowId = null;
}

// The small window: one row of the platforms being searched, each icon with its new-job count.
// Clicking an icon unpins and restores the full window, showing that platform.
function renderPip(counts, unread) {
  if (!pipWindow) return;
  const doc = pipWindow.document;
  const row = doc.createElement("div");
  row.className = "pip-row";
  for (const p of PROVIDERS.filter(x => settings.sites[x.id].on)) {
    const b = doc.createElement("button");
    b.type = "button";
    b.className = "pip-icon";
    b.title = `${displayName(p)}: ${counts[p.id] || 0} jobs${unread[p.id] ? `, ${unread[p.id]} new` : ""} — click to open`;
    const icon = doc.createElement("img");
    icon.src = siteIconUrl(p.id);
    icon.alt = displayName(p);
    b.append(icon);
    if (unread[p.id]) {
      const badge = doc.createElement("span");
      badge.className = "pip-badge";
      badge.textContent = String(unread[p.id]);
      b.append(badge);
    }
    b.addEventListener("click", () => {
      selectPlatform(p.id);
      pipWindow?.close(); // pagehide restores the main window
    });
    row.append(b);
  }
  if (pinProblem) {
    const warn = doc.createElement("button");
    warn.type = "button";
    warn.className = "pip-icon pip-warn";
    warn.title = pinProblem;
    warn.textContent = "⚠";
    warn.addEventListener("click", () => {
      showPage("settings");
      pipWindow?.close();
    });
    row.append(warn);
  }
  doc.body.replaceChildren(row);
}

// ---------- detail window ----------

// (A completed job the list has already dropped opens as it was when bid on.)
const findJob = k => jobs.get(k) || trash.get(k) || bidJobSnapshot(k);

function openDetail(k, { bidders = false } = {}) {
  const job = findJob(k);
  if (!job) return;
  detailKey = k;
  showBiddersFor = bidders ? k : null;
  job.viewed = true;
  job.unread = false; // the platform's new-count goes down as jobs are viewed
  saveJobs();
  scheduleRender();
  $("detail").hidden = false;
  $("resultsWrap").classList.add("locked"); // the list behind doesn't scroll
  // Opening shows what is already loaded; only the 🔄 Re-search button fetches the job again.
  renderDetail(job);
}

// 🔄 Re-search: fetch just this job again — fresh details, bidders and client profile.
function researchJob(job) {
  const k = key(job);
  if (!jobs.has(k)) return;
  job.detail = "pending";
  job.detailTries = 0;
  bidderLists.delete(k);
  profiles.delete(profileKey(job));
  renderDetail(job);
  loadDetail(job);
}

function closeDetail() {
  detailKey = null;
  $("detail").hidden = true;
  $("resultsWrap").classList.remove("locked");
}

// Clicking the proposal count shows the bidders (without re-searching the job; 🔄 Re-search refreshes them).
function showBidders(job) {
  showBiddersFor = key(job);
  renderBidders(job);
}

function renderDetail(job) {
  const provider = providerOf(job.site);
  const inTrash = trash.has(key(job));
  $("detail").querySelector(".detail-window").style.setProperty("--site", `var(--${job.site})`);

  // Header: tags, title, ピン留め / 削除 / 閉じる
  const head = el("div", "detail-head");
  const grow = el("div", "grow");
  const tags = el("div", "tags");
  tags.append(siteIcon(job.site, "tag-icon"));
  if (isClosed(job)) tags.append(el("span", "tag closed", tx(job, "✖ 募集終了 — 提案を受け付けていません", "✖ CLOSED — no longer accepting proposals")));
  if (inTrash) tags.append(el("span", "tag", tx(job, "🗑 削除済み", "🗑 Deleted")));
  if (job.siteCategory) tags.append(el("span", "tag", job.siteCategory));
  const title = el("h2", "", job.title);
  title.id = "detailTitle";
  grow.append(tags, title);
  const stats = inTrash ? null : bidStats(job);
  if (stats) grow.append(stats);
  const actions = el("div", "head-actions");
  if (inTrash) {
    actions.append(button("↩ Restore", "pin-btn", () => { closeDetail(); restoreJob(key(job)); }));
  } else {
    const searching = job.detail === "pending";
    const research = button(searching ? "🔄 Searching…" : "🔄 Re-search", "btn ghost", () => researchJob(job));
    research.disabled = searching || !jobs.has(key(job)); // (a completed job dropped from the list can't be re-searched)
    research.title = tx(job, "この案件の詳細・提案者・クライアント情報を再取得", "Fetch this job's details, bidders and client again");
    const pin = button(job.pinned ? "📌 Pinned" : "📌 Pin", `pin-btn${job.pinned ? " on" : ""}`, () => togglePin(job));
    pin.title = job.pinned ? tx(job, "「すべての案件」に戻す", "Move back to all jobs") : tx(job, "「ピン留め」に移動", "Move to Pinned");
    const bid = bidButton(job); // Lancers / Coconala / CrowdWorks only
    const dm = dmButton(job);   // message the client
    actions.append(research, pin, ...[bid, dm].filter(Boolean), button("🗑 Delete", "btn ghost danger", () => deleteJob(job)));
  }
  const close = button("×", "icon", closeDetail);
  close.setAttribute("aria-label", tx(job, "閉じる", "Close"));
  actions.append(close);
  head.append(grow, actions);

  // Left: project
  const project = el("section", "col project");
  const tiles = el("div", "tiles");
  const bidsLabel = tx(job, "提案数", "Proposals");
  for (const [label, value, busy] of [
    [tx(job, "予算", "Budget"), budgetText(job)],
    [bidsLabel, bidsText(job), job.bids > BUSY_BIDS],
    [tx(job, "採用 / 募集", "Hired / Wanted"), recruitText(job)],
    [tx(job, "希望納期", "Delivery"), niceDate(job.deliveryDate, job)],
    [tx(job, "募集期限", "Deadline"), deadlineText(job)],
    [tx(job, "掲載日", "Posted"), postedText(job)]
  ]) {
    if (value == null || value === "") continue;
    const t = tile(label, value);
    if (busy) t.classList.add("busy");
    if (label === bidsLabel) {
      t.classList.add("clickable");
      t.title = tx(job, "クリックで提案者を表示", "Click to see who bid");
      t.addEventListener("click", () => showBidders(job));
    }
    tiles.append(t);
  }
  const biddersBox = el("div", "bidders");
  biddersBox.id = "biddersBox";
  const projectActions = el("div", "actions-row");
  const proposeUrl = proposalPageUrl(job);
  const proposeLink = proposeUrl && externalLink(tx(job, "📝 提案ページを開く", "📝 Open proposal page"), proposeUrl, "btn");
  if (proposeLink) proposeLink.title = tx(job, "この案件の提案フォームをサイトで開く", "Open this job's proposal form on the site");
  projectActions.append(
    externalLink("Open job page", job.url, "btn"),
    ...(proposeLink ? [proposeLink] : []),
    copyButton("Copy URL", () => job.url, job),
    copyButton("Copy all info", () => allInfoText(job, profiles.get(profileKey(job))), job)
  );
  project.append(el("h3", "", tx(job, "案件", "Project")), tiles, biddersBox, projectActions);
  if (job.detail === "error") project.append(el("p", "error-text", `${tx(job, "詳細を読み込めませんでした", "Couldn't load the job details")}: ${job.detailError}`));
  if (job.rows?.length) project.append(el("h3", "", tx(job, "詳細", "Details")), infoTable(job.rows, job));
  const descHead = el("h3", "", tx(job, "依頼内容", "Description"));
  let description;
  if (job.description) {
    descHead.append(el("span", "hint", tx(job, "— クリックまたは選択で翻訳", "— click or select text to translate")));
    description = translatable(job.description, job);
  } else {
    description = el("div", "description", job.detail === "pending" ? tx(job, "読み込み中…", "Loading…") : tx(job, "説明がありません。案件ページでご確認ください。", "No description available — open the job page."));
  }
  project.append(descHead, description);

  // Right: client
  const client = el("section", "col client");
  client.id = "clientCol";
  renderClient(client, job, profiles.get(profileKey(job)));

  const cols = el("div", "detail-cols");
  cols.append(project, client);
  $("detailBody").replaceChildren(head, cols);
  if (showBiddersFor === key(job)) renderBidders(job);

  // Load the client's full profile (once per client).
  const cached = profiles.get(profileKey(job));
  if ((!cached || cached.error) && job.detail !== "pending" && provider.profile && job.client?.url) loadProfile(job);
}

// ---------- bidders (clicking the proposal count) ----------

const bidderLists = new Map(); // job key → { list } | { error } | { loading: true }

async function renderBidders(job) {
  const box = $("biddersBox");
  if (!box) return;
  const k = key(job);
  const provider = providerOf(job.site);
  const head = el("h3", "", tx(job, "提案者", "Bidders"));
  head.append(button("Hide", "link", () => { showBiddersFor = null; box.replaceChildren(); }));
  if (!provider.bidders) {
    box.replaceChildren(head, el("p", "loading", tx(job, `${displayName(provider)} は提案者を公開していません。`, `${displayName(provider)} doesn't show who placed bids.`)));
    return;
  }
  if (job.detail === "pending") { box.replaceChildren(head, el("p", "loading", tx(job, "最新の情報を読み込み中…", "Loading the latest details…"))); return; }
  let state = bidderLists.get(k);
  // A list read before one of your accounts' proposals went through is read again, so it can show it.
  const ownBids = ownBidEntries(job);
  const stale = !!state?.list && ownBids.some(o => !o.dm && o.at > state.at);
  if (stale) state = null;
  if (!state) {
    bidderLists.set(k, { loading: true });
    box.replaceChildren(head, el("p", "loading", tx(job, "提案者を読み込み中…", "Loading bidders…")));
    try {
      bidderLists.set(k, { list: await provider.bidders(job, controller.signal, { fresh: stale }), at: Date.now() });
    } catch (err) {
      bidderLists.set(k, { error: err.message });
    }
    // Now that your own accounts among them are known, the counts (tiles and card) leave them out.
    if (detailKey === k && showBiddersFor === k) renderDetail(job);
    scheduleRender();
    return;
  }
  if (state.loading) return;
  if (state.error) { box.replaceChildren(head, el("p", "error-text", `${tx(job, "提案者を読み込めませんでした", "Couldn't load the bidders")}: ${state.error}`)); return; }
  // Your own accounts (on the Accounts page) are left out of the bidders and their count, and listed
  // apart: selecting one shows its proposal (History, or the job's BID window).
  const mine = [], others = [];
  for (const bidder of state.list) {
    const account = ownAccountOf(job.site, bidder);
    (account ? mine : others).push({ bidder, account });
  }
  // Your accounts that bid from Job Finder (or sent a DM) are listed too when the site's list doesn't
  // show them (yet).
  const listed = new Set(mine.map(m => m.account.label));
  for (const own of ownBids) {
    if (listed.has(own.label)) continue;
    mine.push({
      bidder: { name: own.name, avatar: own.avatar },
      account: { label: own.label },
      note: own.dm ? tx(job, "DM送信済み", "DM sent") : tx(job, "Job Finder から提案済み（サイトの一覧にはまだ表示されていません）", "Proposed from Job Finder (not on the site's list yet)")
    });
  }
  head.firstChild.after(el("span", "hint", ` ${others.length}${mine.length ? tx(job, `（自分の${mine.length}件を除く）`, ` (excluding ${mine.length} of yours)`) : ""}`));
  const parts = [head];
  if (mine.length) {
    const own = el("ul", "bidder-list own");
    for (const { bidder, account, note } of mine) {
      const item = el("li", "own-bidder");
      item.tabIndex = 0;
      item.title = tx(job, "クリックでこのアカウントの提案を表示", "Click to see this account's proposal");
      item.append(avatar(bidder.avatar), el("span", "", bidder.name), el("span", "hint", note ? `${account.label} · ${note}` : account.label),
        el("span", "own-bidder-go", tx(job, "提案を見る →", "View proposal →")));
      const go = () => showProposal(job, account);
      item.addEventListener("click", go);
      item.addEventListener("keydown", e => { if (e.key === "Enter") go(); });
      own.append(item);
    }
    parts.push(el("div", "hint own-bidders-head", tx(job, "あなたのアカウント（提案数に含めません）", "Your accounts (not counted)")), own);
  }
  // Everyone else: avatar and name only.
  const list = el("ul", "bidder-list");
  for (const { bidder } of others) {
    const item = el("li");
    item.append(avatar(bidder.avatar), bidder.url ? externalLink(bidder.name, bidder.url) : el("span", "", bidder.name));
    list.append(item);
  }
  parts.push(others.length ? list : el("p", "loading", tx(job, mine.length ? "ほかの提案者はいません。" : "まだ提案者はいません。", mine.length ? "No other bidders." : "No bidders are listed yet.")));
  box.replaceChildren(...parts);
}

// A text block that sends its text to the translator when clicked (unless part of it was just
// selected — a selection is translated on its own when the mouse is released).
function translatable(text, job) {
  const box = el("div", "description translatable", text);
  box.title = tx(job, "クリックで全文を翻訳（ドラッグで選択した部分だけを翻訳）", "Click to translate all (or drag to select part)");
  box.tabIndex = 0;
  box.addEventListener("click", () => { if (!String(window.getSelection())) sendToTranslator(text); });
  box.addEventListener("keydown", e => { if (e.key === "Enter") sendToTranslator(text); });
  return box;
}

// Selecting text anywhere in a job's details translates the selection when the mouse is released.
function translateSelection() {
  const selected = String(window.getSelection() || "").trim();
  if (selected.length > 1) sendToTranslator(selected);
}

function renderClient(col, job, profile) {
  if (!col) return;
  const c = job.client || {};
  const p = profile && !profile.error ? profile : {};

  const card = el("div", "client-card");
  const info = el("div");
  const nameText = p.name || c.name || tx(job, "クライアント", "Client");
  const url = p.url || c.url;
  // Name, with the client's gender as an icon when the profile states it.
  const nameLine = el("div", "name-line");
  nameLine.append(url ? externalLink(nameText, url, "name") : el("div", "name", nameText));
  const gender = (p.rows || []).find(([label]) => label === "Gender")?.[1];
  if (gender === "Male" || gender === "Female") {
    const g = el("span", `gender ${gender.toLowerCase()}`, gender === "Male" ? "♂" : "♀");
    g.title = tx(job, gender === "Male" ? "男性" : "女性", gender);
    nameLine.append(g);
  }
  info.append(nameLine);
  // Registration time below the name; a blinking green dot when it was within the last hour.
  if (c.registeredAt) {
    const reg = el("div", "registered", `${tx(job, "登録", "Registered")}: ${fmtDate(new Date(c.registeredAt), !c.registeredDayOnly)}`);
    const age = signupAge(job);
    if (age && !age.dayOnly && age.ms < HOUR) {
      const dot = el("span", "fresh-dot");
      dot.title = tx(job, "1時間以内に登録したクライアント", "Signed up within the last hour");
      reg.append(dot);
    }
    info.append(reg);
  }
  if (p.lastSeen) info.append(el("div", "seen", `${tx(job, "最終アクセス", "Last active")}: ${valueJa(p.lastSeen, job)}`));
  const flags = el("div", "flags");
  const type = clientType(job, p);
  if (type) flags.append(typeBadge(type, job));
  flags.append(...signupFlags(job));
  info.append(flags);
  // ID / phone (Workana: payment) as clear icons right under the name.
  const badges = el("div", "vbadge-row");
  if (job.site === "workana") badges.append(verifyBadge("card", c.paymentVerified, "Payment method", job));
  else badges.append(verifyBadge("id", c.identityVerified, tx(job, "本人確認", "Identity"), job), verifyBadge("phone", c.phoneVerified, tx(job, "電話確認", "Phone"), job));
  info.append(badges);
  card.append(avatar(p.avatar || c.avatar), info);

  // (No separate verification section: the ID / phone icons under the name show it.)
  col.replaceChildren(el("h3", "", tx(job, "クライアント", "Client")), card);

  const statTiles = p.tiles?.length ? p.tiles : c.buyerTiles?.length ? c.buyerTiles : null;
  if (statTiles) {
    const grid = el("div", "tiles");
    for (const [label, value, sub] of statTiles) grid.append(tile(ja(label, job), valueJa(value, job), sub ? valueJa(sub, job) : ""));
    col.append(el("h3", "", tx(job, "実績", "Track record")), grid);
  } else if (c.extra?.length) {
    col.append(el("h3", "", tx(job, "実績", "Track record")), el("div", "loading", c.extra.map(e => extraJa(e, job)).join(" · ")));
  }

  if (p.rows?.length) col.append(el("h3", "", tx(job, "プロフィール", "Profile")), infoTable(p.rows, job));

  const introHead = el("h3", "", tx(job, "自己紹介", "About me"));
  col.append(introHead);
  if (profile?.error) col.append(el("p", "error-text", `${tx(job, "プロフィールを読み込めませんでした", "Couldn't load the profile")}: ${profile.error}`));
  else if (!profile) col.append(el("div", "loading", providerOf(job.site).profile ? tx(job, "プロフィールを読み込み中…", "Loading profile…") : tx(job, "プロフィールはありません。", "Profile not available.")));
  else if (p.intro) {
    introHead.append(el("span", "hint", tx(job, "— クリックまたは選択で翻訳", "— click or select text to translate")));
    col.append(translatable(p.intro, job));
  } else col.append(el("div", "description", tx(job, "自己紹介は書かれていません。", "The client hasn't written a self-introduction.")));

  const row = el("div", "actions-row");
  if (url) row.append(externalLink("Open client page", url, "btn ghost"));
  row.append(copyButton("Copy client info", () => clientInfoText(job, profiles.get(profileKey(job))), job));
  col.append(row);
}

function tile(label, value, sub) {
  const box = el("div", "tile");
  box.append(el("div", "label", label), el("div", "value", String(value)));
  if (sub) box.append(el("div", "sub", sub));
  return box;
}

function infoTable(rows, job) {
  const table = el("table", "info");
  for (const [label, value] of rows) {
    if (value == null || value === "") continue;
    const tr = el("tr");
    tr.append(el("th", "", ja(label, job)), el("td", "", valueJa(niceDate(String(value), job), job)));
    table.append(tr);
  }
  return table;
}

// ---------- copying ----------

function copyButton(label, getText, job) {
  const b = button(label, "btn ghost", async () => {
    const ok = await copyText(getText() || "");
    b.textContent = ok ? "Copied ✓" : "Copy failed";
    setTimeout(() => { b.textContent = label; }, 1500);
  });
  return b;
}

async function copyText(textToCopy) {
  try {
    await navigator.clipboard.writeText(textToCopy);
    return true;
  } catch {
    const area = el("textarea");
    area.value = textToCopy;
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

function clientInfoText(job, profile) {
  const c = job.client || {};
  const p = profile && !profile.error ? profile : {};
  const type = clientType(job, p);
  const yesNo = v => (v === true ? tx(job, "確認済み", "verified") : v === false ? tx(job, "未確認", "not verified") : tx(job, "非公開", "not published"));
  const lines = [
    `${tx(job, "クライアント", "Client")}: ${p.name || c.name || "?"}`,
    type ? `${tx(job, "種別", "Type")}: ${type.type === "company" ? tx(job, "法人", "Company") : tx(job, "個人", "Individual")}${type.estimated ? tx(job, "（推定）", " (estimated)") : ""}` : "",
    (p.url || c.url) ? `${tx(job, "クライアントページ", "Client page")}: ${p.url || c.url}` : "",
    job.site === "workana" ? `Payment method: ${yesNo(c.paymentVerified)}` : `本人確認: ${yesNo(c.identityVerified)}\n電話確認: ${yesNo(c.phoneVerified)}`,
    c.registeredAt ? `${tx(job, "登録日", "Registered")}: ${fmtDate(new Date(c.registeredAt), !c.registeredDayOnly)}` : "",
    p.lastSeen ? `${tx(job, "最終アクセス", "Last active")}: ${valueJa(p.lastSeen, job)}` : "",
    ...(p.tiles || c.buyerTiles || []).map(([label, value, sub]) => `${ja(label, job)}: ${valueJa(value, job)}${sub ? ` (${valueJa(sub, job)})` : ""}`),
    ...(p.rows || []).map(([label, value]) => `${ja(label, job)}: ${valueJa(niceDate(String(value), job), job)}`),
    p.intro ? `\n${tx(job, "自己紹介", "About me")}:\n${p.intro}` : ""
  ];
  return lines.filter(Boolean).join("\n");
}

function allInfoText(job, profile) {
  const lines = [
    job.title,
    `${tx(job, "プラットフォーム", "Platform")}: ${displayName(providerOf(job.site))}${job.siteCategory ? ` / ${job.siteCategory}` : ""}`,
    `URL: ${job.url}`,
    `${tx(job, "予算", "Budget")}: ${budgetText(job)}`,
    job.bids != null ? `${tx(job, "提案数", "Proposals")}: ${bidsText(job)}` : "",
    recruitText(job) ? `${tx(job, "採用 / 募集", "Hired / Wanted")}: ${recruitText(job)}` : "",
    job.deliveryDate ? `${tx(job, "希望納期", "Delivery")}: ${niceDate(job.deliveryDate, job)}` : "",
    deadlineText(job) ? `${tx(job, "募集期限", "Deadline")}: ${deadlineText(job)}` : "",
    postedText(job) ? `${tx(job, "掲載日", "Posted")}: ${postedText(job)}` : "",
    ...(job.rows || []).map(([label, value]) => `${ja(label, job)}: ${valueJa(niceDate(String(value), job), job)}`),
    job.description ? `\n${tx(job, "依頼内容", "Description")}:\n${job.description}` : "",
    `\n--- ${tx(job, "クライアント", "Client")} ---\n${clientInfoText(job, profile)}`
  ];
  return lines.filter(Boolean).join("\n");
}

// ---------- translator: Google翻訳 or DeepL ----------

const DEEPL_LANG = { en: "EN-US", ja: "JA", es: "ES", pt: "PT-BR", "zh-CN": "ZH", ko: "KO", fr: "FR", de: "DE", id: "ID" };

function applyTranslatorLayout() {
  $("app").classList.toggle("no-translator", !settings.translatorOpen);
  document.documentElement.style.setProperty("--tr-width", `${settings.translatorOpen ? settings.translatorWidth : 0}px`);
  document.documentElement.style.setProperty("--tr-font", `${settings.translatorFont}px`);
  $("toggleTranslator").textContent = settings.translatorOpen ? "Hide translator" : "Show translator";
  $("inputArea").hidden = !settings.translatorInput;
  $("toggleInput").textContent = settings.translatorInput ? "▲ Hide input" : "▼ Show input";
}

function translateButton(textToTranslate, job) {
  const b = button("Translate", "tr-btn", e => {
    e.stopPropagation();
    sendToTranslator(textToTranslate);
  });
  b.title = tx(job, "このタイトルを翻訳", "Translate this title");
  return b;
}

// Replaces the translator's input with this text and translates it.
function sendToTranslator(textToTranslate) {
  if (!settings.translatorOpen) { settings.translatorOpen = true; saveSettings(); applyTranslatorLayout(); }
  $("trInput").value = textToTranslate;
  runTranslation();
}

function updateEngineUi() {
  const deepl = settings.engine === "deepl";
  $("deeplKeyRow").hidden = !deepl;
  $("trOutputLabel").textContent = deepl ? "翻訳結果（DeepL）" : "翻訳結果（Google）";
}

function bindTranslator() {
  $("trEngine").value = settings.engine;
  $("deeplKey").value = settings.deeplKey;
  updateEngineUi();
  $("trEngine").addEventListener("change", () => { settings.engine = $("trEngine").value; saveSettings(); updateEngineUi(); runTranslation(); });
  $("deeplKey").addEventListener("change", () => { settings.deeplKey = $("deeplKey").value.trim(); saveSettings(); runTranslation(); });
  $("trTarget").value = settings.translateTo;
  $("trTarget").addEventListener("change", () => { settings.translateTo = $("trTarget").value; saveSettings(); runTranslation(); });
  $("toggleInput").addEventListener("click", () => { settings.translatorInput = !settings.translatorInput; saveSettings(); applyTranslatorLayout(); });
  $("trGo").addEventListener("click", runTranslation);
  $("trClear").addEventListener("click", () => { $("trInput").value = ""; $("trOutput").textContent = ""; $("trInput").focus(); });
  let typing;
  $("trInput").addEventListener("input", () => { clearTimeout(typing); typing = setTimeout(runTranslation, 800); });
  const resizeText = delta => {
    settings.translatorFont = Math.min(Math.max(settings.translatorFont + delta, 11), 28);
    saveSettings();
    applyTranslatorLayout();
  };
  $("trSmaller").addEventListener("click", () => resizeText(-1));
  $("trLarger").addEventListener("click", () => resizeText(1));

  // Drag the left edge to resize. Measured from the panel itself, so it works at any zoom level.
  const handle = $("resizeHandle");
  handle.addEventListener("pointerdown", e => {
    e.preventDefault();
    handle.setPointerCapture?.(e.pointerId);
    handle.classList.add("dragging");
    document.body.classList.add("resizing");
    const rect = $("translator").getBoundingClientRect();
    const scale = rect.width / settings.translatorWidth || 1;
    const move = ev => {
      const appWidth = $("app").getBoundingClientRect().width / scale;
      const width = (rect.right - ev.clientX) / scale;
      settings.translatorWidth = Math.round(Math.min(Math.max(width, 260), appWidth - 560));
      document.documentElement.style.setProperty("--tr-width", `${settings.translatorWidth}px`);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.classList.remove("dragging");
      document.body.classList.remove("resizing");
      saveSettings();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up, { once: true });
  });
}

let translationRun = 0;
async function runTranslation() {
  const source = $("trInput").value.trim();
  const target = settings.translateTo;
  const deepl = settings.engine === "deepl";
  $("trOpen").textContent = deepl ? "Open in DeepL" : "Open in Google Translate";
  $("trOpen").href = deepl
    ? `https://www.deepl.com/translator#auto/${encodeURIComponent((DEEPL_LANG[target] || "EN").toLowerCase().split("-")[0])}/${encodeURIComponent(source.slice(0, 5000))}`
    : `https://translate.google.com/?sl=auto&tl=${encodeURIComponent(target)}&text=${encodeURIComponent(source.slice(0, 5000))}&op=translate`;
  if (!source) { $("trOutput").textContent = ""; return; }
  const run = ++translationRun;
  $("trOutput").textContent = "翻訳中…";
  try {
    const result = deepl ? await translateDeepl(source, target) : await translateGoogle(source, target);
    if (run === translationRun) $("trOutput").textContent = result;
  } catch (err) {
    if (run === translationRun) $("trOutput").textContent = `翻訳できませんでした: ${err.message}`;
  }
}

// Google Translate's public web endpoint; long text is sent in paragraph-sized pieces.
async function translateGoogle(source, target) {
  const pieces = [];
  let current = "";
  for (const line of source.split("\n")) {
    if (current && current.length + line.length > 1500) { pieces.push(current); current = ""; }
    current += (current ? "\n" : "") + line;
  }
  if (current) pieces.push(current);
  const out = [];
  for (const piece of pieces) {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(piece)}`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}（「Google翻訳で開く」をお試しください）`);
    const data = await res.json();
    out.push((data?.[0] || []).map(part => part?.[0] || "").join(""));
  }
  return out.join("\n");
}

// DeepL's official API (needs the user's API key; keys ending in ":fx" are the free plan).
async function translateDeepl(source, target) {
  const authKey = settings.deeplKey.trim();
  if (!authKey) throw new Error("上の欄に DeepL APIキーを入力してください（無料プランで可）。");
  const lang = DEEPL_LANG[target];
  if (!lang) throw new Error("この言語は DeepL では使えません。");
  const host = authKey.endsWith(":fx") ? "https://api-free.deepl.com" : "https://api.deepl.com";
  const res = await fetch(`${host}/v2/translate`, {
    method: "POST",
    signal: controller.signal,
    headers: { Authorization: `DeepL-Auth-Key ${authKey}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ text: source, target_lang: lang })
  });
  if (res.status === 403) throw new Error("DeepL が APIキーを受け付けませんでした。");
  if (res.status === 456) throw new Error("この APIキーの DeepL 利用上限に達しました。");
  if (!res.ok) throw new Error(`DeepL エラー（HTTP ${res.status}）`);
  const data = await res.json();
  return (data.translations || []).map(t => t.text).join("\n");
}

// ---------- dates & small helpers ----------

// All dates as "2026/10/3" (with "10:39" when there's a time).
function fmtDate(d, withTime = false) {
  const date = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  return withTime ? `${date} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}` : date;
}
const fmtTime = d => `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;

// "2026年10月06日", "2026年10月28日 10:39", "2026-10-06" inside text → "2026/10/6", "2026/10/28 10:39".
function niceDate(value, job) {
  if (value == null || value === "") return value;
  const out = String(value).replace(/(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?(?:\s*(\d{1,2}):(\d{2}))?/g, (_, y, m, d, h, min) =>
    `${y}/${Number(m)}/${Number(d)}${h ? ` ${Number(h)}:${min}` : ""}`);
  return isEn(job) ? out : out.replace(/^Not specified$/, "指定なし");
}

// The end date as time and days remaining, e.g. "残り3日4時間 · 2026/10/28 23:59" ("3d 4h left" for Workana).
function deadlineText(job) {
  if (!job.closesAt) return niceDate(job.deadline, job);
  const end = new Date(job.closesAt);
  const ms = end - Date.now();
  if (ms <= 0) return `${tx(job, "終了", "Ended")} · ${fmtDate(end, true)}`;
  const days = Math.floor(ms / DAY), hours = Math.floor((ms % DAY) / HOUR), minutes = Math.floor((ms % HOUR) / 60000);
  const left = isEn(job)
    ? (days ? `${days}d ${hours}h left` : hours ? `${hours}h ${minutes}m left` : `${minutes}m left`)
    : (days ? `残り${days}日${hours}時間` : hours ? `残り${hours}時間${minutes}分` : `残り${minutes}分`);
  return `${left} · ${fmtDate(end, true)}`;
}

function postedText(job) {
  return job.postedAt ? fmtDate(new Date(job.postedAt), true) : niceDate(job.postedText, job) || "";
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, className, onClick) {
  const b = el("button", className, label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

function safeUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : "";
  } catch {
    return "";
  }
}

function externalLink(label, url, className = "") {
  const a = el("a", className, label);
  a.href = safeUrl(url);
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

function avatar(url) {
  const src = safeUrl(url);
  if (!src) return el("span", "avatar");
  const img = el("img", "avatar");
  img.src = src;
  img.alt = "";
  img.referrerPolicy = "no-referrer";
  img.loading = "lazy";
  return img;
}

function money(amount, currency) {
  return currency === "USD" ? `$${amount.toLocaleString()}` : `¥${amount.toLocaleString()}`;
}

function budgetText(job) {
  const en = isEn(job);
  const type = (en ? { fixed: "fixed", hourly: "hourly", task: "per task" } : { fixed: "固定", hourly: "時間単価", task: "タスク" })[job.budgetType] || "";
  if (job.budgetMin == null && job.budgetMax == null) return en ? "Budget negotiable" : "予算は相談";
  const amount = money(job.budgetMax ?? job.budgetMin, job.currency);
  const range = job.budgetMin != null && job.budgetMax != null && job.budgetMin !== job.budgetMax
    ? `${money(job.budgetMin, job.currency)} ${en ? "–" : "〜"} ${money(job.budgetMax, job.currency)}`
    : en ? `${job.budgetMin == null ? "up to " : ""}${amount}${job.budgetMax == null ? "+" : ""}`
      : `${job.budgetMin == null ? "〜" : ""}${amount}${job.budgetMax == null ? "〜" : ""}`;
  return type ? (en ? `${range} (${type})` : `${range}（${type}）`) : range;
}

function openAppWindow() {
  chrome.windows.create({ url: chrome.runtime.getURL("finder.html"), type: "popup", width: 1600, height: 940 });
}
