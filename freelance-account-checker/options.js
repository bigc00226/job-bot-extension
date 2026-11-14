import { getSlackToken, testSlackToken } from "./slack.js";
import { SCOPE_USE, SETUP_CHANNELS, loadAppManifest, createAppUrl, getTokenInfo, describeScopes, setupChannels } from "./slack-setup.js";

const tokenEl = document.getElementById("token");
const statusEl = document.getElementById("status");

tokenEl.value = await getSlackToken();
statusEl.textContent = tokenEl.value ? "A token is saved." : "Not connected.";

// Slack set up here (slack-setup.js): step 1's link opens Slack's "create app" page with this app
// filled in from setup/slack-app-manifest.json, Save & test also checks the token's scopes, and step 3
// creates / joins the channels.
const tokenCheckEl = document.getElementById("tokenCheck");
const setupLogEl = document.getElementById("setupLog");
let wantedScopes = Object.keys(SCOPE_USE);
loadAppManifest().then(manifest => {
  document.getElementById("createApp").href = createAppUrl(manifest);
  wantedScopes = manifest.oauth_config?.scopes?.user || wantedScopes;
}).catch(() => { document.getElementById("manifestNote").hidden = false; });
document.getElementById("setupChannelList").textContent = SETUP_CHANNELS.map(name => `#${name}`).join(", ");

function addLine(box, text, level = "info") {
  const line = document.createElement("div");
  line.className = level;
  line.textContent = text;
  box.append(line);
}

document.getElementById("save").addEventListener("click", async () => {
  const token = tokenEl.value.trim();
  if (!token) return;
  tokenCheckEl.replaceChildren();
  statusEl.textContent = "Testing…";
  try {
    const who = await testSlackToken(token);
    await chrome.storage.local.set({ slackToken: token });
    statusEl.textContent = `Connected as ${who}.`;
    showTokenCheck(token);
  } catch (err) {
    statusEl.textContent = `Not saved: ${err.message}`;
  }
});

// After Save & test: which scopes the token lacks and what for. The token stays saved either way.
let tokenCheckRun = 0;
async function showTokenCheck(token) {
  const run = ++tokenCheckRun;
  const lines = [];
  try {
    const me = await getTokenInfo(token);
    lines.push({ text: `Slack user ${me.userId}: Job Finder and every other PC must use a token of this same Slack user.` });
    lines.push(...describeScopes(me.scopes, wantedScopes));
  } catch (err) {
    lines.push({ text: `Couldn't check the token's scopes: ${err.message}`, level: "warn" });
  }
  if (!token.startsWith("xoxp-")) lines.push({ text: "This doesn't look like a user token (xoxp-…). Use the User OAuth Token from the app's OAuth & Permissions page.", level: "warn" });
  if (run !== tokenCheckRun) return; // pressed again meanwhile: that check shows instead
  for (const { text, level } of lines) addLine(tokenCheckEl, text, level);
}

// To paste the same token in Job Finder.
const copyTokenEl = document.getElementById("copyToken");
copyTokenEl.addEventListener("click", async () => {
  const value = tokenEl.value.trim();
  if (!value) return;
  copyTokenEl.textContent = await navigator.clipboard.writeText(value).then(() => "Copied", () => "Couldn't copy");
  setTimeout(() => { copyTokenEl.textContent = "Copy token"; }, 2000);
});
document.getElementById("clear").addEventListener("click", () => {
  tokenCheckRun++;
  tokenCheckEl.replaceChildren();
});

// Step 3: the channels, as setup-slack.ps1 makes them. Nothing is saved; the token in the box is used
// (or the saved one).
const setupBtn = document.getElementById("setupChannels");
setupBtn.addEventListener("click", async () => {
  const token = tokenEl.value.trim() || await getSlackToken();
  setupLogEl.hidden = false;
  setupLogEl.replaceChildren();
  if (!token) { addLine(setupLogEl, "Paste the token and press Save & test (step 2) first.", "error"); return; }
  setupBtn.disabled = true;
  try {
    await setupChannels(token, {
      isPrivate: document.getElementById("setupPrivate").checked,
      inviteIds: document.getElementById("setupInvite").value.split(/[,\s]+/).filter(Boolean),
      wanted: wantedScopes,
      log: (text, level) => addLine(setupLogEl, text, level)
    });
    addLine(setupLogEl, "Done. Paste the same token in Job Finder → Settings → Slack (and in this extension's Options on every other PC).", "ok");
    if (token !== await getSlackToken()) addLine(setupLogEl, "This token isn't saved here yet: press Save & test.", "warn");
  } catch (err) {
    addLine(setupLogEl, err.message, "error");
  } finally {
    setupBtn.disabled = false;
  }
});

const autoProposeEl = document.getElementById("autoPropose");
const triggerEl = document.getElementById("triggerSender");
const proposeStatusEl = document.getElementById("proposeStatus");

const saved = await chrome.storage.local.get(["autoPropose", "triggerSender"]);
autoProposeEl.checked = !!saved.autoPropose;
triggerEl.value = saved.triggerSender || "server";
showProposeStatus();

autoProposeEl.addEventListener("change", async () => {
  // Clearing the last-seen timestamp makes the watcher start from "now" when switched on.
  await chrome.storage.local.set({ autoPropose: autoProposeEl.checked, watchLastTs: {} });
  showProposeStatus();
});
triggerEl.addEventListener("change", () => chrome.storage.local.set({ triggerSender: triggerEl.value.trim() || "server" }));

// Job Finder's packages: press Lancers' publish button after filling in, or leave it to you.
const autoPublishEl = document.getElementById("packageAutoPublish");
autoPublishEl.checked = !!(await chrome.storage.local.get("packageAutoPublish")).packageAutoPublish;
autoPublishEl.addEventListener("change", () => chrome.storage.local.set({ packageAutoPublish: autoPublishEl.checked }));

// Job Finder's portfolio items: press 保存 after filling in (on unless turned off), or leave it to you.
const autoSaveEl = document.getElementById("portfolioAutoSave");
autoSaveEl.checked = (await chrome.storage.local.get("portfolioAutoSave")).portfolioAutoSave !== false;
autoSaveEl.addEventListener("change", () => chrome.storage.local.set({ portfolioAutoSave: autoSaveEl.checked }));

// Hours per week used for CrowdWorks hourly jobs when an order doesn't give 稼働時間.
const defaultHoursEl = document.getElementById("defaultHours");
defaultHoursEl.value = (await chrome.storage.local.get("defaultHours")).defaultHours || 10;
defaultHoursEl.addEventListener("change", () => {
  const hours = Math.max(1, Math.round(Number(defaultHoursEl.value) || 10));
  defaultHoursEl.value = hours;
  chrome.storage.local.set({ defaultHours: hours });
});
chrome.storage.onChanged.addListener(showProposeStatus);

// Alerts → #alert every N minutes (alert-check.js).
const alertsOnEl = document.getElementById("alertsOn");
const alertIntervalEl = document.getElementById("alertInterval");
const alertStatusEl = document.getElementById("alertStatus");
const alertSettings = await chrome.storage.local.get(["alertsOff", "alertIntervalMin"]);
alertsOnEl.checked = !alertSettings.alertsOff;
alertIntervalEl.value = alertSettings.alertIntervalMin || 1;
alertsOnEl.addEventListener("change", () => chrome.storage.local.set({ alertsOff: !alertsOnEl.checked }));
alertIntervalEl.addEventListener("change", () => {
  const minutes = Math.max(1, Math.round(Number(alertIntervalEl.value) || 1));
  alertIntervalEl.value = minutes;
  chrome.storage.local.set({ alertIntervalMin: minutes });
});
document.getElementById("checkAlertsNow").addEventListener("click", async () => {
  alertStatusEl.textContent = "Checking…";
  showAlertStatus(await chrome.runtime.sendMessage({ type: "check-alerts" }));
});
showAlertStatus();
chrome.storage.onChanged.addListener(changes => { if (changes.lastAlertCheck) showAlertStatus(); });
async function showAlertStatus(result) {
  const r = result || (await chrome.storage.local.get("lastAlertCheck")).lastAlertCheck;
  if (!r) { alertStatusEl.textContent = "Not checked yet."; return; }
  // (seen: the badge numbers read on each site, e.g. "Coconala: ✉1 ☑43".)
  alertStatusEl.textContent = `${r.at ? `Last check ${r.at}: ` : ""}${r.posted} posted to #alert.` +
    (r.seen?.length ? ` Badges — ${r.seen.join(" · ")}.` : "") +
    (r.errors?.length ? ` Errors: ${r.errors.join(" · ")}` : "");
}

async function showProposeStatus() {
  const { autoPropose, lastProposal, watcherError } = await chrome.storage.local.get(["autoPropose", "lastProposal", "watcherError"]);
  const parts = [autoPropose ? "On — watching #lancers, #coconala and #crowdworks." : "Off."];
  if (lastProposal) {
    parts.push(`Last: ${lastProposal.outcome} for job ${lastProposal.jobId || "?"} (${lastProposal.accountName}) at ${lastProposal.at}${lastProposal.reason ? ` — ${lastProposal.reason}` : ""}.`);
  }
  if (watcherError) parts.push(`Watcher error ${watcherError}`);
  proposeStatusEl.textContent = parts.join(" ");
}

document.getElementById("clear").addEventListener("click", async () => {
  await chrome.storage.local.remove("slackToken");
  tokenEl.value = "";
  statusEl.textContent = "Disconnected.";
});
