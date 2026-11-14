// Slack features of Job Finder, working together with Freelance Account Checker (FAC):
//   Accounts page — "Check" reads #accounts (where FAC posts each signed-in account) and lists them;
//                   pictures can be set per account, accounts deleted, and "Request accounts" posts
//                   ACCOUNT REQUEST to #accounts, which makes every FAC post its accounts again.
//   BID           — in a job's detail window: pick one of your accounts on that platform (each shows
//                   its SUCCESS / FAILURE on this job), fill in the proposal, Confirm → an order
//                   starting with "SERVER" is posted to #lancers / #coconala / #crowdworks. The FAC
//                   signed in to that account submits it and posts Success / Failure back, which is
//                   watched for here. A job with a successful bid moves to "Bid completed". A job
//                   that has no proposal feature comes back as Unavailable ("proposal feature
//                   unavailable"), not as a failure.
//   DM            — next to BID: pick an account, write the message, Send → FAC sends it to the
//                   job's client and posts DM Success / DM Failure; the status shows here (inbox.js).
//                   CrowdWorks / Coconala DMs go to #crowdworks / #coconala, the others to #messages.
//   History page  — every bid and its outcome.
//   Settings      — the Slack token, and clearing every message from the channels.
import { parseHtml } from "./providers/common.js";
import { PROVIDERS } from "./providers/index.js";
import { getSlackToken, testSlackToken, findChannelId, getHistory, getReplies, postMessage, deleteMessage } from "./slack.js";
import { initAlerts, openAlerts, newAlerts, alertCount, alertsOf, latestAlert, totalNewAlerts, deleteAlerts, deleteAllAlerts, KIND_TEXT } from "./alerts.js";
import { initInbox, sendDm, dmsFor, dmState, onDmChange, forgetDm, DM_SITES, DM_CHANNELS, dmTarget, sentDms } from "./inbox.js";

const POLL_MS = 5000;
const SITE_CHECK_MS = 60000;          // a bid still proposing is looked for among the job's proposals on the site this often…
const SITE_CHECK_AFTER_MS = 60000;    // …from a minute after it was sent…
const SITE_CHECK_FOR_MS = 24 * 3600000; // …for a day
const REQUEST_WATCH_MS = 3 * 60000;   // after Request accounts, #accounts is re-read this long
const CHECK_LIMIT_MS = 20000;         // the Check button is never shown busy longer than this
const MAX_PROPOSAL_CHARS = 3000;
const ACCOUNT_CHANNEL = "accounts";
// Platforms FAC can submit proposals on, with the proposal page its order needs.
const BID_SITES = {
  lancers: { name: "Lancers", channel: "lancers", proposeUrl: id => `https://www.lancers.jp/work/propose_start/${id}` },
  coconala: { name: "Coconala", channel: "coconala", proposeUrl: id => `https://coconala.com/offers/add/${id}` },
  crowdworks: { name: "CrowdWorks", channel: "crowdworks", proposeUrl: id => `https://crowdworks.jp/proposals/new?job_offer_id=${id}` }
};
const ACCOUNT_SITES = [["lancers", "Lancers"], ["coconala", "Coconala"], ["crowdworks", "CrowdWorks"], ["workana", "Workana"]];
// The channels FAC's installer creates (its sites.js), cleared by "Clear Slack channels".
const CLEAR_CHANNELS = ["accounts", "lancers", "coconala", "crowdworks", "workana"];
const HOURS_CHOICES = [5, 10, 15, 20, 25, 30, 35, 40];

const $ = id => document.getElementById(id);
const jobKey = job => `${job.site}:${job.id}`;
const siteIconUrl = siteId => chrome.runtime.getURL(`icons/site-${siteId}.png`);
const siteName = siteId => ACCOUNT_SITES.find(([id]) => id === siteId)?.[1] || siteId;

let token = "";
let accounts = { at: 0, list: [] };   // from #accounts: [{ site, label, name, avatar, profileUrl, ts }]
let history = [];                     // every bid, newest first: { id, key, site, jobId, title, url, account, accountName,
                                      //   channel, orderTs, at, amount, mode, hours, date, text, status, reason, resultAt }
let completed = {};                   // job key → { at } once a bid on it succeeded ("Bid completed")
let jobSnapshots = {};                // job key → the job when it was bid on (Bid completed and History open it even after the list drops it)
let avatars = {};                     // account label → picture chosen on the Accounts page (data URL)
let hiddenAccounts = {};              // account label → Slack time it was deleted here; its older posts aren't shown
let accountsClearedAt = 0;            // Slack time of "Delete all"; older #accounts posts aren't shown
let templates = [];                   // saved proposal texts: [{ name, site, text }]
let lastAccount = {};                 // site → label last bid with (preselected next time)
const drafts = new Map();             // job key → what's typed in the BID form (kept while the window is closed)
const paymentChecks = new Map();      // CrowdWorks job key → { mode, source } read from the live job page
const historySelected = new Set();
let notifyChanged = () => {};
let openJob = () => {};
let findJob = () => null;
let goToPage = () => {};
let dialogJob = null;
let dialogStale = false;              // a redraw of the BID window waits while a text box is being typed in
let dmJob = null;                     // the job whose DM window is open
const dmDrafts = new Map();           // job key → { account, text } typed in the DM window

export async function initSlack({ onBidsChanged, openJob: open, showPage, findJob: find }) {
  notifyChanged = onBidsChanged;
  openJob = open;
  findJob = find || findJob;
  goToPage = showPage;
  token = await getSlackToken();
  const stored = await chrome.storage.local.get(["jfAccounts", "jfBids", "jfBidHistory", "jfCompleted", "jfBidJobs", "jfAvatars",
    "jfHiddenAccounts", "jfAccountsClearedAt", "jfTemplates", "jfLastBidAccount"]);
  accounts = stored.jfAccounts || accounts;
  history = stored.jfBidHistory || [];
  completed = stored.jfCompleted || {};
  jobSnapshots = stored.jfBidJobs || {};
  avatars = stored.jfAvatars || {};
  hiddenAccounts = stored.jfHiddenAccounts || {};
  accountsClearedAt = stored.jfAccountsClearedAt || 0;
  templates = stored.jfTemplates || [];
  lastAccount = stored.jfLastBidAccount || {};
  // Bids saved by 1.9.0 (one per job) become history entries.
  if (stored.jfBids) {
    for (const [key, bid] of Object.entries(stored.jfBids)) {
      history.push({ id: bid.orderTs, key, ...bid });
      if (bid.status === "success") completed[key] ||= { at: bid.resultAt || bid.at };
    }
    history.sort((a, b) => b.at - a.at);
    await chrome.storage.local.remove("jfBids");
    await saveBids();
  }

  bindAccountsPage();
  bindHistoryPage();
  bindSlackSettings();
  bindClearChannels();
  $("bidDialog").addEventListener("click", e => { if (e.target === $("bidDialog")) closeBidDialog(); });
  $("bidBody").addEventListener("focusout", () => setTimeout(() => { if (dialogStale && dialogJob) renderBidDialog(); }, 0));
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("bidDialog").hidden) closeBidDialog(); });
  $("dmDialog").addEventListener("click", e => { if (e.target === $("dmDialog")) closeDmDialog(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("dmDialog").hidden) closeDmDialog(); });

  // DMs to a job's client.
  await initInbox({ notify: toast });
  // A DM sent to a job's client counts as a bid on it (History, Bid completed).
  const adoptDms = async () => { if (adoptSentDms()) { await saveBids(); changed(); } };
  onDmChange(() => { adoptDms(); notifyChanged(); if (dmJob) renderDmDialog(); });
  await adoptDms();

  renderAccounts();
  renderHistory();
  notifyChanged();
  watchResults();
  // Each account's new messages / transactions from #alert (shown under the account).
  initAlerts({ changed: renderAccounts, accounts: () => accounts.list, showAccountsPage: () => showPage("accounts") });
}

async function saveBids() {
  // Another Job Finder window may have settled a bid since this one read it (and deleted its Slack
  // report, so this window can't find it); that result is kept rather than overwritten.
  const stored = await chrome.storage.local.get(["jfBidHistory", "jfCompleted"]);
  adoptSettled(stored.jfBidHistory, stored.jfCompleted);
  return chrome.storage.local.set({ jfBidHistory: history, jfCompleted: completed, jfBidJobs: jobSnapshots });
}

// Takes the results other windows saved for bids still "proposing" here. Returns whether any changed.
function adoptSettled(storedHistory = [], storedCompleted = {}) {
  const settled = new Map((storedHistory || []).filter(r => r.status !== "proposing").map(r => [r.id, r]));
  let any = false;
  for (const record of history) {
    const other = settled.get(record.id);
    if (record.status !== "proposing" || !other) continue;
    Object.assign(record, { status: other.status, reason: other.reason, resultAt: other.resultAt });
    if (other.status === "success") completed[record.key] ||= storedCompleted?.[record.key] || { at: other.resultAt };
    any = true;
  }
  return any;
}

// A result saved by another Job Finder window shows here at once.
chrome.storage.onChanged.addListener((change, area) => {
  if (area !== "local" || !change.jfBidHistory) return;
  if (adoptSettled(change.jfBidHistory.newValue, change.jfCompleted?.newValue)) changed();
});

// Each DM that went through becomes a successful bid in History (once), and its job moves to Bid
// completed. Returns whether any was added.
function adoptSentDms() {
  let any = false;
  for (const dm of sentDms()) {
    const id = `dm:${dm.id}`;
    if (history.some(r => r.id === id)) continue;
    const job = findJob(dm.key);
    const at = dm.resultAt || dm.at;
    history.push({
      id, key: dm.key, site: dm.site, jobId: String(dm.jobId || dm.key.split(":")[1] || ""), title: dm.title || job?.title || "",
      url: job?.url || dm.url, account: dm.account, accountName: dm.accountName, channel: "", orderTs: dm.id, at: dm.at,
      amount: 0, mode: "dm", hours: "", date: "", text: dm.text, status: "success", reason: "DM sent to the client", resultAt: at
    });
    completed[dm.key] ||= { at };
    if (job && !jobSnapshots[dm.key]) jobSnapshots[dm.key] = structuredClone(job);
    any = true;
  }
  if (any) history.sort((a, b) => b.at - a.at);
  return any;
}

// Something about bids or accounts changed: the job list, the open windows and History show it.
function changed() {
  notifyChanged();
  renderHistory();
  if (dialogJob) renderBidDialog();
}

// ---------- shared bits ----------

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
function siteIconImg(siteId) {
  const icon = el("img", "tag-icon");
  icon.src = siteIconUrl(siteId);
  icon.alt = siteName(siteId);
  icon.title = siteName(siteId);
  return icon;
}
const pictureOf = account => (account && (avatars[account.label] || account.avatar)) || "";
function avatarImg(url, alt = "") {
  const img = el("img", "acct-avatar");
  img.alt = url ? alt : ""; // (no picture: an empty circle, not the name as broken-image text)
  img.referrerPolicy = "no-referrer";
  if (url) img.src = url; else img.classList.add("none");
  img.addEventListener("error", () => { img.removeAttribute("src"); img.alt = ""; img.classList.add("none"); }, { once: true });
  return img;
}
const tsDate = ts => new Date(Number(ts) * 1000);
const slackNow = () => String(Date.now() / 1000);
const fmtWhen = d => d.toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const ago = ms => { const min = Math.round((Date.now() - ms) / 60000); return min < 1 ? "just now" : min < 60 ? `${min} min ago` : `${Math.round(min / 60)} h ago`; };
const normalize = s => (s || "").normalize("NFKC").toLowerCase();
const charCount = s => [...s].length;
// Slack message text escapes &, < and > (and Slack shows links as <url|label>).
const slackEscape = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const slackPlain = s => (s || "").replace(/<([^|>]+)\|([^>]+)>/g, "$2").replace(/<([^>]+)>/g, "$1")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

let toastTimer;
function toast(text, kind = "") {
  const box = $("jfToast");
  box.textContent = text;
  box.className = `jf-toast ${kind}`;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 8000);
}

const STATUS_MARKS = { proposing: "⏳ PROPOSING", success: "✅ SUCCESS", failure: "❌ FAILURE", unavailable: "🚫 PROPOSAL FEATURE UNAVAILABLE",
  sending: "⏳ SENDING DM", sent: "✅ DM SENT" };
const DM_STATUS_MARKS = { sending: "⏳ SENDING DM", sent: "✅ DM SENT", failure: "❌ DM FAILED", unavailable: "🚫 DM UNAVAILABLE" };
const statusChip = (status, record) => record?.mode === "dm" ? el("span", `status-chip ${status} dm`, "✉ DM SENT")
  : el("span", `status-chip ${status}`, STATUS_MARKS[status]);

// ---------- Settings: Slack token ----------

function bindSlackSettings() {
  const status = $("slackStatus");
  $("slackToken").value = token;
  status.textContent = token ? "A token is saved." : "Not connected.";
  $("slackForm").addEventListener("submit", async e => {
    e.preventDefault();
    const value = $("slackToken").value.trim();
    if (!value) return;
    status.className = "pw-message";
    status.textContent = "Testing…";
    try {
      const who = await testSlackToken(value);
      await chrome.storage.local.set({ jfSlackToken: value });
      token = value;
      status.className = "pw-message ok";
      status.textContent = `Connected as ${who.name}.`;
      renderAccounts();
      watchResults();
    } catch (err) {
      status.className = "pw-message bad";
      status.textContent = `Not saved: ${err.message}`;
    }
  });
  $("slackDisconnect").addEventListener("click", async () => {
    await chrome.storage.local.remove("jfSlackToken");
    token = "";
    $("slackToken").value = "";
    status.className = "pw-message";
    status.textContent = "Disconnected.";
    renderAccounts();
  });
}

// ---------- Accounts page ----------

function bindAccountsPage() {
  $("accountsCheck").addEventListener("click", () => checkAccounts());
  $("accountsRequest").addEventListener("click", requestAccounts);
  $("accountsDeleteAll").addEventListener("click", deleteAllAccounts);
}

// Reads every account FAC has posted to #accounts; the newest post of each account wins.
// Posts from before an account (or all of them) was deleted here are left out.
// One read runs at a time (Check, the Request accounts watch and the BID / DM windows share it). The
// Check button shows "Checking…" only for a Check pressed by you, and never longer than CHECK_LIMIT_MS:
// if Slack is that slow, the button comes back and the list updates whenever the answer arrives.
// A Check pressed while an earlier read has been stuck that long starts a fresh one (only the newest
// read's answer is used).
let checking = null;
let checkingSince = 0;
let readGen = 0;
let checkPressed = false;
async function checkAccounts({ quiet = false } = {}) {
  if (!token) { renderAccounts(); return false; }
  if (!checking || (!quiet && !checkPressed && Date.now() - checkingSince >= CHECK_LIMIT_MS)) {
    const run = readAccounts(++readGen).finally(() => { if (checking === run) checking = null; });
    checking = run;
    checkingSince = Date.now();
  }
  if (quiet) return checking;
  if (checkPressed) return checking;
  const btn = $("accountsCheck");
  checkPressed = true;
  btn.disabled = true;
  btn.textContent = "Checking…";
  setAccountsNote("Searching #accounts in Slack…");
  let limit;
  try {
    const slow = new Promise(resolve => { limit = setTimeout(() => resolve("slow"), CHECK_LIMIT_MS); });
    const result = await Promise.race([checking, slow]);
    if (result === "slow") setAccountsNote(`Slack is slow to answer — the list updates when it does. You can press Check again.`);
    return result === true;
  } finally {
    clearTimeout(limit);
    checkPressed = false;
    btn.textContent = "Check";
    btn.disabled = !token;
  }
}

async function readAccounts(gen) {
  try {
    const channelId = await findChannelId(token, ACCOUNT_CHANNEL);
    const seen = new Set();
    const list = [];
    const posts = await getHistory(token, channelId, { max: 2000 });
    if (gen !== readGen) return false; // a newer read was started meanwhile
    for (const message of posts) {
      const account = readAccountPost(message);
      if (!account || seen.has(account.label.toLowerCase())) continue;
      if (Number(account.ts) <= accountsClearedAt || Number(account.ts) <= Number(hiddenAccounts[account.label] || 0)) continue;
      seen.add(account.label.toLowerCase());
      list.push(account);
    }
    accounts = { at: Date.now(), list };
    await chrome.storage.local.set({ jfAccounts: accounts });
    renderAccounts();
    changed();
    return true;
  } catch (err) {
    if (gen === readGen) renderAccounts(`Couldn't read #${ACCOUNT_CHANNEL}: ${err.message}`);
    return false;
  }
}

// FAC's #accounts post: a section "*LANCERS*\n*Display name:* …\n*Account:* Lancers-123\n<url|Profile>"
// with the avatar as its picture.
function readAccountPost(message) {
  const section = message.blocks?.find(b => b.type === "section" && /\*Account:\*/.test(b.text?.text || ""));
  if (!section) return null;
  const text = section.text.text;
  const line = label => slackPlain(text.match(new RegExp(`\\*${label}:\\*\\s*(.*)`))?.[1] || "").trim();
  const label = line("Account");
  if (!label) return null;
  const platform = (text.match(/^\*([^*]+)\*\s*$/m)?.[1] || label.split("-")[0]).trim().toLowerCase();
  const site = ACCOUNT_SITES.find(([id, name]) => platform === name.toLowerCase() || platform === id)?.[0] || platform;
  const name = line("Display name");
  return {
    site,
    label,
    name: name === "(not found)" ? "" : name,
    avatar: section.accessory?.image_url || "",
    profileUrl: text.match(/<(https?:\/\/[^|>]+)\|Profile>/)?.[1] || "",
    ts: message.ts
  };
}

function setAccountsNote(text, isError = false) {
  const note = $("accountsStatus");
  note.className = `hint page-note${isError ? " error-text" : ""}`;
  note.textContent = text;
}

let requestNote = "";
function renderAccounts(error = "") {
  const box = $("accountsList");
  // New messages / transactions of all accounts, next to "Accounts" in the top menu.
  const waiting = totalNewAlerts();
  $("navAlertCount").hidden = !waiting;
  $("navAlertCount").textContent = String(waiting);
  $("navAlertCount").title = `${waiting} new message${waiting === 1 ? "" : "s"} / transaction${waiting === 1 ? "" : "s"}`;
  $("accountsCheck").disabled = !token || checkPressed;
  $("accountsRequest").disabled = !token;
  $("accountsDeleteAll").disabled = !token;
  if (!token) {
    setAccountsNote("");
    box.replaceChildren(el("p", "empty", "Connect Slack in Settings to see the accounts posted to #accounts."));
    return;
  }
  setAccountsNote(error || [accounts.at
    ? `Checked ${fmtWhen(new Date(accounts.at))} · ${accounts.list.length} account${accounts.list.length === 1 ? "" : "s"} in #${ACCOUNT_CHANNEL}`
    : "Press Check to read #accounts in Slack.", requestNote].filter(Boolean).join(" · "), !!error);
  if (!accounts.list.length) {
    box.replaceChildren(el("p", "empty", accounts.at ? "No accounts yet — press Request accounts to ask Freelance Account Checker to post them." : ""));
    return;
  }
  const groups = ACCOUNT_SITES.map(([id, name]) => [id, name, accounts.list.filter(a => a.site === id)])
    .concat([["", "Other", accounts.list.filter(a => !ACCOUNT_SITES.some(([id]) => id === a.site))]])
    .filter(([, , list]) => list.length);
  box.replaceChildren(...groups.map(([id, name, list]) => {
    const group = el("section", "acct-group");
    group.style.setProperty("--site", id ? `var(--${id})` : "var(--muted)");
    const head = el("h3", "acct-group-head");
    if (id) head.append(siteIconImg(id));
    head.append(name, el("span", "hint", `${list.length}`));
    const grid = el("div", "acct-grid");
    for (const account of list) grid.append(accountCard(account, { manage: true }));
    group.append(head, grid);
    return group;
  }));
}

// One account: its picture, name, label and profile link. On the Accounts page (`manage`) it also shows
// its new messages and transactions (from #alert), and selecting it lists them; its picture can be
// changed and the account deleted. In the BID and DM windows `mark` shows how its bid / DM on that job went.
function accountCard(account, { manage = false, mark = "", marks = STATUS_MARKS } = {}) {
  const card = el("div", "acct-card");
  if (manage) {
    card.classList.add("with-alerts");
    card.tabIndex = 0;
    card.title = "Select to see this account's new messages and transactions";
    card.addEventListener("click", e => { if (!e.target.closest("button, a")) openAlerts(account); });
    card.addEventListener("keydown", e => { if (e.key === "Enter" && e.target === card) openAlerts(account); });
  }
  let picture = avatarImg(pictureOf(account), account.name);
  if (manage) {
    const pick = el("button", "acct-avatar-btn");
    pick.type = "button";
    pick.title = "Click to choose a picture for this account";
    pick.setAttribute("aria-label", `Choose a picture for ${account.name || account.label}`);
    pick.append(picture, el("span", "acct-avatar-edit", "📷"));
    pick.addEventListener("click", () => choosePicture(account));
    picture = pick;
  }
  const text = el("div", "acct-text");
  const nameRow = el("div", "acct-name", account.name || account.label);
  if (mark) nameRow.append(" ", el("span", `status-chip ${mark}`, marks[mark]));
  text.append(nameRow, el("div", "acct-label", account.label));
  const meta = el("div", "hint", `Posted ${fmtWhen(tsDate(account.ts))}`);
  if (account.profileUrl) {
    const link = el("a", "", "Profile");
    link.href = account.profileUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    meta.append(" · ", link);
  }
  if (manage && avatars[account.label]) {
    meta.append(" · ", button("Reset picture", "link", async () => {
      delete avatars[account.label];
      await chrome.storage.local.set({ jfAvatars: avatars });
      renderAccounts();
      changed();
    }));
  }
  text.append(meta);
  if (manage) {
    // "✉ 2 new  ☑ 1 new", and the newest alert.
    const row = el("div", "acct-alerts");
    for (const kind of ["message", "transaction"]) {
      const n = newAlerts(account.label, kind);
      row.append(el("span", `acct-alert ${kind}${n ? " has-new" : ""}`, `${KIND_TEXT[kind].split(" ")[0]} ${n} new`));
    }
    text.append(row);
    const latest = latestAlert(account.label);
    if (latest) {
      // (A Coconala message shows its sender and message.)
      const what = [latest.from, latest.text?.split("\n")[0]].filter(Boolean).join(" — ") || KIND_TEXT[latest.kind];
      const line = el("div", "hint acct-latest", `Latest: ${latest.from ? `${KIND_TEXT[latest.kind].split(" ")[0]} ${what}` : what} · ${fmtWhen(tsDate(latest.ts))}` +
        ` · ${alertCount(account.label)} in all`);
      line.title = what;
      text.append(line);
    }
  }
  card.append(picture, text);
  if (manage) {
    const remove = button("🗑", "icon acct-delete", () => deleteAccount(account));
    remove.title = "Delete this account";
    remove.setAttribute("aria-label", `Delete ${account.label}`);
    card.append(remove);
  }
  return card;
}

// A picture chosen from this computer, cropped square and shrunk (kept only in this browser).
function choosePicture(account) {
  const input = el("input");
  input.type = "file";
  input.accept = "image/*";
  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const image = await createImageBitmap(file);
      const size = 160, side = Math.min(image.width, image.height);
      const canvas = Object.assign(document.createElement("canvas"), { width: size, height: size });
      canvas.getContext("2d").drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, size, size);
      avatars[account.label] = canvas.toDataURL("image/jpeg", 0.9);
      await chrome.storage.local.set({ jfAvatars: avatars });
      renderAccounts();
      changed();
    } catch {
      setAccountsNote("That file couldn't be read as a picture.", true);
    }
  });
  input.click();
}

// Removes an account from the list and deletes its posts in #accounts. If Slack can't delete them,
// they're still left out here; a newer post (e.g. after Request accounts) brings it back.
async function deleteAccount(account) {
  if (!confirm(`Delete ${account.name || account.label} (${account.label}) from Accounts?\n\nIts posts in #${ACCOUNT_CHANNEL} and its messages / transactions in #alert are deleted too. It comes back if Freelance Account Checker posts it again (Request accounts).`)) return;
  hiddenAccounts[account.label] = slackNow();
  accounts.list = accounts.list.filter(a => a !== account);
  await chrome.storage.local.set({ jfHiddenAccounts: hiddenAccounts, jfAccounts: accounts });
  renderAccounts();
  changed();
  const notes = [];
  try {
    const channelId = await findChannelId(token, ACCOUNT_CHANNEL);
    const posts = (await getHistory(token, channelId, { max: 5000 })).filter(m => readAccountPost(m)?.label === account.label);
    const failed = await deleteAll(channelId, posts.map(m => m.ts));
    if (failed) notes.push(`${failed} of its #${ACCOUNT_CHANNEL} posts couldn't be deleted (posted by another user)`);
  } catch (err) {
    notes.push(`not deleted from #${ACCOUNT_CHANNEL}: ${err.message}`);
  }
  try {
    const failed = await deleteAlerts(alertsOf(account.label));
    if (failed) notes.push(`${failed} of its #alert messages couldn't be deleted (posted by another user)`);
  } catch (err) {
    notes.push(`not deleted from #alert: ${err.message}`);
  }
  if (notes.length) setAccountsNote(`${account.label} deleted here; ${notes.join("; ")}.`, true);
}

async function deleteAllAccounts() {
  if (!accounts.list.length && !confirm(`Delete every message in #${ACCOUNT_CHANNEL} and #alert?`)) return;
  if (accounts.list.length && !confirm(`Delete all ${accounts.list.length} accounts?\n\nEvery message in #${ACCOUNT_CHANNEL} and every message / transaction in #alert are deleted too. Press Request accounts afterwards to have the accounts posted again.`)) return;
  accountsClearedAt = Number(slackNow());
  accounts = { at: Date.now(), list: [] };
  await chrome.storage.local.set({ jfAccountsClearedAt: accountsClearedAt, jfAccounts: accounts });
  renderAccounts();
  changed();
  setAccountsNote(`Deleting the messages in #${ACCOUNT_CHANNEL} and #alert…`);
  const notes = [];
  try {
    const channelId = await findChannelId(token, ACCOUNT_CHANNEL);
    const all = [];
    for (const message of await getHistory(token, channelId, { max: 100000 })) {
      if (message.reply_count) all.push(...(await getReplies(token, channelId, message.ts)).map(r => r.ts));
      all.push(message.ts);
    }
    const failed = await deleteAll(channelId, all);
    if (failed) notes.push(`${failed} message${failed === 1 ? "" : "s"} in #${ACCOUNT_CHANNEL} couldn't be deleted (posted by another user)`);
  } catch (err) {
    notes.push(`#${ACCOUNT_CHANNEL} not cleared in Slack: ${err.message}`);
  }
  try {
    const failed = await deleteAllAlerts();
    if (failed) notes.push(`${failed} message${failed === 1 ? "" : "s"} in #alert couldn't be deleted (posted by another user)`);
  } catch (err) {
    notes.push(`#alert not cleared in Slack: ${err.message}`);
  }
  setAccountsNote(notes.length ? `All accounts deleted here; ${notes.join("; ")}.` : `All accounts deleted, and #${ACCOUNT_CHANNEL} and #alert cleared in Slack.`, notes.length > 0);
}

// Deletes messages; returns how many Slack refused (someone else's messages).
async function deleteAll(channelId, timestamps, onProgress) {
  let failed = 0;
  for (const [i, ts] of timestamps.entries()) {
    onProgress?.(i);
    try {
      await deleteMessage(token, channelId, ts);
    } catch (err) {
      if (err.message !== "message_not_found") failed++;
    }
  }
  return failed;
}

// Posts ACCOUNT REQUEST to #accounts. Every FAC with a Slack token answers by checking its sign-ins
// and posting its accounts; #accounts is re-read every few seconds for a while to pick them up.
let requestTimer = null;
async function requestAccounts() {
  const btn = $("accountsRequest");
  btn.disabled = true;
  try {
    const channelId = await findChannelId(token, ACCOUNT_CHANNEL);
    await postMessage(token, channelId, "ACCOUNT REQUEST\nJob Finder asks every Freelance Account Checker to post the accounts signed in to its browser.");
  } catch (err) {
    setAccountsNote(`Request not sent: ${err.message}`, true);
    btn.disabled = !token;
    return;
  }
  const before = new Set(accounts.list.map(a => `${a.label}|${a.ts}`));
  const until = Date.now() + REQUEST_WATCH_MS;
  clearInterval(requestTimer);
  const tick = async () => {
    await checkAccounts({ quiet: true });
    const fresh = accounts.list.filter(a => !before.has(`${a.label}|${a.ts}`)).length;
    const done = Date.now() > until;
    requestNote = done
      ? `Request finished: ${fresh} account post${fresh === 1 ? "" : "s"} received`
      : `Requested — waiting for Freelance Account Checker… ${fresh} received so far`;
    if (done) { clearInterval(requestTimer); requestTimer = null; }
    renderAccounts();
  };
  requestNote = "Requested — waiting for Freelance Account Checker…";
  requestTimer = setInterval(tick, POLL_MS);
  renderAccounts();
}

// ---------- bids: state per job ----------

const recordsFor = k => history.filter(r => r.key === k);
const latestFor = (k, label) => history.find(r => r.key === k && r.account === label);
const accountsOn = siteId => accounts.list.filter(a => a.site === siteId);

function jobState(k) {
  const records = recordsFor(k);
  if (records.some(r => r.status === "proposing")) return "proposing";
  if (completed[k]) return "completed";
  if (records.some(r => r.status === "failure")) return "failure";
  if (records.some(r => r.status === "unavailable")) return "unavailable";
  return "";
}

// Accounts on the platform that can still bid on this job (no successful or pending bid with it yet),
// and the bids made on it.
function bidCounts(job) {
  const k = jobKey(job);
  const list = accountsOn(job.site);
  const states = list.map(a => latestFor(k, a.label)?.status || "");
  const records = recordsFor(k);
  return {
    total: list.length,
    available: states.filter(s => s !== "success" && s !== "proposing").length,
    placed: new Set(records.filter(r => r.status === "success").map(r => r.account)).size,
    proposing: records.filter(r => r.status === "proposing").length,
    failed: new Set(records.filter(r => r.status === "failure" && latestFor(k, r.account) === r).map(r => r.account)).size,
    unavailable: records.some(r => r.status === "unavailable" && latestFor(k, r.account) === r)
  };
}

export const isBidCompleted = k => !!completed[k];

// ---------- your own accounts among a job's bidders ----------

// The account on the Accounts page that a bidder is (null when it's someone else): the same profile
// (its ID in the bidder's profile link, e.g. coconala.com/users/123 for Coconala-123) or the same name.
export function ownAccountOf(site, bidder) {
  const sameName = (a, b) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
  const pathParts = url => { try { return new URL(url).pathname.split("/").filter(Boolean); } catch { return []; } };
  const bidderParts = pathParts(bidder.url || "");
  return accounts.list.find(account => {
    if (account.site !== site) return false;
    const id = account.label.slice(account.label.indexOf("-") + 1);
    if (bidder.url && account.profileUrl && bidder.url.replace(/\/+$/, "") === account.profileUrl.replace(/\/+$/, "")) return true;
    if (id && bidderParts.includes(id)) return true;
    return sameName(bidder.name, account.name) || sameName(bidder.name, id);
  }) || null;
}

// Your accounts whose proposal on this job went through (Success in History): their labels.
// (A DM isn't one of the site's proposals, so it's not taken off the site's proposal count.)
export const ownBidLabels = job => [...new Set(history.filter(r => r.key === jobKey(job) && r.status === "success" && r.mode !== "dm").map(r => r.account))];

// Your accounts that bid on this job — a proposal that went through, or a DM sent — for the job's
// bidder list, so they show there even before the site lists them: [{ label, name, avatar, at, dm }].
export function ownBidEntries(job) {
  const entries = new Map();
  for (const r of history) {
    if (r.key !== jobKey(job) || r.status !== "success") continue;
    const found = entries.get(r.account);
    if (found && !found.dm) continue; // (a proposal is shown rather than a DM)
    const account = accounts.list.find(a => a.label === r.account);
    entries.set(r.account, { label: r.account, name: r.accountName || account?.name || r.account, avatar: pictureOf(account), at: r.resultAt || r.at, dm: r.mode === "dm" });
  }
  return [...entries.values()];
}

// The platform's proposal form for this job (null where Job Finder doesn't bid).
export const proposalPageUrl = job => BID_SITES[job.site]?.proposeUrl(job.id) || null;

// Shows where an account's proposal on this job is: its entry in History (found and highlighted), or
// — when it wasn't sent from Job Finder — the job's BID window, which marks each account's bid.
export function showProposal(job, account) {
  const record = history.find(r => r.key === jobKey(job) && r.account === account.label);
  if (!record) { openBidDialog(job); return; }
  goToPage("history");
  $("historySearch").value = `${record.jobId} ${record.account}`;
  $("historyStatus").value = "";
  $("historySite").value = "";
  renderHistory();
  const row = $("historyList").querySelector(`[data-id="${CSS.escape(String(record.id))}"]`);
  if (row) {
    row.scrollIntoView({ block: "center" });
    row.classList.add("highlight");
    row.focus({ preventScroll: true });
    setTimeout(() => row.classList.remove("highlight"), 4000);
  }
}

// Jobs with a successful bid, newest first, each as it was when bid on.
export function completedEntries() {
  return Object.entries(completed)
    .map(([key, { at }]) => ({ key, at, job: jobSnapshots[key] }))
    .filter(entry => entry.job)
    .sort((a, b) => b.at - a.at);
}

// Removes jobs from Bid completed (their bids stay in History).
export async function dismissCompleted(keys) {
  for (const k of keys) delete completed[k];
  pruneSnapshots();
  await saveBids();
}

// The job as it was when bid on (for jobs the list no longer has).
export const bidJobSnapshot = k => jobSnapshots[k];

// A job's copy is kept while History or Bid completed still refers to it.
function pruneSnapshots() {
  for (const k of Object.keys(jobSnapshots)) if (!completed[k] && !history.some(r => r.key === k)) delete jobSnapshots[k];
}

// What a card shows about bids, for the list's "has this card changed?" check.
export function bidSignature(job) {
  const dm = dmState(jobKey(job));
  if (!BID_SITES[job.site]) return dm;
  const c = bidCounts(job);
  return `${jobState(jobKey(job))}|${c.total}|${c.available}|${c.placed}|${c.proposing}|${c.failed}|${c.unavailable}|${dm}`;
}

const JOB_MARKS = { proposing: "⏳ Proposing…", completed: "✅ BID COMPLETED", failure: "❌ Bid failed", unavailable: "🚫 Proposal feature unavailable" };

export function bidTag(job) {
  if (!BID_SITES[job.site]) return null;
  const state = jobState(jobKey(job));
  return state ? el("span", `tag bid ${state}`, JOB_MARKS[state]) : null;
}

// "👤 2 / 3 accounts available · 💼 1 bid placed" — on every Lancers / Coconala / CrowdWorks card.
export function bidStats(job) {
  if (!BID_SITES[job.site]) return null;
  const c = bidCounts(job);
  const box = el("div", "bid-stats");
  const chip = (text, className, title) => { const s = el("span", `bid-chip ${className}`, text); s.title = title; box.append(s); };
  chip(`👤 ${c.available} / ${c.total} account${c.total === 1 ? "" : "s"} available`, c.available ? "avail" : "none",
    `${siteName(job.site)} accounts in #accounts that haven't bid on this job yet`);
  chip(`💼 ${c.placed} bid${c.placed === 1 ? "" : "s"} placed`, c.placed ? "placed" : "zero", "Successful bids on this job with your accounts");
  if (c.proposing) chip(`⏳ ${c.proposing} proposing`, "proposing", "Waiting for Freelance Account Checker's result");
  if (c.failed) chip(`❌ ${c.failed} failed`, "failure", "Accounts whose last bid on this job failed");
  if (c.unavailable) chip("🚫 proposal feature unavailable", "unavailable", "This job has no proposal feature (closed, ended, or a kind that takes no proposals) — not counted as a failure");
  const dm = dmState(jobKey(job));
  if (dm) chip(DM_STATUS_MARKS[dm], `dm ${dm}`, "Direct message to this job's client");
  return box;
}

export function bidButton(job) {
  if (!BID_SITES[job.site]) return null;
  const state = jobState(jobKey(job));
  const labels = { proposing: "⏳ Proposing…", completed: "✅ Bid completed", failure: "❌ Bid failed", unavailable: "🚫 Proposal unavailable" };
  const b = button(labels[state] || "💼 BID", `bid-btn ${state}`, () => openBidDialog(job));
  b.title = state ? "Click to see the bids or bid with another account" : "Choose an account and send a proposal through Slack";
  return b;
}

// ---------- DM to the client ----------

export function dmButton(job) {
  if (!DM_SITES.includes(job.site)) return null;
  const state = dmState(jobKey(job));
  const labels = { sending: "⏳ DM sending…", sent: "✅ DM sent", failure: "❌ DM failed", unavailable: "🚫 DM unavailable" };
  const b = button(labels[state] || "✉ DM", `bid-btn dm ${state}`, () => openDmDialog(job));
  b.title = state ? "Click to see the DMs or send another one" : "Send a direct message to this job's client through Slack";
  return b;
}

function openDmDialog(job) {
  dmJob = job;
  $("dmDialog").hidden = false;
  $("dmDialog").querySelector(".bid-window").style.setProperty("--site", `var(--${job.site})`);
  renderDmDialog();
  if (token && !accounts.at) checkAccounts();
}

function closeDmDialog() {
  dmJob = null;
  $("dmDialog").hidden = true;
}

function renderDmDialog() {
  const job = dmJob;
  if (!job) return;
  const k = jobKey(job);
  if (!dmDrafts.has(k)) dmDrafts.set(k, { account: lastAccount[job.site] || "", text: "" });
  const draft = dmDrafts.get(k);
  // Typing isn't interrupted by status updates: the box keeps its text and focus.
  const active = document.activeElement;
  const typing = active?.classList.contains("dm-text") ? { start: active.selectionStart, end: active.selectionEnd } : null;

  const head = el("div", "bid-head");
  const title = el("div", "grow");
  const h = el("h2", "", "✉ DM to the client");
  h.id = "dmTitle";
  h.prepend(siteIconImg(job.site));
  title.append(h, el("div", "bid-job", job.title));
  if (job.client?.name) title.append(el("div", "hint", `Client: ${job.client.name}`));
  const close = button("×", "icon", closeDmDialog);
  close.setAttribute("aria-label", "Close");
  head.append(title, close);

  const body = el("div", "bid-content");
  if (!token) {
    body.append(el("p", "empty", "Connect Slack in Settings first (the same token as Freelance Account Checker)."));
    $("dmBody").replaceChildren(head, body);
    return;
  }

  // DMs sent about this job, newest first.
  const sent = dmsFor(k);
  if (sent.length) {
    const box = el("div", "bid-records");
    box.append(el("h3", "bid-step", "DMs on this job"));
    for (const d of sent) {
      const account = accounts.list.find(a => a.label === d.account);
      const row = el("div", `bid-record dm-record ${d.status}`);
      const who = el("div", "bid-record-who");
      who.append(avatarImg(pictureOf(account), d.accountName), el("b", "", d.accountName || d.account), el("span", "hint", d.accountName ? d.account : ""));
      row.append(who, el("span", `status-chip ${d.status}`, DM_STATUS_MARKS[d.status]),
        el("span", "hint", d.status === "sending" ? `sent ${ago(d.at)}` : fmtWhen(new Date(d.resultAt || d.at))));
      if (d.status !== "sending") {
        row.append(button("Remove", "link", () => forgetDm(d.id)));
      }
      row.append(el("div", "bid-sent-text", d.text));
      if (d.reason) row.append(el("div", "bid-reason", d.reason));
      box.append(row);
    }
    body.append(box);
  }

  // 1. Account, 2. message (the input box and Send appear once an account is chosen).
  const list = accountsOn(job.site);
  const stepHead = el("h3", "bid-step", `1. Send as (${siteName(job.site)} account)`);
  stepHead.append(button("↻ Check #accounts", "link", () => checkAccounts()));
  body.append(stepHead);
  if (!accounts.at) body.append(el("p", "loading", "Reading #accounts…"));
  else if (!list.length) body.append(el("p", "hint", `No ${siteName(job.site)} accounts in #accounts yet. Use Accounts → Request accounts to have Freelance Account Checker post them.`));
  else {
    const grid = el("div", "acct-grid pick");
    for (const account of list) {
      const latest = sent.find(d => d.account === account.label);
      const card = accountCard(account, { mark: latest?.status || "", marks: DM_STATUS_MARKS });
      card.classList.add("pickable");
      card.tabIndex = 0;
      card.setAttribute("role", "radio");
      card.setAttribute("aria-checked", String(draft.account === account.label));
      const pick = () => { draft.account = account.label; renderDmDialog(); };
      card.addEventListener("click", e => { if (!e.target.closest("a")) pick(); });
      card.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
      grid.append(card);
    }
    body.append(grid);
  }

  if (list.some(a => a.label === draft.account)) {
    const form = el("form", "bid-form");
    form.noValidate = true;
    const textarea = el("textarea", "bid-text dm-text");
    textarea.rows = 7;
    textarea.placeholder = "メッセージを入力してください";
    textarea.value = draft.text;
    const counter = el("span", "char-count");
    const sendBtn = el("button", "btn", "Send");
    sendBtn.type = "submit";
    const update = () => {
      counter.textContent = `${charCount(draft.text.trim()).toLocaleString()} characters`;
      sendBtn.disabled = !draft.text.trim() || !!dmTarget(job).error;
    };
    textarea.addEventListener("input", () => { draft.text = textarea.value; update(); });
    const field = el("label", "bid-field");
    field.append(el("span", "", "2. Message"), textarea, counter);
    const error = el("p", "error-text");
    error.hidden = true;
    const actions = el("div", "bid-actions");
    actions.append(button("Cancel", "btn ghost", closeDmDialog), sendBtn);
    const target = dmTarget(job);
    const how = {
      crowdworks: `opens ${target.url}, enters it in the job's 相談 box and sends it`,
      coconala: `opens the client's page${target.url ? ` (${target.url})` : ""}, presses メッセージを送る, enters it and presses メッセージを送信`
    }[job.site] || "opens the client's message window, enters it and presses 送信";
    form.append(field, el("p", "hint", `Posted to #${DM_CHANNELS[job.site] || "messages"}; the Freelance Account Checker signed in to ${draft.account} ${how}, then posts DM Success / DM Failure.`), error, actions);
    update();
    if (target.error) {
      error.textContent = target.error;
      error.hidden = false;
    }
    form.addEventListener("submit", async e => {
      e.preventDefault();
      const text = draft.text.trim();
      const { url, error: notReady } = dmTarget(job);
      if (!text || notReady) return;
      sendBtn.disabled = true;
      sendBtn.textContent = "Sending…";
      try {
        const account = accounts.list.find(a => a.label === draft.account);
        await sendDm({ key: k, site: job.site, jobId: String(job.id), title: job.title, account: draft.account,
          accountName: account?.name || "", url, text });
        lastAccount[job.site] = draft.account;
        await chrome.storage.local.set({ jfLastBidAccount: lastAccount });
        draft.text = "";
        renderDmDialog();
      } catch (err) {
        error.textContent = `Not sent: ${err.message}`;
        error.hidden = false;
        sendBtn.disabled = false;
        sendBtn.textContent = "Send";
      }
    });
    body.append(form);
  }
  $("dmBody").replaceChildren(head, body);
  if (typing) {
    const box = $("dmBody").querySelector(".dm-text");
    if (box) { box.focus(); box.setSelectionRange(typing.start, typing.end); }
  }
}

// ---------- BID dialog ----------

function openBidDialog(job) {
  dialogJob = job;
  $("bidDialog").hidden = false;
  $("bidDialog").querySelector(".bid-window").style.setProperty("--site", `var(--${job.site})`);
  renderBidDialog();
  // The account list comes from #accounts; read it the first time.
  if (token && !accounts.at) checkAccounts();
  if (job.site === "crowdworks") checkCrowdworksPayment(job);
}

function closeBidDialog() {
  dialogJob = null;
  $("bidDialog").hidden = true;
}

// CrowdWorks: fixed price (固定報酬制) or hourly (時間単価制), from the best information at hand —
// the job page itself, then the listing, then the wording of the job.
function crowdworksPayment(job) {
  const live = paymentChecks.get(jobKey(job));
  if (live) return live;
  const row = job.rows?.find(([label]) => label === "Payment type")?.[1];
  if (row === "Hourly") return { mode: "hourly", source: "時間単価制 on the job page" };
  if (row === "Fixed price" || row === "Competition") return { mode: "fixed", source: "固定報酬制 on the job page" };
  if (row === "Task") return { mode: "fixed", source: "タスク on the job page", task: true };
  if (job.budgetType === "hourly") return { mode: "hourly", source: "時間単価制 in the job listing" };
  if (job.budgetType === "fixed") return { mode: "fixed", source: "固定報酬制 in the job listing" };
  if (job.budgetType === "task") return { mode: "fixed", source: "タスク in the job listing", task: true };
  if (/時間単価|時給/.test(`${job.title} ${job.description || ""}`)) return { mode: "hourly", source: "the job's wording (時給 / 時間単価)" };
  return { mode: "fixed", source: "no payment type found — fixed price assumed" };
}

// Reads the payment type straight from the CrowdWorks job page (the first row of its summary table).
async function checkCrowdworksPayment(job) {
  const k = jobKey(job);
  if (paymentChecks.has(k)) return;
  try {
    const res = await fetch(`https://crowdworks.jp/public/jobs/${job.id}`, { credentials: "include", cache: "no-store" });
    const doc = parseHtml(await res.text());
    const type = doc.querySelector("table.cw-table.summary tr th")?.textContent.trim() || "";
    const found = /時間単価/.test(type) ? { mode: "hourly", source: "時間単価制 on the job page (just checked)" }
      : /固定報酬|コンペ/.test(type) ? { mode: "fixed", source: "固定報酬制 on the job page (just checked)" }
      : /タスク/.test(type) ? { mode: "fixed", source: "タスク on the job page (just checked)", task: true } : null;
    if (!found) return;
    paymentChecks.set(k, found);
    const draft = drafts.get(k);
    if (draft && !draft.modeChosen) draft.mode = found.mode;
    if (dialogJob && jobKey(dialogJob) === k) renderBidDialog();
  } catch { /* the job listing's information is used */ }
}

function draftFor(job) {
  const k = jobKey(job);
  if (!drafts.has(k)) {
    const yen = job.currency !== "USD";
    drafts.set(k, {
      account: lastAccount[job.site] || "",
      mode: job.site === "crowdworks" ? crowdworksPayment(job).mode : "fixed",
      modeChosen: false,
      amount: yen ? String(job.budgetMax || job.budgetMin || "") : "",
      date: defaultDate(job),
      hours: "10",
      text: ""
    });
  }
  return drafts.get(k);
}

// The client's 希望納期 when it's still ahead, otherwise a week from today.
function defaultDate(job) {
  const wanted = job.deliveryDate ? new Date(job.deliveryDate) : null;
  const date = wanted && !isNaN(wanted) && wanted > Date.now() ? wanted : new Date(Date.now() + 7 * 864e5);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function renderBidDialog() {
  const job = dialogJob;
  if (!job) return;
  const site = BID_SITES[job.site];
  const k = jobKey(job);
  // Typing in the form isn't interrupted by results arriving: the window is redrawn once the
  // text box is left (see initSlack).
  const active = document.activeElement;
  dialogStale = !!active && $("bidBody").contains(active) && /^(TEXTAREA|INPUT)$/.test(active.tagName) && active.type !== "checkbox";
  if (dialogStale) return;

  const head = el("div", "bid-head");
  const title = el("div", "grow");
  const h = el("h2", "", "BID");
  h.id = "bidTitle";
  h.prepend(siteIconImg(job.site));
  if (completed[k]) h.append(el("span", "tag bid completed", "✅ BID COMPLETED"));
  title.append(h, el("div", "bid-job", job.title));
  const close = button("×", "icon", closeBidDialog);
  close.setAttribute("aria-label", "Close");
  head.append(title, close);

  const body = el("div", "bid-content");
  if (!token) {
    body.append(el("p", "empty", "Connect Slack in Settings first (the same token as Freelance Account Checker)."));
    $("bidBody").replaceChildren(head, body);
    return;
  }
  const records = recordsFor(k);
  if (records.length) body.append(bidsOnJob(records, draftFor(job)));
  body.append(...accountStep(job, site));

  // The chosen account's proposal on this job (the clicked bid, or its latest), then — unless it
  // succeeded or is still waiting — the form for a new one.
  const draft = draftFor(job);
  const chosen = accounts.list.find(a => a.label === draft.account && a.site === job.site);
  const latest = chosen && latestFor(k, chosen.label);
  const shown = chosen && (records.find(r => r.id === draft.viewRecord && r.account === chosen.label) || latest);
  if (shown) body.append(submittedProposal(job, shown, draft));
  // (A DM counts as a bid, but a proposal can still be sent with the same account.)
  const latestBid = chosen && history.find(r => r.key === k && r.account === chosen.label && r.mode !== "dm");
  if (chosen && latestBid?.status !== "proposing" && latestBid?.status !== "success") body.append(proposalForm(job, site, draft));
  $("bidBody").replaceChildren(head, body);
}

// What was submitted with an account: amount, date or hours, 提案文, and how it went.
function submittedProposal(job, record, draft) {
  const box = el("section", `bid-submitted ${record.status}`);
  const dm = record.mode === "dm";
  const title = el("h3", "bid-step", `${dm ? "DM" : "Proposal"} sent with ${record.accountName || record.account}`);
  title.append(statusChip(record.status, record));
  box.append(title);
  if (dm) {
    box.append(el("p", "bid-note", "Sent as a DM to the client — counted as a bid on this job. The form below still sends a proposal with this account."),
      el("dl", "bid-facts"), el("div", "bid-field-label", "メッセージ"), el("div", "bid-sent-text", record.text || ""));
    box.querySelector(".bid-facts").append(el("dt", "", "Sent"), el("dd", "", fmtWhen(new Date(record.resultAt || record.at))));
    return box;
  }
  const notes = {
    proposing: "Waiting for Freelance Account Checker's result. Choose another account to bid with it too.",
    success: "Submitted. This account has already bid on this job — choose another account to bid again.",
    failure: "This attempt failed. The form below sends a new one.",
    unavailable: "Proposal feature unavailable: this job takes no proposals (it's closed or ended, or it's a kind without proposals). Nothing was sent, and it isn't counted as a failure."
  };
  box.append(el("p", "bid-note", notes[record.status]));
  const hourly = record.mode === "hourly";
  const amountLabel = hourly ? "時間単価" : record.site === "coconala" ? "提案金額" : "契約金額";
  const facts = [
    ["Sent", fmtWhen(new Date(record.at))],
    record.resultAt && [record.status === "success" ? "Submitted" : "Result", fmtWhen(new Date(record.resultAt))],
    record.amount && [amountLabel, `¥${record.amount.toLocaleString()}${hourly ? " / hour" : ""}`],
    hourly && record.hours && ["稼働時間 / 週", `${record.hours} 時間`],
    !hourly && record.date && [record.site === "coconala" ? "お届け予定日" : "完了予定日", record.date.replace(/^(\d+)-0?(\d+)-0?(\d+)$/, "$1年$2月$3日")],
    record.site === "crowdworks" && ["支払い方式", hourly ? "時間単価制" : "固定報酬制"]
  ].filter(Boolean);
  const grid = el("dl", "bid-facts");
  for (const [label, value] of facts) grid.append(el("dt", "", label), el("dd", "", value));
  box.append(grid);
  box.append(el("div", "bid-field-label", "提案文"),
    record.text ? el("div", "bid-sent-text", record.text) : el("p", "hint", "The text of this proposal wasn't recorded (sent before Job Finder 1.11)."));
  if (record.reason) box.append(el("div", "bid-reason", record.reason));
  if ((record.status === "failure" || record.status === "unavailable") && record.text) {
    const actions = el("div", "bid-actions");
    actions.append(button("Use this proposal in the form", "btn ghost", () => {
      Object.assign(draft, { amount: String(record.amount || ""), text: record.text, ...(record.date && { date: record.date }),
        ...(record.hours && { hours: record.hours }), ...(record.site === "crowdworks" && { mode: record.mode, modeChosen: true }) });
      renderBidDialog();
    }));
    box.append(actions);
  }
  return box;
}

// The bids already made on this job, with their outcome. Clicking one shows what was sent.
function bidsOnJob(records, draft) {
  const box = el("div", "bid-records");
  box.append(el("h3", "bid-step", "Bids on this job"));
  for (const record of records) {
    const account = accounts.list.find(a => a.label === record.account);
    const row = el("div", `bid-record ${record.status}`);
    row.tabIndex = 0;
    row.title = "Click to see the proposal that was sent";
    const show = () => { draft.account = record.account; draft.viewRecord = record.id; renderBidDialog(); };
    row.addEventListener("click", e => { if (!e.target.closest("button, a")) show(); });
    row.addEventListener("keydown", e => { if (e.key === "Enter" && e.target === row) show(); });
    if (draft.viewRecord === record.id) row.classList.add("viewing");
    const who = el("div", "bid-record-who");
    who.append(avatarImg(pictureOf(account) , record.accountName), el("b", "", record.accountName || record.account), el("span", "hint", record.accountName ? record.account : ""));
    const when = record.status === "proposing" ? `sent ${ago(record.at)}` : `${fmtWhen(new Date(record.resultAt || record.at))}`;
    row.append(who, statusChip(record.status, record), el("span", "hint", when));
    if (record.status === "proposing") {
      row.append(button("Stop waiting", "link", async () => {
        if (!confirm("Stop watching Slack for this bid's result? (The order already sent is not withdrawn.)")) return;
        history = history.filter(r => r !== record);
        pruneSnapshots();
        await saveBids();
        changed();
      }));
    }
    if (record.reason) row.append(el("div", "bid-reason", record.reason));
    box.append(row);
  }
  return box;
}

// Step 1: the accounts on this job's platform (from #accounts), each with its result on this job.
function accountStep(job, site) {
  const k = jobKey(job);
  const draft = draftFor(job);
  const list = accountsOn(job.site);
  const head = el("h3", "bid-step", `1. Account on ${site.name}`);
  head.append(button("↻ Check #accounts", "link", () => checkAccounts()));
  if (!accounts.at) return [head, el("p", "loading", "Reading #accounts…")];
  if (!list.length) return [head, el("p", "hint", `No ${site.name} accounts in #accounts yet. Use Accounts → Request accounts to have Freelance Account Checker post them.`)];
  const grid = el("div", "acct-grid pick");
  for (const account of list) {
    const card = accountCard(account, { mark: latestFor(k, account.label)?.status || "" });
    card.classList.add("pickable");
    card.tabIndex = 0;
    card.setAttribute("role", "radio");
    card.setAttribute("aria-checked", String(draft.account === account.label));
    // (Every account stays clickable: one that already bid shows the proposal it sent.)
    const pick = () => { draft.account = account.label; draft.viewRecord = ""; renderBidDialog(); };
    card.addEventListener("click", e => { if (!e.target.closest("a")) pick(); });
    card.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
    grid.append(card);
  }
  return [head, grid];
}

// Step 2: what the platform's proposal form needs, then Confirm.
function proposalForm(job, site, draft) {
  const form = el("form", "bid-form");
  form.noValidate = true;
  const field = (label, input, hint) => {
    const wrap = el("label", "bid-field");
    wrap.append(el("span", "", label), input);
    if (hint) wrap.append(el("span", "hint", hint));
    return wrap;
  };
  const input = (type, prop, attrs = {}) => {
    const node = el("input");
    node.type = type;
    node.value = draft[prop];
    Object.assign(node, attrs);
    node.addEventListener("input", () => { draft[prop] = node.value; updatePreview(); });
    return node;
  };
  const select = (prop, options, onChange) => {
    const node = el("select");
    for (const [value, label] of options) node.append(new Option(label, value, false, String(draft[prop]) === String(value)));
    node.addEventListener("change", () => { draft[prop] = node.value; onChange ? onChange() : updatePreview(); });
    return node;
  };

  const warnings = [];
  if (job.closed === true || (job.closesAt && Date.parse(job.closesAt) < Date.now())) warnings.push("This job is closed — the proposal will most likely fail.");
  const payment = job.site === "crowdworks" ? crowdworksPayment(job) : null;
  if (job.budgetType === "task" || payment?.task) warnings.push("This looks like a task (タスク) job, which doesn't take proposals.");
  const budget = budgetHint(job);

  const fields = [el("h3", "bid-step", "2. Proposal")];
  const row = el("div", "bid-row");
  if (payment) {
    const mode = select("mode", [["fixed", "固定報酬制 (fixed price)"], ["hourly", "時間単価制 (hourly)"]], () => { draft.modeChosen = true; renderBidDialog(); });
    const detected = payment.mode === draft.mode ? `Detected: ${payment.source}` : `Changed by you — detected ${payment.mode === "hourly" ? "時間単価制" : "固定報酬制"} (${payment.source})`;
    row.append(field("支払い方式", mode, detected));
  }
  const hourly = job.site === "crowdworks" && draft.mode === "hourly";
  const amountLabel = hourly ? "時間単価 (円/時, 税抜)" : job.site === "coconala" ? "提案金額 (円)" : "契約金額 (円, 税抜)";
  row.append(field(amountLabel, input("number", "amount", { min: 1, step: hourly ? 50 : 500, required: true }), budget && `Budget: ${budget}`));
  if (hourly) {
    row.append(field("稼働時間 / 週", select("hours", HOURS_CHOICES.map(h => [String(h), `${h} 時間`]))));
  } else {
    const dateLabel = job.site === "coconala" ? "お届け予定日" : "完了予定日";
    const optional = job.site === "crowdworks";
    row.append(field(`${dateLabel}${optional ? " (optional)" : ""}`, input("date", "date", { required: !optional })));
  }
  fields.push(row);

  // 提案文 with a live count against the 3,000-character limit.
  const textarea = el("textarea", "bid-text");
  textarea.rows = 10;
  textarea.value = draft.text;
  textarea.placeholder = "提案文 — your message to the client";
  const counter = el("span", "char-count");
  const updateCounter = () => {
    const n = charCount(draft.text.trim());
    counter.textContent = `${n.toLocaleString()} / ${MAX_PROPOSAL_CHARS.toLocaleString()} characters`;
    counter.classList.toggle("over", n > MAX_PROPOSAL_CHARS);
    textarea.classList.toggle("over", n > MAX_PROPOSAL_CHARS);
  };
  textarea.addEventListener("input", () => { draft.text = textarea.value; updateCounter(); updatePreview(); });
  const textField = field("提案文", textarea);
  textField.append(counter);

  // Templates: saved proposal texts for this platform (or for all).
  const usable = templates.map((t, i) => [t, i]).filter(([t]) => !t.site || t.site === job.site);
  const tools = el("div", "bid-tools");
  const pickTemplate = el("select");
  pickTemplate.append(new Option(usable.length ? "Insert template…" : "No templates yet", ""));
  for (const [t, i] of usable) pickTemplate.append(new Option(`${t.name}${t.site ? "" : " (all platforms)"}`, String(i)));
  pickTemplate.disabled = !usable.length;
  pickTemplate.addEventListener("change", () => {
    const t = templates[Number(pickTemplate.value)];
    pickTemplate.value = "";
    if (!t || (draft.text.trim() && !confirm(`Replace the text with the template "${t.name}"?`))) return;
    draft.text = textarea.value = t.text;
    updateCounter();
    updatePreview();
  });
  tools.append(pickTemplate,
    button("Save as template", "btn ghost", async () => {
      if (!draft.text.trim()) return;
      const name = prompt(`Template name (for ${site.name}):`);
      if (!name?.trim()) return;
      templates.push({ name: name.trim(), site: job.site, text: draft.text });
      await chrome.storage.local.set({ jfTemplates: templates });
      renderBidDialog();
    }),
    ...(usable.length ? [button("Delete template…", "link", async () => {
      const names = usable.map(([t], n) => `${n + 1}. ${t.name}`).join("\n");
      const n = Number(prompt(`Number of the template to delete:\n${names}`)) - 1;
      if (!usable[n]) return;
      templates.splice(usable[n][1], 1);
      await chrome.storage.local.set({ jfTemplates: templates });
      renderBidDialog();
    })] : []));
  fields.push(textField, tools);

  // What will be posted to Slack.
  const preview = el("details", "bid-preview");
  const previewText = el("pre");
  preview.append(el("summary", "", `Message to #${site.channel}`), previewText);
  const updatePreview = () => { previewText.textContent = orderMessage(job, draft); };
  updatePreview();
  updateCounter();
  fields.push(preview);

  const error = el("p", "error-text");
  error.hidden = true;
  const confirmBtn = el("button", "btn", "Confirm");
  confirmBtn.type = "submit";
  const actions = el("div", "bid-actions");
  actions.append(button("Cancel", "btn ghost", closeBidDialog), confirmBtn);
  if (warnings.length) fields.push(...warnings.map(w => el("p", "bid-warning", `⚠ ${w}`)));
  fields.push(error, actions);
  form.append(...fields);

  form.addEventListener("submit", async e => {
    e.preventDefault();
    const problem = checkDraft(job, draft);
    if (problem) { error.textContent = problem; error.hidden = false; return; }
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Sending…";
    try {
      await sendBid(job, site, draft);
    } catch (err) {
      error.textContent = `Not sent: ${err.message}`;
      error.hidden = false;
      confirmBtn.disabled = false;
      confirmBtn.textContent = "Confirm";
    }
  });
  return form;
}

function budgetHint(job) {
  if (job.budgetMin == null && job.budgetMax == null) return "";
  const money = n => (job.currency === "USD" ? `$${n.toLocaleString()}` : `¥${n.toLocaleString()}`);
  const range = job.budgetMin && job.budgetMax && job.budgetMin !== job.budgetMax ? `${money(job.budgetMin)} – ${money(job.budgetMax)}` : money(job.budgetMax || job.budgetMin);
  return `${range}${job.budgetType === "hourly" ? " / hour" : ""}`;
}

function checkDraft(job, draft) {
  const hourly = job.site === "crowdworks" && draft.mode === "hourly";
  if (!draft.account) return "Choose an account.";
  if (!(Number(draft.amount) > 0)) return "Enter an amount greater than 0.";
  if (!hourly && job.site !== "crowdworks" && !draft.date) return "Choose the date.";
  if (!hourly && draft.date && new Date(`${draft.date}T23:59`) < Date.now()) return "The date is in the past.";
  if (!draft.text.trim()) return "Write the proposal (提案文).";
  const length = charCount(draft.text.trim());
  if (length > MAX_PROPOSAL_CHARS) {
    return `The proposal is ${length.toLocaleString()} characters — over the ${MAX_PROPOSAL_CHARS.toLocaleString()}-character limit by ${(length - MAX_PROPOSAL_CHARS).toLocaleString()}. Shorten it; the bid was not sent.`;
  }
  return "";
}

// The order FAC reads (see its order.js): "SERVER", the proposal page URL, the account, the values, 提案文 last.
function orderMessage(job, draft) {
  const site = BID_SITES[job.site];
  const hourly = job.site === "crowdworks" && draft.mode === "hourly";
  const amount = String(Math.round(Number(draft.amount) || 0));
  const lines = ["SERVER", site.proposeUrl(job.id), `アカウント: ${draft.account}`];
  if (hourly) {
    lines.push(`時間単価: ${amount}`, `稼働時間: ${draft.hours}`);
  } else {
    lines.push(`${job.site === "coconala" ? "提案金額" : "契約金額"}: ${amount}`);
    if (draft.date) {
      const [y, m, d] = draft.date.split("-").map(Number);
      lines.push(`${job.site === "coconala" ? "お届け予定日" : "完了予定日"}: ${y}年${m}月${d}日`);
    }
  }
  lines.push("提案文:", draft.text.trim());
  return lines.join("\n");
}

async function sendBid(job, site, draft) {
  const channelId = await findChannelId(token, site.channel);
  // The proposal text is escaped for Slack; FAC un-escapes it.
  const sent = await postMessage(token, channelId, orderMessage(job, { ...draft, text: slackEscape(draft.text) }));
  const account = accounts.list.find(a => a.label === draft.account);
  const k = jobKey(job);
  history.unshift({
    id: sent.ts, key: k, site: job.site, jobId: String(job.id), title: job.title, url: job.url,
    account: draft.account, accountName: account?.name || "", channel: site.channel,
    orderTs: sent.ts, at: Date.now(), amount: Number(draft.amount),
    mode: job.site === "crowdworks" ? draft.mode : "fixed",
    // What was submitted, shown again when the account is clicked in the BID window.
    hours: job.site === "crowdworks" && draft.mode === "hourly" ? draft.hours : "",
    date: job.site === "crowdworks" && draft.mode === "hourly" ? "" : draft.date,
    text: draft.text.trim(),
    status: "proposing", reason: ""
  });
  jobSnapshots[k] = structuredClone(job);
  lastAccount[job.site] = draft.account;
  await saveBids();
  await chrome.storage.local.set({ jfLastBidAccount: lastAccount });
  changed();
  watchResults();
}

// ---------- watching Slack for Success / Failure ----------

let watching = false;

// Every 5 seconds while a bid is waiting: FAC's reports in the platform channels after the order.
async function watchResults() {
  if (watching) return;
  watching = true;
  try {
    while (token && history.some(r => r.status === "proposing")) {
      try {
        await checkResults();
      } catch (err) {
        console.warn("Job Finder: reading Slack results failed", err);
      }
      try {
        await checkPendingOnSite();
      } catch (err) {
        console.warn("Job Finder: looking for pending bids on the sites failed", err);
      }
      await new Promise(r => setTimeout(r, POLL_MS));
    }
  } finally {
    watching = false;
  }
}

async function checkResults() {
  const waiting = history.filter(r => r.status === "proposing");
  let found = false;
  for (const channel of new Set(waiting.map(r => r.channel))) {
    const records = waiting.filter(r => r.channel === channel);
    // A channel that can't be read (e.g. the app isn't in it) doesn't stop the others being checked.
    let channelId, messages;
    try {
      channelId = await findChannelId(token, channel);
      const oldest = records.map(r => r.orderTs).sort((a, b) => Number(a) - Number(b))[0];
      messages = (await getHistory(token, channelId, { oldest, max: 1000 })).sort((a, b) => Number(a.ts) - Number(b.ts));
    } catch (err) {
      console.warn(`Job Finder: reading results in #${channel} failed`, err);
      continue;
    }
    for (const message of messages) {
      const report = readReport(message);
      if (!report) continue;
      // Oldest waiting bid first; one report settles one bid.
      const candidates = records.slice().reverse().filter(r => r.status === "proposing" && Number(message.ts) > Number(r.orderTs) && report.mentions(r.jobId));
      // A report titled (or naming in its context) a bid's account is that bid's. Otherwise, when only
      // one account is waiting on this job, the report is its (older checkers could title a Coconala
      // report with the client's ID read from the offer page).
      const record = candidates.find(r => report.isFor(r))
        || (new Set(candidates.map(r => r.account.toLowerCase())).size === 1 ? candidates[0] : null);
      if (!record) continue;
      Object.assign(record, { status: report.status, reason: report.reason, resultAt: Number(message.ts) * 1000 });
      if (report.ok) completed[record.key] ||= { at: record.resultAt };
      found = true;
      toast(`${STATUS_MARKS[report.status]} — ${record.accountName || record.account}: ${record.title}${report.reason ? `\n${report.reason}` : ""}`, report.ok ? "ok" : "bad");
      // The result is kept here (History), so this job's messages in Slack — the order and the
      // report — are deleted to keep the channel clean.
      for (const ts of [record.orderTs, message.ts]) {
        await deleteMessage(token, channelId, ts).catch(err => {
          if (err.message !== "message_not_found") console.warn(`Job Finder: couldn't delete Slack message ${ts} in #${channel}`, err);
        });
      }
    }
  }
  if (found) {
    await saveBids();
    changed();
  }
}

// A bid still waiting for FAC's report is also looked for on the site: when the job's own list of
// proposals shows the account, the proposal went through, so it's marked Success (the report may have
// been lost, or not matched). Once a minute, from a minute after sending, for a day.
let lastSiteCheck = 0;
async function checkPendingOnSite() {
  if (Date.now() - lastSiteCheck < SITE_CHECK_MS) return;
  lastSiteCheck = Date.now();
  const waiting = history.filter(r => r.status === "proposing" && Date.now() - r.at > SITE_CHECK_AFTER_MS && Date.now() - r.at < SITE_CHECK_FOR_MS);
  let found = false;
  for (const k of new Set(waiting.map(r => r.key))) {
    const records = waiting.filter(r => r.key === k);
    const provider = PROVIDERS.find(p => p.id === records[0].site);
    if (!provider?.bidders) continue;
    let bidders;
    try {
      bidders = await provider.bidders({ site: records[0].site, id: records[0].jobId }, undefined);
    } catch { continue; }
    for (const record of records) {
      if (record.status !== "proposing" || !bidders.some(b => ownAccountOf(record.site, b)?.label === record.account)) continue;
      Object.assign(record, { status: "success", reason: `Found among the job's proposals on ${siteName(record.site)}`, resultAt: Date.now() });
      completed[record.key] ||= { at: record.resultAt };
      const job = !jobSnapshots[record.key] && findJob(record.key);
      if (job) jobSnapshots[record.key] = structuredClone(job);
      found = true;
      toast(`${STATUS_MARKS.success} — ${record.accountName || record.account}: ${record.title}\nFound among the job's proposals on ${siteName(record.site)}`, "ok");
      // (Its order in Slack is done with; FAC's report, if it comes, is left.)
      findChannelId(token, record.channel).then(id => deleteMessage(token, id, record.orderTs)).catch(() => {});
    }
  }
  if (found) {
    await saveBids();
    changed();
  }
}

// FAC's report: text "<name>: Success — Job 123", blocks [header <account>, context, section "*Success*\n<url|Job 123>\nreason"]
// (Success, Failure, or Unavailable when the job has no proposal feature).
// Orders ("SERVER…") and other chat are not reports.
function readReport(message) {
  const text = message.text || "";
  if (/^\s*(server|account request)\b/i.test(text)) return null;
  const blockTexts = [];
  const collect = node => {
    if (!node || typeof node !== "object") return;
    if (typeof node.text === "string") blockTexts.push(node.text);
    for (const value of Object.values(node)) if (typeof value === "object") collect(value);
  };
  collect(message.blocks);
  const all = [text, ...blockTexts].join("\n");
  // (FAC's DM answers — "· DM · OK" — are about DMs, not bids.)
  if (/·\s*DM\s*·/.test(all)) return null;
  const outcome = all.match(/\b(Success|Failure|Unavailable)\b/);
  if (!outcome) return null;
  const header = message.blocks?.find(b => b.type === "header")?.text?.text || "";
  const section = message.blocks?.find(b => b.type === "section" && /\b(Success|Failure|Unavailable)\b/.test(b.text?.text || ""))?.text?.text || "";
  const reason = slackPlain(section).split("\n").slice(1).filter(l => !/^Job \d+$/.test(l.trim())).join("\n").trim();
  return {
    ok: outcome[1] === "Success",
    status: { Success: "success", Failure: "failure", Unavailable: "unavailable" }[outcome[1]],
    account: header.trim(),
    reason,
    mentions: jobId => new RegExp(`(?<!\\d)${jobId}(?!\\d)`).test(all),
    isFor: record => {
      const label = record.account.trim().toLowerCase(), name = (record.accountName || "").trim();
      return header.trim().toLowerCase() === label || all.toLowerCase().includes(`(${label})`) || (!!name && all.includes(`*${name}*`));
    }
  };
}

// ---------- History page ----------

function bindHistoryPage() {
  for (const id of ["historySearch", "historyStatus", "historySite"]) $(id).addEventListener("input", renderHistory);
  $("historySelectAll").addEventListener("change", () => {
    const shown = filteredHistory();
    if ($("historySelectAll").checked) shown.forEach(r => historySelected.add(r.id));
    else shown.forEach(r => historySelected.delete(r.id));
    renderHistory();
  });
  $("historyDeleteSelected").addEventListener("click", async () => {
    if (!historySelected.size || !confirm(`Delete ${historySelected.size} selected record${historySelected.size === 1 ? "" : "s"} from History?`)) return;
    history = history.filter(r => !historySelected.has(r.id));
    historySelected.clear();
    pruneSnapshots();
    await saveBids();
    changed();
  });
}

function filteredHistory() {
  const words = normalize($("historySearch").value).split(/\s+/).filter(Boolean);
  const status = $("historyStatus").value, site = $("historySite").value;
  return history.filter(r => (!status || r.status === status) && (!site || r.site === site)
    && words.every(w => normalize(`${r.title} ${r.account} ${r.accountName} ${r.jobId} ${r.reason}`).includes(w)));
}

function renderHistory() {
  const shown = filteredHistory();
  const count = s => history.filter(r => r.status === s).length;
  $("historySummary").replaceChildren(
    el("span", "", `${history.length} bid${history.length === 1 ? "" : "s"}`),
    statusChip("success"), el("span", "", String(count("success"))),
    statusChip("failure"), el("span", "", String(count("failure"))),
    statusChip("unavailable"), el("span", "", String(count("unavailable"))),
    statusChip("proposing"), el("span", "", String(count("proposing"))));
  for (const id of [...historySelected]) if (!history.some(r => r.id === id)) historySelected.delete(id);
  $("historyDeleteSelected").disabled = !historySelected.size;
  $("historyDeleteSelected").textContent = `Delete selected${historySelected.size ? ` (${historySelected.size})` : ""}`;
  $("historySelectAll").checked = shown.length > 0 && shown.every(r => historySelected.has(r.id));

  const list = $("historyList");
  if (!shown.length) {
    list.replaceChildren(el("p", "empty", history.length ? "No bids match." : "No bids yet — use 💼 BID in a job's detail window."));
    return;
  }
  list.replaceChildren(...shown.map(record => {
    const row = el("div", `history-row ${record.status}`);
    row.dataset.id = String(record.id);
    const check = el("input");
    check.type = "checkbox";
    check.checked = historySelected.has(record.id);
    check.setAttribute("aria-label", "Select");
    check.addEventListener("change", () => { check.checked ? historySelected.add(record.id) : historySelected.delete(record.id); renderHistory(); });
    // Clicking the entry opens the job's detail window on the Proposals page.
    row.tabIndex = 0;
    row.title = "Click to open this job's details";
    const open = () => openJob(record.key, record.url);
    row.addEventListener("click", e => { if (!e.target.closest("input, a, button")) open(); });
    row.addEventListener("keydown", e => { if (e.key === "Enter" && e.target === row) open(); });
    const job = el("div", "history-job");
    const link = el("a", "history-link", "Job page ↗");
    link.href = record.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    const meta = el("div", "hint", `${siteName(record.site)} · Job ${record.jobId}${record.amount ? ` · ¥${record.amount.toLocaleString()}${record.mode === "hourly" ? " / hour" : ""}` : ""} · `);
    meta.append(link);
    job.append(el("div", "history-title", record.title), meta);
    if (record.reason) job.append(el("div", "history-reason", record.reason));
    const account = accounts.list.find(a => a.label === record.account);
    const who = el("div", "history-account");
    who.append(avatarImg(pictureOf(account), record.accountName));
    const names = el("div");
    names.append(el("div", "acct-name", record.accountName || record.account), el("div", "acct-label", record.accountName ? record.account : ""));
    who.append(names);
    row.append(check, siteIconImg(record.site), job, who, statusChip(record.status, record), el("span", "hint history-when", fmtWhen(new Date(record.resultAt || record.at))));
    return row;
  }));
}

// ---------- Settings: clear every message from the channels ----------

function bindClearChannels() {
  const box = $("clearChannelList");
  box.replaceChildren(...CLEAR_CHANNELS.map(name => {
    const label = el("label", "switch");
    const check = el("input");
    check.type = "checkbox";
    check.checked = true;
    check.value = name;
    label.append(check, el("span", "", `#${name}`));
    return label;
  }));
  $("clearChannels").addEventListener("click", clearChannels);
}

async function clearChannels() {
  const status = $("clearStatus");
  const names = [...$("clearChannelList").querySelectorAll("input:checked")].map(c => c.value);
  if (!token) { status.className = "pw-message bad"; status.textContent = "Connect Slack first."; return; }
  if (!names.length) { status.className = "pw-message bad"; status.textContent = "Tick at least one channel."; return; }
  const btn = $("clearChannels");
  btn.disabled = true;
  status.className = "pw-message";
  try {
    // Count first, so the confirmation says exactly what will go.
    const plan = [];
    for (const name of names) {
      status.textContent = `Counting messages in #${name}…`;
      let channelId;
      try { channelId = await findChannelId(token, name); } catch { continue; } // channel not created: nothing to clear
      const messages = [];
      for (const message of await getHistory(token, channelId, { max: 100000 })) {
        if (message.reply_count) messages.push(...(await getReplies(token, channelId, message.ts)).map(r => r.ts));
        messages.push(message.ts);
      }
      if (messages.length) plan.push({ name, channelId, messages });
    }
    const total = plan.reduce((n, p) => n + p.messages.length, 0);
    if (!total) { status.textContent = "Those channels are already empty."; return; }
    const summary = plan.map(p => `#${p.name}: ${p.messages.length}`).join("\n");
    if (!confirm(`Delete ALL ${total} messages?\n\n${summary}\n\nThis cannot be undone.`)) { status.textContent = "Nothing was deleted."; return; }

    let before = 0, skipped = 0;
    for (const { name, channelId, messages } of plan) {
      skipped += await deleteAll(channelId, messages, i => { status.textContent = `Deleting… ${before + i + 1} / ${total} (#${name})`; });
      before += messages.length;
    }
    const done = total - skipped;
    status.className = skipped ? "pw-message bad" : "pw-message ok";
    status.textContent = `Deleted ${done} message${done === 1 ? "" : "s"}.` +
      (skipped ? ` ${skipped} couldn't be deleted — Slack only lets a token delete its own messages (unless it belongs to a workspace admin).` : "");
    if (names.includes(ACCOUNT_CHANNEL)) {
      accounts = { at: Date.now(), list: [] };
      await chrome.storage.local.set({ jfAccounts: accounts });
      renderAccounts();
      changed();
    }
  } catch (err) {
    status.className = "pw-message bad";
    status.textContent = `Stopped: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}
