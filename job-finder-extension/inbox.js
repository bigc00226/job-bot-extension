// DMs to a job's client through Freelance Account Checker (FAC): Job Finder posts a request to Slack,
// the FAC signed in to that account opens the page in a background tab, sends the message, and
// answers DM Success / DM Failure / DM Unavailable in the request's thread; the status shows here.
//   CrowdWorks → #crowdworks with the job's public URL (https://crowdworks.jp/public/jobs/<id>);
//   Coconala   → #coconala with the client's page (https://coconala.com/users/<id>);
//   Lancers, Workana → #messages with the job's URL.
import { getSlackToken, findChannelId, getReplies, postMessage } from "./slack.js";

const POLL_MS = 4000;
const DM_TIMEOUT_MS = 30 * 60000;       // a DM with no answer by then is marked failed
const SITE_NAMES = { lancers: "Lancers", coconala: "Coconala", crowdworks: "CrowdWorks", workana: "Workana" };
// Jobs whose client can be sent a DM.
export const DM_SITES = Object.keys(SITE_NAMES);
export const DM_CHANNELS = { lancers: "messages", coconala: "coconala", crowdworks: "crowdworks", workana: "messages" };

// Where the DM request points FAC: { url } or { error } when it can't be sent yet.
export function dmTarget(job) {
  if (job.site === "crowdworks") return { url: `https://crowdworks.jp/public/jobs/${job.id}` };
  if (job.site === "coconala") {
    const id = (job.client?.url || "").match(/coconala\.com\/users\/(\d+)/)?.[1];
    return id ? { url: `https://coconala.com/users/${id}` }
      : { error: "The client's page isn't known yet — wait until the job's details have loaded (or 🔄 Re-search)." };
  }
  return { url: job.url };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const slackEscape = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

let dms = [];                 // newest first: { id, channelId, key, site, jobId, title, url, account, accountName, text, at, status, reason, resultAt }
const listeners = new Set();
let toast = () => {};

export async function initInbox({ notify }) {
  toast = notify;
  const stored = await chrome.storage.local.get("jfDms");
  dms = stored.jfDms || [];
  // (Conversations copied by 1.14 / 1.15 are no longer kept.)
  chrome.storage.local.remove(["jfInboxCache", "jfInboxSync"]);
  watchDms();
}

export const onDmChange = listener => listeners.add(listener);
function emit() {
  for (const listener of listeners) listener();
}
const saveDms = () => chrome.storage.local.set({ jfDms: dms.slice(0, 500) });

// ---------- requests to FAC over Slack ----------

async function postRequest(action, label, { channel, url = "", message = "" }) {
  const token = await getSlackToken();
  if (!token) throw new Error("Connect Slack in Settings first.");
  const channelId = await findChannelId(token, channel);
  const lines = ["SERVER", action];
  if (url) lines.push(url);
  lines.push(`アカウント: ${label}`);
  if (message) lines.push("メッセージ:", slackEscape(message));
  const { ts } = await postMessage(token, channelId, lines.join("\n"));
  return { channelId, ts };
}

// FAC's answer: context "*name* (label) · Site · DM · OK|FAILED|UNAVAILABLE".
const SUMMARY = /·\s*DM\s*·\s*(OK|FAILED|UNAVAILABLE)\s*$/;
const contextOf = post => post.blocks?.find(b => b.type === "context")?.elements?.map(e => e.text || "").join(" ") || "";
// Slack's text back to what was written: <url> / <url|label> links, then &lt; &gt; &amp;.
const unslack = s => String(s || "").replace(/<(https?:\/\/[^|>]+)(?:\|[^>]*)?>/g, "$1")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// FAC's answer in the request's thread (null until it's there): { ok, unavailable, reason }.
async function readAnswer(channelId, ts) {
  const token = await getSlackToken();
  const reply = (await getReplies(token, channelId, ts)).find(r => SUMMARY.test(contextOf(r)));
  if (!reply) return null;
  const status = contextOf(reply).match(SUMMARY)[1];
  const section = reply.blocks.find(b => b.type === "section")?.text?.text || "";
  const reason = section.split("\n").slice(1).filter(l => !/^<https?:\/\/[^>]*\|Open on [^>]*>$/.test(l)).join("\n");
  return { ok: status === "OK", unavailable: status === "UNAVAILABLE", reason: unslack(reason) };
}

// ---------- DMs ----------

export const dmsFor = key => dms.filter(d => d.key === key);
export const sentDms = () => dms.filter(d => d.status === "sent");
export function dmState(key) {
  const list = dmsFor(key);
  if (list.some(d => d.status === "sending")) return "sending";
  if (list.some(d => d.status === "sent")) return "sent";
  return list[0]?.status || "";
}

// Posts the DM request; the record shows "sending" until FAC answers.
export async function sendDm({ key, site, jobId = "", title = "", account, accountName = "", url, text }) {
  const request = await postRequest("DM", account, { channel: DM_CHANNELS[site] || "messages", url, message: text });
  dms.unshift({ id: request.ts, channelId: request.channelId, key, site, jobId, title, url, account, accountName,
    text, at: Date.now(), status: "sending", reason: "", resultAt: 0 });
  await saveDms();
  emit();
  watchDms();
}

export async function forgetDm(id) {
  dms = dms.filter(d => d.id !== id);
  await saveDms();
  emit();
}

let watching = false;
async function watchDms() {
  if (watching) return;
  watching = true;
  try {
    while (dms.some(d => d.status === "sending")) {
      let changed = false;
      for (const record of dms.filter(d => d.status === "sending")) {
        const answer = await readAnswer(record.channelId, record.id).catch(() => null);
        if (answer) {
          Object.assign(record, { status: answer.ok ? "sent" : answer.unavailable ? "unavailable" : "failure", reason: answer.reason || "", resultAt: Date.now() });
          toast(`${{ sent: "✅ DM SENT", failure: "❌ DM FAILED", unavailable: "🚫 DM UNAVAILABLE" }[record.status]} — ${record.accountName || record.account}${record.title ? `: ${record.title}` : ""}${record.reason ? `\n${record.reason}` : ""}`,
            record.status === "sent" ? "ok" : "bad");
          changed = true;
        } else if (Date.now() - record.at > DM_TIMEOUT_MS) {
          Object.assign(record, { status: "failure", reason: "No answer from Freelance Account Checker within 30 minutes.", resultAt: Date.now() });
          changed = true;
        }
      }
      if (changed) {
        await saveDms();
        emit();
      }
      await sleep(POLL_MS);
    }
  } finally {
    watching = false;
  }
}
