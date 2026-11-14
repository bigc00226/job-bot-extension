// Drives a Coconala offer in a background tab (https://coconala.com/offers/add/<id>):
//   form (.bl_offer-form) → fill 提案内容 (#OfferContent), 提案金額 (data[Offer][price]),
//   date (#OfferExpireDate picker) → press the first .frontButton
//   → once the confirm view (article.bl_offer-detail.-confirm) shows the entered values,
//   press its .frontButton to send.
// Returns { ok, reason, accountId }.
import { waitForTab, waitForDocument, inPage, inPageAcrossLoads, describeFailure, readAccountIdInPage, proposalUnavailable, STEP_MS, AFTER_CLICK_MS, pause, openHiddenTab, closeHiddenTab } from "./tab-utils.js";

const SEND_DELAY_MS = 3000;

export async function runCoconalaOffer(order, site) {
  // Opened as a background tab so the screen you're on never switches.
  const tab = await openHiddenTab(order.url);
  const onForm = url => url.includes("/offers/");
  // (A request without a proposal feature is reported as Unavailable, not Failure.)
  const fail = async reason => ({ ok: false, reason: await describeFailure(tab.id, reason), unavailable: await proposalUnavailable(tab.id, onForm), accountId });
  let accountId = "";
  const onOfferPage = url => url.includes(`/offers/add/${order.jobId}`);

  try {
    // Landing anywhere else means Coconala sent the tab away: the request takes no offers.
    const start = await waitForTab(tab.id, url => onOfferPage(url) || /\/login/.test(url) || (/^https:/.test(url) && !onForm(url)), 60000, { requireComplete: false });
    if (!start) return await fail("The offer page did not open");
    if (/\/login/.test(start)) return await fail("Not signed in to Coconala in this browser");
    if (!onForm(start)) return await fail("This request has no offer form (Coconala opened another page)");
    if (!(await waitForDocument(tab.id, 30000))) return await fail("The offer page did not finish loading");

    accountId = await readAccountIdInPage(tab.id, site);

    // ~2 s before and between every input / selection (STEP_MS), ~3 s after each click (AFTER_CLICK_MS).
    await pause(STEP_MS);
    const filled = await inPage(tab.id, fillCoconalaOffer, [order, STEP_MS]).catch(() => null);
    if (!filled) return await fail("The offer page reloaded while the form was being filled");
    if (!filled.ok) return await fail(filled.reason);

    // Give the page a moment after all input before pressing the button.
    await new Promise(r => setTimeout(r, SEND_DELAY_MS));
    // The first Apply can load a new page for the confirm step; an empty result here means
    // the click already started that navigation, so it counts as pressed.
    const toConfirm = await inPage(tab.id, pressFrontButton, ["form"]).catch(() => null);
    if (toConfirm && !toConfirm.ok) return await fail(toConfirm.reason);
    await pause(AFTER_CLICK_MS);

    // Waits on whichever page ends up showing the confirm view (same page or newly loaded).
    const confirmed = await inPageAcrossLoads(tab.id, checkConfirmView, [order]);
    if (!confirmed) return await fail("The confirm view did not load after the first Apply");
    if (!confirmed.ok) return await fail(confirmed.reason);
    const confirmUrl = (await chrome.tabs.get(tab.id)).url;

    await pause(STEP_MS);
    const sent = await inPage(tab.id, pressFrontButton, ["confirm"]).catch(() => null);
    if (sent && !sent.ok) return await fail(sent.reason);
    await pause(AFTER_CLICK_MS);

    // Coconala then shows a notice window (prohibited actions: 脅迫行為, 差別行為 … 必要な措置)
    // with one more 応募する button at the bottom; press it when it appears.
    // An empty result means the page already moved on, so there was no window to press.
    const notice = await inPage(tab.id, pressNoticeApply, [15000, STEP_MS]).catch(() => null);
    if (notice && !notice.ok) return await fail(notice.reason);

    // Sent once the page moves on from the confirm step, or the form and confirm view are both gone.
    const end = Date.now() + 30000;
    while (Date.now() < end) {
      const tabNow = await chrome.tabs.get(tab.id);
      if (tabNow.url && tabNow.url !== confirmUrl && !onOfferPage(tabNow.url)) return { ok: true, reason: "", accountId };
      const view = await inPage(tab.id, currentView).catch(() => "loading");
      if (view === "form") return await fail("Coconala returned to the form after sending — check the entries");
      if (view === "done") return { ok: true, reason: "", accountId };
      await new Promise(r => setTimeout(r, 500));
    }
    return await fail("Pressed the confirm button but the page did not move on");
  } catch (err) {
    return { ok: false, reason: err.message, accountId };
  } finally {
    // The opened page is always closed, whether the offer succeeded or not.
    closeHiddenTab(tab);
  }
}

// ---- Functions below run inside the Coconala page, so they must be self-contained. ----

function currentView() {
  // A page still loading may not have its form/confirm view yet; don't mistake it for "done".
  if (document.readyState === "loading") return "loading";
  // A completion message on the page itself counts as sent.
  if (/(応募|提案|送信)が完了/.test(document.body.innerText)) return "done";
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  // The form is showing when its input fields are. The confirm screen has no input fields,
  // just the entered values and an 応募する button (plus "入力内容を修正する").
  if (visible(document.querySelector("#OfferContent, textarea[name='data[Offer][content]'], input[name='data[Offer][price]']"))) return "form";
  const applyButton = [...document.querySelectorAll(".frontButton, button, a, input[type='submit'], [role='button']")]
    .some(el => visible(el) && /応募する|提案する/.test(el.value || el.textContent));
  if (visible(document.querySelector("article.bl_offer-detail.-confirm")) || applyButton) return "confirm";
  return "done";
}

// `stepMs` is waited after each field is entered and each date-picker click.
async function fillCoconalaOffer(order, stepMs) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const waitFor = async (find, ms = 30000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const found = find();
      if (found) return found;
      await sleep(250);
    }
    return null;
  };
  // Native setter plus the events Coconala's scripts (counters, price formatting) listen for.
  const setValue = (input, value) => {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    input.focus();
    Object.getOwnPropertyDescriptor(proto, "value").set.call(input, value);
    for (const type of ["input", "keyup", "change"]) input.dispatchEvent(new Event(type, { bubbles: true }));
    input.blur();
  };

  if (!order.proposal) return { ok: false, reason: "No 提案文 in the order" };
  if (!order.amount) return { ok: false, reason: "No 提案金額 / 契約金額 in the order" };
  if (!order.date) return { ok: false, reason: "No date (期日 / 完了予定日) in the order" };

  // All three fields are found before anything is typed, so a missing one never leaves the form half-filled.
  const form = await waitFor(() => document.querySelector(".bl_offer-form"));
  if (!form) return { ok: false, reason: "Offer form (.bl_offer-form) not found — nothing was entered" };
  const content = form.querySelector("#OfferContent") || form.querySelector('textarea[name="data[Offer][content]"]');
  const price = form.querySelector('input[name="data[Offer][price]"]');
  const dateInput = form.querySelector("#OfferExpireDate");
  const missing = [!content && "提案内容", !price && "提案金額", !dateInput && "date"].filter(Boolean);
  if (missing.length) return { ok: false, reason: `Field(s) not found: ${missing.join(", ")} — nothing was entered` };

  const min = Number(content.dataset.minCount || 0);
  const max = Number(content.dataset.maxCount || Infinity);
  if (order.proposal.length < min) return { ok: false, reason: `提案文 is ${order.proposal.length} characters; Coconala needs at least ${min}` };
  if (order.proposal.length > max) return { ok: false, reason: `提案文 is ${order.proposal.length} characters; Coconala allows at most ${max}` };

  setValue(content, order.proposal);
  await sleep(stepMs);
  setValue(price, order.amount);
  await sleep(stepMs);

  // The date field is a read-only pickadate picker: open it, move to the month, click the day.
  // pickadate marks each day with data-pick = that day's local-midnight timestamp.
  const { year, month, day } = order.date;
  const target = new Date(year, month - 1, day).getTime();
  dateInput.click();
  dateInput.focus();
  await sleep(stepMs);
  const root = await waitFor(() => {
    const el = document.getElementById(`${dateInput.id}_root`);
    return el?.querySelector(".picker__day") ? el : null;
  }, 10000);
  if (!root) return { ok: false, reason: "Date picker did not open" };

  let cell = null;
  for (let i = 0; i < 36 && !cell; i++) {
    cell = root.querySelector(`.picker__day[data-pick="${target}"]:not(.picker__day--outfocus)`);
    if (cell) break;
    const shown = Number(root.querySelector(".picker__day--infocus")?.dataset.pick || 0);
    const nav = root.querySelector(target > shown ? ".picker__nav--next" : ".picker__nav--prev");
    if (!nav || nav.classList.contains("picker__nav--disabled")) break;
    nav.click();
    await sleep(stepMs);
  }
  if (!cell) return { ok: false, reason: `${year}/${month}/${day} is not in the date picker` };
  if (cell.classList.contains("picker__day--disabled")) return { ok: false, reason: `${year}/${month}/${day} can't be selected on Coconala` };
  cell.click();
  await sleep(stepMs);
  const selected = root.querySelector(`.picker__day--selected[data-pick="${target}"]`);
  if (!dateInput.value || !selected) return { ok: false, reason: `Could not select ${year}/${month}/${day} (field shows "${dateInput.value}")` };
  root.querySelector(".picker__button--close")?.click();

  // Re-check after the page's scripts have run that nothing was reset.
  await sleep(stepMs);
  if (content.value !== order.proposal) return { ok: false, reason: "提案内容 was changed after entry" };
  if (price.value.replace(/\D/g, "") !== order.amount) return { ok: false, reason: `提案金額 shows ${price.value}, expected ${order.amount}` };
  return { ok: true };
}

// Presses the visible .frontButton of the given stage ("form" → go to confirm, "confirm" → send).
// Both buttons can carry the same label ("Apply"), so they are told apart by position, not text:
// the confirm-stage button is the one inside the confirm view, or else the first one after it.
// The form-stage button is the one inside the form (or the last one on the page).
async function pressFrontButton(stage) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const BACK = /戻る|修正|編集|キャンセル/;
  const end = Date.now() + 20000;
  let seen = [];
  while (Date.now() < end) {
    const confirmView = document.querySelector("article.bl_offer-detail.-confirm");
    const confirmShown = !!confirmView && visible(confirmView);
    const buttons = [...document.querySelectorAll(".frontButton")].filter(b => visible(b) && !BACK.test(b.textContent));
    seen = buttons.map(b => b.textContent.replace(/\s+/g, " ").trim());
    let button = null;

    if (stage === "form" && !confirmShown) {
      const form = document.querySelector(".bl_offer-form");
      button = buttons.find(b => form?.contains(b)) || buttons.at(-1);
    }
    if (stage === "confirm") {
      // Confirm screen = no input fields left, just the values and the 応募する button
      // (which isn't necessarily a .frontButton). "入力内容を修正する" is excluded by BACK.
      const formShown = [...document.querySelectorAll("#OfferContent, textarea[name='data[Offer][content]'], input[name='data[Offer][price]']")].some(visible);
      if (!formShown || confirmShown) {
        const applies = [...document.querySelectorAll(".frontButton, button, a, input[type='submit'], [role='button']")]
          .filter(b => visible(b) && !BACK.test(b.value || b.textContent) && /応募する|提案する/.test(b.value || b.textContent));
        // Keep the innermost element of nested matches (e.g. <div class="frontButton"><a>応募する</a></div>).
        const innermost = applies.filter(b => !applies.some(other => other !== b && b.contains(other)));
        seen = innermost.map(b => (b.value || b.textContent).replace(/\s+/g, " ").trim());
        const after = b => confirmView && confirmView.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING;
        button = (confirmShown && (innermost.filter(b => confirmView.contains(b)).at(-1) || innermost.find(after))) || innermost.at(-1);
      }
    }

    if (button && !button.matches(".is-disabled, .-disabled, [aria-disabled='true']")) {
      button.scrollIntoView({ block: "center" });
      const target = button.querySelector("a, button, input[type='submit']") || button;
      // Some handlers listen for mousedown/mouseup rather than click; send the full sequence (one click).
      for (const type of ["mousedown", "mouseup"]) target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      target.click();
      // Marked so the notice-window step never mistakes this button for the window's own.
      target.dataset.facPressed = "1";
      button.dataset.facPressed = "1";
      return { ok: true };
    }
    await sleep(250);
  }
  return { ok: false, reason: `Could not find the ${stage === "confirm" ? "応募する button on the confirm screen" : "form's first Apply .frontButton"} — visible buttons: ${seen.join(" | ") || "none"}` };
}

// After the confirm screen's 応募する, Coconala shows a small notice window listing prohibited
// actions (脅迫行為, 差別行為 …, "…警告等の必要な措置を取らせていただきます") with another
// 応募する button at the bottom. Waits up to `timeoutMs` for it and presses that button.
// Returns { ok, pressed } — pressed is false when no window appeared. `stepMs` is waited once the
// window is there, before its button is pressed.
async function pressNoticeApply(timeoutMs, stepMs) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const ownText = el => [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join("");
  const MARKERS = ["必要な措置", "脅迫行為", "差別行為"];
  const APPLY = /応募する|提案する|送信する/;
  const BACK = /戻る|修正|編集|キャンセル|閉じる/;
  const CLICKABLE = ".frontButton, button, a, input[type='submit'], [role='button']";
  const label = el => (el.value || el.textContent).replace(/\s+/g, " ").trim();

  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const marker = [...document.querySelectorAll("body *")].find(el => visible(el) && MARKERS.some(m => ownText(el).includes(m)));
    // Climb from the notice text to the smallest block that also holds an apply button: the window itself.
    for (let node = marker?.parentElement; node && node !== document.body; node = node.parentElement) {
      const applies = [...node.querySelectorAll(CLICKABLE)]
        .filter(b => visible(b) && !b.closest("[data-fac-pressed]") && !BACK.test(label(b)) && APPLY.test(label(b)));
      const innermost = applies.filter(b => !applies.some(other => other !== b && b.contains(other)));
      if (!innermost.length) continue;
      const button = innermost.at(-1);
      button.scrollIntoView({ block: "center" });
      await sleep(stepMs);
      for (const type of ["mousedown", "mouseup"]) button.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      button.click();
      return { ok: true, pressed: true };
    }
    if (marker && Date.now() > end - 1000) return { ok: false, reason: "The notice window appeared but its 応募する button was not found" };
    await sleep(250);
  }
  return { ok: true, pressed: false };
}

// Waits for the confirm screen (no input fields, an 応募する button) and checks it shows what
// was entered: 提案額, 納品予定日 and the start of the 提案内容. Nothing is sent if any differs.
async function checkConfirmView(order) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const squash = text => (text || "").replace(/\s+/g, "");
  const pad = n => String(n).padStart(2, "0");
  const { year, month, day } = order.date;
  const dates = [`${year}/${pad(month)}/${pad(day)}`, `${year}/${month}/${day}`, `${year}年${month}月${day}日`, `${year}年${pad(month)}月${pad(day)}日`];

  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const formShown = [...document.querySelectorAll("#OfferContent, textarea[name='data[Offer][content]'], input[name='data[Offer][price]']")].some(visible);
    const article = document.querySelector("article.bl_offer-detail.-confirm");
    const applyShown = [...document.querySelectorAll(".frontButton, button, a, input[type='submit'], [role='button']")]
      .some(el => visible(el) && /応募する|提案する/.test(el.value || el.textContent));
    if (visible(article) || (!formShown && applyShown)) {
      await sleep(500); // let the values finish rendering
      const text = squash((visible(article) ? article : document.body).innerText);
      const missing = [
        !text.replace(/[,，]/g, "").includes(order.amount) && `提案額 ${order.amount}`,
        !dates.some(d => text.includes(d)) && `納品予定日 ${dates[0]}`,
        !text.includes(squash(order.proposal).slice(0, 30)) && "提案内容",
        // (Its end too, so a cut text is never sent.)
        text.includes(squash(order.proposal).slice(0, 30)) && !text.includes(squash(order.proposal).slice(-30)) && "提案内容 (only part of it)"
      ].filter(Boolean);
      if (!missing.length) return { ok: true };
      return { ok: false, reason: `Confirm screen doesn't show the entered ${missing.join(", ")} — not sent` };
    }
    await sleep(250);
  }
  return { ok: false, reason: "The confirm screen (応募する) did not appear — not sent" };
}
