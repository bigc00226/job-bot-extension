// Job Finder's PORTFOLIO REQUEST (#portfolio): adds a Lancers portfolio item (ポートフォリオ) with what
// Job Finder's PORTFOLIO window sent. The data and its files come from Slack (uploaded privately by Job
// Finder with the same Slack user); nothing is kept here.
//   https://www.lancers.jp/myportfolio?page=1 → 新規作成 (the button with the ＋) → the form:
//   タイトル, サブタイトル, カバー画像 (one image), コンテンツ (up to 10 files), 説明文, 検索キーワード,
//   カテゴリー (大 → 小), 業種, 制作期間 (number + unit), 参考価格, パッケージ, the three checkboxes,
//   公開範囲, プロフィールでの表示順 → 保存.
// The form's fields mostly have no name, so each is found under its heading on the page.
// Text is entered about 1 second apart, selections 0.3 seconds apart. 保存 is pressed unless "Save
// portfolio items automatically" is off in Options (then the filled-in page is brought up for you).
// Progress and the result go in the request's thread (PORTFOLIO STARTED / SAVED / FILLED / FAILURE).
import { downloadFile, postMessage } from "./slack.js";
import { openHiddenTab, closeHiddenTab, waitForTab, waitForDocument, inPage, keepInTab, describeFailure, pause } from "./tab-utils.js";
import { requestData, toBase64 } from "./lancers-package.js";

const LIST_URL = "https://www.lancers.jp/myportfolio?page=1";
const TIMING = { text: 1000, select: 300, click: 3000 };
const CHUNK = 4 * 1024 * 1024;
// Job Finder's stages of the portfolio input (the fields of each: see fillPortfolio's `stage`).
const STAGES = ["基本情報の入力", "画像・コンテンツの登録", "制作内容の入力", "公開設定"];

// "PORTFOLIO REQUEST\nアカウント: Lancers-x\nデータ: スレッド\n…" → { account, dataId }
export function parsePortfolioRequest(text) {
  if (!/^\s*PORTFOLIO REQUEST\b/.test(text || "")) return null;
  const line = name => text.match(new RegExp(`^${name}[:：]\\s*(.+)$`, "m"))?.[1]?.trim() || "";
  return { account: line("アカウント"), dataId: line("データ"), site: "lancers" };
}

export async function runPortfolioRequest(request, msg, token, channelId) {
  const reply = text => postMessage(token, channelId, text, undefined, msg.ts).catch(() => {});
  let tab = null, keepOpen = false;
  try {
    if (!request.dataId) throw new Error("No データ line in the request");
    // The portfolio list is opened (and made sure of) first; nothing is entered before it's there.
    tab = await openHiddenTab(LIST_URL);
    await keepInTab(tab.id);
    const landed = await waitForTab(tab.id, url => /lancers\.jp\/myportfolio/.test(url) || /\/login|\/signin/.test(url), 60000);
    if (!landed) throw new Error(await describeFailure(tab.id, "The portfolio page (myportfolio) did not open"));
    if (/\/login|\/signin/.test(landed)) throw new Error("Not signed in to Lancers in this browser");
    await afterLoad(tab);
    await reply("🖼 PORTFOLIO STARTED — Lancers のポートフォリオページ（myportfolio）を開きました。入力を始めます。");
    const pf = JSON.parse(new TextDecoder().decode(await requestData("PORTFOLIO", request, msg, token, channelId)));
    const files = [];
    for (const f of pf.files || []) files.push({ ...f, ...(await downloadFile(token, f.id)) });

    // 新規作成 → the form. (Shown, without taking the focus, if a minimized window doesn't move on.)
    let start = await runStep(tab, "start", pf);
    if (!start?.ok) {
      await chrome.windows.update(tab.windowId, { state: "normal", focused: false }).catch(() => {});
      await pause(2000);
      start = await runStep(tab, "start", pf);
    }
    if (!start?.ok) throw new Error(await describeFailure(tab.id, `start: ${start?.reason || "the page did not answer"}`));

    // The files go into the page in pieces first, then everything is filled in.
    await inPage(tab.id, () => { window.__facFiles = {}; });
    for (const [i, file] of files.entries()) {
      const base64 = toBase64(file.data);
      for (let at = 0; at < base64.length; at += CHUNK) {
        await inPage(tab.id, (key, piece) => { (window.__facFiles[key] ||= []).push(piece); }, [String(i), base64.slice(at, at + CHUNK)]);
      }
    }
    const fileMeta = files.map((f, i) => ({ key: String(i), kind: f.kind, name: f.name, type: f.type || f.mimetype || "" }));
    const filled = await runStep(tab, "fill", { ...pf, fileMeta });
    if (!filled?.ok) throw new Error(await describeFailure(tab.id, `fill: ${filled?.reason || "the page did not answer"}`));
    // Each stage's result, as Job Finder's stages ("PORTFOLIO STEP n/4 ✓|✗ …", shown as green / red
    // circles): what couldn't be entered in its fields, and what Job Finder left empty there.
    for (const [i, name] of STAGES.entries()) {
      const problems = [...(filled.missing || []).filter(m => m.stage === i + 1).map(m => m.text), ...(pf.incompleteSteps?.[i] || [])];
      await reply(`PORTFOLIO STEP ${i + 1}/4 ${problems.length ? "✗" : "✓"} ${name}${problems.length ? ` — ${problems.join(" / ").slice(0, 800)}` : ""}`);
    }
    const notes = (filled.missing || []).map(m => m.text);
    const noteText = notes.length ? `\n入力できなかった項目: ${notes.join(" / ")}` : "";

    const { portfolioAutoSave } = await chrome.storage.local.get("portfolioAutoSave");
    if (portfolioAutoSave !== false) {
      const before = (await chrome.tabs.get(tab.id)).url;
      const saved = await inPage(tab.id, fillPortfolio, ["save", {}, TIMING]).catch(() => null);
      await afterLoad(tab);
      const now = await chrome.tabs.get(tab.id).catch(() => null);
      // Saved: Lancers left the form (another page loaded, or the form is gone).
      const formLeft = saved?.ok || (!saved && now && (now.url !== before ||
        !(await inPage(tab.id, () => !!document.querySelector('textarea[name="title"]')).catch(() => false))));
      if (formLeft) {
        await reply(`✅ PORTFOLIO SAVED — 「${pf.title}」を Lancers のポートフォリオに保存しました。${noteText}`);
        return;
      }
      keepOpen = true;
      await chrome.windows.update(tab.windowId, { state: "normal" }).catch(() => {});
      await reply(`⚠️ PORTFOLIO FILLED — 「${pf.title || "（タイトル未入力）"}」を入力しましたが、保存できませんでした${saved?.reason ? `（${saved.reason}）` : ""}。開いている Lancers のページで確認して保存してください。${noteText}`);
      return;
    }
    keepOpen = true;
    await chrome.windows.update(tab.windowId, { state: "normal" }).catch(() => {});
    await reply(`${notes.length ? "⚠️" : "✅"} PORTFOLIO FILLED — 「${pf.title || "（タイトル未入力）"}」を入力しました。開いている Lancers のページで確認して保存してください。${noteText}`);
  } catch (err) {
    keepOpen = !!tab;
    if (tab) await chrome.windows.update(tab.windowId, { state: "normal" }).catch(() => {});
    await reply(`❌ PORTFOLIO FAILURE — ${err.message}`);
  } finally {
    if (tab && !keepOpen) closeHiddenTab(tab);
  }
}

// A step in the page; if a page load cut it off, it's run again on the page that loaded.
async function runStep(tab, step, pf) {
  const result = await inPage(tab.id, fillPortfolio, [step, pf, TIMING]).catch(() => null);
  if (result) return result;
  await afterLoad(tab);
  return inPage(tab.id, fillPortfolio, [step, pf, TIMING]).catch(err => ({ ok: false, reason: err.message }));
}

async function afterLoad(tab) {
  await pause(1000);
  await waitForDocument(tab.id, 30000);
  await keepInTab(tab.id);
}

// ---- Runs inside the Lancers page, so it must be self-contained. ----
// Returns { ok, reason, missing: [what couldn't be found or set] }.
async function fillPortfolio(step, pf, T) {
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
  const titleField = () => [...document.querySelectorAll('textarea[name="title"]')].find(visible);

  const press = el => {
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
      el.dispatchEvent(type.startsWith("pointer") ? new PointerEvent(type, { ...at, pointerType: "mouse", isPrimary: true }) : new MouseEvent(type, at));
    }
    el.click();
  };

  // 新規作成: the button with the ＋ on the portfolio list, until the form shows.
  if (step === "start") {
    if (titleField()) return { ok: true, missing };
    const isNew = b => {
      const t = norm(b.textContent);
      return visible(b) && !b.disabled && !b.closest("header, nav, footer") && t.length <= 20 &&
        (/新規|作品を?(追加|作成|登録)|ポートフォリオを?(追加|作成|登録)/.test(t) || (b.querySelector("svg") && /(追加|作成|登録)/.test(t)));
    };
    const button = await waitFor(() => [...document.querySelectorAll("button, a, [role='button']")].find(isNew), 30000);
    if (!button) {
      const shown = [...document.querySelectorAll("button, a[role='button']")].filter(visible).map(b => norm(b.textContent)).filter(Boolean).slice(0, 10).join(" | ");
      return { ok: false, reason: `the 新規作成 button was not found on the portfolio page (buttons: ${shown})` };
    }
    for (let attempt = 0; attempt < 3 && !titleField(); attempt++) {
      press(button);
      if (await waitFor(() => titleField(), 10000)) break;
    }
    return titleField() ? { ok: true, missing } : { ok: false, stuck: true, reason: "pressed 新規作成 but the portfolio form didn't open" };
  }

  // 保存 (type=submit): Lancers leaves the form when it's saved; otherwise what it says is wrong is reported.
  if (step === "save") {
    const button = [...document.querySelectorAll("button[type='submit'], button")].find(b => visible(b) && !b.disabled && norm(b.textContent) === "保存");
    if (!button) return { ok: false, reason: "保存 button not found" };
    const before = location.href;
    press(button);
    const left = await waitFor(() => location.href !== before || !titleField(), 20000);
    if (left) return { ok: true, missing };
    const errors = [...document.querySelectorAll("[class*='error' i], [role='alert'], [aria-invalid='true']")]
      .filter(el => visible(el) && el.textContent.trim()).map(el => el.textContent.replace(/\s+/g, " ").trim())
      .filter((t, i, all) => all.indexOf(t) === i).slice(0, 4).join(" / ");
    return { ok: false, reason: errors ? `ページの表示: ${errors}` : "保存後もフォームのままでした" };
  }

  if (step !== "fill") return { ok: false, reason: `unknown step ${step}` };
  const form = titleField();
  if (!form) return { ok: false, reason: "the portfolio form (textarea name=title) is not open" };
  // Each thing not entered is noted with the stage of Job Finder's input its field belongs to
  // (1 基本情報 · 2 画像・コンテンツ · 3 制作内容 · 4 公開設定), set below as the fields are reached.
  let stage = 1;
  const note = missing.push.bind(missing);
  missing.push = (...texts) => note(...texts.map(text => ({ stage, text })));

  // React keeps its own copy of a field's value: the native setter, then the events it listens for.
  const setText = async (el, value) => {
    if (value == null || value === "") return;
    el.scrollIntoView({ block: "center" });
    el.focus();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, String(value));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.blur();
    await sleep(T.text);
  };
  // The controls under a heading (its own text, e.g. "カテゴリー" beside its 必須 badge): the smallest
  // block around a heading of that name that holds such controls, those after the heading. Headings in
  // links, tabs and the page header (the profile tabs 業種 / カテゴリー …) don't count.
  const under = (name, selector) => {
    let best = null;
    const heads = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6, legend, label, dt, th, p, span, div, strong")]
      .filter(el => visible(el) && !el.closest("a, nav, header, [role='tab'], [role='tablist'], select, option, button") && norm(ownText(el)) === norm(name));
    for (const head of heads) {
      for (let node = head.parentElement; node && node !== document.body; node = node.parentElement) {
        const controls = [...node.querySelectorAll(selector)].filter(c => head.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING);
        if (!controls.length) continue;
        const size = node.querySelectorAll("*").length;
        if (!best || size < best.size) best = { size, controls };
        break;
      }
    }
    return best?.controls || [];
  };
  const setSelect = async (select, option) => {
    select.scrollIntoView({ block: "center" });
    select.focus();
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, option.value);
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    select.blur();
    await sleep(T.select);
  };
  // A select found afresh each try (the page may draw it anew), chosen once it has the option, checked a
  // moment later, chosen again if the page put it back (up to 4 times).
  const chooseIn = async (findSelect, findOption, what, wanted) => {
    let option = null;
    for (let set = 0; set < 4; set++) {
      const ready = await waitFor(() => {
        const select = findSelect();
        const found = select && !select.disabled && findOption(select);
        return found ? [select, found] : null;
      }, 12000);
      if (!ready) break;
      [, option] = ready;
      await setSelect(ready[0], option);
      await sleep(900);
      if (findSelect()?.value === option.value) return true;
    }
    const select = findSelect();
    missing.push(`${what}: ${wanted}${!select ? " (not found on the page)" : option ? " (選択が保持されませんでした)" :
      ` (choices: ${[...select.options].map(o => norm(o.textContent)).filter(Boolean).slice(0, 15).join(", ")})`}`);
    return false;
  };
  const byText = (name, value) => select => {
    const options = [...select.options].filter(o => o.value !== "");
    return (name && (options.find(o => same(o.textContent, name)) || options.find(o => norm(o.textContent).includes(norm(name))))) ||
      (value != null && options.find(o => o.value === String(value))) || null;
  };
  const tickLabel = async (label, on) => {
    const box = [...document.querySelectorAll('input[type="checkbox"]')].find(i => {
      const holder = i.closest("label") || i.parentElement?.parentElement;
      return holder && norm(holder.textContent).includes(norm(label));
    });
    if (!box) { if (on) missing.push(`${label} (checkbox not found)`); return; }
    for (let attempt = 0; attempt < 3 && box.checked !== on; attempt++) {
      box.scrollIntoView({ block: "center" });
      (attempt === 0 ? (box.closest("label") || box) : box).click();
      await sleep(T.select);
      await waitFor(() => box.checked === on || null, 1200);
    }
    if (box.checked !== on) missing.push(`${label} (チェックできませんでした)`);
  };

  await setText(form, pf.title);
  if (pf.subtitle) {
    const subtitle = [...document.querySelectorAll('textarea[name="subtitle"]')].find(visible);
    if (subtitle) await setText(subtitle, pf.subtitle); else missing.push("サブタイトル");
  }

  stage = 2;
  // カバー画像 (one) and コンテンツ (the rest), handed in as files.
  const fileInputs = () => [...document.querySelectorAll('input[type="file"]')];
  const attach = async (input, metas) => {
    const list = new DataTransfer();
    for (const meta of metas) {
      const binary = atob((window.__facFiles?.[meta.key] || []).join(""));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      list.items.add(new File([bytes], meta.name, { type: meta.type }));
    }
    input.files = list.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    const size = metas.reduce((n, m) => n + (window.__facFiles?.[m.key] || []).join("").length * 0.75, 0);
    await sleep(T.click + Math.min(30000, size / 1e6 * 300)); // (time for the upload)
  };
  const covers = (pf.fileMeta || []).filter(f => f.kind === "cover").slice(0, 1);
  const contents = (pf.fileMeta || []).filter(f => f.kind === "content");
  if (covers.length) {
    const input = under("カバー画像", 'input[type="file"]')[0] || fileInputs()[0];
    if (input) await attach(input, covers); else missing.push(`カバー画像: ${covers[0].name}`);
  }
  if (contents.length) {
    const input = () => under("コンテンツ", 'input[type="file"]')[0] || fileInputs()[1];
    if (!input()) missing.push(`コンテンツ: ${contents.map(f => f.name).join("、")}`);
    else if (input().multiple) await attach(input(), contents);
    else for (const meta of contents) await attach(input() || fileInputs().at(-1), [meta]);
  }
  delete window.__facFiles;

  stage = 3;
  const description = under("説明文", "textarea")[0] || [...document.querySelectorAll('textarea[name="content"]')].find(visible);
  if (description) await setText(description, pf.description); else if (pf.description) missing.push("説明文");

  stage = 1;
  // 検索キーワード: typed, then Enter adds it.
  if (pf.keywords?.length) {
    const box = under("検索キーワード", "input:not([type='hidden']):not([type='checkbox']), textarea")[0];
    if (!box) missing.push("検索キーワード (field not found)");
    else for (const keyword of pf.keywords) {
      box.scrollIntoView({ block: "center" });
      box.focus();
      const proto = box instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(box, keyword);
      box.dispatchEvent(new Event("input", { bubbles: true }));
      for (const type of ["keydown", "keypress", "keyup"]) {
        box.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      }
      await sleep(T.text);
    }
  }

  // カテゴリー: 大 (by name, else Lancers' value), then 小 — in its group when the group is known.
  if (pf.category) {
    await chooseIn(() => under("カテゴリー", "select")[0], byText(pf.category.name, pf.category.id), "カテゴリー", pf.category.name);
    if (pf.subcategory) {
      const inGroup = select => {
        const options = [...select.options].filter(o => o.value !== "");
        const named = options.filter(o => same(o.textContent, pf.subcategory.name));
        return named.find(o => pf.subcategory.group && same(o.parentElement?.label || "", pf.subcategory.group)) || named[0] ||
          options.find(o => norm(o.textContent).includes(norm(pf.subcategory.name))) || null;
      };
      await chooseIn(() => under("カテゴリー", "select")[1], inGroup, "小カテゴリー", pf.subcategory.name);
    }
  }
  if (pf.industry) await chooseIn(() => under("業種", "select")[0], byText(pf.industry.name, pf.industry.id), "業種", pf.industry.name);

  stage = 3;
  if (pf.period) {
    const number = under("制作期間", "input:not([type='hidden'])")[0];
    if (number) await setText(number, pf.period.value); else missing.push("制作期間");
    await chooseIn(() => under("制作期間", "select")[0], byText(pf.period.unit), "制作期間の単位", pf.period.unit);
  }
  if (pf.price != null) {
    const price = under("参考価格", "input:not([type='hidden'])")[0];
    if (price) await setText(price, pf.price); else missing.push("参考価格");
  }
  stage = 4;
  if (pf.packageName) await chooseIn(() => under("パッケージ", "select")[0], byText(pf.packageName), "パッケージ", pf.packageName);

  // The three checkboxes, as Job Finder had them.
  const FLAGS = { generativeAi: "生成AIを活用した制作物です", inLancers: "ランサーズ内での制作物です", introduce: "ポートフォリオの紹介を希望します" };
  for (const [key, label] of Object.entries(FLAGS)) {
    if (pf.flags && key in pf.flags) await tickLabel(label, !!pf.flags[key]);
  }

  if (pf.visibility) await chooseIn(() => under("公開範囲", "select")[0], byText(pf.visibility.name, pf.visibility.value), "公開範囲", pf.visibility.name);
  if (pf.order != null) {
    const order = under("プロフィールでの表示順", "input:not([type='hidden'])")[0];
    if (order) await setText(order, pf.order); else missing.push("プロフィールでの表示順");
  }
  return { ok: true, missing };
}
