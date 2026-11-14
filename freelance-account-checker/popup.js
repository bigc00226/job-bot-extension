import { SITES, accountLabel } from "./sites.js";
import { getSlackToken, getSlackUserId, searchSlack, findChannelId, postMessage, deleteMessage } from "./slack.js";
import { parseProposalOrder } from "./order.js";
import { storeAccountResults, reportNewAccounts } from "./account-check.js";

const resultsEl = document.getElementById("results");
const checkBtn = document.getElementById("check");
const footerEl = document.getElementById("footer");

let slack = null;              // { token, userId } once connected
const openPanels = new Set();  // site ids whose Slack panel is expanded

// Accounts are checked once at install and otherwise only when "Check now" is pressed.
// Opening the popup just shows the last saved results.
checkBtn.addEventListener("click", runChecks);
showSavedResults();

// Settings (the Options page: Slack connection and the rest), also reachable by right-clicking the toolbar icon.
document.getElementById("openSettings").addEventListener("click", () => chrome.runtime.openOptionsPage());

async function showSavedResults() {
  const { accountResults } = await chrome.storage.local.get("accountResults");
  resultsEl.replaceChildren(...SITES.map(site => renderRow(site, accountResults?.results[site.id] || { state: "idle" })));
  footerEl.textContent = accountResults ? `Last checked ${accountResults.at}` : "Press Check now to check accounts.";

  // Connect Slack (no account check) so the ✉ panels work on saved results too.
  const token = await getSlackToken();
  if (!token) footerEl.textContent += " · Slack not connected (⚙ Settings)";
  if (!token || !accountResults) return;
  try {
    slack = { token, userId: await getSlackUserId(token) };
    for (const site of SITES) rerender(site, accountResults.results[site.id] || { state: "idle" });
  } catch { /* panels just stay hidden; "Check now" reports the Slack error */ }
}

// Manual proposal: the run happens in the background worker, so it keeps going after the popup closes.
const orderTextEl = document.getElementById("orderText");
const proposeBtn = document.getElementById("proposeBtn");
const proposeNoteEl = document.getElementById("proposeNote");

showLastProposal();
proposeBtn.addEventListener("click", async () => {
  const text = orderTextEl.value.trim();
  const order = parseProposalOrder(text);
  const crowdworks = order.site === "crowdworks";
  const missing = [
    !order.url && "Lancers propose_start / Coconala offers/add / CrowdWorks proposals/new URL",
    !crowdworks && !order.date && "date (完了予定日 / 期日)",
    !order.amount && (crowdworks ? "price (時間単価 or 契約金額)" : "amount (契約金額 / 提案金額)"),
    // (CrowdWorks: 稼働時間 falls back to the default from Options, and 完了予定日 is optional.)
    (order.site === "coconala" || crowdworks) && !order.proposal && "提案文"
  ].filter(Boolean);
  if (missing.length) {
    proposeNoteEl.textContent = `Missing: ${missing.join(", ")}`;
    return;
  }
  proposeBtn.disabled = true;
  const site = SITES.find(s => s.id === order.site);
  proposeNoteEl.textContent = `Submitting ${site.name} job ${order.jobId}… The result will be posted to #${site.slackChannel} and shown here next time.`;
  await chrome.runtime.sendMessage({ type: "propose", text });
});

async function showLastProposal() {
  const { lastProposal: p } = await chrome.storage.local.get("lastProposal");
  if (p) proposeNoteEl.textContent = `Last: ${p.outcome} — job ${p.jobId || "?"} (${p.accountName}) at ${p.at}${p.reason ? `\n${p.reason}` : ""}`;
}

async function runChecks() {
  checkBtn.disabled = true;
  resultsEl.replaceChildren(...SITES.map(site => renderRow(site, { state: "pending" })));
  footerEl.textContent = "Checking…";

  const token = await getSlackToken();
  let slackError = "";
  slack = null;
  if (token) {
    try {
      slack = { token, userId: await getSlackUserId(token) };
    } catch (err) {
      slackError = err.message;
    }
  }

  const results = {};
  await Promise.all(SITES.map(async site => {
    // (The service worker reads the site in its hidden frame; it carries on if this popup closes.)
    const result = results[site.id] = await chrome.runtime.sendMessage({ type: "check-site", siteId: site.id })
      .catch(err => ({ state: "error", message: err.message })) || { state: "error", message: "no answer" };
    if (result.state === "signed-in" && slack) {
      try {
        result.slack = await searchSlack(slack.token, site.slackChannel, result.id);
      } catch (err) {
        slackError = err.message;
      }
    }
    rerender(site, result);
  }));
  await storeAccountResults(results);
  const reported = await reportNewAccounts(results);
  if (reported.error) slackError = `#accounts: ${reported.error}`;

  const slackNote = !token ? "Slack not connected (⚙ Settings)"
    : slackError ? `Slack error: ${slackError}`
    : reported.sent.length ? `Posted to #accounts: ${reported.sent.join(", ")}` : "Slack searched";
  footerEl.textContent = `Last checked ${new Date().toLocaleTimeString()} · ${slackNote}`;
  checkBtn.disabled = false;
}

function rerender(site, result) {
  document.getElementById(`row-${site.id}`).replaceWith(renderRow(site, result));
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderRow(site, result) {
  const li = el("li", result.state);
  li.id = `row-${site.id}`;

  const line = el("div", "line");
  const status = el("span", "status");

  switch (result.state) {
    case "idle": status.textContent = "Not checked"; break;
    case "pending": status.textContent = "Checking…"; break;
    // (Results saved by older versions have only a name, so they fall back to it until the next check.)
    case "signed-in":
      status.textContent = result.label || (result.id ? accountLabel(site, result.id) : result.name);
      if (result.label && result.name) status.textContent += ` — ${result.name}`;
      break;
    case "signed-out": status.textContent = "Not signed in"; break;
    case "unknown": {
      status.append("Signed in (ID not found) — ");
      const link = el("a", "", "open");
      link.href = site.checkUrl;
      link.target = "_blank";
      status.append(link);
      break;
    }
    default: status.textContent = `Error: ${result.message}`;
  }

  line.append(el("span", "dot"), el("span", "site", site.name), status);

  if (result.slack?.count > 0) {
    const badge = el("a", "slack-hit", `Slack ${result.slack.count}`);
    badge.href = result.slack.matches[0]?.permalink || "#";
    badge.target = "_blank";
    badge.title = `${result.slack.count} message(s) in #${site.slackChannel} mention this name — opens the latest`;
    line.append(badge);
  }

  const canUseSlack = slack && (result.state === "signed-in" || result.state === "unknown");
  if (canUseSlack) {
    const toggle = el("button", "icon-btn", openPanels.has(site.id) ? "▲" : "✉");
    toggle.type = "button";
    toggle.title = `Send / delete messages in #${site.slackChannel}`;
    toggle.addEventListener("click", () => {
      openPanels.has(site.id) ? openPanels.delete(site.id) : openPanels.add(site.id);
      rerender(site, result);
    });
    line.append(toggle);
  }

  li.append(line);
  if (canUseSlack && openPanels.has(site.id)) li.append(renderSlackPanel(site, result));
  return li;
}

function renderSlackPanel(site, result) {
  const panel = el("div", "slack-panel");
  const note = el("p", "muted");

  // Compose
  const input = el("textarea");
  input.rows = 2;
  input.placeholder = `Message #${site.slackChannel}`;
  const sendBtn = el("button", "", "Send");
  sendBtn.type = "button";
  sendBtn.addEventListener("click", async () => {
    const text = input.value.trim();
    if (!text) return;
    sendBtn.disabled = true;
    note.textContent = "Sending…";
    try {
      const channelId = result.slack?.matches[0]?.channelId || await findChannelId(slack.token, site.slackChannel);
      const sent = await postMessage(slack.token, channelId, text);
      result.slack ??= { count: 0, matches: [] };
      result.slack.matches.unshift({ ...sent, text, user: slack.userId, username: "you", permalink: "" });
      rerender(site, result);
    } catch (err) {
      note.textContent = `Send failed: ${err.message}`;
      sendBtn.disabled = false;
    }
  });
  const compose = el("div", "compose");
  compose.append(input, sendBtn);
  panel.append(compose, note);

  // Messages (search matches + anything sent from here), with delete for your own
  const list = el("ul", "messages");
  for (const msg of result.slack?.matches || []) {
    const item = el("li");
    const body = el("div", "msg-text", msg.text.length > 160 ? `${msg.text.slice(0, 160)}…` : msg.text);
    const meta = el("div", "msg-meta", msg.user === slack.userId ? "You" : msg.username || msg.user);
    if (msg.permalink) {
      const link = el("a", "", "view");
      link.href = msg.permalink;
      link.target = "_blank";
      meta.append(" · ", link);
    }
    item.append(body, meta);

    if (msg.user === slack.userId) {
      const delBtn = el("button", "danger", "Delete");
      delBtn.type = "button";
      delBtn.addEventListener("click", async () => {
        // Two-step: first click arms, second click deletes.
        if (!delBtn.dataset.armed) {
          delBtn.dataset.armed = "1";
          delBtn.textContent = "Confirm delete";
          return;
        }
        delBtn.disabled = true;
        try {
          await deleteMessage(slack.token, msg.channelId, msg.ts);
          result.slack.matches = result.slack.matches.filter(m => m !== msg);
          if (msg.permalink) result.slack.count = Math.max(0, result.slack.count - 1);
          rerender(site, result);
        } catch (err) {
          note.textContent = `Delete failed: ${err.message}`;
          delBtn.disabled = false;
        }
      });
      item.append(delBtn);
    }
    list.append(item);
  }
  if (!list.children.length) list.append(el("li", "muted", "No matching messages."));
  panel.append(list);
  return panel;
}
