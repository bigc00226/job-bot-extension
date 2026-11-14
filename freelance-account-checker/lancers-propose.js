// Drives a Lancers proposal in a background tab:
//   propose_start → fill completion date, amount (and proposal text) → 内容を確認する
//   propose_confirm → (利用規約に)同意して提案する
//   (some jobs show 同意して提案する on propose_start instead of 内容を確認する; it may lead to
//    propose_confirm or send directly, so the landing URL decides the next step)
// Returns { ok, reason, accountId }.
import { waitForTab, waitForDocument, inPage, describeFailure, readAccountIdInPage, proposalUnavailable, STEP_MS, AFTER_CLICK_MS, pause, openHiddenTab, closeHiddenTab } from "./tab-utils.js";

const CONFIRM_LABEL = "内容を確認する";
// Lancers has used both wordings for the final button (<input id="form_end" name="send" type="submit">).
const SUBMIT_LABEL = ["利用規約に同意して提案する", "同意して提案する"];
const SUBMIT_ID = "form_end";
const SEND_DELAY_MS = 3000;

// Required (必須) choice questions that only some proposal forms have. For each question whose
// heading contains `heading`, the option whose label contains one of `prefer` is chosen,
// falling back to the first option.
const REQUIRED_CHOICES = [
  { heading: "生成AI", prefer: ["使用していない", "使用しない"] }
];

// Agreement checkboxes some jobs add to the form, e.g. the NDA box
// <input type="checkbox" id="ProposalIsAgreement"> 秘密保持契約（NDA）の内容を確認し、同意します.
// Any box with that id, or whose label says 同意/agree together with one of these, is ticked.
const AGREEMENT_LABELS = ["NDA", "秘密保持", "機密保持", "規約", "Non-Disclosure", "terms"];

export async function runProposal(order, site) {
  // Opened as a background tab so the screen you're on never switches.
  const tab = await openHiddenTab(order.url);
  const onForm = url => url.includes("/work/propose_");
  // (A job without a proposal feature is reported as Unavailable, not Failure.)
  const fail = async reason => ({ ok: false, reason: await describeFailure(tab.id, reason), unavailable: await proposalUnavailable(tab.id, onForm), accountId });
  let accountId = "";

  try {
    // Only the URL is waited for here; the form itself is waited for inside the page,
    // since Lancers pages can stay "loading" long after the form is usable.
    // Landing anywhere else means Lancers sent the tab away: the job takes no proposals.
    const start = await waitForTab(tab.id, url => url.includes(`/work/propose_start/${order.jobId}`) || /\/login/.test(url) || (/^https:/.test(url) && !onForm(url)), 60000, { requireComplete: false });
    if (!start) return await fail("The proposal page did not open");
    if (/\/login/.test(start)) return await fail("Not signed in to Lancers in this browser");
    if (!onForm(start)) return await fail("This job has no proposal form (Lancers opened another page)");
    if (!(await waitForDocument(tab.id, 30000))) return await fail("The proposal page did not finish loading");

    accountId = await readAccountIdInPage(tab.id, site);

    // ~2 s before and between every input / selection (STEP_MS).
    await pause(STEP_MS);
    const filled = await inPage(tab.id, fillProposalForm, [order, STEP_MS]);
    if (!filled.ok) return await fail(filled.reason);

    const answered = await inPage(tab.id, answerRequiredChoices, [REQUIRED_CHOICES, STEP_MS]);
    if (!answered.ok) return await fail(answered.reason);

    const agreed = await inPage(tab.id, tickAgreements, [AGREEMENT_LABELS, STEP_MS]);
    if (!agreed.ok) return await fail(agreed.reason);

    // Give the page a moment after all input before pressing the send (内容を確認する) button.
    await new Promise(r => setTimeout(r, SEND_DELAY_MS));
    const textKept = await inPage(tab.id, checkProposalText, [order.proposal]);
    if (!textKept.ok) return await fail(textKept.reason);
    // On some jobs propose_start shows a 同意して提案する button (#form_end) instead of
    // 内容を確認する. Either one may lead to propose_confirm or send the proposal outright,
    // so where the tab lands decides the next step.
    const confirmClick = await inPage(tab.id, clickSubmit, [[CONFIRM_LABEL, ...SUBMIT_LABEL], SUBMIT_ID]);
    if (!confirmClick.ok) return await fail(confirmClick.reason);

    const next = await waitForTab(tab.id, url => !url.includes("/work/propose_start/"), 30000, { requireComplete: false });
    if (!next) return await fail(`Clicked "${confirmClick.label}" but the page did not move on`);
    if (!next.includes("/work/propose_confirm/")) return { ok: true, reason: "", accountId };
    if (!(await waitForDocument(tab.id, 30000))) return await fail("The propose_confirm page did not finish loading");

    // ~3 s after the previous click before the next one.
    await pause(AFTER_CLICK_MS);
    const whole = await inPage(tab.id, confirmShowsWholeProposal, [order.proposal]);
    if (!whole.ok) return await fail(whole.reason);
    const submitClick = await inPage(tab.id, clickSubmit, [SUBMIT_LABEL, SUBMIT_ID]);
    if (!submitClick.ok) return await fail(submitClick.reason);

    const done = await waitForTab(tab.id, url => !url.includes("/work/propose_confirm/"), 30000, { requireComplete: false });
    if (!done) return await fail(`Clicked "${submitClick.label}" but the page did not move on`);

    return { ok: true, reason: "", accountId };
  } catch (err) {
    return { ok: false, reason: err.message, accountId };
  } finally {
    // The opened page is always closed, whether the proposal succeeded or not.
    closeHiddenTab(tab);
  }
}

// ---- Functions below run inside the Lancers page, so they must be self-contained. ----

// `stepMs` is waited after each field is entered.
async function fillProposalForm(order, stepMs) {
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
  // React ignores plain `.value =`; use the native setter and fire the events it listens for.
  const setValue = (input, value) => {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const nearLabel = (inputs, labels) => {
    let best = null, bestDepth = Infinity;
    for (const input of inputs) {
      let node = input, depth = 0;
      while (node && depth < 8) {
        if (labels.some(l => node.textContent.includes(l))) break;
        node = node.parentElement;
        depth++;
      }
      if (node && depth < bestDepth) { best = input; bestDepth = depth; }
    }
    return best;
  };
  const digits = value => (value.match(/\d+/g) || []).map(Number);

  if (!order.date) return { ok: false, reason: "No 完了予定日 in the server message" };
  if (!order.amount) return { ok: false, reason: "No 契約金額 in the server message" };

  // --- Date and amount are only ever entered inside the Planning (計画) section. ---
  // The section is the smallest block around its heading that holds both a text and a number input.
  const SECTION_LABELS = ["計画", "計画を立てる", "プランニング", "Planning"];
  const ownText = el => [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join("").trim();
  const section = await waitFor(() => {
    const heading = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6, legend, dt, th, label, p, span, div")]
      .find(el => SECTION_LABELS.includes(ownText(el)));
    for (let node = heading?.parentElement; node && node !== document.body; node = node.parentElement) {
      if (node.querySelector('input[type="number"]') && node.querySelector('input[type="text"]')) return node;
    }
    return null;
  });
  if (!section) return { ok: false, reason: `Planning section (${SECTION_LABELS.join(" / ")}) not found — nothing was entered` };

  // Within Planning, only fields whose heading carries a 必須 (required) badge are used,
  // and nothing at or below the additional-proposal (追加提案) heading is ever touched.
  const REQUIRED_MARKS = ["必須", "required"];
  const ADDITIONAL_LABELS = ["追加提案", "追加のご提案", "追加オプション"];
  const additionalHeading = () =>
    [...document.querySelectorAll("h1, h2, h3, h4, h5, h6, legend, dt, th, label, p, span, div, strong")]
      .filter(el => !el.closest("button, a"))
      .find(el => {
        const text = ownText(el);
        return text.length <= 30 && ADDITIONAL_LABELS.some(label => text.includes(label));
      });
  // The field's block is its nearest ancestor holding a 必須 badge; the badge only counts
  // as this field's if that block contains no other input of the same kind.
  const isRequiredField = (input, kind) => {
    for (let node = input.parentElement; node && node !== document.body; node = node.parentElement) {
      const badge = [...node.querySelectorAll("*")].find(el => REQUIRED_MARKS.includes(ownText(el).toLowerCase()));
      if (badge) return node.querySelectorAll(kind).length === 1;
    }
    return false;
  };
  const allowedInputs = kind => {
    const extra = additionalHeading();
    return [...section.querySelectorAll(kind)].filter(input =>
      !(extra && extra.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING) &&
      !extra?.contains(input) &&
      isRequiredField(input, kind)
    );
  };

  // --- Completion date: required <input type="text" class="" value=""> in Planning ---
  const dateInput = await waitFor(() => {
    const texts = allowedInputs('input[type="text"]');
    const blankClass = texts.filter(i => i.getAttribute("class") === "");
    if (blankClass.length === 1) return blankClass[0];
    return nearLabel(blankClass.length ? blankClass : texts, ["完了予定日", "納品予定日", "納期"]) || (texts.length === 1 ? texts[0] : null);
  });
  if (!dateInput) return { ok: false, reason: "No required (必須) completion date field in the Planning section — nothing was entered" };

  // --- Amount: required <input type="number" step="1000" max="100000000"> next to 円 in Planning ---
  // Found before anything is typed, so a missing field never leaves the form half-filled.
  const amountInput = await waitFor(() => {
    const numbers = allowedInputs('input[type="number"]');
    return numbers.find(i => i.matches('[step="1000"][max="100000000"]')) || nearLabel(numbers, ["円"]);
  });
  if (!amountInput) return { ok: false, reason: "No required (必須) amount field in the Planning section — nothing was entered" };

  const { year, month, day } = order.date;
  const dateIsSet = () => {
    const [y, m, d] = digits(dateInput.value);
    return y === year && m === month && d === day;
  };

  // Type the date straight into the field (no calendar clicking); try common formats until one sticks.
  dateInput.scrollIntoView({ block: "center" });
  const pad = n => String(n).padStart(2, "0");
  for (const text of [`${year}/${pad(month)}/${pad(day)}`, `${year}-${pad(month)}-${pad(day)}`, `${year}年${month}月${day}日`]) {
    if (dateIsSet()) break;
    dateInput.focus();
    setValue(dateInput, "");
    setValue(dateInput, text);
    dateInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
    await sleep(300);
  }
  dateInput.blur();
  document.body.click();
  await sleep(stepMs);
  if (!dateIsSet()) return { ok: false, reason: `Could not set completion date to ${year}/${month}/${day} (field shows "${dateInput.value}")` };

  amountInput.focus();
  setValue(amountInput, "");
  setValue(amountInput, order.amount);
  amountInput.blur();
  await sleep(stepMs);

  // --- Proposal text, if the message included 提案文 ---
  if (order.proposal) {
    const textareas = [...document.querySelectorAll("textarea")];
    const textarea = nearLabel(textareas, ["提案文", "提案内容", "メッセージ"]) || textareas[0];
    if (!textarea) return { ok: false, reason: "Proposal text field not found" };
    if (textarea.maxLength > 0 && order.proposal.length > textarea.maxLength) {
      return { ok: false, reason: `提案文 is ${order.proposal.length} characters; this form allows at most ${textarea.maxLength}` };
    }
    textarea.setAttribute("data-fac-proposal", "");
    textarea.focus();
    setValue(textarea, order.proposal);
    textarea.blur();
    await sleep(stepMs);
  }

  // Re-check after React has re-rendered that nothing was reset.
  await sleep(500);
  if (!dateIsSet()) return { ok: false, reason: "Completion date was reset after entry" };
  if (Number(amountInput.value) !== Number(order.amount)) {
    return { ok: false, reason: `Amount shows ${amountInput.value}, expected ${order.amount}` };
  }
  return { ok: true };
}

// Right before the button is pressed: the 提案文 box still holds the whole proposal (the page may put
// back a saved text or cut it after entry). Entered once more if not; never sent incomplete.
async function checkProposalText(proposal) {
  if (!proposal) return { ok: true };
  const same = (a, b) => a.replace(/\r\n?/g, "\n").trim() === b.replace(/\r\n?/g, "\n").trim();
  const box = document.querySelector("textarea[data-fac-proposal]");
  if (!box) return { ok: false, reason: "The proposal text field was replaced after entry — not sent" };
  if (same(box.value, proposal)) return { ok: true };
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(box, proposal);
  box.dispatchEvent(new Event("input", { bubbles: true }));
  box.dispatchEvent(new Event("change", { bubbles: true }));
  await new Promise(r => setTimeout(r, 1000));
  return same(box.value, proposal) ? { ok: true }
    : { ok: false, reason: `The proposal text field shows ${box.value.length} characters, not the ${proposal.length} sent — not submitted` };
}

// propose_confirm: when the page shows the proposal's beginning, it must show its end too (a cut text
// is never sent). A page that shows neither is left to Lancers.
function confirmShowsWholeProposal(proposal) {
  if (!proposal) return { ok: true };
  const squash = s => (s || "").replace(/\s+/g, "");
  const page = squash(document.body.innerText);
  const text = squash(proposal);
  const head = text.slice(0, 20), tail = text.slice(-20);
  if (!page.includes(head) || page.includes(tail)) return { ok: true };
  return { ok: false, reason: "The confirmation page shows only part of the proposal text — not submitted" };
}

async function answerRequiredChoices(rules, stepMs) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const REQUIRED_MARKS = ["必須", "required"];
  const ownText = el => [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join("").trim();
  const squash = text => (text || "").replace(/\s+/g, "");
  const labelOf = input => squash(
    input.closest("label")?.textContent ||
    (input.id && document.querySelector(`label[for="${CSS.escape(input.id)}"]`)?.textContent) ||
    input.parentElement?.textContent
  );
  const answered = [];
  const done = new Set();

  for (const rule of rules) {
    const headings = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6, legend, dt, th, label, p, span, div, strong")]
      .filter(el => ownText(el).includes(rule.heading) && ownText(el).length <= 80 && !el.closest("button, a"));

    for (const heading of headings) {
      // The question's block: nearest ancestor of its heading that holds the choices.
      let block = null;
      for (let node = heading.parentElement; node && node !== document.body; node = node.parentElement) {
        if (node.querySelector('input[type="radio"], input[type="checkbox"], select')) { block = node; break; }
      }
      if (!block || done.has(block)) continue;
      if (![...block.querySelectorAll("*")].some(el => REQUIRED_MARKS.includes(ownText(el).toLowerCase()))) continue;
      done.add(block);
      const matchesPrefer = text => rule.prefer.some(p => text.includes(p));

      const radios = [...block.querySelectorAll('input[type="radio"]')];
      const checkboxes = [...block.querySelectorAll('input[type="checkbox"]')];
      const select = block.querySelector("select");

      if (radios.length) {
        const choice = radios.find(r => matchesPrefer(labelOf(r))) || radios[0];
        if (!choice.checked) {
          (choice.closest("label") || choice).click();
          await sleep(stepMs);
          if (!choice.checked) { choice.click(); await sleep(stepMs); }
        }
        if (!choice.checked) return { ok: false, reason: `Could not select "${labelOf(choice)}" for required ${rule.heading} question` };
        answered.push(labelOf(choice));
      } else if (select) {
        const options = [...select.options].filter(o => o.value !== "");
        const choice = options.find(o => matchesPrefer(squash(o.textContent))) || options[0];
        if (!choice) return { ok: false, reason: `Required ${rule.heading} question has no options` };
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, choice.value);
        select.dispatchEvent(new Event("input", { bubbles: true }));
        select.dispatchEvent(new Event("change", { bubbles: true }));
        await sleep(stepMs);
        answered.push(squash(choice.textContent));
      } else if (checkboxes.length) {
        // Checkboxes: only tick the matching "don't use" box; never guess with the first one.
        const choice = checkboxes.find(c => matchesPrefer(labelOf(c)));
        if (!choice) return { ok: false, reason: `No "${rule.prefer[0]}" option in required ${rule.heading} question` };
        if (!choice.checked) (choice.closest("label") || choice).click();
        await sleep(stepMs);
        if (!choice.checked) return { ok: false, reason: `Could not tick "${labelOf(choice)}" for required ${rule.heading} question` };
        answered.push(labelOf(choice));
      }
    }
  }
  return { ok: true, answered };
}

async function tickAgreements(topics, stepMs) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const squash = text => (text || "").replace(/\s+/g, "");
  const labelFor = input => input.closest("label") ||
    (input.id && document.querySelector(`label[for="${CSS.escape(input.id)}"]`)) || null;
  const isAgreement = input => {
    if (input.id === "ProposalIsAgreement") return true;
    const text = squash(labelFor(input)?.textContent || input.parentElement?.textContent).toLowerCase();
    return /同意|agree/.test(text) && topics.some(t => text.includes(t.toLowerCase()));
  };
  const ticked = [];
  for (const box of document.querySelectorAll('input[type="checkbox"]')) {
    if (box.disabled || !isAgreement(box)) continue;
    const text = squash(labelFor(box)?.textContent) || box.id;
    if (!box.checked) {
      box.scrollIntoView({ block: "center" });
      (labelFor(box) || box).click();
      await sleep(stepMs);
      if (!box.checked) { box.click(); await sleep(stepMs); }
    }
    if (!box.checked) return { ok: false, reason: `Could not tick the agreement box "${text}"` };
    ticked.push(text);
  }
  return { ok: true, ticked };
}

// `label` is one button text or a list of them in order of preference; `id`, if given, also
// identifies a button (used after the texts, so a changed wording is still found).
async function clickSubmit(label, id) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const labels = [label].flat();
  const textOf = b => (b.value || b.textContent).trim();
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const buttons = [...document.querySelectorAll('input[type="submit"], button[type="submit"], button:not([type])')]
      .filter(b => !b.disabled);
    const byId = id && document.getElementById(id);
    const button = labels.map(l => buttons.find(b => textOf(b) === l)).find(Boolean) ||
      (byId && !byId.disabled ? byId : null);
    if (button) {
      button.scrollIntoView({ block: "center" });
      button.click();
      return { ok: true, label: textOf(button) };
    }
    await sleep(250);
  }
  return { ok: false, reason: `"${labels.join('" / "')}" button not found or stayed disabled` };
}
