// The alert in the top-right corner of the screen, for new jobs
// (Windows' own notifications always appear bottom-right and can't be moved). It shows for 5 seconds
// and never takes the keyboard focus. With Job Finder Helper installed (helper.js) it's a Windows
// window above every other window; otherwise a small Chrome window (notify.html). Clicking it brings
// Job Finder forward.
// groups: [{ site, title, items: [{ title, category }] }]
import { helperSend, onHelperMessage } from "./helper.js";

// Options: sticky — stays until it's clicked (the Accounts alerts), in the bottom-right corner so it
// never covers the new-jobs alert, a new sticky alert replacing it; theme: "green" — on a green
// background; heading / badge — the header's name and its pill ("+3 NEW" otherwise).
const ALERT_WIDTH = 400;
const SHOW_MS = 5000;
let alertWindowId = null, stickyWindowId = null;
const clickListeners = new Set();
const stickyGoneListeners = new Set();

// Called when the sticky alert is gone (clicked or closed with ×).
export function onStickyAlertGone(fn) {
  stickyGoneListeners.add(fn);
}
const stickyGone = () => { for (const fn of stickyGoneListeners) fn(); };
chrome.windows.onRemoved.addListener(id => {
  if (id === stickyWindowId) { stickyWindowId = null; stickyGone(); }
});

// Called with { account } when an alert is clicked (from the helper or notify.html).
export function onAlertClick(fn) {
  clickListeners.add(fn);
}

function alertClicked(account) {
  chrome.runtime.sendMessage({ type: "focus-finder", account }).catch(() => {});
  for (const fn of clickListeners) fn({ account });
}

onHelperMessage(message => {
  if (message?.type === "toast-click") alertClicked(message.account || "");
  if ((message?.type === "toast-click" || message?.type === "toast-closed") && message.sticky) stickyGone();
});
chrome.runtime.onMessage.addListener(message => {
  if (message?.type === "focus-finder") for (const fn of clickListeners) fn({ account: message.account || "" });
});

export async function showAlert({ total, groups, account = "", sticky = false, theme = "", heading = "", badge = "" }) {
  if (!groups.length) return;
  if (await helperSend({ type: "toast", total, groups, account, sticky, theme, heading, badge })) return;
  const previous = sticky ? stickyWindowId : alertWindowId;
  if (sticky) stickyWindowId = null; // (replaced: not "gone")
  if (previous != null) chrome.windows.remove(previous).catch(() => {});
  const height = Math.min(52 + groups.reduce((h, g) => h + 44 + Math.min(g.items.length, 4) * 21 + (g.items.length > 4 ? 19 : 0), 0) + 12 + 34, 460); // (+ the popup's title bar)
  try {
    const win = await chrome.windows.create({
      url: `notify.html#${encodeURIComponent(JSON.stringify({ total, groups, account, sticky, theme, heading, badge }))}`,
      type: "popup",
      focused: false,
      width: ALERT_WIDTH,
      height,
      left: Math.round(screen.availLeft + screen.availWidth - ALERT_WIDTH - 8),
      top: Math.round(sticky ? screen.availTop + screen.availHeight - height - 8 : screen.availTop + 8)
    });
    if (sticky) {
      stickyWindowId = win.id;
    } else {
      alertWindowId = win.id;
      setTimeout(() => { if (alertWindowId === win.id) alertWindowId = null; }, SHOW_MS + 500);
    }
  } catch { /* the badges still show what's new */ }
}
