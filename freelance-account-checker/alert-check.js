// Every minute (or the interval set in Options) the Coconala, CrowdWorks and Lancers accounts signed in
// to this browser are looked at afresh, and a new message or transaction is announced in Slack #alert,
// naming the account that received it.
// Nothing is shown on screen: each site's page is loaded anew in this extension's hidden frame
// (frame-reader.js) at desktop size, with this browser's normal sign-in, and the numbers on its header
// buttons are read — ✉ messages, ☑ transactions / やることリスト (CrowdWorks has no transaction button:
// its 🔔 お知らせ, where contracts and 仮払い are announced, counts instead).
// On Coconala, https://coconala.com/message is opened too: each conversation showing an unread number
// is posted with its sender, time and message as the list shows them (conversations themselves are
// never opened, so nothing is marked read). No site API is called and no cookie or key is read.
// Only what's new is posted: a number above the one already announced (the difference), and on
// Coconala each unread message not posted before. What was posted once is never posted again.
import { SITES, ALERTS } from "./sites.js";
import { getSlackToken, findOrCreateChannel, postMessage } from "./slack.js";
import { readInFrame } from "./frame-reader.js";

export const ALERT_ALARM = "alert-check";
export const DEFAULT_ALERT_MIN = 1;

// The page whose header is read on each site.
const WATCH = {
  lancers: "https://www.lancers.jp/mypage?",
  coconala: "https://coconala.com/",
  crowdworks: "https://crowdworks.jp/dashboard"
};
const KIND_OF = { crowdworks: { notification: "transaction" } };
// Sites whose message list page is read for the sender and message (the others: the number only).
const MESSAGE_PAGES = { coconala: "https://coconala.com/message" };
// Where the alert's link goes when the button itself has no link (CrowdWorks' are buttons).
const LINKS = { crowdworks: { message: "https://crowdworks.jp/messages?ref=login_header", transaction: "https://crowdworks.jp/notifications?ref=login_header" } };
const KINDS = ["message", "transaction"];
const ICON = { message: "✉", transaction: "☑" };
const TITLE = { message: "New message", transaction: "New transaction" };
const LOWER_AFTER = 3;

let running = null;

// Looks at every signed-in account once. Returns { at, posted, errors, seen }.
export function checkAlerts() {
  running ||= run().finally(() => { running = null; });
  return running;
}

async function run() {
  const token = await getSlackToken();
  const stored = await chrome.storage.local.get(["accountLabels", "accountInfo", "alertState", "alertsOff"]);
  const result = { at: new Date().toLocaleString(), posted: 0, errors: [], seen: [] };
  if (!token || stored.alertsOff) return result;
  const state = stored.alertState || {};
  let channelId = null;

  for (const site of SITES.filter(s => WATCH[s.id])) {
    const label = stored.accountLabels?.[site.id];
    if (!label) continue; // not signed in here at the last account check
    const info = stored.accountInfo?.[site.id] || {};
    let read;
    try {
      read = await readInFrame(WATCH[site.id], "header", [], 45000);
      if (read.error) throw new Error(read.error);
    } catch (err) {
      result.errors.push(`${site.name}: ${err.message}`);
      continue;
    }
    if (read.signedOut || site.loginUrlPattern.test(new URL(read.url).pathname)) {
      result.seen.push(`${site.name}: signed out`);
      continue;
    }
    const icons = read.icons.map(i => ({ ...i, kind: KIND_OF[site.id]?.[i.kind] || i.kind }));
    const seen = [];

    for (const kind of KINDS) {
      const mine = icons.filter(i => i.kind === kind);
      // No number = nothing new; a red dot counts as 1; the same button drawn twice counts once.
      const count = mine.length ? Math.max(...mine.map(i => (i.count < 0 ? 1 : i.count))) : 0;
      seen.push(`${ICON[kind]}${count}`);
      const key = `${label}|${kind}`;
      const before = state[key] ?? 0;

      // Coconala messages: https://coconala.com/message is opened, and every conversation with an
      // unread number is posted with its sender and message (once per message).
      const page = MESSAGE_PAGES[site.id];
      let listed = null;
      if (kind === "message" && page) {
        listed = await postNewMessages(site, label, info, page, state, () => (channelId ||= findOrCreateChannel(token, ALERTS.slackChannel)), token, result);
        if (listed) seen[seen.length - 1] += ` (${listed.unread} unread on ${new URL(page).pathname})`;
      }

      // Only a number above the one already announced is new. It's lowered (read on the site) only
      // after reading lower LOWER_AFTER times in a row, so a header drawn for a moment without one of
      // its badges doesn't make the same messages / transactions look new again.
      if (count < before) {
        const low = (state[`${key}|low`] || 0) + 1;
        if (low >= LOWER_AFTER) { state[key] = count; delete state[`${key}|low`]; }
        else state[`${key}|low`] = low;
        continue;
      }
      delete state[`${key}|low`];
      if (count === before) continue;
      // The unread conversations were posted one by one: the number isn't posted as well.
      // (A failed post is tried again next time.)
      if (listed?.unread) { if (!listed.failed) state[key] = count; continue; }
      try {
        channelId = await (channelId ||= findOrCreateChannel(token, ALERTS.slackChannel));
        const link = mine.find(i => /^https?:/.test(i.href))?.href || LINKS[site.id]?.[kind] || WATCH[site.id];
        await postMessage(token, channelId, alertText(site, label, info, kind, count - before), alertBlocks(site, label, info, kind, count, before, link));
        state[key] = count; // announced
        result.posted++;
      } catch (err) {
        // Not recorded, so it's tried again next time.
        result.errors.push(`#${ALERTS.slackChannel}: ${err.message}`);
      }
    }
    result.seen.push(`${site.name}: ${seen.join(" ")}`);
  }
  await chrome.storage.local.set({ alertState: state, lastAlertCheck: result });
  return result;
}

// Reads the message page and posts each unread conversation's newest message not posted before.
// Returns { unread, failed } (unread: conversations with an unread number), or null when the page
// couldn't be read.
async function postNewMessages(site, label, info, page, state, channel, token, result) {
  let read;
  try {
    read = await readInFrame(page, "messageList", [], 45000);
    if (read.error) throw new Error(read.error);
    if (read.signedOut) return null;
    if (!read.rows.length) throw new Error("no conversations found on the page");
  } catch (err) {
    result.errors.push(`${site.name} ${page}: ${err.message}`);
    return null;
  }
  const memory = state[`${label}|messages`] ||= [];
  const known = new Set(memory);
  const unread = read.rows.filter(r => r.unread > 0);
  let failed = false;
  for (const row of unread.slice().reverse()) { // oldest first
    const key = `${row.url || row.from}|${row.text}`;
    if (known.has(key)) continue;
    try {
      const channelId = await channel();
      await postMessage(token, channelId, messageText(site, label, info, row), messageBlocks(site, label, info, row, page));
      memory.unshift(key);
      result.posted++;
    } catch (err) {
      result.errors.push(`#${ALERTS.slackChannel}: ${err.message}`);
      failed = true;
    }
  }
  state[`${label}|messages`] = memory.slice(0, 300);
  return { unread: unread.length, failed };
}

const escape = s => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const who = (label, info) => (info.name ? `${info.name} (${label})` : label);

// e.g. "✉ New message — sakura (Coconala-123)"
function alertText(site, label, info, kind, added) {
  return escape(`${ICON[kind]} ${TITLE[kind]}${added > 1 ? ` ×${added}` : ""} — ${who(label, info)} on ${site.name}`);
}

// e.g. "✉ New message — sakura (Coconala-123): Bluemoon_partner — こんにちは。お元気ですか？"
function messageText(site, label, info, row) {
  return escape(`✉ New message — ${who(label, info)} on ${site.name}: ${[row.from, row.text].filter(Boolean).join(" — ")}`.slice(0, 300));
}

// The same layout as the number alerts (Job Finder reads both), plus From / Time and the message.
function messageBlocks(site, label, info, row, page) {
  return [
    { type: "section", text: { type: "mrkdwn", text: [
      `*✉ New message* — *${escape(who(label, info))}*`,
      `*Account:* ${escape(label)} · ${site.name}`,
      row.from && `*From:* ${escape(row.from.slice(0, 100))}`,
      row.time && `*Time:* ${escape(row.time)}`,
      `*Unread:* ${row.unread}`,
      row.text && `>${escape(row.text.slice(0, 1000))}`,
      `<${row.url || page}|Open on ${site.name}>`
    ].filter(Boolean).join("\n") } }
  ];
}

function alertBlocks(site, label, info, kind, count, before, link) {
  const time = new Date().toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  return [
    { type: "section", text: { type: "mrkdwn", text: [
      `*${ICON[kind]} ${TITLE[kind]}* — *${escape(who(label, info))}*`,
      `*Account:* ${escape(label)} · ${site.name}`,
      `*Badge:* ${count}${before ? ` (was ${before})` : ""} · ${time}`,
      `<${link}|Open on ${site.name}>`
    ].join("\n") } }
  ];
}
