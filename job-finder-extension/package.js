// Lancers package (パッケージ出品) input, opened with PACKAGE in a Lancers account's window on the
// Accounts page. Five steps, in the order and with the fields of Lancers' own form:
//   1 基本情報の入力   title, subtitle, カテゴリー (大 → 中, then the 中カテゴリー's own checkboxes and 業務),
//                    業種, up to 5 検索キーワード
//   2 料金プランの入力 ベーシック / スタンダード / プレミアム (説明文, 納期, 価格), and オプション added under them
//   3 業務内容の入力   the service description, and よくある質問 (question + answer) added one by one
//   4 確認事項の入力   注文時のお願い, and 注文時の質問 (each with 必須)
//   5 画像ほかの登録   up to 3 images, a video, an audio file and a PDF (all optional); 出品する
// Any step can be opened from the step list at the top, and 次へ always moves on (a step left
// incomplete is marked "未入力あり"), and 出品する sends whatever is filled in (what's missing is listed
// as 未入力 in the request).
// What's typed is kept per account while the window is closed (also after Job Finder is closed).
// 出品する sends the package to Lancers through Slack, and nothing of it stays in Job Finder: its files
// and the package itself (package.json) are uploaded to Slack privately (only this Slack user can
// read them), then "PACKAGE REQUEST" naming the account (and the whole package in text, so it can be searched) is posted to #package. The Freelance Account
// Checker signed in to that account fills in Lancers' https://www.lancers.jp/myplan/add with it
// (its lancers-package.js) and answers in the request's thread, which this window shows.
import { CATEGORIES, SUBCATEGORY_FIELDS, INDUSTRIES, DELIVERY_DAYS, deliveryDay, LIMITS } from "./lancers-options.js";
import { getSlackToken, getReplies, uploadFile } from "./slack.js";
import { sendRequest } from "./slack-request.js";
import { noticeSent, noticeResult } from "./submit-notice.js";

const PACKAGE_CHANNEL = "package";   // Slack #package (made if missing)

const $ = id => document.getElementById(id);
const PLANS = [["basic", "ベーシック"], ["standard", "スタンダード"], ["premium", "プレミアム"]];
const FILES = {
  video: { label: "動画", accept: "video/mp4,.mp4", types: /^video\/mp4$|\.mp4$/i, formats: "MP4", maxMB: LIMITS.videoMB, icon: "🎬" },
  audio: { label: "音声", accept: "audio/mpeg,.mp3", types: /^audio\/(mpeg|mp3)$|\.mp3$/i, formats: "MP3", maxMB: LIMITS.audioMB, icon: "🔊" },
  pdf: { label: "PDF", accept: "application/pdf,.pdf", types: /^application\/pdf$|\.pdf$/i, formats: "PDF", maxMB: LIMITS.pdfMB, icon: "📄" }
};
const IMAGE_TYPES = /^image\/(jpeg|png|gif)$|\.(jpe?g|png|gif)$/i;

let account = null;
let draft = null;
let step = 0;
let errors = [];
let done = null;                     // the package sent, after 出品する: { summary, ts, channelId, replies }
let sending = "";                    // what 出品する is doing ("ファイルを送信中… 2 / 5")
let fileNote = "";                   // why a chosen file wasn't taken (step 5)
let bound = false;

const emptyPlan = () => ({ text: "", days: "", price: "" });
// A draft or template from before 納期 matched Lancers' choices: each 納期 moved to one Lancers has.
function fixDays(p) {
  for (const plan of Object.values(p.plans || {})) plan.days = deliveryDay(plan.days);
  for (const option of p.options || []) option.days = deliveryDay(option.days);
  return p;
}
const emptyDraft = () => ({
  title: "", subtitle: "", category: "", subcategory: "", details: {}, industry: "", keywords: ["", "", "", "", ""],
  plans: { basic: emptyPlan(), standard: emptyPlan(), premium: emptyPlan() }, options: [],
  work: "", faqs: [], request: "", questions: [],
  images: [], video: null, audio: null, pdf: null
});

// ---------- storage (IndexedDB: the draft being typed, per account label; templates, by name) ----------

let dbPromise = null;
function db() {
  return dbPromise ||= new Promise((resolve, reject) => {
    const open = indexedDB.open("jf-packages", 3);
    open.onupgradeneeded = () => {
      const names = open.result.objectStoreNames;
      if (!names.contains("drafts")) open.result.createObjectStore("drafts");
      if (!names.contains("templates")) open.result.createObjectStore("templates");
      if (!names.contains("pfTemplates")) open.result.createObjectStore("pfTemplates"); // (the portfolio input's, portfolio.js)
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}
// (Also used by the portfolio input, portfolio.js, for its drafts.)
export async function store(name, mode, use) {
  const tx = (await db()).transaction(name, mode);
  const request = use(tx.objectStore(name));
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}
let saveTimer;
function saveDraft() {
  clearTimeout(saveTimer);
  const label = account.label, copy = { ...draft, step };
  saveTimer = setTimeout(() => store("drafts", "readwrite", s => s.put(copy, label)).catch(err => console.warn("Job Finder: draft not saved", err)), 400);
}

// Templates: a whole package (every field and its files) kept under a name, for any Lancers account to
// start from. One is saved on each 出品する (named after its title; the same name is replaced), or
// with 「テンプレートに保存」 at any time.
let templates = [];                  // [{ name, savedAt }], newest first
let templateNote = "";
async function loadTemplates() {
  const all = await store("templates", "readonly", s => s.getAll()).catch(() => []);
  templates = (all || []).map(t => ({ name: t.name, savedAt: t.savedAt })).sort((a, b) => b.savedAt - a.savedAt);
}
const templateName = p => (p.title || "").trim() || `無題 ${new Date().toLocaleString("ja-JP")}`;
async function saveTemplate(p, name = templateName(p)) {
  const { reached, ...data } = p;
  await store("templates", "readwrite", s => s.put({ name, savedAt: Date.now(), data: structuredClone(data) }, name));
  await loadTemplates();
  return name;
}

// ---------- the window ----------

export async function openPackage(acct) {
  if (!bound) {
    bound = true;
    $("pkgDialog").addEventListener("click", e => { if (e.target === $("pkgDialog")) closePackage(); });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("pkgDialog").hidden) closePackage(); });
  }
  account = acct;
  const saved = await store("drafts", "readonly", s => s.get(acct.label)).catch(() => null);
  draft = fixDays({ ...emptyDraft(), ...(saved || {}) });
  step = Math.min(Math.max(saved?.step || 0, 0), STEPS.length - 1);
  delete draft.step;
  errors = [];
  done = null;
  templateNote = "";
  await loadTemplates();
  $("pkgDialog").hidden = false;
  $("pkgDialog").querySelector(".bid-window").style.setProperty("--site", "var(--lancers)");
  render();
}

function closePackage() {
  if (account && draft && !done) saveDraft();
  $("pkgDialog").hidden = true;
  account = null;
}

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
const badge = required => el("span", `pkg-badge${required ? " required" : ""}`, required ? "必須" : "任意");
const chars = s => [...(s || "")].length;

// A labelled field: "タイトル [必須]", a hint, the control.
function field(label, required, hint, ...controls) {
  const box = el("div", "pkg-field");
  const head = el("div", "pkg-label", label);
  if (required !== null) head.append(" ", badge(required));
  box.append(head);
  if (hint) box.append(el("div", "hint", hint));
  box.append(...controls);
  return box;
}

// A text box bound to obj[key], with a "n / max" counter (red when over).
function text(obj, key, max, { rows = 0, placeholder = "", label = "" } = {}) {
  const input = el(rows ? "textarea" : "input", rows ? "bid-text" : "pkg-input");
  if (rows) input.rows = rows; else input.type = "text";
  input.value = obj[key] || "";
  input.placeholder = placeholder;
  if (label) input.setAttribute("aria-label", label);
  const count = el("div", "pkg-count");
  const update = () => {
    const n = chars(input.value);
    count.textContent = `${n} / ${max}`;
    count.classList.toggle("over", n > max);
    input.classList.toggle("over", n > max);
  };
  input.addEventListener("input", () => { obj[key] = input.value; update(); saveDraft(); });
  update();
  const wrap = el("div", "pkg-text");
  wrap.append(input, count);
  return wrap;
}

function select(obj, key, choices, { placeholder = "選択してください", label = "", onChange } = {}) {
  const box = el("select", "pkg-select");
  if (label) box.setAttribute("aria-label", label);
  box.append(new Option(placeholder, ""));
  for (const [value, name] of choices) box.append(new Option(name, value));
  box.value = obj[key] || "";
  box.addEventListener("change", () => { obj[key] = box.value; saveDraft(); onChange?.(); });
  return box;
}
const daysSelect = (obj, label) => select(obj, "days", DELIVERY_DAYS.map(d => [String(d), `${d}日`]), { label });

function priceInput(obj, label) {
  const wrap = el("label", "pkg-price");
  const input = el("input");
  input.type = "number";
  input.min = "0";
  input.step = "1";
  input.inputMode = "numeric";
  input.value = obj.price || "";
  input.setAttribute("aria-label", label);
  input.addEventListener("input", () => { obj.price = input.value; saveDraft(); });
  wrap.append(input, el("span", "", "円"));
  return wrap;
}

const removeButton = onClick => button("⊗ 削除", "link pkg-remove", onClick);

// ---------- the steps ----------

const STEPS = [
  { title: "基本情報の入力", render: basicStep, check: checkBasic },
  { title: "料金プランの入力", render: planStep, check: checkPlans },
  { title: "業務内容の入力", render: workStep, check: checkWork },
  { title: "確認事項の入力", render: confirmStep, check: checkConfirm },
  { title: "画像ほかの登録", render: filesStep, check: () => [] }
];

function basicStep() {
  // 大カテゴリー → 中カテゴリー → that 中カテゴリー's checkboxes and 業務 (a new 中カテゴリー starts them afresh).
  const sub = el("div", "pkg-sub");
  const details = el("div", "pkg-details");
  const drawDetails = () => details.replaceChildren(...subcategoryFields(drawDetails));
  const drawSub = () => sub.replaceChildren(
    el("div", "pkg-sublabel", "中カテゴリー"),
    select(draft, "subcategory", (CATEGORIES[draft.category] || []).map(c => [c, c]), {
      label: "中カテゴリー",
      onChange: () => { draft.details = {}; saveDraft(); drawDetails(); }
    }));
  const main = select(draft, "category", Object.keys(CATEGORIES).map(c => [c, c]), {
    label: "大カテゴリー",
    onChange: () => {
      if (!(CATEGORIES[draft.category] || []).includes(draft.subcategory)) { draft.subcategory = ""; draft.details = {}; }
      drawSub();
      drawDetails();
    }
  });
  drawSub();
  drawDetails();
  const mainBox = el("div", "pkg-sub");
  mainBox.append(el("div", "pkg-sublabel", "大カテゴリー"), main);
  const categories = el("div", "pkg-row");
  categories.append(mainBox, sub);

  const keywords = el("div", "pkg-keywords");
  draft.keywords.forEach((_, i) => keywords.append(text(draft.keywords, i, LIMITS.keyword, { placeholder: `キーワード${i + 1}`, label: `検索キーワード${i + 1}` })));

  return [
    field("タイトル", true, "どのような業務を提供するのか、できるだけ詳しく入力してください。",
      text(draft, "title", LIMITS.title, { rows: 2, placeholder: "例: Shopifyで新規顧客を獲得して売上アップするECサイトを構築します" })),
    field("サブタイトル", false, "業務を提供する人を思い浮かべながら、あなたの強みや特徴をできるだけ詳しく入力してください",
      text(draft, "subtitle", LIMITS.subtitle, { rows: 2, placeholder: "例: 導入から運用までワンストップでお任せください" })),
    field("カテゴリー", true, "提供する業務を表す適切な項目を選択してください", categories),
    details,
    field("業種", true, "どんな業種の人に業務を提供するかを想像しながら、最適な業種を選択してください",
      select(draft, "industry", INDUSTRIES, { label: "業種" })),
    field("検索キーワード", false, `提供する業務を表す適切なキーワードがあれば入力してください（最大${LIMITS.keywords}件まで）`, keywords)
  ];
}

// The chosen 中カテゴリー's own fields: checkbox groups (任意, any number) and 業務 (one; 未選択 to start).
// "すべて選択 / すべて解除" at the top ticks or clears every checkbox of every group; each group's
// "すべて選択" box ticks or clears that group's.
function subcategoryFields(redraw) {
  const groups = SUBCATEGORY_FIELDS[draft.subcategory] || [];
  draft.details ||= {};
  const checks = groups.filter(g => g.type !== "radio");
  const setAll = (list, on) => {
    for (const g of list) draft.details[g.key || g.name] = on ? [...g.options] : [];
    saveDraft();
    redraw();
  };
  const allOf = g => (draft.details[g.key || g.name] || []).length === g.options.length;
  const toolbar = el("div", "pkg-select-all");
  if (checks.length) {
    toolbar.append(el("span", "hint", "チェックボックス:"),
      button("すべて選択", "btn ghost", () => setAll(checks, true)),
      button("すべて解除", "btn ghost", () => setAll(checks, false)));
  }
  return [...(checks.length ? [toolbar] : []), ...groups.map(group => {
    const grid = el("div", "pkg-choices");
    const key = group.key || group.name;
    for (const option of group.options) {
      const label = el("label", "pkg-check");
      const input = el("input");
      input.type = group.type === "radio" ? "radio" : "checkbox";
      input.name = `pkg-${key}`;
      input.value = option;
      if (group.type === "radio") {
        draft.details[key] ||= "未選択";
        input.checked = draft.details[key] === option;
        input.addEventListener("change", () => { draft.details[key] = option; saveDraft(); });
      } else {
        input.checked = (draft.details[key] || []).includes(option);
        input.addEventListener("change", () => {
          const chosen = new Set(draft.details[key] || []);
          if (input.checked) chosen.add(option); else chosen.delete(option);
          draft.details[key] = group.options.filter(o => chosen.has(o));
          saveDraft();
        });
      }
      label.append(input, ` ${option}`);
      grid.append(label);
    }
    const box = field(group.name, group.required, null, grid);
    if (group.type !== "radio" && group.options.length > 1) {
      const all = el("label", "pkg-check pkg-group-all");
      const toggle = el("input");
      toggle.type = "checkbox";
      toggle.checked = allOf(group);
      toggle.addEventListener("change", () => setAll([group], toggle.checked));
      all.append(toggle, " すべて選択");
      box.querySelector(".pkg-label").append(" ", all);
    }
    return box;
  })];
}

// "業務: 開発 · 目的: SNS、教育" — what's chosen under the 中カテゴリー (for the summary).
const detailsText = p => Object.entries(p.details || {})
  .map(([name, value]) => [name, Array.isArray(value) ? value.join("、") : value])
  .filter(([, value]) => value).map(([name, value]) => `${name}: ${value}`).join(" · ");

function checkBasic() {
  const e = [];
  if (!draft.title.trim()) e.push("タイトルを入力してください");
  if (chars(draft.title) > LIMITS.title) e.push(`タイトルは${LIMITS.title}文字以内で入力してください`);
  if (chars(draft.subtitle) > LIMITS.subtitle) e.push(`サブタイトルは${LIMITS.subtitle}文字以内で入力してください`);
  if (!draft.category || !draft.subcategory) e.push("カテゴリー（大カテゴリー・中カテゴリー）を選択してください");
  if (!draft.industry) e.push("業種を選択してください");
  if (draft.keywords.some(k => chars(k) > LIMITS.keyword)) e.push(`検索キーワードは各${LIMITS.keyword}文字以内で入力してください`);
  return e;
}

function planStep() {
  const sections = PLANS.map(([id, name]) => {
    const plan = draft.plans[id];
    const box = el("section", `pkg-plan ${id}`);
    const row = el("div", "pkg-row");
    row.append(field("納期", true, "プランの納期を選択してください", daysSelect(plan, `${name} 納期`)),
      field("価格 (税抜)", true, "プランの価格を入力してください", priceInput(plan, `${name} 価格`)));
    box.append(el("h3", "pkg-plan-name", name),
      field("説明文", true, "プランの説明文を入力してください", text(plan, "text", LIMITS.planText, { rows: 3, label: `${name} 説明文` })), row);
    return box;
  });

  const options = el("section", "pkg-options");
  options.append(el("h3", "pkg-section-title", "オプション"),
    el("div", "hint", "オプションを作ります。どのようなオプションを提供するのか、できるだけ詳しく入力してください"));
  draft.options.forEach((option, i) => {
    const box = el("div", "pkg-repeat");
    const row = el("div", "pkg-row");
    row.append(field("納期", true, null, daysSelect(option, `追加オプション${i + 1} 納期`)),
      field("価格 (税抜)", true, null, priceInput(option, `追加オプション${i + 1} 価格`)));
    box.append(el("div", "pkg-repeat-title", `追加オプション${i + 1}`),
      field("タイトル", true, null, text(option, "title", LIMITS.optionTitle, { label: `追加オプション${i + 1} タイトル` })),
      field("説明文", true, null, text(option, "text", LIMITS.optionText, { label: `追加オプション${i + 1} 説明文` })),
      row, removeButton(() => { draft.options.splice(i, 1); saveDraft(); render(); }));
    options.append(box);
  });
  options.append(button("＋ オプションを追加する", "btn ghost pkg-add", () => {
    draft.options.push({ title: "", text: "", days: "", price: "" });
    saveDraft();
    render({ focusLast: true });
  }));
  return [...sections, options];
}

const priceOk = p => /^\d+$/.test(String(p || "")) && Number(p) > 0;
function checkPlans() {
  const e = [];
  for (const [id, name] of PLANS) {
    const plan = draft.plans[id];
    if (!plan.text.trim()) e.push(`${name}の説明文を入力してください`);
    if (chars(plan.text) > LIMITS.planText) e.push(`${name}の説明文は${LIMITS.planText}文字以内で入力してください`);
    if (!plan.days) e.push(`${name}の納期を選択してください`);
    if (!priceOk(plan.price)) e.push(`${name}の価格を入力してください（円・整数）`);
  }
  // (A row left completely empty isn't sent, so it isn't missing anything.)
  draft.options.forEach((o, i) => {
    if (!o.title.trim() && !o.text.trim() && !o.days && !String(o.price ?? "").trim()) return;
    const name = `追加オプション${i + 1}`;
    if (!o.title.trim() || chars(o.title) > LIMITS.optionTitle) e.push(`${name}のタイトルを${LIMITS.optionTitle}文字以内で入力してください`);
    if (!o.text.trim() || chars(o.text) > LIMITS.optionText) e.push(`${name}の説明文を${LIMITS.optionText}文字以内で入力してください`);
    if (!o.days) e.push(`${name}の納期を選択してください`);
    if (!priceOk(o.price)) e.push(`${name}の価格を入力してください（円・整数）`);
  });
  return e;
}

function workStep() {
  const faqs = el("section", "pkg-faqs");
  draft.faqs.forEach((faq, i) => {
    const box = el("div", "pkg-repeat");
    box.append(text(faq, "q", LIMITS.faqQ, { placeholder: "質問", label: `よくある質問${i + 1} 質問` }),
      text(faq, "a", LIMITS.faqA, { rows: 5, placeholder: "回答", label: `よくある質問${i + 1} 回答` }),
      removeButton(() => { draft.faqs.splice(i, 1); saveDraft(); render(); }));
    faqs.append(box);
  });
  faqs.append(button("＋ よくある質問を追加する", "btn ghost pkg-add", () => {
    draft.faqs.push({ q: "", a: "" });
    saveDraft();
    render({ focusLast: true });
  }));
  return [
    field("業務内容", true, "どのような業務を提供するのか、できるだけ詳しく入力してください",
      text(draft, "work", LIMITS.work, { rows: 14, label: "業務内容" })),
    field("よくある質問", false, "発注者からよく聞かれる質問があれば、それに対する回答をあらかじめ記載しておくことで、その後のやり取りを効率化できます。", faqs)
  ];
}

function checkWork() {
  const e = [];
  if (!draft.work.trim()) e.push("業務内容を入力してください");
  if (chars(draft.work) > LIMITS.work) e.push(`業務内容は${LIMITS.work}文字以内で入力してください`);
  draft.faqs.forEach((f, i) => {
    if (!f.q.trim() && !f.a.trim()) return;
    if (!f.q.trim() ||chars(f.q) > LIMITS.faqQ) e.push(`よくある質問${i + 1}の質問を${LIMITS.faqQ}文字以内で入力してください`);
    if (!f.a.trim() || chars(f.a) > LIMITS.faqA) e.push(`よくある質問${i + 1}の回答を${LIMITS.faqA}文字以内で入力してください`);
  });
  return e;
}

function confirmStep() {
  const questions = el("section", "pkg-questions");
  draft.questions.forEach((question, i) => {
    const box = el("div", "pkg-repeat");
    const required = el("label", "pkg-check");
    const box2 = el("input");
    box2.type = "checkbox";
    box2.checked = question.required !== false;
    box2.addEventListener("change", () => { question.required = box2.checked; saveDraft(); });
    required.append(box2, " 必須");
    box.append(text(question, "text", LIMITS.question, { placeholder: "例:", label: `注文時の質問${i + 1}` }), required,
      removeButton(() => { draft.questions.splice(i, 1); saveDraft(); render(); }));
    questions.append(box);
  });
  questions.append(button("＋ 注文時の質問を追加する", "btn ghost pkg-add", () => {
    draft.questions.push({ text: "", required: true });
    saveDraft();
    render({ focusLast: true });
  }));
  return [
    el("p", "hint", "業務を提供するにあたり、事前に必要な情報、できること・できないことなど、できるだけ詳しく入力してください"),
    field("注文時のお願い", true, null, text(draft, "request", LIMITS.request, { rows: 7,
      placeholder: "例:\nご購入いただく際に、下記3点についてご連絡をいただけますと幸いです\n1. イメージされている制作物の内容やテイスト\n2. ターゲット層\n3. ご希望の納期" })),
    field("注文時の質問", false, "業務を提供するにあたり、事前に必要な質問があれば入力してください", questions)
  ];
}

function checkConfirm() {
  const e = [];
  if (!draft.request.trim()) e.push("注文時のお願いを入力してください");
  if (chars(draft.request) > LIMITS.request) e.push(`注文時のお願いは${LIMITS.request}文字以内で入力してください`);
  draft.questions.forEach((q, i) => {
    if (q.text.trim() && chars(q.text) > LIMITS.question) e.push(`注文時の質問${i + 1}を${LIMITS.question}文字以内で入力してください`);
  });
  return e;
}

// A file picker: "ファイルを選択する" box, or what's chosen with 削除.
function picker({ accept, multiple = false, onFiles, icon }) {
  const zone = el("label", "pkg-drop");
  const input = el("input");
  input.type = "file";
  input.accept = accept;
  input.multiple = multiple;
  input.hidden = true;
  input.addEventListener("change", () => { onFiles([...input.files]); input.value = ""; });
  zone.append(input, el("span", "pkg-drop-icon", icon), el("span", "hint", "ファイルを選択する"));
  zone.addEventListener("dragover", e => { e.preventDefault(); zone.classList.add("over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", e => { e.preventDefault(); zone.classList.remove("over"); onFiles([...e.dataTransfer.files]); });
  return zone;
}
const sizeText = bytes => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)}MB` : `${Math.ceil(bytes / 1024)}KB`);
function chosenFile(file, onRemove, preview = false) {
  const row = el("div", "pkg-file");
  if (preview) {
    const img = el("img", "pkg-thumb");
    img.src = URL.createObjectURL(file);
    img.alt = file.name;
    img.addEventListener("load", () => URL.revokeObjectURL(img.src), { once: true });
    row.append(img);
  }
  row.append(el("span", "pkg-file-name", file.name), el("span", "hint", sizeText(file.size)), removeButton(onRemove));
  return row;
}

function filesStep() {
  const problem = text => { fileNote = text; render(); };

  const images = el("div", "pkg-files");
  draft.images.forEach((file, i) => images.append(chosenFile(file, () => { draft.images.splice(i, 1); saveDraft(); render(); }, true)));
  if (draft.images.length < LIMITS.images) {
    images.append(picker({ accept: "image/jpeg,image/png,image/gif", multiple: true, icon: "🖼", onFiles: files => {
      const bad = files.filter(f => !IMAGE_TYPES.test(f.type || f.name) || f.size > LIMITS.imageMB * 1048576);
      const room = LIMITS.images - draft.images.length;
      const ok = files.filter(f => !bad.includes(f));
      draft.images.push(...ok.slice(0, room));
      saveDraft();
      problem([bad.length && `${bad.map(f => f.name).join("、")}: JPG・PNG・GIF、${LIMITS.imageMB}MBまでのファイルを選択してください`,
        ok.length > room && `画像は${LIMITS.images}つまでです`].filter(Boolean).join(" / "));
    } }));
  }
  const imageRow = el("div", "pkg-file-row");
  const imageInfo = el("div", "pkg-file-info");
  const optional = name => { const h = el("h3", "pkg-plan-name", name); h.append(" ", badge(false)); return h; };
  imageInfo.append(optional("画像"),
    el("div", "hint", `推奨サイズ：1220 x 686px (16:9)\n対応形式：JPG、PNG、GIF\n最大サイズ：${LIMITS.imageMB}MB\n画像数：${LIMITS.images}つまで`));
  imageRow.append(imageInfo, images);

  const rows = Object.entries(FILES).map(([key, kind]) => {
    const row = el("div", "pkg-file-row");
    const info = el("div", "pkg-file-info");
    info.append(optional(kind.label), el("div", "hint", `対応ファイル形式：${kind.formats}\n最大サイズ：${kind.maxMB}MB`));
    const slot = el("div", "pkg-files");
    slot.append(draft[key]
      ? chosenFile(draft[key], () => { draft[key] = null; saveDraft(); render(); })
      : picker({ accept: kind.accept, icon: kind.icon, onFiles: ([file]) => {
          if (!file) return;
          if (!kind.types.test(file.type || file.name) || file.size > kind.maxMB * 1048576) {
            problem(`${file.name}: ${kind.formats}、${kind.maxMB}MBまでのファイルを選択してください`);
            return;
          }
          draft[key] = file;
          saveDraft();
          render();
        } }));
    row.append(info, slot);
    return row;
  });

  return [
    el("p", "pkg-lead", "画像、動画、音声、PDF等を登録すると受注率が約10倍になります。\n特に1枚目に登録する画像はパッケージの代表画像で、購入されるためにとても重要な画像です。"),
    el("p", "hint", "どれも任意です。ファイルがなくても「出品する」で送信できます。"),
    el("p", "error-text pkg-file-note", fileNote),
    imageRow, ...rows
  ];
}

// ---------- drawing ----------

function render({ focusLast = false } = {}) {
  if (!account) return;
  const head = el("div", "bid-head");
  const title = el("div", "grow");
  const h = el("h2", "", "📦 パッケージ出品");
  h.id = "pkgTitle";
  const icon = el("img", "tag-icon");
  icon.src = chrome.runtime.getURL("icons/site-lancers.png");
  icon.alt = "";
  h.prepend(icon);
  title.append(h, el("div", "bid-job", `${account.name || account.label} (${account.label}) · Lancers`));
  head.append(title, button("×", "icon", closePackage));
  head.lastChild.setAttribute("aria-label", "Close");

  const body = el("div", "bid-content pkg-content");
  if (done) {
    body.append(...doneView());
    $("pkgBody").replaceChildren(head, body);
    return;
  }
  // The five stages, each opening its step, with a circle: blinking green on the one being worked on,
  // green once left complete, red once left with something missing ("未入力あり").
  const steps = el("ol", "pkg-steps");
  STEPS.forEach((s, i) => {
    const left = i !== step && i <= (draft.reached || 0);
    const missing = left && s.check().length > 0;
    const item = el("li", [i === step && "current", left && (missing ? "incomplete" : "complete")].filter(Boolean).join(" "),
      `${i + 1}. ${s.title}`);
    if (left && missing) item.append(el("span", "pkg-step-note", "未入力あり"));
    item.title = i === step ? "入力中" : !left ? "未入力" : missing ? s.check().join("\n") : "入力済み";
    item.tabIndex = 0;
    item.setAttribute("role", "button");
    if (i === step) item.setAttribute("aria-current", "step");
    item.addEventListener("click", () => go(i));
    item.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(i); } });
    steps.append(item);
  });
  body.append(templateBar(), steps, el("h3", "pkg-step-title", STEPS[step].title), ...STEPS[step].render());

  if (errors.length) {
    const box = el("ul", "pkg-errors");
    for (const e of errors) box.append(el("li", "", e));
    body.append(box);
  }
  const actions = el("div", "bid-actions");
  if (step > 0) actions.append(button("戻る", "btn ghost", () => go(step - 1)));
  actions.append(step < STEPS.length - 1
    ? button("次へ", "btn", () => next())
    : button(sending ? "送信中…" : "出品する", "btn pkg-submit", () => submit()));
  if (sending) {
    actions.querySelectorAll("button").forEach(b => { b.disabled = true; });
    actions.prepend(el("span", "hint pkg-sending", sending));
  }
  body.append(actions);

  $("pkgBody").replaceChildren(head, body);
  if (focusLast) [...$("pkgBody").querySelectorAll(".pkg-repeat")].pop()?.querySelector("input, textarea")?.focus();
  if (errors.length) $("pkgBody").querySelector(".pkg-errors")?.scrollIntoView({ block: "nearest" });
}

// テンプレート: [choose ▾] 読み込む 削除 · テンプレートに保存. 読み込む replaces what's typed with the
// template (after asking, when something is typed); the files come with it.
function templateBar() {
  const bar = el("div", "pkg-templates");
  const pick = el("select");
  pick.setAttribute("aria-label", "テンプレート");
  pick.append(new Option(templates.length ? "テンプレートを選択…" : "テンプレートはまだありません", ""));
  for (const t of templates) pick.append(new Option(`${t.name}（${new Date(t.savedAt).toLocaleDateString("ja-JP")}）`, t.name));
  pick.disabled = !templates.length;
  const note = text => { templateNote = text; render(); };
  const load = button("読み込む", "btn ghost", async () => {
    if (!pick.value) return;
    const typed = draft.title.trim() || draft.work.trim() || draft.subcategory;
    if (typed && !confirm(`入力中の内容をテンプレート「${pick.value}」で置き換えますか？`)) return;
    const saved = await store("templates", "readonly", s => s.get(pick.value)).catch(() => null);
    if (!saved) return note("テンプレートが見つかりませんでした");
    draft = fixDays({ ...emptyDraft(), ...structuredClone(saved.data), reached: STEPS.length - 1 });
    step = 0;
    errors = [];
    saveDraft();
    note(`テンプレート「${saved.name}」を読み込みました`);
  });
  const remove = button("削除", "btn ghost", async () => {
    if (!pick.value || !confirm(`テンプレート「${pick.value}」を削除しますか？`)) return;
    await store("templates", "readwrite", s => s.delete(pick.value)).catch(() => {});
    await loadTemplates();
    note(`テンプレート「${pick.value}」を削除しました`);
  });
  const save = button("テンプレートに保存", "btn ghost", async () => {
    const name = await saveTemplate(draft).catch(err => { note(`保存できませんでした: ${err.message}`); return null; });
    if (name) note(`テンプレート「${name}」に保存しました`);
  });
  load.disabled = remove.disabled = !templates.length;
  bar.append(el("span", "pkg-sublabel", "テンプレート"), pick, load, remove, save);
  if (templateNote) bar.append(el("span", "hint", templateNote));
  return bar;
}

function go(i) {
  draft.reached = Math.max(draft.reached || 0, step, i);
  step = i;
  errors = [];
  fileNote = "";
  saveDraft();
  render();
  $("pkgDialog").querySelector(".bid-window").scrollTop = 0;
}

// 次へ moves on whether or not this step is complete (what's missing is marked in the step list).
function next() {
  go(step + 1);
}

async function submit() {
  // Sent even with fields left empty: what's missing goes with the request (未入力), and Freelance
  // Account Checker fills in what there is.
  if (sending) return;
  draft.reached = STEPS.length - 1;
  const acct = account, p = draft;
  const incompleteSteps = STEPS.map(s => s.check());   // (per stage, so each stage's circle can show it)
  const incomplete = incompleteSteps.flat();
  const show = text => { sending = text; if (account === acct) render(); };
  try {
    const token = await getSlackToken();
    if (!token) throw new Error("Slack に接続されていません（Settings で Slack token を保存してください）");
    // The files first (privately, in no channel), then the package with their IDs as package.json.
    // (Images, video, audio and PDF are all optional: a package without any sends none.)
    const files = [...(p.images || []).map(f => ["image", f]), ...["video", "audio", "pdf"].filter(k => p[k]).map(k => [k, p[k]])];
    const sent = [];
    for (const [i, [kind, file]] of files.entries()) {
      show(`ファイルを Slack に送信中… ${i + 1} / ${files.length}（${file.name}）`);
      sent.push({ kind, name: file.name, type: file.type, size: file.size, id: await uploadFile(token, file.name, file) });
    }
    show("パッケージを Slack に送信中…");
    const data = { ...lancersPackage(p, acct, sent), incomplete, incompleteSteps };
    const { ts, channelId } = await sendRequest(token, {
      channel: PACKAGE_CHANNEL, kind: "PACKAGE", data, requestText: dataId => requestText(data, dataId),
      onProgress: (n, of) => show(`パッケージを Slack に送信中… ${n} / ${of}`)
    });
    // Sent: the package (with its files) is kept as a template to start the next one from, and the draft is removed.
    clearTimeout(saveTimer);
    const template = await saveTemplate(p).catch(() => "");
    await store("drafts", "readwrite", s => s.delete(acct.label)).catch(() => {});
    done = { summary: data, ts, channelId, replies: [], template };
    noticeSent("パッケージ", data.title, acct.label);
    sending = "";
    if (account === acct) render();
    watchReplies(done, token);
  } catch (err) {
    sending = "";
    errors = [`送信できませんでした: ${err.message}`];
    if (account === acct) render();
  }
}

// The PACKAGE REQUEST message. Its first lines (アカウント, データ) are what Freelance Account Checker
// reads; the rest is the whole package in plain text, so #package can be searched in Slack (by title,
// category, keyword, account, price…).
function requestText(d, dataId) {
  const kinds = { image: "画像", video: "動画", audio: "音声", pdf: "PDF" };
  const text = [
    "PACKAGE REQUEST",
    `アカウント: ${d.account}`,
    `データ: ${dataId}`,
    `名前: ${d.accountName || d.account}`,
    `タイトル: ${d.title || "（未入力）"}`,
    d.subtitle && `サブタイトル: ${d.subtitle}`,
    `カテゴリー: ${[d.category, d.subcategory].filter(Boolean).join(" › ") || "（未選択）"}`,
    ...d.details.map(g => `${g.name}: ${g.values.join("、")}`),
    d.industry && `業種: ${d.industry.name}`,
    d.keywords.length && `検索キーワード: ${d.keywords.join("、")}`,
    ...d.plans.map(plan => `${plan.name}: ${terms(plan)} — ${plan.text}`),
    ...d.options.map((o, i) => `オプション${i + 1}: ${o.title} ${terms(o)} — ${o.text}`),
    d.work && `業務内容:\n${d.work}`,
    ...d.faqs.map((f, i) => `よくある質問${i + 1}: ${f.question} → ${f.answer}`),
    d.request && `注文時のお願い:\n${d.request}`,
    ...d.questions.map((q, i) => `注文時の質問${i + 1}: ${q.text}${q.required ? "（必須）" : ""}`),
    `ファイル: ${d.files.length ? d.files.map(f => `${kinds[f.kind]} ${f.name}`).join("、") : "なし"}`,
    d.incomplete?.length && `未入力: ${d.incomplete.join(" / ")}`
  ].filter(Boolean).join("\n");
  return text;
}

// "5,000円 / 3日", with "—" for a price or 納期 not entered.
const terms = o => `${o.price == null ? "—" : `${o.price.toLocaleString()}円`} / ${o.days == null ? "—" : `${o.days}日`}`;
// A number field's value, or null when it's empty (or not a number).
const num = v => (v === "" || v == null || !Number.isFinite(Number(v)) ? null : Number(v));

// What Freelance Account Checker needs to fill in Lancers' form, in its words: the 中カテゴリー's own
// fields by their heading on the page (the nth one with that heading), 業種 by Lancers' option value.
function lancersPackage(p, acct, files) {
  const seen = {};
  const details = (SUBCATEGORY_FIELDS[p.subcategory] || []).map(group => {
    const occurrence = seen[group.name] = (seen[group.name] ?? -1) + 1;
    const value = p.details?.[group.key || group.name];
    const values = group.type === "radio" ? (value && value !== "未選択" ? [value] : []) : (value || []);
    return { name: group.name, occurrence, type: group.type, values };
  }).filter(group => group.values.length);
  const industry = INDUSTRIES.find(([id]) => id === p.industry);
  return {
    version: 1, account: acct.label, accountName: acct.name || "",
    title: p.title, subtitle: p.subtitle, category: p.category, subcategory: p.subcategory, details,
    industry: industry ? { id: industry[0], name: industry[1] } : null,
    keywords: p.keywords.map(k => k.trim()).filter(Boolean),
    plans: PLANS.map(([id, name]) => ({ name, text: p.plans[id].text, days: num(deliveryDay(p.plans[id].days)), price: num(p.plans[id].price) })),
    // (Rows left completely empty are not sent.)
    options: p.options.filter(o => o.title.trim() || o.text.trim() || num(o.price) != null)
      .map(o => ({ title: o.title, text: o.text, days: num(deliveryDay(o.days)), price: num(o.price) })),
    work: p.work, faqs: p.faqs.filter(f => f.q.trim() || f.a.trim()).map(f => ({ question: f.q, answer: f.a })),
    request: p.request, questions: p.questions.filter(q => q.text.trim()).map(q => ({ text: q.text, required: q.required !== false })),
    files
  };
}

// Freelance Account Checker's progress and result, from the request's thread (every 5 s, 30 minutes).
async function watchReplies(sent, token) {
  const end = Date.now() + 30 * 60000;
  while (done === sent && Date.now() < end) {
    await new Promise(r => setTimeout(r, 5000));
    if (done !== sent) return;
    try {
      const replies = (await getReplies(token, sent.channelId, sent.ts)).filter(r => !/^PACKAGE DATA\b/.test(r.text || ""));
      if (replies.length !== sent.replies.length) {
        sent.replies = replies;
        if (account && !$("pkgDialog").hidden) render();
      }
      const result = replies.find(r => /PACKAGE (SUCCESS|FILLED|FAILURE)/.test(r.text || ""));
      if (result) { noticeResult("パッケージ", sent.summary.title, sent.summary.account, result.text); return; }
    } catch { /* tried again in 5 s */ }
  }
}

// Freelance Account Checker's report of each stage: "PACKAGE STEP 2/5 ✓ 料金プラン" or "… ✗ 料金プラン — why".
const STAGE_REPLY = /^PACKAGE STEP (\d)\/5 (✓|✗)[^—]*(?:— ([\s\S]*))?$/;
const unslack = text => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// The submission as five stages on Lancers: the one being entered blinks green, a stage entered
// completely is green, one left incomplete or with an error is red (with why), the rest grey.
function progressView(state) {
  const reports = new Map();
  for (const reply of done.replies) {
    const m = (reply.text || "").match(STAGE_REPLY);
    if (m) reports.set(Number(m[1]) - 1, { ok: m[2] === "✓", why: m[3] ? unslack(m[3]).trim() : "" });
  }
  // (Working on the stage after the last one reported, until Freelance Account Checker has finished.)
  const started = done.replies.length > 0;
  const current = state === "proposing" && started ? Math.max(-1, ...reports.keys()) + 1 : -1;
  const list = el("ol", "pkg-steps pkg-progress");
  STEPS.forEach((s, i) => {
    const report = reports.get(i);
    const failedHere = state === "failure" && !report && i === Math.max(-1, ...reports.keys()) + 1;
    const cls = i === current ? "current" : report ? (report.ok ? "complete" : "incomplete") : failedHere ? "incomplete" : "";
    const item = el("li", cls, `${i + 1}. ${s.title}`);
    const note = i === current ? "入力中…" : report && !report.ok ? report.why || "未完了" : "";
    if (note) item.append(el("span", "pkg-step-note", `· ${note}`));
    list.append(item);
  });
  return list;
}

function doneView() {
  const p = done.summary;
  const facts = el("dl", "bid-facts");
  const add = (k, v) => { facts.append(el("dt", "", k), el("dd", "", v)); };
  add("タイトル", p.title || "（未入力）");
  if (p.subtitle) add("サブタイトル", p.subtitle);
  add("カテゴリー", [p.category, p.subcategory].filter(Boolean).join(" › ") || "（未選択）");
  const details = p.details.map(d => `${d.name}: ${d.values.join("、")}`).join(" · ");
  if (details) add("詳細", details);
  add("業種", p.industry?.name || "");
  if (p.keywords.length) add("検索キーワード", p.keywords.join("、"));
  for (const plan of p.plans) add(plan.name, `${terms(plan)} · ${plan.text}`);
  if (p.options.length) add("オプション", p.options.map(o => `${o.title}（${terms(o)}）`).join("、"));
  if (p.faqs.length) add("よくある質問", `${p.faqs.length}件`);
  if (p.questions.length) add("注文時の質問", `${p.questions.length}件`);
  if (p.incomplete?.length) add("未入力", p.incomplete.join(" / "));
  const kinds = { image: "画像", video: "動画", audio: "音声", pdf: "PDF" };
  add("ファイル", p.files.length ? p.files.map(f => `${kinds[f.kind]} ${f.name}`).join("、") : "なし");

  // Freelance Account Checker's answers in the request's thread (newest last).
  const last = done.replies.at(-1)?.text || "";
  const state = /PACKAGE FAILURE/.test(last) ? "failure" : /PACKAGE (SUCCESS|FILLED)/.test(last) ? "success" : "proposing";
  const partly = state === "success" && last.startsWith("⚠️");   // (stopped where Lancers needs more)
  const status = el("div", `bid-status ${state}`);
  status.append(el("div", "bid-status-title", partly ? "⚠️ Lancers に入力できたところまで入力しました"
    : { failure: "❌ Lancers への入力に失敗しました", success: "✅ Lancers に入力しました", proposing: "⏳ Lancers に送信しました" }[state]),
    el("p", "", state === "proposing"
      ? "Slack の #package に PACKAGE REQUEST を送りました（#package で検索できます）。このアカウントの Freelance Account Checker が Lancers のパッケージ作成ページを開いて入力します（このウィンドウに結果が表示されます）。Job Finder には何も保存していません。"
      : ""));
  status.append(progressView(state));
  for (const reply of done.replies.filter(r => !STAGE_REPLY.test(r.text || ""))) {
    status.append(el("div", "bid-reason", unslack(reply.text)));
  }
  status.append(facts);
  const actions = el("div", "bid-actions");
  if (done.template) actions.append(el("span", "hint", `テンプレート「${done.template}」に保存しました（次回「テンプレート」から読み込めます）`));
  actions.append(button("閉じる", "btn", closePackage));
  return [status, actions];
}
