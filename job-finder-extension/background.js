// Clicking the toolbar icon (or an alert window) brings the open Job Finder to the front — the app
// window ("Open as app") when there is one, else its tab — and only opens a new one when none is open.
const FINDER_URL = chrome.runtime.getURL("finder.html");

async function focusOrOpenFinder() {
  // The extension's own open pages (no "tabs" permission needed).
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["TAB"], documentUrls: [FINDER_URL] });
  const open = contexts.filter(c => c.tabId >= 0);
  if (open.length) {
    const windows = await Promise.all(open.map(c => chrome.windows.get(c.windowId).catch(() => null)));
    const index = Math.max(0, windows.findIndex(w => w?.type === "popup")); // the app window first
    const target = open[index], win = windows[index];
    await chrome.tabs.update(target.tabId, { active: true });
    await chrome.windows.update(target.windowId, { focused: true, ...(win?.state === "minimized" ? { state: "normal" } : {}) });
    return;
  }
  await chrome.tabs.create({ url: FINDER_URL });
}

chrome.action.onClicked.addListener(focusOrOpenFinder);

// A Job Finder tab that Chrome unloaded anyway (Memory Saver, chrome://discards) is loaded again
// straight away, so the searches carry on. (A discarded tab gets a new ID; it's known by its URL.)
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.discarded === true && (tab.url || tab.pendingUrl || "").startsWith(FINDER_URL)) chrome.tabs.reload(tabId).catch(() => {});
});
// Clicking an alert window.
chrome.runtime.onMessage.addListener(message => {
  if (message?.type === "focus-finder") focusOrOpenFinder();
});