// Slack set up from Options, with no separate setup program: the Slack app is created from
// setup/slack-app-manifest.json through Slack's pre-filled "create app" link (no App Configuration
// Token needed), the pasted user token's scopes are checked, and the channels named in sites.js are
// created (or unarchived) and joined — what setup/setup-slack.ps1 does, done here.
// Only Options uses this. It saves nothing and never posts or deletes messages; slack.js (which the
// watcher, popup and alerts use) is left as it is.
//
// (A Slack Webhook URL can't take the token's place: a webhook can only post into the one channel it
// was made for, returns no message ts and posts as the app, while this extension reads orders and
// requests from Slack, downloads Job Finder's files and deletes messages.)
import { SITES, ACCOUNTS, MESSAGES, ALERTS, PACKAGES, PORTFOLIOS } from "./sites.js";

// What each scope is for (shown when the token lacks it).
export const SCOPE_USE = {
  "search:read": "finding messages that mention your accounts",
  "chat:write": "posting and deleting messages",
  "channels:read": "finding public channels by name",
  "channels:write": "creating and joining channels (#alert, #package, …)",
  "groups:read": "finding private channels by name",
  "groups:write": "creating private channels",
  "channels:history": "reading new orders and requests in public channels",
  "groups:history": "reading new orders and requests in private channels",
  "users:read": "recognising who sent an order",
  "files:read": "reading a package's images / video / audio / PDF (Freelance Account Checker)",
  "files:write": "uploading a package's images / video / audio / PDF (Job Finder)"
};

// Every channel the two extensions use, in sites.js order (as setup-slack.ps1 reads them):
// lancers, coconala, crowdworks, workana, accounts, messages, alert, package, portfolio.
export const SETUP_CHANNELS = [...new Set([
  ...SITES.map(site => site.slackChannel),
  ACCOUNTS.slackChannel, MESSAGES.slackChannel, ALERTS.slackChannel, PACKAGES.slackChannel, PORTFOLIOS.slackChannel
])];

// The app's name and user token scopes — the same file setup-slack.ps1 uses.
export async function loadAppManifest() {
  const res = await fetch(chrome.runtime.getURL("setup/slack-app-manifest.json"));
  if (!res.ok) throw new Error(`setup/slack-app-manifest.json: HTTP ${res.status}`);
  return res.json();
}

// Slack's "create an app from a manifest" page with this app already filled in: pick the workspace,
// Next, Create.
export const createAppUrl = manifest =>
  `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`;

// Calls Slack like slack.js does (waits and retries when rate-limited, gives up after 30 s), and also
// returns the token's scopes, which Slack names in the x-oauth-scopes header of every answer (null if
// it didn't). A failed call's error has Slack's error code as .code.
const TIMEOUT_MS = 30000;
async function setupCall(method, token, params = {}, { post = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    const url = `https://slack.com/api/${method}`;
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const res = await (post
      ? fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify(params),
          signal
        })
      : fetch(`${url}?${new URLSearchParams(params)}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal })
    ).catch(err => { throw err.name === "TimeoutError" ? new Error(`Slack didn't answer ${method} within ${TIMEOUT_MS / 1000} s`) : err; });
    if (res.status === 429 && attempt < 10) {
      await new Promise(r => setTimeout(r, (Number(res.headers.get("Retry-After")) || 5) * 1000));
      continue;
    }
    const data = await res.json();
    if (!data.ok) {
      const err = new Error(data.error === "missing_scope" && data.needed
        ? `${method}: missing_scope (the Slack app needs the "${data.needed}" scope)`
        : `${method}: ${data.error || `HTTP ${res.status}`}`);
      err.code = data.error;
      throw err;
    }
    const header = res.headers.get("x-oauth-scopes");
    return { data, scopes: header ? header.split(/\s*,\s*/).filter(Boolean) : null };
  }
}

// Who the token belongs to, and its scopes.
export async function getTokenInfo(token) {
  const { data, scopes } = await setupCall("auth.test", token);
  return { user: data.user, team: data.team, userId: data.user_id, scopes };
}

// Lines ({ text, level }) saying whether the token has every scope in `wanted`, and what a missing one
// is needed for.
export function describeScopes(have, wanted) {
  if (!have?.length) return [{ text: "Slack didn't say which scopes this token has — skipping the scope check.", level: "warn" }];
  const missing = wanted.filter(scope => !have.includes(scope));
  if (!missing.length) return [{ text: `Token scopes: all ${wanted.length} present.`, level: "ok" }];
  return [
    { text: `The token is missing ${missing.length} scope${missing.length === 1 ? "" : "s"}:`, level: "warn" },
    ...missing.map(scope => ({ text: `    ${scope} – for ${SCOPE_USE[scope] || "Freelance Account Checker / Job Finder"}`, level: "warn" })),
    { text: "Add them at api.slack.com/apps → the app → OAuth & Permissions → User Token Scopes, press Reinstall to Workspace → Allow, then paste the new token here (step 2) and in Job Finder.", level: "warn" }
  ];
}

// setup-slack.ps1's "Check token & create channels": checks the token and its scopes, then for each
// channel: creates it if it doesn't exist (unarchives it if it was archived), joins it, and invites
// the member IDs given. Safe to run more than once: existing channels are left as they are.
// log(text, level) gets the progress; level is "info", "ok" or "warn".
export async function setupChannels(token, { isPrivate = false, inviteIds = [], wanted = Object.keys(SCOPE_USE), log }) {
  if (!token.startsWith("xoxp-")) throw new Error("That isn't a user token. It must start with 'xoxp-' (User OAuth Token on the app's OAuth & Permissions page).");
  const me = await getTokenInfo(token);
  log(`Connected as ${me.user} @ ${me.team}`, "ok");
  for (const { text, level } of describeScopes(me.scopes, wanted)) log(text, level);

  // The channels this Slack user can see, archived ones included.
  const listChannels = async () => {
    const channels = new Map();
    let cursor = "";
    do {
      const { data } = await setupCall("conversations.list", token, { types: "public_channel,private_channel", exclude_archived: false, limit: 1000, cursor });
      for (const c of data.channels) channels.set(c.name, c);
      cursor = data.response_metadata?.next_cursor || "";
    } while (cursor);
    return channels;
  };
  let existing = await listChannels();

  log(`Channels: ${SETUP_CHANNELS.map(name => `#${name}`).join(", ")}`);
  for (const name of SETUP_CHANNELS) {
    try {
      let channel = existing.get(name);
      let created = false;
      if (!channel) {
        try {
          channel = (await setupCall("conversations.create", token, { name, is_private: isPrivate }, { post: true })).data.channel;
          created = true;
          log(`#${name}  created`, "ok");
        } catch (err) {
          if (err.code === "restricted_action") { log(`#${name}: this workspace doesn't let you create channels — ask an admin to create #${name}.`, "warn"); continue; }
          if (err.code !== "name_taken") throw err;
          // Made a moment ago (the watcher makes #alert, #package and #portfolio when they're missing),
          // or a private channel this user isn't in.
          existing = await listChannels();
          channel = existing.get(name);
          if (!channel) { log(`#${name} exists but you can't see it (a private channel you're not in) — ask a member to invite you.`, "warn"); continue; }
        }
      }
      if (!created) {
        if (channel.is_archived) {
          await setupCall("conversations.unarchive", token, { channel: channel.id }, { post: true });
          log(`#${name}  unarchived`, "ok");
        } else {
          log(`#${name}  already exists`);
        }
        if (!channel.is_member) {
          if (channel.is_private) { log(`#${name} is private and you're not a member — ask a member to invite you.`, "warn"); continue; }
          await setupCall("conversations.join", token, { channel: channel.id }, { post: true });
          log(`#${name}  joined`);
        }
      }
      if (inviteIds.length) {
        try {
          await setupCall("conversations.invite", token, { channel: channel.id, users: inviteIds.join(",") }, { post: true });
          log(`#${name}  invited ${inviteIds.join(", ")}`);
        } catch (err) {
          if (err.code === "already_in_channel") log(`#${name}  invitees already in channel`);
          else log(`#${name} invite: ${err.message}`, "warn");
        }
      }
    } catch (err) {
      log(`#${name}: ${err.message}`, "warn");
    }
  }
}
