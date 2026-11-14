// Account alerts: Freelance Account Checker announces each account's new messages and transactions in
// Slack #alert (its alert-check.js: "✉ New message — name (label)", with the account, the badge number
// and a link to the site). Job Finder watches that channel, keeps the alerts per account, shows the new
// ones under each account on the Accounts page (and their total next to "Accounts" in the top menu),
// and lists an account's alerts when the account is selected. Opening them marks them as seen.
// Coconala messages come with their sender and message (FAC reads https://coconala.com/message).
// Alerts that arrive while Job Finder is open also pop up in the top-right corner of the screen
// (5 seconds); clicking it opens that account's alerts. #alert is read every 3 seconds (only what's
// newer than the last alert), and at once when this window comes back to the front.
// An alert deleted here (one, an account's, or all with Accounts → Delete all) is deleted from #alert
// too; if Slack refuses, it still isn't shown again.
import { getSlackToken, findChannelId, getHistory, deleteMessage } from "./slack.js";
import { showAlert, onAlertClick, onStickyAlertGone } from "./alert.js";
import { openPackage } from "./package.js";
import { openPortfolio } from "./portfolio.js";

const CHANNEL = "alert";
const POLL_MS = 3000;
const MISSING_RETRY_MS = 30000;      // #alert doesn't exist yet: looked for again after this long
const FULL_SYNC_EVERY = 100;         // every 100th check re-reads the whole channel (picks up deletions made elsewhere)
const SITE_IDS = { Lancers: "lancers", Coconala: "coconala", CrowdWorks: "crowdworks", Workana: "workana" };
export const KIND_TEXT = { message: "✉ Message", transaction: "☑ Transaction" };

const $ = id => document.getElementById(id);
let list = [];                       // newest first: { ts, account, site, kind, count, before, time, url }
let unread = new Set();              // ts of alerts not seen yet
let latestTs = "";
let initialized = false;             // #alert was read once (what was there then isn't popped up)
let deleted = new Set();             // ts of alerts deleted here (not shown again even if Slack kept them)
let clearedAt = 0;                   // Slack time of Delete all; older alerts aren't shown
let polls = 0;
let missingAt = 0;                   // when #alert was last found missing
let onChange = () => {};
let dialogAccount = null;
let viewingNew = new Set();          // what was new when the window opened (stays highlighted while it's open)

let accountsLookup = () => [];

export async function initAlerts({ changed, accounts, showAccountsPage }) {
  onChange = changed;
  accountsLookup = accounts;
  const stored = await chrome.storage.local.get(["jfAlerts", "jfAlertsUnread", "jfAlertsLatest", "jfAlertsInit", "jfAlertsDeleted", "jfAlertsClearedAt"]);
  list = stored.jfAlerts || [];
  unread = new Set(stored.jfAlertsUnread || []);
  latestTs = stored.jfAlertsLatest || "";
  initialized = !!stored.jfAlertsInit;
  deleted = new Set(stored.jfAlertsDeleted || []);
  clearedAt = stored.jfAlertsClearedAt || 0;
  $("alertDialog").addEventListener("click", e => { if (e.target === $("alertDialog")) closeAlerts(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("alertDialog").hidden) closeAlerts(); });
  // Clicking the pop-up (the background script brings this window forward): that account's alerts.
  onAlertClick(message => {
    const account = accountsLookup().find(a => a.label === message.account);
    if (!account) return;
    showAccountsPage();
    openAlerts(account);
  });
  // Back to the front: read #alert now rather than at the next poll.
  document.addEventListener("visibilitychange", () => { if (!document.hidden) sync().catch(() => {}); });
  window.addEventListener("focus", () => sync().catch(() => {}));
  watch();
}

function save() {
  return chrome.storage.local.set({ jfAlerts: list.slice(0, 2000), jfAlertsUnread: [...unread], jfAlertsLatest: latestTs, jfAlertsInit: initialized,
    jfAlertsDeleted: [...deleted].slice(-5000), jfAlertsClearedAt: clearedAt });
}

// ---------- counts for the Accounts page ----------

export const newAlerts = (label, kind) => list.filter(a => a.account === label && unread.has(a.ts) && (!kind || a.kind === kind)).length;
export const alertCount = label => list.filter(a => a.account === label).length;
export const alertsOf = label => list.filter(a => a.account === label);
export const latestAlert = label => list.find(a => a.account === label) || null;
export const totalNewAlerts = () => list.filter(a => unread.has(a.ts)).length;

// ---------- watching #alert ----------

let watching = false;
async function watch() {
  if (watching) return;
  watching = true;
  for (;;) {
    try {
      await sync({ full: !initialized || polls % FULL_SYNC_EVERY === 0 });
    } catch (err) {
      console.warn("Job Finder: reading #alert failed", err);
    }
    polls++;
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

// Reads #alert (everything, or what's newer than the last alert seen). Alerts not seen before are new.
// (One read at a time: a call while one runs waits for it, then reads again if it asked for everything.)
let reading = null;
export async function sync({ full = false } = {}) {
  while (reading) {
    await reading.catch(() => {});
    if (!full) return;
  }
  reading = read(full).finally(() => { reading = null; });
  return reading;
}

async function read(full) {
  const token = await getSlackToken();
  if (!token) return;
  if (missingAt && Date.now() - missingAt < MISSING_RETRY_MS && !full) return;
  let channelId;
  try {
    channelId = await findChannelId(token, CHANNEL);
    missingAt = 0;
  } catch (err) {
    // FAC creates #alert with its first alert: until then there's nothing to show (and its first alerts pop up).
    if (/not found/.test(err.message)) { missingAt = Date.now(); if (!initialized) { initialized = true; await save(); } return; }
    throw err;
  }
  const posts = await getHistory(token, channelId, full ? { max: 3000 } : { oldest: latestTs, max: 1000 });
  const parsed = posts.map(readPost).filter(a => a && !deleted.has(a.ts) && Number(a.ts) > clearedAt);
  const known = new Set(list.map(a => a.ts));
  const arrived = parsed.filter(a => !known.has(a.ts));
  // (On the very first read, what's already in #alert is shown but not popped up.)
  const announce = initialized ? arrived.filter(a => Number(a.ts) > Number(latestTs || 0)) : [];
  list = full ? parsed : [...arrived, ...list];
  list.sort((a, b) => Number(b.ts) - Number(a.ts));
  const present = new Set(list.map(a => a.ts));
  for (const ts of [...unread]) if (!present.has(ts)) unread.delete(ts);
  for (const a of arrived) if (dialogAccount?.label !== a.account) unread.add(a.ts);
  if (Number(list[0]?.ts || 0) > Number(latestTs || 0)) latestTs = list[0].ts;
  initialized = true;
  await save();
  if (announce.length) notify(announce);
  if (arrived.length || full) {
    onChange();
    if (dialogAccount) renderAlerts();
  }
}

// ---------- deleting ----------

// Deletes alerts here and their posts in #alert. Returns how many posts Slack wouldn't delete
// (posted by another Slack user); those still aren't shown here again.
export async function deleteAlerts(items) {
  if (!items.length) return 0;
  for (const a of items) { deleted.add(a.ts); unread.delete(a.ts); viewingNew.delete(a.ts); }
  const gone = new Set(items.map(a => a.ts));
  list = list.filter(a => !gone.has(a.ts));
  await save();
  onChange();
  renderAlerts();
  return removeFromSlack([...gone]);
}

// Accounts → Delete all: every alert, and every message in #alert.
export async function deleteAllAlerts() {
  await reading?.catch(() => {});
  clearedAt = Date.now() / 1000;
  list = [];
  unread.clear();
  viewingNew.clear();
  await save();
  onChange();
  renderAlerts();
  const token = await getSlackToken();
  let channelId;
  try {
    channelId = await findChannelId(token, CHANNEL);
  } catch (err) {
    if (/not found/.test(err.message)) return 0; // no #alert: nothing to delete
    throw err;
  }
  return removeFromSlack((await getHistory(token, channelId, { max: 100000 })).map(m => m.ts), channelId);
}

async function removeFromSlack(timestamps, channelId) {
  const token = await getSlackToken();
  if (!token || !timestamps.length) return 0;
  channelId ||= await findChannelId(token, CHANNEL);
  let failed = 0;
  for (const ts of timestamps) {
    try {
      await deleteMessage(token, channelId, ts);
    } catch (err) {
      if (err.message !== "message_not_found") failed++;
    }
  }
  return failed;
}

// FAC's post: a section "*✉ New message* — *name (label)*\n*Account:* label · Site\n*Badge:* 2 (was 1) · 10/28 15:40\n<url|Open on Site>".
function readPost(post) {
  const section = post.blocks?.find(b => b.type === "section")?.text?.text || "";
  const plain = s => (s || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim();
  const account = section.match(/^\*Account:\*\s*(.+?)\s*·\s*(\S+)\s*$/m);
  const kind = /New transaction/.test(section) ? "transaction" : /New message/.test(section) ? "message" : "";
  if (!account || !kind) return null;
  const badge = section.match(/^\*Badge:\*\s*(\d+)(?:\s*\(was (\d+)\))?(?:\s*·\s*(.+))?$/m);
  // A Coconala message also has "*From:* sender", "*Time:* 4分前", "*Unread:* 2" and ">message".
  const field = name => plain(section.match(new RegExp(`^\\*${name}:\\*\\s*(.*)$`, "m"))?.[1]);
  return {
    ts: post.ts,
    account: plain(account[1]),
    site: SITE_IDS[account[2]] || account[2].toLowerCase(),
    kind,
    count: Number(badge?.[1] || 0),
    before: Number(badge?.[2] || 0),
    time: field("Time") || plain(badge?.[3]),
    from: field("From"),
    unreadOnSite: Number(field("Unread") || 0),
    text: section.split("\n").filter(l => l.startsWith(">") || l.startsWith("&gt;")).map(l => plain(l.replace(/^(&gt;|>)/, ""))).join("\n"),
    url: section.match(/<(https?:\/\/[^|>]+)\|Open on [^>]*>/)?.[1] || ""
  };
}

// The pop-up: one group per platform, a line per alert ("account: sender — message", or "New message").
// Green, and it stays until it's clicked (bottom-right, so it never covers the new-jobs pop-up); alerts
// arriving meanwhile join it, so none is missed.
let showing = [];
onStickyAlertGone(() => { showing = []; });
function notify(arrived) {
  const nameOf = label => accountsLookup().find(a => a.label === label)?.name || label;
  const fresh = new Set(arrived.map(a => a.ts));
  showing = [...arrived, ...showing.filter(a => !fresh.has(a.ts))];
  const groups = Object.values(SITE_IDS).map(site => {
    const items = showing.filter(a => a.site === site);
    if (!items.length) return null;
    const kinds = new Set(items.map(a => a.kind));
    const noun = kinds.size === 2 ? "messages & transactions" : `${[...kinds][0]}${items.length === 1 ? "" : "s"}`;
    return {
      site,
      title: `${siteName(site)} — ${items.length} new ${noun}`,
      items: items.slice(0, 4).map(a => ({
        title: `${nameOf(a.account)}: ${[a.from, a.text.split("\n")[0]].filter(Boolean).join(" — ") || `New ${a.kind}`}`,
        category: KIND_TEXT[a.kind]
      }))
    };
  }).filter(Boolean);
  showAlert({ total: showing.length, groups, account: arrived[0]?.account || "", sticky: true, theme: "green", heading: "Job Finder — Accounts" });
}

// ---------- the account's alerts window ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
const fmtWhen = ts => new Date(Number(ts) * 1000).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const siteName = site => Object.keys(SITE_IDS).find(name => SITE_IDS[name] === site) || "the site";

let lastNote = "";                   // what the last deletion in the window came to

export function openAlerts(account) {
  dialogAccount = account;
  lastNote = "";
  const mine = list.filter(a => a.account === account.label);
  viewingNew = new Set(mine.filter(a => unread.has(a.ts)).map(a => a.ts));
  for (const a of mine) unread.delete(a.ts);
  save();
  onChange();
  $("alertDialog").hidden = false;
  $("alertDialog").querySelector(".bid-window").style.setProperty("--site", `var(--${account.site})`);
  renderAlerts();
}

function closeAlerts() {
  dialogAccount = null;
  $("alertDialog").hidden = true;
}

function renderAlerts() {
  const account = dialogAccount;
  if (!account) return;
  const mine = list.filter(a => a.account === account.label);

  const head = el("div", "bid-head");
  const title = el("div", "grow");
  const h = el("h2", "", `🔔 ${account.name || account.label}`);
  h.id = "alertTitle";
  const icon = el("img", "tag-icon");
  icon.src = chrome.runtime.getURL(`icons/site-${account.site}.png`);
  icon.alt = "";
  h.prepend(icon);
  title.append(h, el("div", "bid-job", `${account.label} · ${mine.length} alert${mine.length === 1 ? "" : "s"} in #${CHANNEL}`));
  const close = el("button", "icon", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close");
  close.addEventListener("click", closeAlerts);
  head.append(title, close);

  // A Lancers account: PACKAGE (the package input, package.js) and PORTFOLIO.
  const lancers = account.site === "lancers" ? el("div", "acct-actions") : null;
  if (lancers) {
    const pkg = el("button", "btn", "📦 PACKAGE");
    pkg.type = "button";
    pkg.title = "Enter a Lancers package (パッケージ出品) for this account";
    pkg.addEventListener("click", () => { closeAlerts(); openPackage(account); });
    const portfolio = el("button", "btn ghost", "🖼 PORTFOLIO");
    portfolio.type = "button";
    portfolio.title = "Enter a Lancers portfolio item (ポートフォリオ) for this account";
    portfolio.addEventListener("click", () => { closeAlerts(); openPortfolio(account); });
    lancers.append(pkg, portfolio);
  }

  const tools = el("div", "alert-tools");
  const refresh = el("button", "btn ghost", "↻ Refresh");
  refresh.type = "button";
  const status = el("span", "hint");
  refresh.addEventListener("click", async () => {
    status.textContent = `Reading #${CHANNEL}…`;
    await sync({ full: true }).then(() => { status.textContent = ""; }, err => { status.textContent = err.message; });
  });
  const removeAll = el("button", "btn ghost danger", "🗑 Delete all");
  removeAll.type = "button";
  removeAll.title = `Delete this account's alerts here and in #${CHANNEL}`;
  removeAll.disabled = !mine.length;
  removeAll.addEventListener("click", () => {
    if (!confirm(`Delete all ${mine.length} alert${mine.length === 1 ? "" : "s"} of ${account.label}?\n\nTheir messages in #${CHANNEL} are deleted too.`)) return;
    removeWithStatus(mine);
  });
  tools.append(refresh, removeAll, status);
  // (The window is redrawn at once without them; the status shows what Slack said.)
  const removeWithStatus = items => {
    lastNote = `Deleting ${items.length} message${items.length === 1 ? "" : "s"} in #${CHANNEL}…`;
    deleteAlerts(items).then(failed => { lastNote = failed ? `${failed} message${failed === 1 ? "" : "s"} in #${CHANNEL} couldn't be deleted (posted by another Slack user); not shown here any more.` : `Deleted from #${CHANNEL}.`; },
      err => { lastNote = `Deleted here, but not from #${CHANNEL}: ${err.message}`; })
      .then(() => { const hint = $("alertBody").querySelector(".alert-tools .hint"); if (hint) hint.textContent = lastNote; });
  };
  status.textContent = lastNote;

  const body = el("div", "bid-content alert-list");
  if (!mine.length) body.append(el("p", "empty", `No new messages or transactions for this account yet. Freelance Account Checker posts them to #${CHANNEL} when they arrive.`));
  for (const a of mine) {
    const item = el("article", `alert-item ${a.kind}${viewingNew.has(a.ts) ? " new" : ""}`);
    const top = el("div", "alert-top");
    top.append(el("span", `alert-kind ${a.kind}`, KIND_TEXT[a.kind]));
    if (viewingNew.has(a.ts)) top.append(el("span", "alert-new", "NEW"));
    const added = a.count - a.before;
    top.append(el("b", "alert-from", a.from || `New ${a.kind}${added > 1 ? ` ×${added}` : ""}`),
      el("span", "hint alert-when", a.time ? `${a.time} · ${fmtWhen(a.ts)}` : fmtWhen(a.ts)));
    const remove = el("button", "icon alert-delete", "🗑");
    remove.type = "button";
    remove.title = `Delete this alert here and in #${CHANNEL}`;
    remove.setAttribute("aria-label", "Delete this alert");
    remove.addEventListener("click", () => removeWithStatus([a]));
    top.append(remove);
    item.append(top);
    if (a.text) item.append(el("div", "alert-text", a.text));
    item.append(el("div", "hint", a.from ? `${a.unreadOnSite} unread in this conversation on ${siteName(a.site)}`
      : `Badge on ${siteName(a.site)}: ${a.count}${a.before ? ` (was ${a.before})` : ""}`));
    if (a.url) {
      const link = el("a", "alert-link", `Open on ${siteName(a.site)} ↗`);
      link.href = a.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      item.append(link);
    }
    body.append(item);
  }
  $("alertBody").replaceChildren(...[head, lancers, tools, body].filter(Boolean));
}
