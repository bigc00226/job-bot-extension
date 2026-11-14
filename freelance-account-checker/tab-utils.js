// Helpers shared by the Lancers and Coconala proposal runners.

// Pacing of everything typed, chosen or clicked on the sites (to look less like a bot):
// about 2 seconds between inputs / selections, about 3 seconds after a button is clicked.
export const STEP_MS = 2000;
export const AFTER_CLICK_MS = 3000;
export const pause = ms => new Promise(r => setTimeout(r, ms));

// In the page's own world: links and window.open stay in this (background) tab instead of opening
// new ones, and confirm() / alert() don't block the run (confirm is answered OK; the text of either
// is kept on <html data-fac-dialog> so a failure can report it).
export function keepInTab(tabId) {
  return chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: () => {
    if (window.__facKeepInTab) return;
    window.__facKeepInTab = true;
    window.open = url => { if (url) location.href = new URL(url, location.href).href; return window; };
    const note = message => { document.documentElement.dataset.facDialog = String(message || "").slice(0, 300); };
    window.alert = message => note(message);
    window.confirm = message => { note(message); return true; };
    document.addEventListener("click", e => {
      const link = e.target.closest?.("a[target]");
      if (link && link.target !== "_self") link.target = "_self";
    }, true);
  } }).catch(() => {});
}

// Opens `url` in a tab of its own minimized window, so the work happens off screen (no tab appears in
// the browser window in use). Falls back to a background tab if a window can't be made.
// Returns the tab; closeHiddenTab(tab) closes it (and its window).
export async function openHiddenTab(url) {
  let tab;
  try {
    const win = await chrome.windows.create({ url, state: "minimized", focused: false, type: "normal" });
    tab = win.tabs[0];
  } catch {
    tab = await chrome.tabs.create({ url, active: false });
  }
  // Chrome's Memory Saver must not unload the page mid-run (it would reload blank when looked at).
  await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  return tab;
}

export async function closeHiddenTab(tab) {
  if (!tab) return;
  const win = await chrome.windows.get(tab.windowId, { populate: true }).catch(() => null);
  // Only a window with nothing else in it is closed whole.
  if (win && win.tabs.length <= 1) await chrome.windows.remove(win.id).catch(() => {});
  else await chrome.tabs.remove(tab.id).catch(() => {});
}

// Polls (rather than waiting on events) so the service worker stays alive during the run.
export async function waitForTab(tabId, matches, timeoutMs, { requireComplete = true } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url && (!requireComplete || tab.status === "complete") && matches(tab.url)) return tab.url;
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

// Waits until the page's DOM is ready (injection fails while a navigation is still in flight, so retry).
export async function waitForDocument(tabId, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const state = await inPage(tabId, () => document.readyState).catch(() => null);
    if (state === "interactive" || state === "complete") return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

// A script that never answers (the page reloaded or hung while it ran) fails after `timeoutMs` instead
// of holding up every later task.
export async function inPage(tabId, func, args = [], timeoutMs = 10 * 60000) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`The page didn't answer within ${Math.round(timeoutMs / 60000)} min (it may have reloaded)`)), timeoutMs); });
  try {
    const [injection] = await Promise.race([chrome.scripting.executeScript({ target: { tabId }, func, args }), limit]);
    return injection?.result;
  } finally {
    clearTimeout(timer);
  }
}

// Like inPage, but survives a page load in between: if the page navigates while `func` runs
// (its result comes back empty), it waits for the new page and runs `func` there.
// Only for steps that are safe to repeat (reading / waiting, not clicking). Returns null on timeout.
export async function inPageAcrossLoads(tabId, func, args = [], timeoutMs = 45000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await waitForDocument(tabId, Math.max(1000, end - Date.now()));
    const result = await inPage(tabId, func, args).catch(() => null);
    if (result != null) return result;
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

// Builds the failure result, adding where the tab stopped and any visible error text.
export async function describeFailure(tabId, reason) {
  const current = await chrome.tabs.get(tabId).catch(() => null);
  const errors = await inPage(tabId, readPageErrors).catch(() => "");
  const where = current ? ` [at ${current.url || current.pendingUrl || "?"}, ${current.status}]` : " [tab was closed]";
  return `${reason}${where}${errors ? ` (page says: ${errors})` : ""}`;
}

// Whether a failed proposal failed because the job has no proposal feature (closed, ended, deleted,
// or a kind that takes none): the site sent the tab away from its proposal form, or the page shows
// such a notice and no form. Reported as "Unavailable" instead of "Failure".
export async function proposalUnavailable(tabId, onFormPage) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const url = tab?.url || "";
  if (!/^https:/.test(url) || /login|signin/i.test(url)) return false;
  if (!onFormPage(url)) return true;
  return !!(await inPage(tabId, noProposalForm).catch(() => false));
}

// Reads your account ID from the page header's link to your own profile (same rule as the account check).
export function readAccountIdInPage(tabId, site) {
  return inPage(tabId, readAccountId, [site.idPattern.source, site.idPattern.flags]).catch(() => "");
}

// ---- Functions below run inside the site's page, so they must be self-contained. ----

function readAccountId(patternSource, flags) {
  const pattern = new RegExp(patternSource, flags);
  const idsIn = scope => [...new Set(
    [...scope.querySelectorAll("a[href]")].map(a => a.getAttribute("href").match(pattern)?.[1]).filter(Boolean)
  )];
  for (const selector of ["header", "nav", "[class*='header' i]", "[class*='navbar' i]", "[class*='usermenu' i]", "[class*='user-menu' i]"]) {
    for (const scope of document.querySelectorAll(selector)) {
      const ids = idsIn(scope);
      if (ids.length === 1) return ids[0];
    }
  }
  const ids = idsIn(document);
  return ids.length === 1 ? ids[0] : "";
}

function noProposalForm() {
  const CLOSED = /募集(は|を)?終了|募集期間(は|が)?終了|受付(は|を)?終了|締め切りました|掲載(は|を)?終了|(提案|応募)(は|が|を)?(でき|出来)ません|(提案|応募)(は|の)?受付(は|を)?(終了|停止)|この(仕事|依頼|案件)は(存在しません|見つかりません|削除)|ページが見つかりません|no longer (available|accepting)/i;
  const formShown = [...document.querySelectorAll("textarea, input[type='number'], input[type='text']")]
    .some(el => el.getClientRects().length > 0 && !el.closest("header, nav, footer"));
  return !formShown && CLOSED.test(document.body?.innerText || "");
}

function readPageErrors() {
  // Skip <noscript> content (e.g. Lancers' "JavaScriptが無効" notice) and hidden elements.
  // A success notice (CrowdWorks' cw-alert_success) is not an error.
  return [...document.querySelectorAll("[class*='error' i], [class*='alert' i], [role='alert']")]
    .filter(el => !el.closest("noscript") && el.getClientRects().length > 0 && !/success/i.test(el.className))
    .map(el => el.textContent.replace(/\s+/g, " ").trim())
    // Standing notices (e.g. CrowdWorks' "※契約完了後、源泉徴収に…") are not errors.
    .filter(text => text && !text.includes("JavaScriptが無効") && !text.startsWith("※"))
    .slice(0, 3)
    // A dialog the site opened (see keepInTab).
    .concat(document.documentElement.dataset.facDialog ? [`dialog: ${document.documentElement.dataset.facDialog}`] : [])
    .join(" / ")
    .slice(0, 300);
}
