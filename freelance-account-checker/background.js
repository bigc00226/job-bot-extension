// Watches #lancers, #coconala and #crowdworks for order messages from the trigger sender ("server" by
// default) and submits each one on the matching site, then posts Success / Failure to that site's
// channel, titled with the account. Orders are only acted on while auto-propose is switched on in
// Options; Job Finder's DM requests and PACKAGE REQUESTs (#package) are handled whenever Slack is connected.
import { SITES, ACCOUNTS, MESSAGES, PACKAGES, PORTFOLIOS, accountLabel } from "./sites.js";
import { findChannelId, findOrCreateChannel, getChannelHistory, getSenderNames, postMessage } from "./slack.js";
import { parseProposalOrder } from "./order.js";
import { runProposal } from "./lancers-propose.js";
import { runCoconalaOffer } from "./coconala-offer.js";
import { runCrowdworksProposal } from "./crowdworks-propose.js";
import { checkSite, checkAllSites, storeAccountResults, reportNewAccounts } from "./account-check.js";
import { parseInboxRequest, runInboxRequest } from "./inbox.js";
import { checkAlerts, ALERT_ALARM, DEFAULT_ALERT_MIN } from "./alert-check.js";
import { parsePackageRequest, runPackageRequest } from "./lancers-package.js";
import { parsePortfolioRequest, runPortfolioRequest } from "./lancers-portfolio.js";

const ALARM = "lancers-watch";
const POLL_MS = 5000;
const RUNNERS = { lancers: runProposal, coconala: runCoconalaOffer, crowdworks: runCrowdworksProposal };
const WATCHED = SITES.filter(site => RUNNERS[site.id]);

chrome.runtime.onInstalled.addListener(syncAlarm);

// Accounts are checked when the extension is switched on — installed, enabled in chrome://extensions,
// or started with the browser — once per session (session storage is emptied whenever the extension
// is switched off or the browser closes). Otherwise only "Check now" checks.
checkAccountsOnActivation();
async function checkAccountsOnActivation() {
  const { accountsCheckedThisSession } = await chrome.storage.session.get("accountsCheckedThisSession");
  if (accountsCheckedThisSession) return;
  await chrome.storage.session.set({ accountsCheckedThisSession: true });
  await startAccountCheck();
}

// The check reads the sites' own pages in a hidden frame, with no window (account-check.js). `force` (an ACCOUNT
// REQUEST from Job Finder) posts every signed-in account to #accounts, not only new ones.
let accountCheck = null, forceNext = false;
async function startAccountCheck({ force = false } = {}) {
  forceNext ||= force;
  if (accountCheck) return accountCheck; // already running: it reports (forced too, if asked)
  accountCheck = (async () => {
    const results = await checkAllSites();
    const forced = forceNext;
    forceNext = false;
    await storeAccountResults(results);
    await reportNewAccounts(results, { force: forced });
    // With the accounts known, they're looked at for new messages / transactions right away.
    await checkAlerts();
  })().catch(err => chrome.storage.local.set({ watcherError: `${new Date().toLocaleString()}: account check: ${err.message}` }))
    .finally(() => { accountCheck = null; });
  return accountCheck;
}
chrome.runtime.onStartup.addListener(syncAlarm);
chrome.storage.onChanged.addListener(changes => {
  if (changes.autoPropose || changes.slackToken) syncAlarm();
  if (changes.alertIntervalMin) syncAlarm({ restartAlerts: true });
});
// Chrome alarms can't fire more often than every 30 s, so the alarm only (re)starts the
// 5-second loop below in case Chrome stopped the service worker.
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM) watchLoop();
  if (alarm.name === ALERT_ALARM) checkAlerts();
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // "Submit proposal" button in the popup.
  if (message?.type === "propose") {
    enqueue(message.text);
    sendResponse({ queued: true });
  }
  // "Check for alerts now" in Options.
  if (message?.type === "check-alerts") {
    checkAlerts().then(sendResponse, err => sendResponse({ posted: 0, errors: [err.message], seen: [] }));
    return true;
  }
  // The popup's "Check now": one site, read in the hidden frame by this service worker.
  if (message?.type === "check-site") {
    const site = SITES.find(s => s.id === message.siteId);
    if (!site) { sendResponse({ state: "error", message: "unknown site" }); return; }
    checkSite(site).then(sendResponse, err => sendResponse({ state: "error", message: err.message }));
    return true;
  }
});

// One task at a time (proposals from Slack or the popup, Job Finder's DM requests), so the
// background tabs never get in each other's way.
// A task that hasn't finished in TASK_LIMIT_MS is given up on, so one stuck page never stops the
// tasks after it (it was the most likely way for the watcher to stop working after a while).
const TASK_LIMIT_MS = 30 * 60000;
let queue = Promise.resolve();
function enqueue(text, sourceSiteId) {
  return runTask(() => runOrder(text, sourceSiteId)).catch(err =>
    chrome.storage.local.set({ lastProposal: { at: new Date().toLocaleString(), outcome: "Failure", accountName: "", jobId: null, reason: err.message } })
  );
}
function runTask(task) {
  const run = queue.then(() => {
    let timer;
    const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Gave up after ${TASK_LIMIT_MS / 60000} minutes`)), TASK_LIMIT_MS); });
    return Promise.race([task(), limit]).finally(() => clearTimeout(timer));
  });
  queue = run.catch(() => {});
  return run;
}

// Slack is watched whenever a token is saved: #accounts always (for Job Finder's ACCOUNT REQUEST),
// the platform channels only while auto-propose is on.
async function syncAlarm({ restartAlerts = false } = {}) {
  // (The message search of earlier versions is gone: its alarm is removed.)
  await chrome.alarms.clear("messages-check");
  const { slackToken, alertIntervalMin } = await chrome.storage.local.get(["slackToken", "alertIntervalMin"]);
  if (slackToken) {
    await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
    // New message / transaction alerts: every N minutes as set in Options (1 by default). Kept if
    // already scheduled with that interval, so restarts don't push it back.
    const every = Math.max(1, Number(alertIntervalMin) || DEFAULT_ALERT_MIN);
    const current = await chrome.alarms.get(ALERT_ALARM);
    if (restartAlerts || !current || current.periodInMinutes !== every) {
      await chrome.alarms.create(ALERT_ALARM, { periodInMinutes: every, delayInMinutes: 1 });
    }
    watchLoop();
  } else {
    await chrome.alarms.clear(ALARM);
    await chrome.alarms.clear(ALERT_ALARM);
  }
}

let looping = false;

// Checks Slack every 5 seconds while a token is saved. The storage read each round
// is an extension API call, which also keeps the service worker alive.
async function watchLoop() {
  if (looping) return;
  looping = true;
  try {
    for (;;) {
      const { slackToken } = await chrome.storage.local.get("slackToken");
      if (!slackToken) break;
      await poll();
      await new Promise(r => setTimeout(r, POLL_MS));
    }
  } finally {
    looping = false;
  }
}

// When the current round started (0 = none running). A round still "running" after POLL_STUCK_MS is
// taken as stuck and no longer blocks the next one.
const POLL_STUCK_MS = 45 * 60000;
let polling = 0;

async function poll() {
  if (polling && Date.now() - polling < POLL_STUCK_MS) return;
  const round = polling = Date.now();
  try {
    const settings = await chrome.storage.local.get(["autoPropose", "slackToken", "watchLastTs", "triggerSender"]);
    const token = settings.slackToken;
    if (!token) return;
    const lastTs = settings.watchLastTs || {};
    const trigger = (settings.triggerSender || "server").trim().toLowerCase();

    // #accounts: "ACCOUNT REQUEST" (Job Finder's Request accounts) → check the sign-ins again and
    // post every account found here. Starts from "now" the first time, like the other channels.
    if (!lastTs[ACCOUNTS.slackChannel]) {
      lastTs[ACCOUNTS.slackChannel] = String(Date.now() / 1000);
      await chrome.storage.local.set({ watchLastTs: lastTs });
    } else {
      const accountsId = await findChannelId(token, ACCOUNTS.slackChannel);
      const requests = await getChannelHistory(token, accountsId, lastTs[ACCOUNTS.slackChannel]);
      if (requests.length) {
        lastTs[ACCOUNTS.slackChannel] = requests[requests.length - 1].ts;
        await chrome.storage.local.set({ watchLastTs: lastTs });
        if (requests.some(msg => /^\s*ACCOUNT REQUEST\b/i.test(msg.text || ""))) await startAccountCheck({ force: true });
      }
    }

    // #messages: Job Finder's DM requests (Lancers, Workana) for an account signed in here
    // (see inbox.js). Answered in the request's thread.
    if (!lastTs[MESSAGES.slackChannel]) {
      lastTs[MESSAGES.slackChannel] = String(Date.now() / 1000);
      await chrome.storage.local.set({ watchLastTs: lastTs });
    } else {
      const inboxId = await findChannelId(token, MESSAGES.slackChannel);
      for (const msg of await getChannelHistory(token, inboxId, lastTs[MESSAGES.slackChannel])) {
        lastTs[MESSAGES.slackChannel] = msg.ts;
        await chrome.storage.local.set({ watchLastTs: lastTs });
        const request = parseInboxRequest(msg.text || "");
        if (!request || !(await isForThisBrowser(request, request.site))) continue;
        await runTask(() => runInboxRequest(request, msg.ts, token)).catch(err =>
          chrome.storage.local.set({ watcherError: `${new Date().toLocaleString()}: ${request.action}: ${err.message}` }));
      }
    }

    // #package: Job Finder's PACKAGE REQUEST → fill in a Lancers package for the account signed in
    // here (lancers-package.js), answered in the request's thread. (The channel is made if missing.)
    if (!lastTs[PACKAGES.slackChannel]) {
      lastTs[PACKAGES.slackChannel] = String(Date.now() / 1000);
      await chrome.storage.local.set({ watchLastTs: lastTs });
    } else {
      const packageId = await findOrCreateChannel(token, PACKAGES.slackChannel);
      for (const msg of await getChannelHistory(token, packageId, lastTs[PACKAGES.slackChannel])) {
        lastTs[PACKAGES.slackChannel] = msg.ts;
        await chrome.storage.local.set({ watchLastTs: lastTs });
        const request = parsePackageRequest(msg.text || "");
        if (!request || !(await isForThisBrowser(request, "lancers"))) continue;
        await runTask(() => runPackageRequest(request, msg, token, packageId)).catch(err =>
          chrome.storage.local.set({ watcherError: `${new Date().toLocaleString()}: package: ${err.message}` }));
      }
    }

    // #portfolio: Job Finder's PORTFOLIO REQUEST → add a Lancers portfolio item for the account signed in
    // here (lancers-portfolio.js), answered in the request's thread. (The channel is made if missing.)
    if (!lastTs[PORTFOLIOS.slackChannel]) {
      lastTs[PORTFOLIOS.slackChannel] = String(Date.now() / 1000);
      await chrome.storage.local.set({ watchLastTs: lastTs });
    } else {
      const portfolioId = await findOrCreateChannel(token, PORTFOLIOS.slackChannel);
      for (const msg of await getChannelHistory(token, portfolioId, lastTs[PORTFOLIOS.slackChannel])) {
        lastTs[PORTFOLIOS.slackChannel] = msg.ts;
        await chrome.storage.local.set({ watchLastTs: lastTs });
        const request = parsePortfolioRequest(msg.text || "");
        if (!request || !(await isForThisBrowser(request, "lancers"))) continue;
        await runTask(() => runPortfolioRequest(request, msg, token, portfolioId)).catch(err =>
          chrome.storage.local.set({ watcherError: `${new Date().toLocaleString()}: portfolio: ${err.message}` }));
      }
    }

    // The platform channels: Job Finder's DM requests (CrowdWorks / Coconala DMs are posted to their
    // own channel) whenever a token is saved; orders only while auto-propose is on (orders posted
    // while it is off are passed over, never submitted later).
    for (const site of WATCHED) {
      // Start each channel from "now" the first time, so older messages are never acted on.
      if (!lastTs[site.id]) {
        lastTs[site.id] = String(Date.now() / 1000);
        await chrome.storage.local.set({ watchLastTs: lastTs });
        continue;
      }
      const channelId = await findChannelId(token, site.slackChannel);
      const messages = await getChannelHistory(token, channelId, lastTs[site.id]);
      for (const msg of messages) {
        // Mark as handled before running, so a crash or restart never submits the same order twice.
        lastTs[site.id] = msg.ts;
        await chrome.storage.local.set({ watchLastTs: lastTs });
        const dm = parseInboxRequest(msg.text || "");
        if (dm) {
          dm.site ||= site.id;
          if (!(await isForThisBrowser(dm, dm.site))) continue;
          await runTask(() => runInboxRequest(dm, msg.ts, token, site.slackChannel)).catch(err =>
            chrome.storage.local.set({ watcherError: `${new Date().toLocaleString()}: DM: ${err.message}` }));
          continue;
        }
        if (!settings.autoPropose) continue;
        if (!(await isTriggerMessage(token, msg, trigger))) continue;
        if (!(await isForThisBrowser(parseProposalOrder(msg.text || ""), site.id))) continue;
        await enqueue(msg.text || "", site.id);
      }
    }
    await chrome.storage.local.set({ watcherError: "" });
  } catch (err) {
    await chrome.storage.local.set({ watcherError: `${new Date().toLocaleString()}: ${err.message}` });
  } finally {
    if (polling === round) polling = 0;
  }
}

// A message counts as an order when it is posted by the trigger sender ("server"),
// or when its text contains the word "server" and a Lancers / Coconala / CrowdWorks proposal URL.
// (The URL requirement keeps ordinary chat that mentions "server" from triggering anything.)
async function isTriggerMessage(token, msg, trigger) {
  const text = msg.text || "";
  if (text.toLowerCase().includes(trigger) && parseProposalOrder(text).url) return true;
  const names = await getSenderNames(token, msg);
  return names.some(n => n.trim().toLowerCase() === trigger);
}

// An order that names an account (アカウント: Lancers-tanaka123, sent by Job Finder's BID) is only
// submitted by the browser signed in to that account; other browsers watching the channel leave it.
// Orders without an account line are submitted as before.
async function isForThisBrowser(order, channelSiteId) {
  if (!order.account) return true;
  const siteId = order.site || channelSiteId;
  const { accountLabels = {}, accountInfo = {} } = await chrome.storage.local.get(["accountLabels", "accountInfo"]);
  const wanted = order.account.trim().toLowerCase();
  return [accountLabels[siteId], accountInfo[siteId]?.label, accountInfo[siteId]?.name]
    .some(name => name && name.trim().toLowerCase() === wanted);
}

// Runs one order on the site its URL belongs to and reports it to that site's channel
// (when Slack is connected) and to the popup / Options.
async function runOrder(text, sourceSiteId = "lancers") {
  const order = parseProposalOrder(text);
  const site = SITES.find(s => s.id === (order.site || sourceSiteId));
  // CrowdWorks hourly jobs need hours per week; when the order doesn't say, the default from Options is used.
  let usedDefaultHours = false;
  if (order.site === "crowdworks" && !order.hours) {
    const { defaultHours } = await chrome.storage.local.get("defaultHours");
    order.hours = String(defaultHours || 10);
    usedDefaultHours = true;
  }
  const result = order.url
    ? await RUNNERS[order.site](order, site)
    : { ok: false, reason: "No Lancers propose_start, Coconala offers/add or CrowdWorks proposals/new URL in the order", accountId: "" };

  const { accountLabels = {}, accountInfo = {}, slackToken } = await chrome.storage.local.get(["accountLabels", "accountInfo", "slackToken"]);
  // The account named in the order (already checked to be this browser's) titles the report, so Job
  // Finder matches it to its bid even when the page's header link can't be read (Coconala's offer
  // page also links to the client's profile, which could be taken for this account's).
  const title = order.account?.trim() || (result.accountId ? accountLabel(site, result.accountId) : accountLabels[site.id] || site.name);
  // The account's display name and avatar (from the last account check) go with every report.
  const info = accountInfo[site.id] || {};
  // "Unavailable": the job has no proposal feature (closed, ended, or a kind that takes none) —
  // Job Finder shows it as "proposal feature unavailable", not as a failure.
  const outcome = result.ok ? "Success" : result.unavailable ? "Unavailable" : "Failure";
  let reason = result.reason;
  if (usedDefaultHours && result.ok && result.mode === "hourly") reason = `稼働時間 not in the order — used the default ${order.hours} hours/week`;

  if (slackToken) {
    const details = [order.url && `<${order.url}|Job ${order.jobId}>`, result.reason].filter(Boolean).join("\n");
    const account = { type: "context", elements: [
      ...(info.avatar ? [{ type: "image", image_url: info.avatar, alt_text: info.name || title }] : []),
      { type: "mrkdwn", text: `*${info.name || title}*${info.name ? ` (${title})` : ""}` }
    ] };
    const blocks = [
      { type: "header", text: { type: "plain_text", text: title.slice(0, 150) } },
      account,
      { type: "section", text: { type: "mrkdwn", text: `*${outcome}*${details ? `\n${details}` : ""}` } }
    ];
    // (The job number in the plain text lets Job Finder match the report to its proposal.)
    const summary = `${info.name || title}: ${outcome}${order.jobId ? ` — Job ${order.jobId}` : ""}`;
    try {
      const channelId = await findChannelId(slackToken, site.slackChannel);
      try {
        await postMessage(slackToken, channelId, summary, blocks);
      } catch (err) {
        // Slack refuses image blocks it can't download; send without the avatar rather than not at all.
        if (!info.avatar || !/invalid_blocks|downloading image/i.test(err.message)) throw err;
        account.elements = account.elements.filter(e => e.type !== "image");
        await postMessage(slackToken, channelId, summary, blocks);
      }
    } catch (err) {
      reason = [reason, `Slack report failed: ${err.message}`].filter(Boolean).join(" · ");
    }
  }

  await chrome.storage.local.set({
    lastProposal: { at: new Date().toLocaleString(), outcome, accountName: title, jobId: order.jobId, reason }
  });
}
