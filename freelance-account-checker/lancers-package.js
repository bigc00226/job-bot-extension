// Job Finder's PACKAGE REQUEST (#package): fills in a Lancers package (パッケージ) with what Job
// Finder's PACKAGE window sent. The package and its files come from Slack (uploaded privately by
// Job Finder with the same Slack user; the message names their IDs), nothing is kept here.
//   https://www.lancers.jp/myplan/add → 手動でパッケージを作成する
//   1 基本情報の入力   title, subtitle, 大 / 中カテゴリー (+ the 中カテゴリー's checkboxes and 業務), 業種,
//                    検索キーワード (typed + Enter) → 次へ
//   2 料金プラン       each plan's 説明文 / 納期 / 価格, then each オプション (オプションを追加) → 次へ
//   3 業務内容         the description, then each よくある質問 (よくある質問を追加) → 次へ
//   4 確認事項         注文時のお願い (ProjectPlanForm.notice_for_sale), then each 注文時の質問 (追加) → 次へ
//   5 画像ほかの登録   images, video, audio, PDF
// Text is entered about 1 second apart, selections (selects, checkboxes, radios) 0.3 seconds apart.
// The final publish button is only pressed when "Publish packages automatically" is on in Options;
// otherwise the filled-in page is brought up for you to check and publish.
// Progress and the result are posted in the request's thread (PACKAGE STARTED / FILLED / SUCCESS / FAILURE).
import { downloadFile, postMessage, getReplies } from "./slack.js";
import { openHiddenTab, closeHiddenTab, waitForTab, waitForDocument, inPage, keepInTab, describeFailure, pause } from "./tab-utils.js";

const ADD_URL = "https://www.lancers.jp/myplan/add?ref=header_menu";
const TIMING = { text: 1000, select: 300, click: 3000 };
const CHUNK = 4 * 1024 * 1024;   // files go into the page in pieces of this many base64 characters
// The form's stages: fillStep's step, its name (as Job Finder shows it), a word of its name in Lancers'
// step list, and a field only that stage shows (gone once 次へ has moved on; none known for 業務内容).
const STAGES = [["basic", "基本情報の入力", "基本情報", 'textarea[name="ProjectPlanForm.title"]'],
  ["plans", "料金プランの入力", "料金プラン", 'textarea[name^="ProjectPlanMenuForm["]'], ["work", "業務内容の入力", "業務内容", ""],
  ["notice", "確認事項の入力", "確認事項", 'textarea[name="ProjectPlanForm.notice_for_sale"]'], ["files", "画像ほかの登録", "画像", ""]];

// "PACKAGE REQUEST\nアカウント: Lancers-x\n…\nデータ: F0123" → { account, dataId }
export function parsePackageRequest(text) {
  if (!/^\s*PACKAGE REQUEST\b/.test(text || "")) return null;
  const line = name => text.match(new RegExp(`^${name}[:：]\\s*(.+)$`, "m"))?.[1]?.trim() || "";
  return { account: line("アカウント"), dataId: line("データ"), site: "lancers" };
}

export async function runPackageRequest(request, msg, token, channelId) {
  const reply = text => postMessage(token, channelId, text, undefined, msg.ts).catch(() => {});
  let tab = null, keepOpen = false;
  try {
    if (!request.dataId) throw new Error("No データ line in the request");
    // The package page is opened (and made sure of) first; nothing is entered before it's there.
    tab = await openHiddenTab(ADD_URL);
    await openAddPage(tab);
    await reply("📦 PACKAGE STARTED — Lancers のパッケージ作成ページ（myplan/add）を開きました。入力を始めます。");
    const pkg = JSON.parse(new TextDecoder().decode(await packageData(request, msg, token, channelId)));
    const files = [];
    for (const f of pkg.files || []) files.push({ ...f, ...(await downloadFile(token, f.id)) });
    await openAddPage(tab, { reload: false });

    // 手動でパッケージを作成する → the form. A page in a minimized window may not move on (Lancers waits
    // for the page to be drawn), so then its window is shown — without taking the focus — and it's
    // pressed again; the window then stays shown for the rest of the run.
    let start = await startForm(tab, pkg);
    if (!start?.ok) {
      await chrome.windows.update(tab.windowId, { state: "normal", focused: false }).catch(() => {});
      await pause(2000);
      start = await startForm(tab, pkg);
    }
    if (!start?.ok) throw new Error(await describeFailure(tab.id, `start: ${start?.reason || "the page did not answer"}`));

    // The five stages. Each one's result goes in the thread ("PACKAGE STEP n/5 ✓|✗ …", which Job Finder
    // shows as a green or red circle). A stage that can't be completed doesn't stop the rest: when 次へ
    // can't be pressed, the next stage is opened from Lancers' own step list.
    const notes = [];
    let red = 0;
    for (const [i, [step, title, , marker]] of STAGES.entries()) {
      let result = (step === "files" ? await attachFiles(tab, files) : await runStage(tab, step, pkg))
        || { ok: false, reason: "the page did not answer" };
      // Filled in: 次へ, and on to the next stage once Lancers shows it.
      if (result.ok && step !== "files") {
        const moved = await pressNext(tab, title, marker);
        if (!moved.ok) result = { ...moved, missing: [...(result.missing || []), ...(moved.missing || [])] };
      }
      notes.push(...(result.missing || []));
      // (Also red: what Job Finder's package left empty in this stage.)
      const problems = [!result.ok && result.reason, ...(result.missing || []), ...(pkg.incompleteSteps?.[i] || [])].filter(Boolean);
      if (problems.length) red++;
      await reply(`PACKAGE STEP ${i + 1}/5 ${problems.length ? "✗" : "✓"} ${title}${problems.length ? ` — ${problems.join(" / ").slice(0, 800)}` : ""}`);
      if (result.ok || i === STAGES.length - 1) continue;
      const next = STAGES[i + 1];
      // (No answer from openStage means its click loaded the next stage's page, which ends the script: moved on.)
      const opened = await inPage(tab.id, openStage, [next[2], TIMING]).catch(() => null);
      await afterLoad(tab);
      if (opened !== false) continue;
      // No way on to the next stage: the rest are left for you on the page.
      for (let j = i + 1; j < STAGES.length; j++) {
        await reply(`PACKAGE STEP ${j + 1}/5 ✗ ${STAGES[j][1]} — 「${next[1]}」に進めませんでした（前の段階の必須項目を Lancers で入力してください）`);
        red++;
      }
      break;
    }

    const { packageAutoPublish } = await chrome.storage.local.get("packageAutoPublish");
    const noteText = notes.length ? `\n入力できなかった項目: ${notes.join(" / ")}` : "";
    if (packageAutoPublish && !red) {
      const published = await inPage(tab.id, fillStep, ["publish", pkg, TIMING]);
      if (!published?.ok) throw new Error(await describeFailure(tab.id, `publish: ${published?.reason || "the page did not answer"}`));
      await reply(`✅ PACKAGE SUCCESS — 「${pkg.title}」を Lancers に出品しました（${published.label}）。${noteText}`);
    } else {
      // Left open for you: the window comes up with the filled-in page.
      keepOpen = true;
      await chrome.windows.update(tab.windowId, { state: "normal" }).catch(() => {});
      await reply(red
        ? `⚠️ PACKAGE FILLED — 「${pkg.title || "（タイトル未入力）"}」を入力できたところまで入力しました。${red}つの段階に未入力・エラーがあります（赤の段階）。開いている Lancers のページで残りを入力して出品してください。${noteText}`
        : `✅ PACKAGE FILLED — 「${pkg.title}」をすべて入力しました。開いている Lancers のページで内容を確認して出品してください。${noteText}`);
    }
  } catch (err) {
    keepOpen = !!tab; // (the page stays open where it stopped, to see what happened)
    if (tab) await chrome.windows.update(tab.windowId, { state: "normal" }).catch(() => {});
    await reply(`❌ PACKAGE FAILURE — ${err.message}`);
  } finally {
    if (tab && !keepOpen) closeHiddenTab(tab);
  }
}

// The start step. If pressing the button loaded another page (so the script was cut off), the form is
// looked for on the page that loaded.
async function startForm(tab, pkg) {
  const result = await inPage(tab.id, fillStep, ["start", pkg, TIMING]).catch(() => null);
  if (result) return result;
  await waitForDocument(tab.id, 30000);
  await keepInTab(tab.id);
  return inPage(tab.id, fillStep, ["start", pkg, TIMING]).catch(err => ({ ok: false, reason: err.message }));
}

// A stage on the page as it is now: if a page load cuts the script off (Lancers loading the stage
// late), it's run again on the page that loaded.
async function runStage(tab, step, pkg) {
  const result = await inPage(tab.id, fillStep, [step, pkg, TIMING]).catch(() => null);
  if (result) return result;
  await afterLoad(tab);
  return inPage(tab.id, fillStep, [step, pkg, TIMING]).catch(err => ({ ok: false, reason: err.message }));
}

// 次へ, then waits for whatever Lancers shows next: a page load cuts the script off (so no result
// comes back), and that page is waited for.
async function pressNext(tab, where, marker) {
  const result = await inPage(tab.id, fillStep, ["next", { where, marker }, TIMING]).catch(() => null);
  await afterLoad(tab);
  return result || { ok: true };
}

async function afterLoad(tab) {
  await pause(1000);
  await waitForDocument(tab.id, 30000);
  await keepInTab(tab.id);
}

// Stage 5: the files are handed to the page in pieces, then attached to its file inputs (with none,
// it only checks the stage is open).
// The page is waited for first (a stage opened from the step list may still be loading), and if the
// files didn't survive until they're attached (a page load in between), they're handed in again.
async function attachFiles(tab, files) {
  const meta = files.map((f, i) => ({ key: String(i), kind: f.kind, name: f.name, type: f.type || f.mimetype || "", size: f.data?.byteLength || 0 }));
  let result = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    await afterLoad(tab);
    await inPage(tab.id, () => { window.__facFiles = {}; }).catch(() => {});
    for (const [i, file] of files.entries()) {
      const base64 = toBase64(file.data);
      for (let at = 0; at < base64.length; at += CHUNK) {
        await inPage(tab.id, (key, piece) => { (window.__facFiles ||= {}); (window.__facFiles[key] ||= []).push(piece); }, [String(i), base64.slice(at, at + CHUNK)]).catch(() => {});
      }
    }
    result = await inPage(tab.id, fillStep, ["files", { files: meta }, TIMING]).catch(() => null);
    if (result && !result.lost) return result;
  }
  return result || { ok: false, reason: "画像ほかの登録: the page did not answer" };
}

// Makes sure the tab shows https://www.lancers.jp/myplan/add, loaded: a tab sent somewhere else (the
// top page, a notice…) is sent back to it, up to 3 times. With reload: false, a tab already there is
// only checked. Throws when it can't be opened, or when Lancers asks to sign in.
async function openAddPage(tab, { reload = true } = {}) {
  const onAddPage = url => /^https:\/\/www\.lancers\.jp\/myplan\/add\b/.test(url);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await chrome.tabs.update(tab.id, { url: ADD_URL });
    await keepInTab(tab.id);
    const landed = await waitForTab(tab.id, url => onAddPage(url) || /\/login|\/signin/.test(url), 60000);
    if (landed && /\/login|\/signin/.test(landed)) throw new Error("Not signed in to Lancers in this browser");
    if (landed && (await waitForDocument(tab.id, 30000))) {
      await pause(1500);
      // (Still there once loaded: Lancers didn't redirect away.)
      const now = (await chrome.tabs.get(tab.id).catch(() => null))?.url || "";
      if (onAddPage(now)) {
        await keepInTab(tab.id);
        return;
      }
    }
    if (!reload) throw new Error(await describeFailure(tab.id, "The package page (myplan/add) is no longer open"));
  }
  throw new Error(await describeFailure(tab.id, `The package page (${ADD_URL}) did not open`));
}

const packageData = (request, msg, token, channelId) => requestData("PACKAGE", request, msg, token, channelId);

// A request's data (kind: PACKAGE, PORTFOLIO): "データ: スレッド" → the base64 text of the "<KIND> DATA"
// replies in the request's thread (posted just after the request, so they're waited for a little);
// otherwise the file ID of its <kind>.json.
export async function requestData(kind, request, msg, token, channelId) {
  if (request.dataId !== "スレッド") return (await downloadFile(token, request.dataId)).data;
  // In numbered parts ("PACKAGE DATA 2/5", as Slack cuts long messages; one unnumbered "PACKAGE DATA"
  // from older Job Finders), posted one after another just after the request: waited for until all
  // are there, and what they join to must read as the request's data.
  const partPattern = new RegExp(`^${kind} DATA(?: (\\d+)\\/(\\d+))?\\s+([\\s\\S]*)$`);
  const what = kind.toLowerCase();
  let found = "";
  for (let tries = 0; tries < 15; tries++) {
    const parts = new Map();
    let count = 0;
    for (const r of await getReplies(token, channelId, msg.ts)) {
      const m = (r.text || "").match(partPattern);
      if (!m) continue;
      parts.set(Number(m[1] || 1), m[3].replace(/\s+/g, ""));
      count = Number(m[2] || 1);
    }
    found = `${parts.size} / ${count || "?"}`;
    if (count && parts.size === count) {
      const encoded = [...parts.keys()].sort((a, b) => a - b).map(k => parts.get(k)).join("");
      try {
        const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
        JSON.parse(new TextDecoder().decode(bytes));
        return bytes;
      } catch (err) {
        throw new Error(`The ${what} data in the thread is damaged (${parts.size} parts, ${encoded.length} characters: ${err.message}) — send the ${what} again from Job Finder`);
      }
    }
    await pause(3000);
  }
  throw new Error(`The ${what} data in the request's thread is incomplete (${kind} DATA parts found: ${found})`);
}

export function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

// ---- Runs inside the Lancers page, so these must be self-contained. ----
// Opens a stage from the form's own step list (an item there whose name contains `word`); false when
// there's no such item.
async function openStage(word, T) {
  const norm = s => (s || "").normalize("NFKC").replace(/\s+/g, "");
  const lists = document.querySelectorAll("nav, ol, ul, [role='tablist'], [class*='step' i], [class*='progress' i]");
  const item = [...lists].flatMap(list => [...list.querySelectorAll("a, button, [role='tab'], [role='button'], li, span, div")])
    .filter(el => el.getClientRects().length > 0 && norm(el.textContent).includes(norm(word)) && norm(el.textContent).length <= 20 && !el.closest("header, footer"))
    .sort((a, b) => a.textContent.length - b.textContent.length)[0];
  if (!item) return false;
  const target = item.closest("a, button, [role='tab'], [role='button']") || item;
  target.scrollIntoView({ block: "center" });
  target.click();
  await new Promise(r => setTimeout(r, T.click));
  return true;
}

// One step of the form. Returns { ok, reason, missing: [what couldn't be found or set] }.
async function fillStep(step, pkg, T) {
  // (Each wait starts from a message, not from the timer before it: Chrome slows chained timers in a page
  // hidden for minutes — as in the minimized window — to about once a minute, which this avoids.)
  const sleep = ms => new Promise(r => { const ch = new MessageChannel(); ch.port1.onmessage = () => setTimeout(r, ms); ch.port2.postMessage(0); });
  const norm = s => (s || "").normalize("NFKC").replace(/\s+/g, "");
  const same = (text, wanted) => {
    const a = norm(text), b = norm(wanted);
    return a === b || (b.endsWith("…") && a.startsWith(b.slice(0, -1)));
  };
  const visible = el => !!el && el.getClientRects().length > 0;
  const waitFor = async (find, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const found = find();
      if (found) return found;
      await sleep(250);
    }
    return null;
  };
  const ownText = el => [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join("").trim();
  const missing = [];
  // A field by selector: the copy showing on the page (a page can hold hidden copies), else the first.
  const shown = selector => [...document.querySelectorAll(selector)].find(visible) || document.querySelector(selector);

  // React keeps its own copy of a field's value: the native setter, then the events it listens for.
  // (A value the package left empty is skipped, leaving the field as it is.)
  const setText = async (el, value) => {
    if (value == null || value === "") return;
    el.scrollIntoView({ block: "center" });
    el.focus();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, String(value ?? ""));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.blur();
    await sleep(T.text);
  };
  const setSelect = async (select, option) => {
    select.scrollIntoView({ block: "center" });
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, option.value);
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(T.select);
  };
  const optionIn = (select, { value, text, days }) => [...select.options].find(o =>
    (value != null && o.value === String(value)) ||
    (text && same(o.textContent, text)) ||
    (days != null && o.value !== "" && (o.value === String(days) || norm(o.textContent) === `${days}日` || norm(o.textContent) === String(days))));
  const choose = async (select, wanted, what) => {
    if (wanted.value == null && !wanted.text && wanted.days == null) return false; // (left empty in the package)
    if (!select) { missing.push(`${what} (select not found)`); return false; }
    const option = await waitFor(() => optionIn(select, wanted), 10000);
    if (!option) { missing.push(`${what}: ${wanted.text || wanted.value || `${wanted.days}日`}`); return false; }
    await setSelect(select, option);
    return true;
  };
  // A select found afresh by its selector on every try (the page may draw it anew, e.g. the 中カテゴリー
  // once its list has loaded), chosen once it's enabled and has the option, then checked again a moment
  // later — chosen again (up to 4 times) if the page put it back. Options match by value, then by text
  // (exactly, then by its beginning or as part of it).
  // 納期 ({ days }) by the day shown ("21日"), and only then by an option's value, as the values may not be the days.
  // A day Lancers doesn't offer (Lancers has 1–7, 10, 14, 21 … 90日) takes the next longer one, noted as not entered as sent.
  const dayOf = o => Number(norm(o.textContent).match(/^(\d+)日?$/)?.[1]);
  const dayOption = (select, days) => {
    const options = [...select.options].filter(o => o.value !== "");
    const exact = options.find(o => norm(o.textContent) === `${days}日`) || options.find(o => dayOf(o) === Number(days));
    return exact || options.filter(o => dayOf(o) > Number(days)).sort((a, b) => dayOf(a) - dayOf(b))[0] ||
      options.find(o => o.value === String(days)) || null;
  };
  const chooseLive = async (selector, wanted, what) => {
    if (wanted.value == null && !wanted.text && wanted.days == null) return false; // (left empty in the package)
    if (!selector) { missing.push(`${what} (select not found)`); return false; }
    const find = select => wanted.days != null ? dayOption(select, wanted.days) :
      [...select.options].find(o => o.value !== "" && wanted.value != null && o.value === String(wanted.value)) ||
      optionIn(select, { text: wanted.text }) ||
      (wanted.text && [...select.options].find(o => o.value !== "" && (norm(o.textContent).startsWith(norm(wanted.text)) || norm(o.textContent).includes(norm(wanted.text)))));
    let option = null;
    for (let set = 0; set < 4; set++) {
      const ready = await waitFor(() => {
        const select = shown(selector);
        const found = select && !select.disabled && find(select);
        return found ? [select, found] : null;
      }, 15000);
      if (!ready) break;
      [, option] = ready;
      ready[0].focus();
      await setSelect(ready[0], option);
      ready[0].blur?.();
      await sleep(1200);
      const now = shown(selector);
      if (now && now.value === option.value) {
        if (wanted.days != null && dayOf(option) !== Number(wanted.days)) {
          missing.push(`${what}: ${wanted.days}日 は Lancers にないため ${norm(option.textContent)} を選択しました`);
        }
        return true;
      }
    }
    const select = shown(selector);
    missing.push(`${what}: ${wanted.days != null ? `${wanted.days}日` : wanted.text || wanted.value}${!select ? " (select not found)" : option ? " (選択が保持されませんでした)" :
      ` (choices: ${[...select.options].map(o => norm(o.textContent)).filter(Boolean).slice(0, 15).join(", ")})`}`);
    return false;
  };
  // A select's selector by its name (to find it again if it's drawn anew); null without one.
  const selectorOf = select => select?.name ? `select[name="${select.name.replace(/["\\]/g, "\\$&")}"]` : null;
  const tick = async (input, on = true) => {
    if (input.checked === on) return;
    input.scrollIntoView({ block: "center" });
    (input.closest("label") || input).click();
    await sleep(T.select);
    if (input.checked !== on) { input.click(); await sleep(T.select); }
  };
  // A button / link whose text contains every word (the smallest such element). Real buttons come
  // first, so a heading like "追加オプション" isn't taken for the オプションを追加する button.
  const findButton = words => {
    const matching = selector => [...document.querySelectorAll(selector)].filter(visible)
      .filter(el => { const t = norm(el.textContent); return t.length <= 30 && words.every(w => t.includes(norm(w))); })
      .sort((a, b) => a.textContent.length - b.textContent.length || (b.contains(a) ? -1 : 1));
    const button = matching("button, a, [role='button']").find(b => !b.disabled);
    return button || matching("span, div").map(el => el.closest("button, a, [role='button']") || el)[0] || null;
  };
  const click = async el => {
    el.scrollIntoView({ block: "center" });
    el.click();
    await sleep(T.click);
  };
  const fields = selector => [...document.querySelectorAll(selector)];
  const textFields = () => fields("input[type='text'], input:not([type]), textarea").filter(visible);
  // Clicks an add button (e.g. オプションを追加) and returns the text fields it brought up.
  const addRow = async (words, what) => {
    const before = new Set(textFields());
    const button = findButton(words);
    if (!button) { missing.push(`${what} (「${words.join("")}」 button not found)`); return null; }
    await click(button);
    const added = await waitFor(() => { const now = textFields().filter(f => !before.has(f)); return now.length ? now : null; }, 8000);
    if (!added) missing.push(`${what} (no new fields after 「${words.join("")}」)`);
    return added;
  };
  // An option / FAQ / question's own fields: same name prefix "Form[n]." as its first field.
  const rowFields = first => {
    const prefix = first.name?.match(/^(.*\[\d+\]\.)/)?.[1];
    return prefix ? fields(`[name^="${prefix.replace(/["\\]/g, "\\$&")}"]`) : [first];
  };
  const named = (row, pattern, tag = "") => row.find(f => (!tag || f.tagName === tag) && pattern.test(f.name || ""));
  // 次へ (also "保存して次へ" and the like).
  const isNext = b => {
    const t = norm(b.textContent);
    return visible(b) && (["次へ", "次へ進む", "次に進む", "Next"].includes(t) || (t.length <= 12 && /次へ(進む)?$/.test(t)));
  };
  // 次へ not pressed: a disabled one (Lancers waits for a required field) stops the run softly.
  const notNext = where => [...document.querySelectorAll("button")].some(b => isNext(b) && b.disabled)
    ? { ok: false, stopped: true, reason: `「次へ」を押せませんでした（${where}に未入力の必須項目があります）`, missing }
    : { ok: false, reason: `「次へ」 button not found on ${where}`, missing };
  // What the page shows as errors (e.g. "業務を選択してください").
  const pageErrors = () => [...document.querySelectorAll("[class*='error' i], [role='alert'], [class*='invalid' i]")]
    .filter(el => visible(el) && !el.closest("noscript")).map(el => el.textContent.replace(/\s+/g, " ").trim()).filter(Boolean)
    .filter((t, i, all) => all.indexOf(t) === i).slice(0, 4).join(" / ");

  // 次へ at the end of a stage (pkg here is { where, marker }). Lancers moves on by loading another page
  // (which ends this script — the runner then waits for it), by changing the address, or by replacing the
  // stage's fields (marker: a field of the stage just filled in). If none of that happens, what the page
  // says is wrong is reported.
  if (step === "next") {
    const button = await waitFor(() => [...document.querySelectorAll("button")].find(b => isNext(b) && !b.disabled), 10000);
    if (!button) return notNext(pkg.where);
    const before = location.href;
    await click(button);
    const moved = () => location.href !== before || (pkg.marker && !fields(pkg.marker).some(visible));
    if (!pkg.marker || (await waitFor(() => moved() || null, 15000))) return { ok: true, missing };
    const errors = pageErrors();
    return { ok: false, reason: `「次へ」を押しましたが${pkg.where}から次の段階に進みませんでした${errors ? `（ページの表示: ${errors}）` : "（未入力の必須項目がないか確認してください）"}`, missing };
  }

  if (step === "start") {
    // 手動でパッケージを作成する is pressed until the form (its title field) shows: the button showing on
    // the page (not a hidden copy of it), pressed a different way on each try (full mouse press, click(), Enter).
    const LABEL = "手動でパッケージを作成する";
    const formShown = () => [...document.querySelectorAll('textarea[name="ProjectPlanForm.title"]')].some(visible);
    const buttons = () => [...new Set([...document.querySelectorAll(`[data-dd-action-name="${LABEL}"]`),
      ...[...document.querySelectorAll("button, a, [role='button'], span, div, p")].filter(el => norm(el.textContent) === LABEL)]
      .map(el => el.closest("button, a, [role='button']") || el))].filter(el => visible(el) && !el.disabled);
    const diagnosis = () => `page ${document.visibilityState}; ${LABEL} shown: ${buttons().length}, in page: ${document.querySelectorAll(`[data-dd-action-name="${LABEL}"]`).length}; ` +
      `buttons: ${[...document.querySelectorAll("button, [role='button']")].filter(visible).map(b => norm(b.textContent)).filter(Boolean).slice(0, 8).join(" | ")}`;
    const press = (el, how) => {
      el.scrollIntoView({ block: "center" });
      if (how === 1) { el.click(); return; }
      if (how === 2) {
        el.focus();
        for (const type of ["keydown", "keypress", "keyup"]) el.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        return;
      }
      const r = el.getBoundingClientRect();
      const at = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
      for (const type of ["pointerover", "pointerenter", "mouseover", "pointerdown", "mousedown"]) {
        el.dispatchEvent(type.startsWith("pointer") ? new PointerEvent(type, { ...at, pointerType: "mouse", isPrimary: true }) : new MouseEvent(type, at));
      }
      el.focus?.();
      el.dispatchEvent(new PointerEvent("pointerup", { ...at, pointerType: "mouse", isPrimary: true }));
      el.dispatchEvent(new MouseEvent("mouseup", at));
      el.dispatchEvent(new MouseEvent("click", { ...at, detail: 1 }));
    };
    if (!(await waitFor(() => formShown() || buttons().length > 0, 30000))) {
      return { ok: false, reason: `「${LABEL}」 button not found (${diagnosis()})` };
    }
    for (let how = 0; how < 3 && !formShown(); how++) {
      const button = buttons()[0];
      if (button) press(button, how);
      if (await waitFor(() => formShown(), 10000)) break;
    }
    if (!formShown()) return { ok: false, stuck: true, reason: `pressed 「${LABEL}」 but the form didn't open (${diagnosis()})` };
    await sleep(T.select);
    return { ok: true, missing };
  }

  if (step === "basic") {
    const title = await waitFor(() => shown('textarea[name="ProjectPlanForm.title"]'), 30000);
    if (!title) return { ok: false, reason: "Title field (ProjectPlanForm.title) not found" };
    await setText(title, pkg.title);
    if (pkg.subtitle) {
      const subtitle = shown('textarea[name="ProjectPlanForm.subtitle"]');
      if (subtitle) await setText(subtitle, pkg.subtitle); else missing.push("サブタイトル");
    }
    await chooseLive('select[name="___main_category_id"]', { text: pkg.category }, "大カテゴリー");
    // The 中カテゴリー list is filled in (and its select may be drawn anew) after the 大カテゴリー is chosen.
    await chooseLive('select[name="ProjectPlanForm.project_category_id"]', { text: pkg.subcategory }, "中カテゴリー");
    await sleep(1500);

    // The 中カテゴリー's own fields: each group under its heading (the nth heading with that name).
    // A single choice (業務, radio) is looked for among radio buttons only — native ones or ones drawn
    // with role="radio" — so a checkbox group nearby with a same-named item isn't used instead.
    const CHECKS = 'input[type="checkbox"], [role="checkbox"]', RADIOS = 'input[type="radio"], [role="radio"]';
    for (const group of pkg.details || []) {
      const kinds = group.type === "radio" ? RADIOS : CHECKS;
      // The group's heading and its choices, looked up afresh for every item, as the page may draw the
      // list anew after a tick (a choice found earlier would then be a copy no longer on the page).
      const locate = () => {
        const heading = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6, legend, dt, th, label, p, span, div, strong")]
          .filter(el => visible(el) && !el.closest("label") && same(ownText(el), group.name))[group.occurrence || 0];
        let block = null;
        for (let node = heading?.parentElement; node && node !== document.body; node = node.parentElement) {
          if (node.querySelector(kinds)) { block = node; break; }
        }
        // (Only the choices after the heading: a block can also hold the group before it.)
        return block && { block, inputs: [...block.querySelectorAll(kinds)].filter(i => heading.compareDocumentPosition(i) & Node.DOCUMENT_POSITION_FOLLOWING) };
      };
      let found = await waitFor(locate, 8000);
      if (!found) { missing.push(`${group.name} (not on the page)`); continue; }
      // A list shown in part ("もっと見る", "すべて表示", "+12件"…) is opened in full first.
      for (let more = 0; more < 5; more++) {
        const opener = [...found.block.querySelectorAll("button, a, [role='button'], span, div")]
          .filter(el => visible(el) && !el.querySelector(kinds) && norm(el.textContent).length <= 15 &&
            /^(もっと見る|もっと表示|さらに表示|すべて表示|すべて見る|全て表示|続きを見る|他\d+件|\+\d+件?|表示を増やす)/.test(norm(el.textContent)))[0];
        if (!opener) break;
        await click(opener.closest("button, a, [role='button']") || opener);
        found = locate() || found;
      }
      const labelOf = input => (input.getAttribute("role") && (input.getAttribute("aria-label") || input.textContent)) ||
        input.closest("label")?.textContent ||
        (input.id && document.querySelector(`label[for="${CSS.escape(input.id)}"]`)?.textContent) ||
        (input.getAttribute("aria-labelledby") && document.getElementById(input.getAttribute("aria-labelledby"))?.textContent) ||
        input.parentElement?.textContent || "";
      const isOn = input => input.tagName === "INPUT" ? input.checked : input.getAttribute("aria-checked") === "true";
      // A choice by its label: exactly, ignoring case, as a part of it (when only one has it), then by
      // spelling within a letter or two ("Twilio" / "Twillo"), the closest one.
      const lower = s => norm(s).toLowerCase();
      const distance = (a, b) => {
        let row = Array.from({ length: b.length + 1 }, (_, j) => j);
        for (let i = 1; i <= a.length; i++) {
          const next = [i];
          for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
          row = next;
        }
        return row[b.length];
      };
      const match = (inputs, value) => {
        const want = lower(value).replace(/…$/, "");
        const exact = inputs.find(i => same(labelOf(i), value)) || inputs.find(i => lower(labelOf(i)) === want);
        if (exact) return exact;
        const containing = inputs.filter(i => lower(labelOf(i)).includes(want));
        if (containing.length === 1) return containing[0];
        const allowed = want.length >= 8 ? 2 : want.length >= 4 ? 1 : 0;
        const near = inputs.map(i => [i, distance(lower(labelOf(i)), want)]).filter(([, d]) => d <= allowed).sort((a, b) => a[1] - b[1]);
        return near[0]?.[0] || containing[0] || null;
      };
      for (const value of group.values) {
        const input = match(locate()?.inputs || found.inputs, value);
        if (!input) {
          missing.push(`${group.name}: ${value} (choices: ${(locate()?.inputs || found.inputs).map(i => norm(labelOf(i))).join(", ").slice(0, 400)})`);
          continue;
        }
        if (isOn(input)) continue;
        // Its label, then the input itself, then a full mouse press on what's drawn for it — until it's on.
        // Each try is made on the choice as the page shows it now, and checked (on the page as redrawn)
        // before the next, so a tick that just took a moment isn't clicked off again.
        const current = () => match(locate()?.inputs || [], value);
        let on = false;
        for (const how of ["label", "input", "press"]) {
          const now = current() || input;
          if (isOn(now)) { on = true; break; }
          const label = now.closest("label") || (now.id && document.querySelector(`label[for="${CSS.escape(now.id)}"]`));
          // (Its parent only when that holds no other choice, so a press can't land on another one.)
          const drawn = label || (now.parentElement?.querySelectorAll(kinds).length === 1 ? now.parentElement : null);
          now.scrollIntoView?.({ block: "center" });
          if (how === "label" && label) label.click();
          else if (how === "input") now.click();
          else if (how === "press" && drawn) {
            const r = drawn.getBoundingClientRect();
            const at = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.left + 8, clientY: r.top + r.height / 2, button: 0 };
            for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
              drawn.dispatchEvent(type.startsWith("pointer") ? new PointerEvent(type, { ...at, pointerType: "mouse", isPrimary: true }) : new MouseEvent(type, at));
            }
          } else continue;
          await sleep(T.select);
          if (await waitFor(() => { const c = current(); return c && isOn(c) ? c : null; }, 1500)) { on = true; break; }
        }
        if (!on) missing.push(`${group.name}: ${value} (選択できませんでした)`);
      }
    }

    if (pkg.industry) await chooseLive('select[name="ProjectPlanForm.industry_type_id"]', { value: pkg.industry.id, text: pkg.industry.name }, "業種");

    // 検索キーワード: typed, then Enter adds it as a tag.
    if (pkg.keywords?.length) {
      const box = shown('input[name="MultiSelectTagSearch_ProjectPlanTagForm"]');
      if (!box) missing.push("検索キーワード (field not found)");
      else for (const keyword of pkg.keywords) {
        box.scrollIntoView({ block: "center" });
        box.focus();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(box, keyword);
        box.dispatchEvent(new Event("input", { bubbles: true }));
        for (const type of ["keydown", "keypress", "keyup"]) {
          box.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        }
        await sleep(T.text);
      }
    }
    return { ok: true, missing };
  }

  if (step === "plans") {
    const descriptions = await waitFor(() => {
      const found = fields('textarea[name^="ProjectPlanMenuForm["]').filter(f => /\.description$/.test(f.name));
      return found.length ? found : null;
    }, 30000);
    if (!descriptions) return { ok: false, reason: "Plan fields (ProjectPlanMenuForm[n].description) not found after 次へ" };
    const prices = fields('input[name^="ProjectPlanMenuForm["]').filter(f => /\.price$/.test(f.name));
    const selects = fields('select[name^="ProjectPlanMenuForm["]');
    for (const [i, plan] of pkg.plans.entries()) {
      if (descriptions[i]) await setText(descriptions[i], plan.text); else missing.push(`${plan.name} 説明文`);
      // (Each plan's own select, by its name's [n]; else the nth one.)
      const index = descriptions[i]?.name.match(/\[(\d+)\]/)?.[1];
      const select = selects.find(s => s.name.startsWith(`ProjectPlanMenuForm[${index}]`)) || selects[i];
      await chooseLive(selectorOf(select), { days: plan.days }, `${plan.name} 納期`);
      const price = prices.find(p => p.name.startsWith(`ProjectPlanMenuForm[${index}]`)) || prices[i];
      if (price) await setText(price, plan.price); else missing.push(`${plan.name} 価格`);
    }

    // After the plans: オプションを追加する is pressed for each option, then the fields it brings up are filled in.
    for (const [k, option] of (pkg.options || []).entries()) {
      // (An option row already showing on the page is used; hidden ones aren't.)
      const titles = fields('[name^="ProjectPlanExtraFormCustomOptions["]').filter(f => /\.title$/.test(f.name) && visible(f));
      let title = titles[k];
      if (!title) {
        const added = await addRow(findButton(["オプションを追加"]) ? ["オプションを追加"] : ["オプション", "追加"], `オプション${k + 1}`);
        title = added && (added.find(f => /\.title$/.test(f.name || "")) || added[0]);
      }
      if (!title) continue;
      // A row that comes up switched off is switched on first (its checkbox / toggle).
      if (title.disabled || title.readOnly) {
        let toggle = null;
        for (let node = title.parentElement; node && node !== document.body && !toggle; node = node.parentElement) {
          toggle = node.querySelector('input[type="checkbox"]:not(:checked), [role="switch"][aria-checked="false"]');
        }
        if (toggle) { toggle.tagName === "INPUT" ? await tick(toggle) : await click(toggle); }
      }
      const row = rowFields(title);
      await setText(title, option.title);
      const text = named(row, /\.(description|detail|content|body)$/) || row.find(f => f !== title && f.tagName === "TEXTAREA");
      if (text) await setText(text, option.text); else missing.push(`オプション${k + 1} 説明文`);
      const select = row.find(f => f.tagName === "SELECT") || title.closest("section, li, [class]")?.querySelector("select");
      await chooseLive(selectorOf(select), { days: option.days }, `オプション${k + 1} 納期`);
      const price = named(row, /price/i);
      if (price) await setText(price, option.price); else missing.push(`オプション${k + 1} 価格`);
      // An option entered in a dialog is confirmed with its own 追加 / 保存 button.
      const dialog = title.closest("[role='dialog'], dialog, [class*='modal' i]");
      const confirm = dialog && [...dialog.querySelectorAll("button")].find(b => visible(b) && /^(追加|追加する|保存|保存する|決定|OK)$/.test(norm(b.textContent)));
      if (confirm) await click(confirm);
    }
    return { ok: true, missing };
  }

  if (step === "work") {
    const work = await waitFor(() => {
      const areas = fields("textarea").filter(f => visible(f) && !/^ProjectPlan(Faq|Menu|Extra)/.test(f.name || ""));
      return areas.find(f => /description|content|detail|body/i.test(f.name || "")) ||
        areas.sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0];
    }, 30000);
    if (!work) return { ok: false, reason: "業務内容 field not found after 次へ" };
    await setText(work, pkg.work);
    for (const [k, faq] of (pkg.faqs || []).entries()) {
      const questions = fields('[name^="ProjectPlanFaqForm["]').filter(f => /\.question$/.test(f.name));
      let question = questions[k];
      if (!question) {
        const added = await addRow(["質問", "追加"], `よくある質問${k + 1}`);
        question = added && (added.find(f => /\.question$/.test(f.name || "")) || added[0]);
      }
      if (!question) continue;
      await setText(question, faq.question);
      const answer = named(rowFields(question), /\.answer$/) || rowFields(question).find(f => f !== question && f.tagName === "TEXTAREA");
      if (answer) await setText(answer, faq.answer); else missing.push(`よくある質問${k + 1} 回答`);
    }
    return { ok: true, missing };
  }

  if (step === "notice") {
    const notice = await waitFor(() => shown('textarea[name="ProjectPlanForm.notice_for_sale"]'), 30000);
    if (!notice) return { ok: false, reason: "注文時のお願い field (ProjectPlanForm.notice_for_sale) not found after 次へ" };
    await setText(notice, pkg.request);
    for (const [k, q] of (pkg.questions || []).entries()) {
      const added = await addRow(findButton(["質問", "追加"]) ? ["質問", "追加"] : ["追加"], `注文時の質問${k + 1}`);
      const input = added?.[0];
      if (!input) continue;
      await setText(input, q.text);
      // Its 必須 checkbox: the nearest one around the new field.
      let box = null;
      for (let node = input.parentElement; node && node !== document.body && !box; node = node.parentElement) {
        box = node.querySelector('input[type="checkbox"]');
      }
      if (box) await tick(box, q.required); else if (q.required) missing.push(`注文時の質問${k + 1} 必須`);
    }
    return { ok: true, missing };
  }

  if (step === "files") {
    const KINDS = { image: [/image/i, "画像"], video: [/video|mp4/i, "動画"], audio: [/audio|mp3|mpeg/i, "音声"], pdf: [/pdf/i, "PDF"] };
    const inputFor = kind => {
      const [accept, heading] = KINDS[kind];
      const inputs = fields('input[type="file"]');
      const byAccept = inputs.find(i => accept.test(i.accept || ""));
      if (byAccept) return byAccept;
      // No accept attribute: the file input after the section's heading.
      const head = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6, dt, th, p, span, div, strong")].find(el => norm(ownText(el)) === norm(heading));
      return head && inputs.find(i => head.compareDocumentPosition(i) & Node.DOCUMENT_POSITION_FOLLOWING);
    };
    if (!(await waitFor(() => fields('input[type="file"]').length, 30000))) return { ok: false, reason: "No file inputs on 画像ほかの登録" };
    // The files handed in must all be here, whole (a page load in between loses them: handed in again).
    const whole = meta => Math.floor((window.__facFiles?.[meta.key] || []).join("").length * 3 / 4) >= (meta.size || 1) - 2;
    if (pkg.files.some(meta => !whole(meta))) return { ok: false, lost: true, reason: "the files did not reach the page", missing };
    const fileOf = meta => {
      const binary = atob((window.__facFiles?.[meta.key] || []).join(""));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new File([bytes], meta.name, { type: meta.type });
    };
    const put = async (input, files) => {
      const list = new DataTransfer();
      for (const file of files) list.items.add(file);
      input.files = list.files;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(T.click + Math.min(20000, files.reduce((n, f) => n + f.size, 0) / 1e6 * 300)); // (time for the upload)
    };

    // 画像 (up to 3), one by one. After one is added, the section changes: the input found first may now
    // be that image's own (replacing it), so each image goes to an input of an empty slot, and the
    // section must show one image more afterwards — otherwise another input is tried, then the file is
    // dropped on the section's drop zone (ファイルを選択する). An image Lancers refuses (its message is
    // noted) doesn't stop the next ones.
    const images = pkg.files.filter(m => m.kind === "image");
    if (images.length) {
      const imageBlock = () => {
        const head = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6, dt, th, p, span, div, strong")]
          .find(el => visible(el) && norm(ownText(el)) === "画像");
        for (let node = head?.parentElement; node && node !== document.body; node = node.parentElement) {
          if (node.querySelector('input[type="file"]')) return node;
        }
        return null;
      };
      const imageInputs = () => {
        const block = imageBlock();
        const inputs = block ? [...block.querySelectorAll('input[type="file"]')].filter(i => !i.accept || /image/i.test(i.accept))
          : fields('input[type="file"]').filter(i => /image/i.test(i.accept || ""));
        return inputs.length ? inputs : [inputFor("image")].filter(Boolean);
      };
      const shownImages = () => (imageBlock() || document).querySelectorAll("img").length;
      // (A slot holding an image already: its input sits beside an <img>.)
      const filled = i => { const slot = i.closest("li, label, [class*='slot' i], [class*='item' i]") || i.parentElement; return slot?.querySelector("img") ? 1 : 0; };
      const emptyFirst = inputs => [...inputs].sort((a, b) => filled(a) - filled(b));
      // The drop zone: the smallest element in the section saying ファイルを選択 / ドラッグ.
      const dropZone = () => [...(imageBlock() || document).querySelectorAll("div, label, section, button, span")]
        .filter(el => visible(el) && /ファイルを選択|ドラッグ|ドロップ/.test(norm(el.textContent)) && norm(el.textContent).length <= 40)
        .sort((a, b) => a.textContent.length - b.textContent.length).map(el => el.closest("label, [role='button'], div") || el)[0] || null;
      const drop = async (zone, file) => {
        const list = new DataTransfer();
        list.items.add(file);
        for (const type of ["dragenter", "dragover", "drop"]) {
          zone.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: list }));
        }
        await sleep(T.click + Math.min(20000, file.size / 1e6 * 300));
      };
      const sectionErrors = () => [...(imageBlock() || document).querySelectorAll("[class*='error' i], [role='alert']")]
        .filter(el => visible(el) && el.textContent.trim()).map(el => el.textContent.replace(/\s+/g, " ").trim()).slice(0, 2).join(" / ");
      if (!imageInputs().length && !dropZone()) missing.push(`画像: ${images.map(m => m.name).join("、")} (画像の入力欄が見つかりません)`);
      else for (const meta of images) {
        const before = shownImages();
        // (Added: one image more in the section, or its file name shown there.)
        const shows = () => shownImages() > before || norm(imageBlock()?.textContent || "").includes(norm(meta.name));
        const tries = [...emptyFirst(imageInputs()).slice(0, 2).map(input => () => put(input, [fileOf(meta)])),
          () => { const zone = dropZone(); return zone ? drop(zone, fileOf(meta)) : null; }];
        let added = false;
        for (const attempt of tries) {
          if (await attempt() === null) continue;
          if (await waitFor(() => shows() || null, 15000)) { added = true; break; }
        }
        if (added) { await sleep(1500); continue; }   // (the upload settling before the next image)
        const said = sectionErrors();
        missing.push(`画像: ${meta.name} (追加できませんでした${said ? `: ${said}` : ""})`);
      }
    }

    for (const meta of pkg.files.filter(m => m.kind !== "image")) {
      const input = inputFor(meta.kind);
      if (!input) { missing.push(`${KINDS[meta.kind][1]}: ${meta.name}`); continue; }
      await put(input, [fileOf(meta)]);
    }
    delete window.__facFiles;
    return { ok: true, missing };
  }

  if (step === "publish") {
    const button = await waitFor(() => [...document.querySelectorAll("button, input[type='submit']")].filter(b => visible(b) && !b.disabled)
      .find(b => ["出品する", "この内容で出品する", "公開する", "パッケージを公開する", "出品"].includes(norm(b.value || b.textContent))), 15000);
    if (!button) return { ok: false, reason: "The publish (出品する / 公開する) button not found" };
    const label = norm(button.value || button.textContent);
    await click(button);
    return { ok: true, label, missing };
  }
  return { ok: false, reason: `unknown step ${step}` };
}
