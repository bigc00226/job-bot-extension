// Drives a CrowdWorks proposal in a background tab (https://crowdworks.jp/proposals/new?job_offer_id=<id>).
// The form shows the kind of job:
//   hourly      → 時間単価（税抜） (hourly_wage_dummy[]), then 稼働時間/週 (hours_limit), then the message;
//   fixed price → 金額 (amount_dummy[]), then the 納期 year / month / day menus, then the message;
// then 応募する (input[name="commit"]) → success once the page becomes /proposals/<number>
// (e.g. /proposals/310395166?proposal_ref=create).
// The opened page is always closed afterwards. Returns { ok, reason, accountId }.
import { waitForTab, waitForDocument, inPage, describeFailure, readAccountIdInPage, proposalUnavailable, STEP_MS, openHiddenTab, closeHiddenTab } from "./tab-utils.js";

const SEND_DELAY_MS = 3000;
const isNewForm = url => url.includes("/proposals/new");
const isCreated = url => /\/proposals\/\d+/.test(url);
// The form, or the form shown again with errors after 応募する (/proposals).
const onForm = url => /crowdworks\.jp\/proposals(?:\/new)?(?:[?#]|$)/.test(url);

export async function runCrowdworksProposal(order, site) {
  // Opened as a background tab so the screen you're on never switches.
  const tab = await openHiddenTab(order.url);
  // (A job without a proposal feature is reported as Unavailable, not Failure.)
  const fail = async reason => ({ ok: false, reason: await describeFailure(tab.id, reason), unavailable: await proposalUnavailable(tab.id, onForm), accountId, mode });
  let accountId = "", mode = "", note = "";

  try {
    // Landing anywhere else means CrowdWorks sent the tab away: the job takes no proposals.
    const start = await waitForTab(tab.id, url => isNewForm(url) || /\/login/.test(url) || (/^https:/.test(url) && !onForm(url)), 60000, { requireComplete: false });
    if (!start) return await fail("The proposal page did not open");
    if (/\/login/.test(start)) return await fail("Not signed in to CrowdWorks in this browser");
    if (!isNewForm(start)) return await fail("This job has no proposal form (CrowdWorks opened another page)");
    if (!(await waitForDocument(tab.id, 30000))) return await fail("The proposal page did not finish loading");

    accountId = await readAccountIdInPage(tab.id, site);

    await new Promise(r => setTimeout(r, STEP_MS));
    const filled = await inPage(tab.id, fillCrowdworksProposal, [order, STEP_MS]).catch(() => null);
    if (!filled) return await fail("The proposal page reloaded while the form was being filled");
    if (!filled.ok) return await fail(filled.reason);
    mode = filled.mode;
    note = filled.note || "";

    // Give the page a moment after all input before pressing 応募する.
    await new Promise(r => setTimeout(r, SEND_DELAY_MS));
    // (Only a notice that appears after pressing counts as success below.)
    const noticeBefore = await inPage(tab.id, prepaymentNoticeShown).catch(() => false);
    const pressed = await inPage(tab.id, pressApply).catch(() => null); // empty = the page already started moving on
    if (pressed && !pressed.ok) return await fail(pressed.reason);

    // Sent once the page becomes the created proposal, or CrowdWorks shows its notice
    // "【注意】…クライアントが仮払いをおこなってから、作業を開始してください。" (also a success).
    const end = Date.now() + 30000;
    while (Date.now() < end) {
      const now = await chrome.tabs.get(tab.id);
      if (isCreated(now.url || "")) return { ok: true, reason: note, accountId, mode };
      if (!noticeBefore && await inPage(tab.id, prepaymentNoticeShown).catch(() => false)) return { ok: true, reason: note, accountId, mode };
      await new Promise(r => setTimeout(r, 500));
    }
    return await fail("Pressed 応募する but the page did not move on to the created proposal");
  } catch (err) {
    return { ok: false, reason: err.message, accountId };
  } finally {
    // The opened page is always closed, whether the proposal succeeded or not.
    closeHiddenTab(tab);
  }
}

// ---- Functions below run inside the CrowdWorks page, so they must be self-contained. ----

// CrowdWorks' notice after a proposal or message has gone out:
// "【注意】契約が成立した場合でも、クライアントが仮払いをおこなってから、作業を開始してください。"
function prepaymentNoticeShown() {
  const text = (document.body?.innerText || "").replace(/\s+/g, "");
  return /仮払いを(おこな|行な|行)ってから.{0,6}作業を開始/.test(text);
}

// `stepMs` is waited after each value typed or chosen.
async function fillCrowdworksProposal(order, stepMs) {
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
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden" && !el.disabled;
  // Enter text the way typing does — the browser's own text insertion fires the same input
  // events as a keyboard, so the page's scripts (which copy the amount into the field that is
  // actually sent) register it. Falls back to setting the value directly.
  const type = async (input, value) => {
    input.scrollIntoView({ block: "center" });
    input.focus();
    input.select?.();
    const typed = document.execCommand("selectAll") && document.execCommand("insertText", false, value) && input.value === value;
    if (!typed) {
      const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    for (const key of ["keydown", "keyup"]) input.dispatchEvent(new KeyboardEvent(key, { bubbles: true, key: "0", code: "Digit0" }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.blur();
    input.dispatchEvent(new Event("blur", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await sleep(stepMs);
  };
  // The visible "…_dummy[]" box is copied by the page into a hidden field that is what gets sent
  // (an empty copy is why CrowdWorks answered "金額は0より大きい値を入力してください").
  // If the page's script didn't fill that copy, fill it too.
  const fillHiddenCopy = (dummy, pattern, value) => {
    const scope = dummy.closest(".cw-form_group, fieldset, li, tr, .proposal_condition, form") || document;
    for (const hidden of scope.querySelectorAll('input[type="hidden"], input:not([type])')) {
      if (hidden === dummy || !pattern.test(hidden.name || "") || /dummy/.test(hidden.name)) continue;
      if (!hidden.value || Number(hidden.value) === 0) {
        hidden.value = value;
        hidden.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
  };

  // Select menus: pick the option by its value and fire change.
  const choose = async (select, value) => {
    const option = [...select.options].find(o => o.value === String(value));
    if (!option) return false;
    select.scrollIntoView({ block: "center" });
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, option.value);
    for (const kind of ["input", "change"]) select.dispatchEvent(new Event(kind, { bubbles: true }));
    await sleep(stepMs);
    return select.value === option.value;
  };

  if (!order.amount) return { ok: false, reason: "No price (時間単価 / 単価 / 契約金額) in the order" };
  if (!order.proposal) return { ok: false, reason: "No 提案文 (message) in the order" };

  // The form shows which kind of job this is: hourly jobs show the 時間単価（税抜） box, fixed-price
  // (piece-rate) jobs show the 契約金額 box and the 完了予定日 menus. The page contains both forms
  // and hides the one that doesn't apply, so only the visible one counts.
  const findWage = () => [...document.querySelectorAll('input.user_input_hourly_wage[name="hourly_wage_dummy[]"], input#hourly_wage_dummy_')].find(visible);
  const findBudget = () => [...document.querySelectorAll('input.user_input_budget[name="amount_dummy[]"], input#amount_dummy_')].find(visible);
  await waitFor(() => findWage() || findBudget());
  const wage = findWage(), budget = findBudget();
  const message = [...document.querySelectorAll("#proposal_conditions_attributes_0_message_attributes_body, textarea.message_body_for_reply")].find(visible);

  if (wage) {
    // ---- Hourly: 時間単価, then 稼働時間/週, then the message ----
    if (!order.hours) return { ok: false, reason: "This is an hourly job, but the order has no 稼働時間 (hours per week)" };
    const hours = [...document.querySelectorAll("#proposal_conditions_attributes_0_hours_limit, input.hours_limit")].find(visible);
    const missing = [!hours && "稼働時間/週", !message && "メッセージ"].filter(Boolean);
    if (missing.length) return { ok: false, reason: `Field(s) not found: ${missing.join(", ")} — nothing was entered` };

    await type(wage, order.amount);
    fillHiddenCopy(wage, /hourly_wage/, order.amount);
    await type(hours, order.hours);
    await type(message, order.proposal);

    await sleep(800); // check nothing was reset by the page's scripts
    if (wage.value.replace(/\D/g, "") !== order.amount) return { ok: false, reason: `時間単価 shows "${wage.value}", expected ${order.amount}` };
    if (hours.value.replace(/\D/g, "") !== order.hours) return { ok: false, reason: `稼働時間 shows "${hours.value}", expected ${order.hours}` };
    if (message.value.trim() !== order.proposal.trim()) return { ok: false, reason: "The message was changed after entry" };
    return { ok: true, mode: "hourly" };
  }

  if (budget) {
    // ---- Fixed price: 契約金額（税抜）, then 完了予定日 (optional: year / month / day), then the message ----
    if (!message) return { ok: false, reason: "Field not found: メッセージ — nothing was entered" };
    // The 完了予定日 menus that belong to the visible 契約金額 box (the hidden form has its own).
    const near = selector => {
      const all = [...document.querySelectorAll(selector)];
      return all.find(visible) || all[0] || null;
    };
    const year = near('select[id$="_deadline_1i"], select[name$="[deadline(1i)]"]');
    const month = near('select[id$="_deadline_2i"], select[name$="[deadline(2i)]"]');
    const day = near('select[id$="_deadline_3i"], select[name$="[deadline(3i)]"]');
    // 完了予定日 is optional: chosen when the order has a date the menus can show, otherwise left empty.
    let note = "";
    let date = order.date;
    if (!date) note = "完了予定日 not in the order — left empty (optional)";
    else if (!year || !month || !day) { note = "完了予定日 menus not found — left empty"; date = null; }
    else if (![...year.options].some(o => o.value === String(date.year))) { note = `${date.year} isn't offered for 完了予定日 — left empty (optional)`; date = null; }

    // One step at a time: each value is checked right after it's entered (and retried once)
    // before moving on to the next field.
    const amountIn = () => budget.value.replace(/\D/g, "") === order.amount;
    await type(budget, order.amount);
    if (!amountIn()) await type(budget, order.amount);
    if (!amountIn()) return { ok: false, reason: `契約金額 shows "${budget.value}", expected ${order.amount}` };
    fillHiddenCopy(budget, /amount|budget/, order.amount);

    if (date) {
      for (const [select, value, label] of [[year, date.year, "年"], [month, date.month, "月"], [day, date.day, "日"]]) {
        if (!(await choose(select, value)) && !(await choose(select, value))) {
          return { ok: false, reason: `Could not select ${value}${label} for 完了予定日 (${date.year}/${date.month}/${date.day})` };
        }
      }
    }

    await type(message, order.proposal);
    if (message.value.trim() !== order.proposal.trim()) await type(message, order.proposal);

    // Check everything was entered correctly before 応募する is pressed.
    await sleep(800);
    if (budget.value.replace(/\D/g, "") !== order.amount) return { ok: false, reason: `契約金額 shows "${budget.value}", expected ${order.amount}` };
    if (date && (year.value !== String(date.year) || month.value !== String(date.month) || day.value !== String(date.day))) {
      return { ok: false, reason: `完了予定日 shows ${year.value}/${month.value}/${day.value}, expected ${date.year}/${date.month}/${date.day}` };
    }
    if (message.value.trim() !== order.proposal.trim()) return { ok: false, reason: "The message was changed after entry" };
    return { ok: true, mode: "fixed", note };
  }

  return { ok: false, reason: "Neither the 時間単価 nor the 金額 field was found — nothing was entered" };
}

// Presses 応募する: <input type="submit" name="commit" class="cw-button cw-button_highlight …">.
async function pressApply() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const button = [...document.querySelectorAll('input[type="submit"][name="commit"], button[type="submit"][name="commit"]')]
      .find(b => visible(b) && !b.disabled && (b.classList.contains("cw-button_highlight") || /応募|Apply/i.test(b.value || b.textContent)));
    if (button) {
      button.scrollIntoView({ block: "center" });
      button.click();
      return { ok: true };
    }
    await sleep(250);
  }
  return { ok: false, reason: "The 応募する button was not found or stayed disabled" };
}
