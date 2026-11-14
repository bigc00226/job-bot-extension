// DMs that Job Finder asks for in #crowdworks and #coconala (see inbox.js for the request format):
//   CrowdWorks — the job page https://crowdworks.jp/public/jobs/<id> is loaded completely, the message
//                goes into its 相談 box (textarea#message_body), and the box's send button is pressed.
//                Sent once CrowdWorks shows "メッセージありがとうございます。" (.result_message.cw-alert_success).
//   Coconala   — the client's page https://coconala.com/users/<id> is loaded completely, メッセージを送る
//                is pressed, and in the message window that opens (/mypage/direct_message/<id>) the
//                message goes into textarea#DirectMessageBody and メッセージを送信 is pressed.
// About 2 seconds pass before each input and before each click, and about 3 seconds after each click
// (STEP_MS / AFTER_CLICK_MS). Everything runs in a background tab that is always closed again.
// Each returns { ok, reason, accountId, url, unavailable? }.
import { waitForTab, waitForDocument, inPage, inPageAcrossLoads, describeFailure, readAccountIdInPage,
  STEP_MS, AFTER_CLICK_MS, pause, keepInTab, openHiddenTab, closeHiddenTab } from "./tab-utils.js";

const COCONALA_DM_WINDOW = /\/mypage\/direct_messages?\/\d+/;

export async function sendCrowdworksDm(site, request) {
  const jobId = request.url.match(/crowdworks\.jp\/public\/jobs\/(\d+)/)?.[1];
  if (!jobId) return { ok: false, reason: "Not a CrowdWorks job URL (https://crowdworks.jp/public/jobs/<number>)" };
  const url = `https://crowdworks.jp/public/jobs/${jobId}`;
  return inLoadedTab(url, site, async (tabId, fail) => {
    const accountId = await readAccountIdInPage(tabId, site);
    await keepInTab(tabId);

    await pause(STEP_MS);
    const typed = await inPage(tabId, typeCrowdworksMessage, [request.message, AFTER_CLICK_MS]).catch(() => null);
    if (!typed) return fail("The job page reloaded while the message was being entered");
    if (!typed.ok) return fail(typed.reason, { unavailable: !!typed.unavailable, accountId });

    await pause(STEP_MS);
    // (The 仮払い notice only counts as sent when it wasn't on the page before pressing.)
    const noticeBefore = await inPage(tabId, () => /仮払いを(おこな|行な|行)ってから.{0,6}作業を開始/.test((document.body?.innerText || "").replace(/\s+/g, ""))).catch(() => false);
    const pressed = await inPage(tabId, pressCrowdworksSend).catch(() => null); // empty: the page is already moving on
    if (pressed && !pressed.ok) return fail(pressed.reason, { accountId });

    await pause(AFTER_CLICK_MS);
    const result = await inPageAcrossLoads(tabId, waitCrowdworksResult, [!!noticeBefore], 30000);
    if (!result) return fail("Pressed send, but CrowdWorks showed no answer", { accountId });
    if (!result.ok) return fail(result.reason, { accountId });
    return { ok: true, reason: "", accountId, url };
  });
}

export async function sendCoconalaDm(site, request) {
  if (!/coconala\.com\/(users\/\d+|mypage\/direct_messages?\/\d+)/.test(request.url)) {
    return { ok: false, reason: "Not a Coconala client page (https://coconala.com/users/<number>)" };
  }
  return inLoadedTab(request.url, site, async (tabId, fail) => {
    const accountId = await readAccountIdInPage(tabId, site);
    if (!COCONALA_DM_WINDOW.test((await chrome.tabs.get(tabId)).url)) {
      // The client's page: メッセージを送る opens the message window (kept in this tab).
      await keepInTab(tabId);
      await pause(STEP_MS);
      const pressed = await inPage(tabId, pressCoconalaMessageButton).catch(() => null);
      if (pressed && !pressed.ok) return fail(pressed.reason, { unavailable: !!pressed.unavailable, accountId });
      await pause(AFTER_CLICK_MS);
      if (!(await waitForTab(tabId, url => COCONALA_DM_WINDOW.test(url), 30000))) {
        return fail("Pressed メッセージを送る, but the message window (/mypage/direct_message/…) did not open", { accountId });
      }
      if (!(await waitForDocument(tabId, 30000))) return fail("The message window did not finish loading", { accountId });
    }
    await keepInTab(tabId);

    await pause(STEP_MS);
    const typed = await inPage(tabId, typeCoconalaMessage, [request.message]).catch(() => null);
    if (!typed) return fail("The message window reloaded while the message was being entered", { accountId });
    if (!typed.ok) return fail(typed.reason, { accountId });

    await pause(STEP_MS);
    const pressed = await inPage(tabId, pressCoconalaSend).catch(() => null);
    if (pressed && !pressed.ok) return fail(pressed.reason, { accountId });

    await pause(AFTER_CLICK_MS);
    const result = await inPageAcrossLoads(tabId, waitCoconalaResult, [request.message], 30000);
    if (!result) return fail("Pressed メッセージを送信, but Coconala showed no answer", { accountId });
    if (!result.ok) return fail(result.reason, { accountId });
    return { ok: true, reason: "", accountId, url: (await chrome.tabs.get(tabId)).url };
  });
}

// Opens `url` in a background tab and waits until it has loaded completely; `work(tabId, fail)` runs
// there. The tab is always closed afterwards.
async function inLoadedTab(url, site, work) {
  const tab = await openHiddenTab(url);
  const fail = async (reason, extra = {}) => ({ ok: false, ...extra, reason: await describeFailure(tab.id, reason) });
  try {
    const loaded = await waitForTab(tab.id, () => true, 60000);
    if (!loaded) return await fail("The page did not load");
    if (site.loginUrlPattern.test(new URL(loaded).pathname)) return { ok: false, reason: `Not signed in to ${site.name} in this browser` };
    if (!(await waitForDocument(tab.id, 30000))) return await fail("The page did not finish loading");
    return await work(tab.id, fail);
  } catch (err) {
    return { ok: false, reason: err.message };
  } finally {
    closeHiddenTab(tab);
  }
}

// ---- Functions below run inside the site's page, so they must be self-contained. ----

// Types the message into the job page's 相談 box. If the box is there but hidden, the button that
// shows it is clicked first (then `afterClickMs` is waited).
async function typeCrowdworksMessage(message, afterClickMs) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const findBox = () => document.querySelector("textarea#message_body, textarea[name='message[body]']");
  let box = null;
  for (let i = 0; i < 60 && !box; i++) {
    box = findBox();
    if (!box) await sleep(250);
  }
  if (!box) {
    const closed = /募集(は|を)?終了|募集期間(は|が)?終了|受付(は|を)?終了|掲載(は|を)?終了|この(仕事|依頼)は(存在しません|見つかりません|削除)/.test(document.body.innerText);
    return { ok: false, unavailable: closed, reason: closed ? "This job is closed — no message box" : "The message box (このお仕事に…相談) was not found on the job page" };
  }
  if (!visible(box)) {
    const OPEN = /相談する|メッセージで相談|メッセージを送る|質問する|問い合わせ/;
    const opener = [...document.querySelectorAll("a, button, [role='button']")]
      .find(el => visible(el) && !el.closest("header, nav, footer") && OPEN.test(el.textContent));
    if (opener) {
      opener.scrollIntoView({ block: "center" });
      opener.click();
      await sleep(afterClickMs);
    }
    if (!visible(box)) return { ok: false, reason: "The message box is on the job page but hidden" };
  }
  if (box.disabled || box.readOnly) return { ok: false, unavailable: true, reason: "The message box is switched off for this job" };

  box.scrollIntoView({ block: "center" });
  box.focus();
  const typed = document.execCommand("selectAll") && document.execCommand("insertText", false, message) && box.value === message;
  if (!typed) {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(box, message);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  }
  box.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "a" }));
  box.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(300);
  return box.value === message ? { ok: true } : { ok: false, reason: "The message could not be entered into the message box" };
}

// The send button of the form the 相談 box belongs to.
async function pressCrowdworksSend() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const box = document.querySelector("textarea#message_body, textarea[name='message[body]']");
  if (!box) return { ok: false, reason: "The message box disappeared before sending" };
  const SEND = /送信|送る|相談する|メッセージを送|submit|send/i;
  const label = b => (b.value || b.textContent || b.getAttribute("aria-label") || "").trim();
  let button = null;
  for (let i = 0; i < 40 && !button; i++) {
    const scopes = [box.form, box.closest("form"), box.parentElement?.parentElement?.parentElement].filter(Boolean);
    for (const scope of scopes) {
      const buttons = [...scope.querySelectorAll("button, input[type='submit'], [role='button']")].filter(b => visible(b) && !b.disabled);
      button = buttons.find(b => b.type === "submit" && SEND.test(label(b))) || buttons.find(b => SEND.test(label(b))) || buttons.find(b => b.type === "submit");
      if (button) break;
    }
    if (!button) await sleep(250);
  }
  if (!button) return { ok: false, reason: "The message box's send button was not found or stayed disabled" };
  button.scrollIntoView({ block: "center" });
  button.click();
  return { ok: true };
}

// Waits for CrowdWorks' answer: the success notice, or an error.
async function waitCrowdworksResult(noticeBefore) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  for (let i = 0; i < 80; i++) {
    const success = [...document.querySelectorAll(".result_message.cw-alert_success, .cw-alert_success")].find(visible);
    // (CrowdWorks' "【注意】…仮払いをおこなってから、作業を開始してください。" notice also means it went out.)
    const page = document.body.innerText;
    if (success || /メッセージありがとうございます/.test(page) || !noticeBefore && /仮払いを(おこな|行な|行)ってから.{0,6}作業を開始/.test(page.replace(/\s+/g, ""))) return { ok: true };
    const error = [...document.querySelectorAll(".cw-alert_danger, .cw-alert_error, .cw-alert_warning, .result_message:not(.cw-alert_success), .error_message, .field_with_errors")]
      .find(el => visible(el) && el.textContent.trim() && !/仮払い|※/.test(el.textContent));
    if (error) return { ok: false, reason: `CrowdWorks:${error.textContent.replace(/\s+/g, " ").trim().slice(0, 200)}` };
    await sleep(250);
  }
  return { ok: false, reason: "Pressed send, but CrowdWorks didn't show メッセージありがとうございます" };
}

// The client page's メッセージを送る button (the PC and phone layouts both have one; the visible one).
async function pressCoconalaMessageButton() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const TEXT = /メッセージを送る|メッセージを送信|メッセージで相談|ダイレクトメッセージ/;
  const find = () => [...document.querySelectorAll("button, a[href], [role='button']")]
    .filter(el => visible(el) && !el.closest("header, nav, footer") && TEXT.test(el.textContent.replace(/\s+/g, "")))
    .sort((a, b) => a.textContent.length - b.textContent.length)[0];
  let button = null;
  for (let i = 0; i < 60 && !button; i++) {
    button = find();
    if (!button) await sleep(250);
  }
  if (!button) return { ok: false, unavailable: true, reason: "This user's page has no メッセージを送る button" };
  if (button.disabled || button.getAttribute("aria-disabled") === "true") return { ok: false, unavailable: true, reason: "メッセージを送る is disabled for this user" };
  button.scrollIntoView({ block: "center" });
  if (button.target) button.target = "_self";
  for (const type of ["mousedown", "mouseup"]) button.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  button.click();
  return { ok: true };
}

// Types the message into the message window's box (textarea#DirectMessageBody).
async function typeCoconalaMessage(message) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  let box = null;
  for (let i = 0; i < 80 && !box; i++) {
    box = [...document.querySelectorAll("textarea#DirectMessageBody, textarea[name='data[DirectMessage][body]']")].find(visible) || null;
    if (!box) await sleep(250);
  }
  if (!box) return { ok: false, reason: "The message box (DirectMessageBody) was not found in the message window" };
  const max = Number(box.dataset.maxCount || 0);
  if (max && [...message].length > max) return { ok: false, reason: `The message is ${[...message].length} characters; Coconala allows at most ${max}` };
  box.scrollIntoView({ block: "center" });
  box.focus();
  const typed = document.execCommand("selectAll") && document.execCommand("insertText", false, message) && box.value === message;
  if (!typed) {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(box, message);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  }
  // The character counter (js_text-count-up) enables メッセージを送信 on these events.
  for (const type of ["keydown", "keyup"]) box.dispatchEvent(new KeyboardEvent(type, { bubbles: true, key: "a" }));
  box.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(300);
  return box.value === message ? { ok: true } : { ok: false, reason: "The message could not be entered into the message box" };
}

// <div class="bl_message-button"><button class="… js_text-count-up-submit js_handle-submit" disabled>メッセージを送信</button></div>
async function pressCoconalaSend() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const find = () => [...document.querySelectorAll(".bl_message-button button.js_handle-submit, .bl_message-button button, button.js_text-count-up-submit")].find(visible);
  let button = null;
  for (let i = 0; i < 40; i++) {
    button = find();
    if (button && !button.disabled) break;
    // Still disabled: let the counter see the text again.
    document.querySelector("textarea#DirectMessageBody")?.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "a" }));
    await sleep(250);
  }
  if (!button) return { ok: false, reason: "The メッセージを送信 button was not found" };
  if (button.disabled) return { ok: false, reason: "メッセージを送信 stayed disabled" };
  try { sessionStorage.setItem("fac-dm-sent", String(Date.now())); } catch { /* storage blocked */ }
  button.scrollIntoView({ block: "center" });
  button.click();
  return { ok: true };
}

// Sent once the box has emptied (or the page reloaded after sending) and the text shows in the
// conversation; an error or warning on the page is a failure.
async function waitCoconalaResult(message) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const start = message.replace(/\s+/g, "").slice(0, 30);
  const sentAt = Number((() => { try { return sessionStorage.getItem("fac-dm-sent"); } catch { return 0; } })()) || 0;
  for (let i = 0; i < 80; i++) {
    const box = document.querySelector("textarea#DirectMessageBody, textarea[name='data[DirectMessage][body]']");
    const error = [...document.querySelectorAll(".c-errorMessage, .error-message, .errorMessage, [class*='alert' i][class*='danger' i], .js_error-message")]
      .find(el => visible(el) && el.textContent.trim());
    if (error) return { ok: false, reason: `Coconala: ${error.textContent.replace(/\s+/g, " ").trim().slice(0, 200)}` };
    const shown = [...document.querySelectorAll("p, div, span, pre")]
      .some(el => el.children.length === 0 && !el.closest("textarea") && el.textContent.replace(/\s+/g, "").includes(start));
    const emptied = !box || box.value.trim() === "";
    if (emptied && (shown || Date.now() - sentAt < 120000)) return { ok: true };
    await sleep(250);
  }
  return { ok: false, reason: "Pressed メッセージを送信, but the message didn't go out (it is still in the box)" };
}
