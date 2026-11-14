// Job Finder's DM requests, handled by the browser signed in to the named account:
//   SERVER / DM / <URL> / アカウント: Lancers-xxx / メッセージ: <text>
//   - in #crowdworks: <URL> is the job (https://crowdworks.jp/public/jobs/<id>) — its 相談 box is used;
//   - in #coconala:   <URL> is the client's page (https://coconala.com/users/<id>) — メッセージを送る;
//     (both in site-dms.js)
//   - in #messages (Lancers, Workana): the conversation, or from a job the client's message window.
// The text is typed in and sent, and DM Success / DM Failure / DM Unavailable is answered in the
// request's thread (context "*name* (label) · Site · DM · OK|FAILED|UNAVAILABLE", which Job Finder reads).
// Existing conversations, messages and transactions are never read or copied.
// Like everything else here, the site is opened in a background tab that is always closed again.
import { SITES, MESSAGES } from "./sites.js";
import { findChannelId, postMessage } from "./slack.js";
import { waitForTab, waitForDocument, inPage, describeFailure, readAccountIdInPage, STEP_MS, AFTER_CLICK_MS, pause, keepInTab, openHiddenTab, closeHiddenTab } from "./tab-utils.js";
import { sendCrowdworksDm, sendCoconalaDm } from "./site-dms.js";

export function parseInboxRequest(rawText) {
  // Slack shows links as <url> or <url|label> and escapes &, < and >.
  const text = rawText.replace(/<(https?:\/\/[^|>]+)(?:\|[^>]*)?>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const lines = text.split("\n");
  if (lines[0]?.trim().toUpperCase() !== "SERVER" || (lines[1] || "").trim().toUpperCase() !== "DM") return null;
  const account = text.match(/^\s*(?:アカウント|Account)\s*[:：]\s*(\S.*)$/im)?.[1].trim() || null;
  const url = lines.slice(2).find(l => /^\s*https?:\/\//.test(l))?.trim() || null;
  const message = text.match(/(?:^|\n)\s*(?:メッセージ|Message)\s*[:：][ \t]*\n?([\s\S]*)$/)?.[1].trim() || "";
  const host = url ? new URL(url).hostname : "";
  const site = SITES.find(s => account?.toLowerCase().startsWith(`${s.name.toLowerCase()}-`))
    || SITES.find(s => host && host === new URL(s.checkUrl).hostname);
  return { action: "dm", account, url, message, site: site?.id || null };
}

// Sends the DM and answers in the request's thread (in the channel the request was posted to).
export async function runInboxRequest(request, requestTs, token, channel = MESSAGES.slackChannel) {
  const site = SITES.find(s => s.id === request.site);
  const send = { crowdworks: sendCrowdworksDm, coconala: sendCoconalaDm }[site?.id] || sendDm;
  let result;
  try {
    result = !site ? { ok: false, reason: "Unknown platform for this account" }
      : !request.url ? { ok: false, reason: "No URL in the DM request" }
      : !request.message ? { ok: false, reason: "No message text in the DM request" }
      : await send(site, request);
  } catch (err) {
    result = { ok: false, reason: err.message };
  }
  const { accountInfo = {} } = await chrome.storage.local.get("accountInfo");
  const info = (site && accountInfo[site.id]) || {};
  const label = request.account || info.label || site?.name || "";
  const title = result.ok ? "DM Success" : result.unavailable ? "DM Unavailable" : "DM Failure";
  const status = result.ok ? "OK" : result.unavailable ? "UNAVAILABLE" : "FAILED";
  const channelId = await findChannelId(token, channel);
  await postMessage(token, channelId, escape(`${info.name || label}: ${title}`), [
    { type: "header", text: { type: "plain_text", text: label.slice(0, 150) || "Freelance Account Checker" } },
    { type: "context", elements: [{ type: "mrkdwn", text: `*${escape(info.name || label)}* (${escape(label)}) · ${site?.name || "?"} · DM · ${status}` }] },
    { type: "section", text: { type: "mrkdwn", text: [`*${title}*`, result.url && `<${result.url}|Open on ${site?.name || "the site"}>`, result.reason && escape(result.reason)].filter(Boolean).join("\n").slice(0, 2900) } }
  ], requestTs);
  return result;
}

const escape = s => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function withTab(url, site, work) {
  const tab = await openHiddenTab(url);
  try {
    const opened = await waitForTab(tab.id, () => true, 60000, { requireComplete: false });
    if (!opened) return { ok: false, reason: "The page did not open" };
    if (!(await waitForDocument(tab.id, 30000))) return { ok: false, reason: "The page did not finish loading" };
    const now = (await chrome.tabs.get(tab.id)).url || opened;
    if (site.loginUrlPattern.test(new URL(now).pathname)) return { ok: false, reason: `Not signed in to ${site.name} in this browser` };
    return await work(tab.id);
  } finally {
    closeHiddenTab(tab);
  }
}

async function goTo(tabId, url) {
  const before = (await chrome.tabs.get(tabId)).url;
  await chrome.tabs.update(tabId, { url });
  if (before !== url) await waitForTab(tabId, u => u !== before, 30000, { requireComplete: false });
  await pause(1000);
  return waitForDocument(tabId, 30000);
}

// DM (Lancers, Workana): a conversation URL is written in directly; from a job page, the client's
// message button is used (on the job page, or else on the client's profile). Success once the text
// has gone out. Paced like everything else: ~2 s before each input or click, ~3 s after a click.
async function sendDm(site, request) {
  return withTab(request.url, site, async tabId => {
    const fail = async (reason, extra = {}) => ({ ok: false, reason: await describeFailure(tabId, reason), ...extra });
    const accountId = await readAccountIdInPage(tabId, site);
    const isBoard = site.boardPattern?.test((await chrome.tabs.get(tabId)).url);
    if (!isBoard) {
      // Run once per page (it may click): a page that navigates right after the click returns
      // nothing, which means the click led on to the message window.
      const findEntry = async () => {
        await waitForDocument(tabId, 30000);
        await keepInTab(tabId);
        await pause(STEP_MS);
        const entry = (await inPage(tabId, findDmEntry).catch(() => null)) || { found: true, href: "" };
        if (entry.found && !entry.href) await pause(AFTER_CLICK_MS);
        return entry;
      };
      let entry = await findEntry();
      if (!entry.found) {
        // Not on the job page: try the client's profile.
        const client = await inPage(tabId, findClientLink, [site.clientPattern?.source || "$^"]).catch(() => "");
        if (client) {
          await goTo(tabId, client);
          entry = await findEntry();
        }
      }
      if (!entry?.found) return fail("This client can't be messaged directly — no message button on the job or the client's page", { unavailable: true });
      if (entry.href) await goTo(tabId, entry.href);
      else await waitForDocument(tabId, 30000);
    }
    // Run once only (never repeated after a reload, which could send the message twice). A page that
    // reloads right after 送信 was pressed counts as sent.
    await waitForDocument(tabId, 30000);
    await keepInTab(tabId);
    await pause(STEP_MS);
    let sent = await inPage(tabId, sendInConversation, [request.message, STEP_MS]).catch(() => null);
    if (!sent) {
      await waitForDocument(tabId, 30000);
      const clickedAt = Number(await inPage(tabId, () => sessionStorage.getItem("fac-dm-sent")).catch(() => 0)) || 0;
      sent = Date.now() - clickedAt < 120000 ? { ok: true } : null;
    }
    if (!sent) return fail("The page reloaded before the message could be sent");
    if (!sent.ok) return fail(sent.reason);
    return { ok: true, reason: "", accountId, url: (await chrome.tabs.get(tabId)).url };
  });
}

// ---- Functions below run inside the site's page, so they must be self-contained. ----

// The client's "send a message" button on a job or profile page (not public Q&A).
// Returns { found, href } — href when it's a link to follow; otherwise it was clicked here.
// Waits a few seconds for pages that draw their buttons late.
async function findDmEntry() {
  for (let i = 0; i < 32 && !find(); i++) await new Promise(r => setTimeout(r, 250));
  const entry = find();
  if (!entry) return { found: false };
  const href = entry.tagName === "A" ? entry.getAttribute("href") : "";
  if (href && !/^(javascript:|#)/.test(href)) return { found: true, href: entry.href };
  entry.scrollIntoView({ block: "center" });
  entry.click();
  return { found: true, href: "" };

  function find() {
    const TEXT = /メッセージを送る|メッセージを送信|メッセージで(相談|質問|問い合わせ)|ダイレクトメッセージ|個別(に)?(相談|メッセージ)|相談する|問い合わせる|お問い合わせ|send (a )?message|contact|enviar mensaje/i;
    const NOT = /質問掲示板|公開|一覧|履歴|設定/;
    const items = [...document.querySelectorAll("a[href], button, [role='button'], input[type='button'], input[type='submit']")]
      .filter(el => !el.closest("header, nav, footer") && el.getClientRects().length > 0);
    const words = el => `${el.innerText || el.value || ""} ${el.title || ""} ${el.getAttribute("aria-label") || ""}`.replace(/\s+/g, " ").trim();
    return items.find(el => TEXT.test(words(el)) && !NOT.test(words(el))) || null;
  }
}

function findClientLink(patternSource) {
  const pattern = new RegExp(patternSource);
  return [...document.querySelectorAll("a[href]")].find(a => !a.closest("header, nav, footer") && pattern.test(a.pathname))?.href || "";
}

// Types the message into the conversation's input box, waits `stepMs`, and presses 送信.
async function sendInConversation(message, stepMs) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  let box = null;
  for (let i = 0; i < 60 && !box; i++) {
    const boxes = [...document.querySelectorAll("textarea")].filter(el => visible(el) && !el.disabled && !el.readOnly);
    box = boxes.find(el => /メッセージ|message|mensaje/i.test(el.placeholder || "")) || boxes[0] || null;
    if (!box) await sleep(250);
  }
  if (!box) return { ok: false, reason: "No message input box on the page" };
  box.scrollIntoView({ block: "center" });
  box.focus();
  // React ignores plain `.value =`; the native setter plus an input event is what typing does.
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(box, message);
  box.dispatchEvent(new Event("input", { bubbles: true }));
  box.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(stepMs);
  if (box.value !== message) return { ok: false, reason: "The message could not be typed into the input box" };

  // The send button nearest the box (送信 is disabled until there is text).
  const SEND = /^(送信|送信する|送る|メッセージを送る|メッセージを送信|メッセージを送信する|返信|返信する|send|enviar)$/i;
  const label = b => (b.innerText || b.value || b.getAttribute("aria-label") || "").trim();
  let button = null;
  for (let i = 0; i < 40 && !button; i++) {
    for (let scope = box.parentElement; scope && !button; scope = scope.parentElement) {
      button = [...scope.querySelectorAll("button, input[type='submit'], [role='button']")].find(b => visible(b) && SEND.test(label(b)) && !b.disabled);
      if (scope === document.body) break;
    }
    if (!button) await sleep(250);
  }
  if (!button) return { ok: false, reason: "The 送信 (send) button wasn't found or stayed disabled" };
  const before = location.href;
  try { sessionStorage.setItem("fac-dm-sent", String(Date.now())); } catch { /* storage blocked: the checks below decide */ }
  button.click();

  // Sent once the box empties, the page moves on, or the text shows up in the conversation.
  const start = message.slice(0, 30);
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    if (location.href !== before || !document.contains(box) || box.value.trim() === "") return { ok: true };
    const shown = [...document.querySelectorAll("p, div, span, pre")].some(el => el !== box && !el.contains(box) && el.children.length === 0 && el.textContent.includes(start));
    if (shown) return { ok: true };
  }
  return { ok: false, reason: "Pressed 送信 but the message didn't go out (the input box still holds it)" };
}
