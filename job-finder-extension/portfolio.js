// Lancers portfolio (ポートフォリオ) input, opened with PORTFOLIO in a Lancers account's window on the
// Accounts page. It works as the package input does (package.js): stages with a stage list (circles:
// blinking green on the one shown, green when complete, red when something's missing), 戻る / 次へ that
// always move on, templates, and 送信 on the last stage. The stages hold the fields of Lancers' own form:
//   1 基本情報の入力         タイトル, サブタイトル, カテゴリー (大 → 小, in the 小カテゴリー's groups), 業種,
//                            検索キーワード (10 boxes)
//   2 画像・コンテンツの登録  カバー画像 (one image), コンテンツ (up to 10 images / videos / audio files)
//   3 制作内容の入力         説明文, 制作期間 (number + unit), 参考価格
//   4 公開設定               パッケージ, the three checkboxes, 公開範囲, プロフィールでの表示順
// What's typed is kept per account while the window is closed (in the package input's IndexedDB).
// 送信 sends it to Lancers through Slack, as 出品する does for packages: the files are uploaded to Slack
// privately, then "PORTFOLIO REQUEST" naming the account (and the whole portfolio in text, so it can be
// searched) is posted to #portfolio with the data in its thread. The Freelance Account Checker signed in
// to that account opens https://www.lancers.jp/myportfolio, presses 新規作成, fills in the form, saves
// it (its lancers-portfolio.js) and answers in the request's thread, which this window shows.
import { PF_CATEGORIES, PF_SUBCATEGORIES, PF_PERIOD_UNITS, PF_VISIBILITY, PF_FLAGS, PF_LIMITS } from "./portfolio-options.js";
import { INDUSTRIES } from "./lancers-options.js";
import { store } from "./package.js";
import { getSlackToken, getReplies, uploadFile } from "./slack.js";
import { sendRequest } from "./slack-request.js";
import { noticeSent, noticeResult } from "./submit-notice.js";

const PORTFOLIO_CHANNEL = "portfolio";   // Slack #portfolio (made if missing)
const COVER_TYPES = /^image\/(jpeg|png|gif)$|\.(jpe?g|png|gif)$/i;
const CONTENT_TYPES = /^(image\/(jpeg|png|gif)|video\/(mp4|quicktime)|audio\/(mpeg|mp3))$|\.(jpe?g|png|gif|mp4|mov|mp3)$/i;
const OTHER_SUB = "__other";             // 小カテゴリー: リストにない（直接入力）

const $ = id => document.getElementById(id);
let account = null;
let draft = null;
let done = null;                         // the portfolio sent: { summary, ts, channelId, replies }
let sending = "";
let note = "";                           // why a chosen file wasn't taken, or why sending failed
let bound = false;

const emptyDraft = () => ({
  title: "", subtitle: "", cover: null, contents: [], description: "", keywords: Array(PF_LIMITS.keywords).fill(""),
  category: "", subGroup: "", sub: "", subCustom: "", industry: "", period: "", periodUnit: "", price: "",
  packageName: "", flags: { generativeAi: false, inLancers: false, introduce: false }, visibility: "", order: "1"
});
const draftKey = acct => `portfolio:${acct.label}`;
let step = 0;                            // the stage shown (PF_STEPS)
let saveTimer;
function saveDraft() {
  clearTimeout(saveTimer);
  const key = draftKey(account), copy = { ...draft, step };
  saveTimer = setTimeout(() => store("drafts", "readwrite", s => s.put(copy, key)).catch(err => console.warn("Job Finder: portfolio draft not saved", err)), 400);
}

// Templates, as the package input's: a whole portfolio item (with its files) kept under a name, for any
// Lancers account to start from. One is saved on each 送信 (named after its title; the same name is
// replaced), or with 「テンプレートに保存」 at any time.
let templates = [];                      // [{ name, savedAt }], newest first
let templateNote = "";
async function loadTemplates() {
  const all = await store("pfTemplates", "readonly", s => s.getAll()).catch(() => []);
  templates = (all || []).map(t => ({ name: t.name, savedAt: t.savedAt })).sort((a, b) => b.savedAt - a.savedAt);
}
const templateName = p => (p.title || "").trim() || `無題 ${new Date().toLocaleString("ja-JP")}`;
async function saveTemplate(p, name = templateName(p)) {
  const { reached, ...data } = p;
  await store("pfTemplates", "readwrite", s => s.put({ name, savedAt: Date.now(), data: structuredClone(data) }, name));
  await loadTemplates();
  return name;
}

// テンプレート: [choose ▾] 読み込む 削除 · テンプレートに保存.
function templateBar() {
  const bar = el("div", "pkg-templates");
  const pick = el("select");
  pick.setAttribute("aria-label", "テンプレート");
  pick.append(new Option(templates.length ? "テンプレートを選択…" : "テンプレートはまだありません", ""));
  for (const t of templates) pick.append(new Option(`${t.name}（${new Date(t.savedAt).toLocaleDateString("ja-JP")}）`, t.name));
  pick.disabled = !templates.length;
  const tell = message => { templateNote = message; render(); };
  const load = button("読み込む", "btn ghost", async () => {
    if (!pick.value) return;
    const typed = draft.title.trim() || draft.description.trim() || draft.category;
    if (typed && !confirm(`入力中の内容をテンプレート「${pick.value}」で置き換えますか？`)) return;
    const saved = await store("pfTemplates", "readonly", s => s.get(pick.value)).catch(() => null);
    if (!saved) return tell("テンプレートが見つかりませんでした");
    draft = { ...emptyDraft(), ...structuredClone(saved.data), reached: PF_STEPS.length - 1 };
    draft.keywords = Array.from({ length: PF_LIMITS.keywords }, (_, i) => draft.keywords?.[i] || "");
    step = 0;
    saveDraft();
    tell(`テンプレート「${saved.name}」を読み込みました`);
  });
  const remove = button("削除", "btn ghost", async () => {
    if (!pick.value || !confirm(`テンプレート「${pick.value}」を削除しますか？`)) return;
    await store("pfTemplates", "readwrite", s => s.delete(pick.value)).catch(() => {});
    await loadTemplates();
    tell(`テンプレート「${pick.value}」を削除しました`);
  });
  const save = button("テンプレートに保存", "btn ghost", async () => {
    const name = await saveTemplate(draft).catch(err => { tell(`保存できませんでした: ${err.message}`); return null; });
    if (name) tell(`テンプレート「${name}」に保存しました`);
  });
  load.disabled = remove.disabled = !templates.length;
  bar.append(el("span", "pkg-sublabel", "テンプレート"), pick, load, remove, save);
  if (templateNote) bar.append(el("span", "hint", templateNote));
  return bar;
}

// The four stages, each opening its stage, with a circle: blinking green on the one being worked on,
// green once left complete, red once left with something missing ("未入力あり"), grey not yet opened.
function stepList() {
  const steps = el("ol", "pkg-steps");
  PF_STEPS.forEach((title, i) => {
    const left = i !== step && i <= (draft.reached || 0);
    const missing = left && checkStep(i).length > 0;
    const item = el("li", [i === step && "current", left && (missing ? "incomplete" : "complete")].filter(Boolean).join(" "), `${i + 1}. ${title}`);
    if (missing) item.append(el("span", "pkg-step-note", "未入力あり"));
    item.title = i === step ? "入力中" : !left ? "未入力" : missing ? checkStep(i).join("\n") : "入力済み";
    item.tabIndex = 0;
    item.setAttribute("role", "button");
    if (i === step) item.setAttribute("aria-current", "step");
    item.addEventListener("click", () => go(i));
    item.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(i); } });
    steps.append(item);
  });
  return steps;
}

function go(i) {
  draft.reached = Math.max(draft.reached || 0, step, i);
  step = i;
  note = "";
  saveDraft();
  render();
  $("pfDialog").querySelector(".bid-window").scrollTop = 0;
}

// ---------- the window ----------

export async function openPortfolio(acct) {
  if (!bound) {
    bound = true;
    $("pfDialog").addEventListener("click", e => { if (e.target === $("pfDialog")) closePortfolio(); });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("pfDialog").hidden) closePortfolio(); });
  }
  account = acct;
  const saved = await store("drafts", "readonly", s => s.get(draftKey(acct))).catch(() => null);
  draft = { ...emptyDraft(), ...(saved || {}) };
  draft.flags = { ...emptyDraft().flags, ...(draft.flags || {}) };
  // (Always the 10 keyword boxes, also for a draft from before they were boxes.)
  draft.keywords = Array.from({ length: PF_LIMITS.keywords }, (_, i) => draft.keywords?.[i] || "");
  step = Math.min(Math.max(saved?.step || 0, 0), PF_STEPS.length - 1);
  delete draft.step;
  done = null;
  note = "";
  templateNote = "";
  await loadTemplates();
  // (Package templates' titles are offered for パッケージ.)
  packageNames = await store("templates", "readonly", s => s.getAllKeys()).catch(() => []) || [];
  $("pfDialog").hidden = false;
  $("pfDialog").querySelector(".bid-window").style.setProperty("--site", "var(--lancers)");
  render();
}
let packageNames = [];

function closePortfolio() {
  if (account && draft && !done) saveDraft();
  $("pfDialog").hidden = true;
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
function field(label, required, hint, ...controls) {
  const box = el("div", "pkg-field");
  const head = el("div", "pkg-label", label);
  head.append(" ", badge(required));
  box.append(head);
  if (hint) box.append(el("div", "hint", hint));
  box.append(...controls);
  return box;
}
// (Bound to draft[key], or to get / set when given.)
function text(key, max, { rows = 0, placeholder = "", label = "", get = () => draft[key], set = value => { draft[key] = value; } } = {}) {
  const input = el(rows ? "textarea" : "input", rows ? "bid-text" : "pkg-input");
  if (rows) input.rows = rows; else input.type = "text";
  input.value = get() || "";
  input.placeholder = placeholder;
  if (label) input.setAttribute("aria-label", label);
  const count = el("div", "pkg-count");
  const update = () => {
    const n = chars(input.value);
    count.textContent = `${n} / ${max}`;
    count.classList.toggle("over", n > max);
    input.classList.toggle("over", n > max);
  };
  input.addEventListener("input", () => { set(input.value); update(); saveDraft(); });
  update();
  const wrap = el("div", "pkg-text");
  wrap.append(input, count);
  return wrap;
}
function select(key, choices, { placeholder = "選択してください", label = "", onChange, groups = null } = {}) {
  const box = el("select", "pkg-select");
  if (label) box.setAttribute("aria-label", label);
  box.append(new Option(placeholder, ""));
  if (groups) {
    for (const [group, items] of groups) {
      const optgroup = el("optgroup");
      optgroup.label = group;
      for (const [value, name] of items) optgroup.append(new Option(name, value));
      box.append(optgroup);
    }
  }
  for (const [value, name] of choices) box.append(new Option(name, value));
  box.value = draft[key] || "";
  box.addEventListener("change", () => { draft[key] = box.value; saveDraft(); onChange?.(box.value); });
  return box;
}
function numberInput(key, { placeholder = "", label = "", min = "0" } = {}) {
  const input = el("input", "pkg-input pf-number");
  input.type = "number";
  input.min = min;
  input.step = "1";
  input.inputMode = "numeric";
  input.placeholder = placeholder;
  input.value = draft[key] || "";
  input.setAttribute("aria-label", label);
  input.addEventListener("input", () => { draft[key] = input.value; saveDraft(); });
  return input;
}
const sizeText = bytes => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)}MB` : `${Math.ceil(bytes / 1024)}KB`);
function picker({ accept, multiple = false, onFiles, label }) {
  const zone = el("label", "pkg-drop pf-drop");
  const input = el("input");
  input.type = "file";
  input.accept = accept;
  input.multiple = multiple;
  input.hidden = true;
  input.addEventListener("change", () => { onFiles([...input.files]); input.value = ""; });
  zone.append(input, el("span", "hint", "ここにファイルをドラッグ＆ドロップ\nまたは"), el("span", "btn pf-choose", label || "ファイルを選択"));
  zone.addEventListener("dragover", e => { e.preventDefault(); zone.classList.add("over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", e => { e.preventDefault(); zone.classList.remove("over"); onFiles([...e.dataTransfer.files]); });
  return zone;
}
function chosenFile(file, onRemove) {
  const row = el("div", "pkg-file");
  if (/^image\//.test(file.type)) {
    const img = el("img", "pkg-thumb");
    img.src = URL.createObjectURL(file);
    img.alt = file.name;
    img.addEventListener("load", () => URL.revokeObjectURL(img.src), { once: true });
    row.append(img);
  } else row.append(el("span", "pkg-drop-icon", /^video\//.test(file.type) ? "🎬" : /^audio\//.test(file.type) ? "🔊" : "📄"));
  row.append(el("span", "pkg-file-name", file.name), el("span", "hint", sizeText(file.size)), button("⊗ 削除", "link pkg-remove", onRemove));
  return row;
}

// ---------- the form ----------

function form() {
  const problem = message => { note = message; render(); };

  // カバー画像: one image only (a new one replaces it).
  const cover = el("div", "pkg-files");
  if (draft.cover) cover.append(chosenFile(draft.cover, () => { draft.cover = null; saveDraft(); render(); }));
  else cover.append(picker({ accept: "image/jpeg,image/png,image/gif", onFiles: ([file]) => {
    if (!file) return;
    if (!COVER_TYPES.test(file.type || file.name) || file.size > PF_LIMITS.coverMB * 1048576) {
      return problem(`${file.name}: JPG・PNG・GIF、${PF_LIMITS.coverMB}MBまでの画像を選択してください`);
    }
    draft.cover = file;
    saveDraft();
    problem("");
  } }));

  // コンテンツ: up to 10 images, videos or audio files.
  const contents = el("div", "pkg-files");
  draft.contents.forEach((file, i) => contents.append(chosenFile(file, () => { draft.contents.splice(i, 1); saveDraft(); render(); })));
  if (draft.contents.length < PF_LIMITS.contents) {
    contents.append(picker({ accept: "image/jpeg,image/png,image/gif,video/mp4,video/quicktime,audio/mpeg,.mov,.mp3", multiple: true, onFiles: files => {
      const bad = files.filter(f => !CONTENT_TYPES.test(f.type || f.name) || f.size > PF_LIMITS.contentMB * 1048576);
      const ok = files.filter(f => !bad.includes(f));
      const room = PF_LIMITS.contents - draft.contents.length;
      draft.contents.push(...ok.slice(0, room));
      saveDraft();
      problem([bad.length && `${bad.map(f => f.name).join("、")}: JPG・PNG・GIF・MP4・MP3・MOV、${PF_LIMITS.contentMB}MBまでのファイルを選択してください`,
        ok.length > room && `コンテンツは${PF_LIMITS.contents}個までです`].filter(Boolean).join(" / "));
    } }));
  }

  // 検索キーワード: 10 boxes, one keyword each (Freelance Account Checker types each into Lancers' field).
  const keywords = el("div", "pkg-keywords");
  for (let i = 0; i < PF_LIMITS.keywords; i++) {
    keywords.append(text(null, PF_LIMITS.keyword, { placeholder: `キーワード${i + 1}`, label: `検索キーワード${i + 1}`, get: () => draft.keywords[i], set: value => { draft.keywords[i] = value; } }));
  }

  // カテゴリー: 大 → 小 (grouped as on Lancers), or a 小カテゴリー typed in.
  const subBox = el("div", "pkg-sub");
  const drawSub = () => {
    const groups = PF_SUBCATEGORIES[draft.category] || {};
    const entries = Object.entries(groups).map(([group, items]) => [group, items.map(name => [`${group}\u0000${name}`, name])]);
    const chosen = draft.sub && draft.subGroup ? `${draft.subGroup}\u0000${draft.sub}` : draft.subCustom != null && draft.sub === OTHER_SUB ? OTHER_SUB : "";
    const sub = select("_sub", [[OTHER_SUB, "リストにない（直接入力）"]], { placeholder: "小カテゴリーを選択", label: "小カテゴリー", groups: entries, onChange: value => {
      if (value === OTHER_SUB) { draft.sub = OTHER_SUB; draft.subGroup = ""; }
      else { const [group, name] = value.split("\u0000"); draft.subGroup = group || ""; draft.sub = name || ""; }
      delete draft._sub;
      saveDraft();
      drawSub();
    } });
    sub.value = chosen;
    sub.disabled = !draft.category;
    subBox.replaceChildren(sub);
    if (draft.sub === OTHER_SUB) {
      const typed = el("input", "pkg-input");
      typed.type = "text";
      typed.placeholder = "小カテゴリー名（Lancers の表示どおり）";
      typed.value = draft.subCustom || "";
      typed.setAttribute("aria-label", "小カテゴリー名");
      typed.addEventListener("input", () => { draft.subCustom = typed.value; saveDraft(); });
      subBox.append(typed);
    }
  };
  const main = select("category", PF_CATEGORIES, { placeholder: "カテゴリーを選択", label: "カテゴリー", onChange: () => {
    draft.sub = ""; draft.subGroup = ""; draft.subCustom = "";
    saveDraft();
    drawSub();
  } });
  drawSub();
  const categories = el("div", "pkg-row");
  const mainBox = el("div", "pkg-sub");
  mainBox.append(main);
  categories.append(mainBox, subBox);

  // 制作期間: number + unit.
  const period = el("div", "pf-inline");
  period.append(numberInput("period", { placeholder: "10", label: "制作期間", min: "1" }),
    select("periodUnit", PF_PERIOD_UNITS.map(u => [u, u]), { label: "制作期間の単位" }));
  const price = el("label", "pkg-price");
  price.append(numberInput("price", { placeholder: "50,000", label: "参考価格" }), el("span", "", "円"));

  // パッケージ: a package's title as it is on Lancers (empty: なし). Package templates' titles are suggested.
  const pkgInput = el("input", "pkg-input");
  pkgInput.type = "text";
  pkgInput.placeholder = "なし";
  pkgInput.value = draft.packageName || "";
  pkgInput.setAttribute("aria-label", "パッケージ");
  pkgInput.setAttribute("list", "pfPackageNames");
  pkgInput.addEventListener("input", () => { draft.packageName = pkgInput.value; saveDraft(); });
  const names = el("datalist");
  names.id = "pfPackageNames";
  for (const n of packageNames) names.append(new Option(n, n));

  const flags = PF_FLAGS.map(([key, label, hint]) => {
    const box = el("div", "pf-flag");
    const row = el("label", "pkg-check");
    const input = el("input");
    input.type = "checkbox";
    input.checked = !!draft.flags[key];
    input.addEventListener("change", () => { draft.flags[key] = input.checked; saveDraft(); });
    row.append(input, ` ${label}`);
    box.append(row, el("div", "hint", hint));
    return box;
  });

  // The four stages (as the package input's five), each with the fields of Lancers' form it holds.
  return [
    [
      field("タイトル", true, "どのような制作物なのか、できるだけ詳しく入力してください。「ました」は削除できません",
        text("title", PF_LIMITS.title, { rows: 2, placeholder: "例: 和菓子屋さんの店外モニターで流す製造工程のプロモーションムービーを制作・編集しました", label: "タイトル" })),
      field("サブタイトル", false, "その制作物のポイントや得られた効果など、アピールポイントをできるだけ詳しく入力してください",
        text("subtitle", PF_LIMITS.subtitle, { rows: 2, placeholder: "例: プロモーションムービーを掲出後、来客数が10%アップしたとご報告いただいております", label: "サブタイトル" })),
      field("カテゴリー", true, null, categories),
      field("業種", true, null, select("industry", INDUSTRIES, { label: "業種" })),
      field("検索キーワード", false, `制作物の特徴を表す適切なキーワードがあれば入力してください。最大${PF_LIMITS.keywords}個まで入力できます`, keywords)
    ],
    [
      field("カバー画像", true, `推奨サイズ：1000 x 782px 対応形式：JPG、PNG、GIF 最大サイズ：${PF_LIMITS.coverMB}MB（1枚のみ）`, cover),
      field("コンテンツ", false, `制作物の画像、動画、音声ファイルを選択してください。最大${PF_LIMITS.contents}個まで選択できます\n対応形式：JPG、PNG、GIF、MP4、MP3、MOV 最大サイズ：${PF_LIMITS.contentMB}MB`, contents),
      el("p", "error-text pkg-file-note", note)
    ],
    [
      field("説明文", true, "どのような制作物なのか、できるだけ詳しく入力してください",
        text("description", PF_LIMITS.description, { rows: 9, label: "説明文",
          placeholder: "例: 富山の和菓子屋さんの店外モニターで流す製造工程のプロモーションムービーのご依頼に提案し、採用いただきました。\nご提供いただいた動画の編集、テロップ、エフェクト、SE、BGMを担当しております。\n1枚目: ショートバージョン\n2枚目: ロングバージョン" })),
      field("制作期間", true, null, period),
      field("参考価格", true, null, price)
    ],
    [
      field("パッケージ", false, "ポートフォリオに掲載するパッケージを選択してください。パッケージの見積もり・カスタマイズの相談に繋がります（Lancers での名前のとおり。空欄: なし）", pkgInput, names),
      ...flags,
      field("公開範囲", true, null, select("visibility", PF_VISIBILITY, { label: "公開範囲" })),
      field("プロフィールでの表示順", true, "数値が大きいほどプロフィールの先頭に表示されます", numberInput("order", { placeholder: "1", label: "プロフィールでの表示順" }))
    ]
  ][step];
}

// The stages, and what each is missing for Lancers (sent anyway, listed as 未入力).
export const PF_STEPS = ["基本情報の入力", "画像・コンテンツの登録", "制作内容の入力", "公開設定"];
const CHECKS = [
  () => [
    !draft.title.trim() && "タイトル",
    chars(draft.title) > PF_LIMITS.title && `タイトル（${PF_LIMITS.title}文字以内）`,
    chars(draft.subtitle) > PF_LIMITS.subtitle && `サブタイトル（${PF_LIMITS.subtitle}文字以内）`,
    (!draft.category || !(draft.sub === OTHER_SUB ? (draft.subCustom || "").trim() : draft.sub)) && "カテゴリー（小カテゴリーまで）",
    !draft.industry && "業種"
  ],
  () => [!draft.cover && "カバー画像"],
  () => [
    !draft.description.trim() && "説明文",
    chars(draft.description) > PF_LIMITS.description && `説明文（${PF_LIMITS.description}文字以内）`,
    (!draft.period || !draft.periodUnit) && "制作期間",
    !draft.price && "参考価格"
  ],
  () => [!draft.visibility && "公開範囲", (draft.order === "" || draft.order == null) && "プロフィールでの表示順"]
];
const checkStep = i => CHECKS[i]().filter(Boolean);
const check = () => PF_STEPS.flatMap((_, i) => checkStep(i));

// ---------- sending ----------

async function submit() {
  if (sending) return;
  draft.reached = PF_STEPS.length - 1;
  const acct = account, p = draft;
  const incompleteSteps = PF_STEPS.map((_, i) => checkStep(i));   // (per stage, for each stage's circle)
  const incomplete = incompleteSteps.flat();
  const show = message => { sending = message; if (account === acct) render(); };
  try {
    const token = await getSlackToken();
    if (!token) throw new Error("Slack に接続されていません（Settings で Slack token を保存してください）");
    const files = [...(p.cover ? [["cover", p.cover]] : []), ...p.contents.map(f => ["content", f])];
    const sent = [];
    for (const [i, [kind, file]] of files.entries()) {
      show(`ファイルを Slack に送信中… ${i + 1} / ${files.length}（${file.name}）`);
      sent.push({ kind, name: file.name, type: file.type, size: file.size, id: await uploadFile(token, file.name, file) });
    }
    show("ポートフォリオを Slack に送信中…");
    const data = { ...lancersPortfolio(p, acct, sent), incomplete, incompleteSteps };
    const { ts, channelId } = await sendRequest(token, {
      channel: PORTFOLIO_CHANNEL, kind: "PORTFOLIO", data, requestText: dataId => requestText(data, dataId),
      onProgress: (n, of) => show(`ポートフォリオを Slack に送信中… ${n} / ${of}`)
    });
    // Sent: kept as a template (with its files) to start the next one from; the draft is removed.
    clearTimeout(saveTimer);
    const template = await saveTemplate(p).catch(() => "");
    await store("drafts", "readwrite", s => s.delete(draftKey(acct))).catch(() => {});
    done = { summary: data, ts, channelId, replies: [], template };
    noticeSent("ポートフォリオ", data.title, acct.label);
    sending = "";
    if (account === acct) render();
    watchReplies(done, token);
  } catch (err) {
    sending = "";
    note = `送信できませんでした: ${err.message}`;
    if (account === acct) render();
  }
}

// What Freelance Account Checker needs to fill in Lancers' form, in its words.
function lancersPortfolio(p, acct, files) {
  const category = PF_CATEGORIES.find(([id]) => id === p.category);
  const industry = INDUSTRIES.find(([id]) => id === p.industry);
  const visibility = PF_VISIBILITY.find(([value]) => value === p.visibility);
  const number = v => (v === "" || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    version: 1, account: acct.label, accountName: acct.name || "",
    title: p.title, subtitle: p.subtitle, description: p.description,
    keywords: [...new Set(p.keywords.map(k => (k || "").trim()).filter(Boolean))],
    category: category ? { id: category[0], name: category[1] } : null,
    subcategory: p.sub === OTHER_SUB ? (p.subCustom || "").trim() ? { group: "", name: p.subCustom.trim() } : null
      : p.sub ? { group: p.subGroup, name: p.sub } : null,
    industry: industry ? { id: industry[0], name: industry[1] } : null,
    period: number(p.period) != null && p.periodUnit ? { value: number(p.period), unit: p.periodUnit } : null,
    price: number(p.price), packageName: (p.packageName || "").trim(),
    flags: { ...p.flags }, visibility: visibility ? { value: visibility[0], name: visibility[1] } : null,
    order: number(p.order), files
  };
}

// The PORTFOLIO REQUEST message: アカウント and データ first (what Freelance Account Checker reads), then
// the whole portfolio in plain text, so #portfolio can be searched.
function requestText(d, dataId) {
  return [
    "PORTFOLIO REQUEST",
    `アカウント: ${d.account}`,
    `データ: ${dataId}`,
    `名前: ${d.accountName || d.account}`,
    `タイトル: ${d.title || "（未入力）"}`,
    d.subtitle && `サブタイトル: ${d.subtitle}`,
    `カテゴリー: ${[d.category?.name, d.subcategory?.name].filter(Boolean).join(" › ") || "（未選択）"}`,
    d.industry && `業種: ${d.industry.name}`,
    d.period && `制作期間: ${d.period.value}${d.period.unit}`,
    d.price != null && `参考価格: ${d.price.toLocaleString()}円`,
    d.keywords.length && `検索キーワード: ${d.keywords.join("、")}`,
    d.packageName && `パッケージ: ${d.packageName}`,
    ...PF_FLAGS.filter(([key]) => d.flags[key]).map(([, label]) => `✔ ${label}`),
    d.visibility && `公開範囲: ${d.visibility.name}`,
    d.order != null && `表示順: ${d.order}`,
    d.description && `説明文:\n${d.description}`,
    `ファイル: ${d.files.length ? d.files.map(f => `${f.kind === "cover" ? "カバー" : "コンテンツ"} ${f.name}`).join("、") : "なし"}`,
    d.incomplete?.length && `未入力: ${d.incomplete.join(" / ")}`
  ].filter(Boolean).join("\n");
}

// Freelance Account Checker's progress and result, from the request's thread (every 5 s, 30 minutes).
async function watchReplies(sent, token) {
  const end = Date.now() + 30 * 60000;
  while (done === sent && Date.now() < end) {
    await new Promise(r => setTimeout(r, 5000));
    if (done !== sent) return;
    try {
      const replies = (await getReplies(token, sent.channelId, sent.ts)).filter(r => !/^PORTFOLIO DATA\b/.test(r.text || ""));
      if (replies.length !== sent.replies.length) {
        sent.replies = replies;
        if (account && !$("pfDialog").hidden) render();
      }
      const result = replies.find(r => /PORTFOLIO (SAVED|FILLED|FAILURE)/.test(r.text || ""));
      if (result) { noticeResult("ポートフォリオ", sent.summary.title, sent.summary.account, result.text); return; }
    } catch { /* tried again in 5 s */ }
  }
}

const unslack = s => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// Freelance Account Checker's report of each stage: "PORTFOLIO STEP 2/4 ✓ 画像・コンテンツの登録" or "… ✗ … — why".
const STAGE_REPLY = /^PORTFOLIO STEP (\d)\/4 (✓|✗)[^—]*(?:— ([\s\S]*))?$/;

// The submission as the four stages: the one being entered blinks green, a stage entered completely
// is green, one left incomplete or with an error is red (with why), the rest grey.
function progressView(state) {
  const reports = new Map();
  for (const reply of done.replies) {
    const m = (reply.text || "").match(STAGE_REPLY);
    if (m) reports.set(Number(m[1]) - 1, { ok: m[2] === "✓", why: m[3] ? unslack(m[3]).trim() : "" });
  }
  const started = done.replies.length > 0;
  const next = Math.max(-1, ...reports.keys()) + 1;
  const current = state === "proposing" && started ? next : -1;
  const list = el("ol", "pkg-steps pkg-progress");
  PF_STEPS.forEach((title, i) => {
    const report = reports.get(i);
    const failedHere = state === "failure" && !report && i === next;
    const item = el("li", i === current ? "current" : report ? (report.ok ? "complete" : "incomplete") : failedHere ? "incomplete" : "", `${i + 1}. ${title}`);
    const why = i === current ? "入力中…" : report && !report.ok ? report.why || "未完了" : "";
    if (why) item.append(el("span", "pkg-step-note", `· ${why}`));
    list.append(item);
  });
  return list;
}

function doneView() {
  const p = done.summary;
  const facts = el("dl", "bid-facts");
  const add = (k, v) => { if (v) facts.append(el("dt", "", k), el("dd", "", v)); };
  add("タイトル", p.title || "（未入力）");
  add("サブタイトル", p.subtitle);
  add("カテゴリー", [p.category?.name, p.subcategory?.name].filter(Boolean).join(" › ") || "（未選択）");
  add("業種", p.industry?.name);
  add("制作期間", p.period && `${p.period.value}${p.period.unit}`);
  add("参考価格", p.price != null && `${p.price.toLocaleString()}円`);
  add("公開範囲", p.visibility?.name);
  add("ファイル", p.files.length ? p.files.map(f => `${f.kind === "cover" ? "カバー" : "コンテンツ"} ${f.name}`).join("、") : "なし");
  add("未入力", p.incomplete?.join(" / "));

  const last = done.replies.at(-1)?.text || "";
  const state = /PORTFOLIO FAILURE/.test(last) ? "failure" : /PORTFOLIO (SAVED|FILLED)/.test(last) ? "success" : "proposing";
  const partly = state === "success" && last.startsWith("⚠️");
  const status = el("div", `bid-status ${state}`);
  status.append(el("div", "bid-status-title", partly ? "⚠️ Lancers に入力できたところまで入力しました"
    : { failure: "❌ Lancers への入力に失敗しました", success: /PORTFOLIO SAVED/.test(last) ? "✅ Lancers にポートフォリオを保存しました" : "✅ Lancers に入力しました",
      proposing: "⏳ Lancers に送信しました" }[state]),
    el("p", "", state === "proposing"
      ? "Slack の #portfolio に PORTFOLIO REQUEST を送りました（#portfolio で検索できます）。このアカウントの Freelance Account Checker が Lancers のポートフォリオ作成ページを開いて入力し、保存します（このウィンドウに結果が表示されます）。"
      : ""));
  status.append(progressView(state));
  for (const reply of done.replies.filter(r => !STAGE_REPLY.test(r.text || ""))) status.append(el("div", "bid-reason", unslack(reply.text)));
  status.append(facts);
  const actions = el("div", "bid-actions");
  if (done.template) actions.append(el("span", "hint", `テンプレート「${done.template}」に保存しました（次回「テンプレート」から読み込めます）`));
  actions.append(button("閉じる", "btn", closePortfolio));
  return [status, actions];
}

// ---------- drawing ----------

function render() {
  if (!account) return;
  const head = el("div", "bid-head");
  const title = el("div", "grow");
  const h = el("h2", "", "🖼 ポートフォリオ");
  h.id = "pfTitle";
  const icon = el("img", "tag-icon");
  icon.src = chrome.runtime.getURL("icons/site-lancers.png");
  icon.alt = "";
  h.prepend(icon);
  title.append(h, el("div", "bid-job", `${account.name || account.label} (${account.label}) · Lancers`));
  head.append(title, button("×", "icon", closePortfolio));
  head.lastChild.setAttribute("aria-label", "Close");

  const body = el("div", "bid-content pkg-content");
  if (done) {
    body.append(...doneView());
    $("pfBody").replaceChildren(head, body);
    return;
  }
  body.append(templateBar(), stepList(), el("h3", "pkg-step-title", PF_STEPS[step]), ...form());
  // (On the last stage: everything still missing, which doesn't stop 送信.)
  const missing = step === PF_STEPS.length - 1 ? check() : [];
  if (missing.length) body.append(el("p", "hint pf-missing", `未入力: ${missing.join("、")}（このままでも送信できます）`));
  const actions = el("div", "bid-actions");
  if (step > 0) actions.append(button("戻る", "btn ghost", () => go(step - 1)));
  // 次へ moves on whether or not this stage is complete (what's missing is marked in the stage list).
  actions.append(step < PF_STEPS.length - 1
    ? button("次へ", "btn", () => go(step + 1))
    : button(sending ? "送信中…" : "送信", "btn pkg-submit", () => submit()));
  if (sending) {
    actions.querySelectorAll("button").forEach(b => { b.disabled = true; });
    actions.prepend(el("span", "hint pkg-sending", sending));
  }
  body.append(actions);
  const scroll = $("pfDialog").querySelector(".bid-window").scrollTop;
  $("pfBody").replaceChildren(head, body);
  $("pfDialog").querySelector(".bid-window").scrollTop = scroll;
}
