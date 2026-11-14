// Alert shown as a small Chrome window in the top-right corner of the screen (new jobs)
// when Job Finder Helper isn't installed; colour-coded by platform. It closes itself
// after 5 seconds (the bar shows the time left; pointing at it pauses). Clicking it opens Job Finder.
// The finder passes { total, groups: [{ site, title, items: [{ title, category }] }], account } in the URL hash.
const SHOW_MS = 5000;
const MAX_ITEMS = 4;

// Also { sticky, theme, heading, badge }: a sticky alert (the Accounts alerts) has no time limit and
// closes only when it's clicked; theme "green" puts it on green.
let data = { total: 0, groups: [], account: "" };
try { data = JSON.parse(decodeURIComponent(location.hash.slice(1))); } catch { /* show nothing */ }
if (data.theme === "green") document.body.classList.add("green");
if (data.sticky) document.body.classList.add("sticky");
if (data.heading) document.getElementById("heading").textContent = data.heading;

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

document.getElementById("count").textContent = data.badge || (data.total ? `+${data.total} NEW` : "NEW");
for (const group of data.groups) {
  const box = el("div", "group");
  box.style.setProperty("--site", `var(--${group.site})`);
  const icon = el("img");
  icon.src = `icons/site-${group.site}.png`;
  icon.alt = "";
  const body = el("div", "body");
  const list = el("ul");
  for (const item of group.items.slice(0, MAX_ITEMS)) {
    const li = el("li");
    li.append(el("span", "", item.title));
    if (item.category) li.append(el("small", "", item.category));
    list.append(li);
  }
  body.append(el("div", "head", group.title), list);
  if (group.items.length > MAX_ITEMS) body.append(el("div", "more", `+${group.items.length - MAX_ITEMS} more`));
  box.append(icon, body);
  document.getElementById("groups").append(box);
}

document.getElementById("close").addEventListener("click", e => { e.stopPropagation(); window.close(); });
document.body.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "focus-finder", account: data.account || "" });
  window.close();
});
// Closes when the bar runs out (it pauses while the pointer is on the alert) — not a sticky one.
if (!data.sticky) {
  document.getElementById("bar").addEventListener("animationend", () => {
    document.body.classList.add("leaving");
    setTimeout(() => window.close(), 300);
  });
  setTimeout(() => { if (!document.body.matches(":hover")) window.close(); }, SHOW_MS + 15000); // safety net
}
