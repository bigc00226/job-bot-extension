// Slack Web API helpers for Job Finder. Uses the same Slack user token (xoxp-…) as Freelance Account
// Checker (its app has every scope needed here — files:write for a package's files — channels:read / groups:read, channels:history /
// groups:history, chat:write). The token is stored only in this browser.

export async function getSlackToken() {
  const { jfSlackToken } = await chrome.storage.local.get("jfSlackToken");
  return jfSlackToken || "";
}

// Slack answers "ratelimited" (HTTP 429) when called too fast — e.g. while clearing a channel —
// so the call waits the time Slack asks for and tries again. A call Slack doesn't answer within
// 30 seconds fails (rather than leaving whatever waits for it waiting forever).
const TIMEOUT_MS = 30000;
async function callSlack(method, token, params = {}, { post = false } = {}) {
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
    // (missing_scope names the scope the Slack app still needs.)
    if (!data.ok) throw new Error(data.error === "missing_scope" && data.needed
      ? `missing_scope — the Slack app needs the "${data.needed}" scope: add it under OAuth & Permissions → User Token Scopes, reinstall the app, and save the new token`
      : data.error || `HTTP ${res.status}`);
    return data;
  }
}

export async function testSlackToken(token) {
  const data = await callSlack("auth.test", token);
  return { name: `${data.user} @ ${data.team}`, userId: data.user_id };
}

const channelIdCache = new Map();

export async function findChannelId(token, channelName) {
  if (channelIdCache.has(channelName)) return channelIdCache.get(channelName);
  let cursor = "";
  do {
    const data = await callSlack("conversations.list", token, { types: "public_channel,private_channel", exclude_archived: true, limit: 1000, cursor });
    const found = data.channels.find(c => c.name === channelName);
    if (found) {
      channelIdCache.set(channelName, found.id);
      return found.id;
    }
    cursor = data.response_metadata?.next_cursor || "";
  } while (cursor);
  throw new Error(`channel #${channelName} not found`);
}

// The channel's ID; the channel is created (public) when it doesn't exist yet (channels:write).
export async function findOrCreateChannel(token, channelName) {
  try {
    return await findChannelId(token, channelName);
  } catch (err) {
    if (!/not found/.test(err.message)) throw err;
    const { channel } = await callSlack("conversations.create", token, { name: channelName }, { post: true });
    channelIdCache.set(channelName, channel.id);
    return channel.id;
  }
}

// Top-level messages, newest first: all of them, or only those after `oldest` (a message ts).
export async function getHistory(token, channelId, { oldest = "", max = 5000 } = {}) {
  const messages = [];
  let cursor = "";
  do {
    const data = await callSlack("conversations.history", token, { channel: channelId, limit: 200, cursor, ...(oldest && { oldest, inclusive: false }) });
    messages.push(...data.messages);
    cursor = data.response_metadata?.next_cursor || "";
  } while (cursor && messages.length < max);
  return messages;
}

// A thread's replies (without its first message).
export async function getReplies(token, channelId, ts) {
  const replies = [];
  let cursor = "";
  do {
    const data = await callSlack("conversations.replies", token, { channel: channelId, ts, limit: 200, cursor });
    replies.push(...data.messages.filter(m => m.ts !== ts));
    cursor = data.response_metadata?.next_cursor || "";
  } while (cursor);
  return replies;
}

// Link previews are off, so the job link doesn't pull the site's description into the channel.
// With `threadTs`, it's posted as a reply in that message's thread.
export async function postMessage(token, channelId, text, threadTs) {
  const data = await callSlack("chat.postMessage", token, { channel: channelId, text, unfurl_links: false, unfurl_media: false, ...(threadTs && { thread_ts: threadTs }) }, { post: true });
  return { ts: data.ts, channelId: data.channel };
}

// Uploads a file (Blob) privately — shared in no channel, so only this Slack user (the same token in
// Freelance Account Checker) can read it — and returns its file ID. Needs the files:write scope.
export async function uploadFile(token, name, blob) {
  const { upload_url: uploadUrl, file_id: fileId } = await callSlack("files.getUploadURLExternal", token, { filename: name, length: blob.size });
  const res = await fetch(uploadUrl, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: blob });
  if (!res.ok) throw new Error(`uploading ${name}: HTTP ${res.status}`);
  await callSlack("files.completeUploadExternal", token, { files: [{ id: fileId, title: name }] }, { post: true });
  return fileId;
}

// Slack only lets you delete your own messages (workspace admins excepted).
export async function deleteMessage(token, channelId, ts) {
  await callSlack("chat.delete", token, { channel: channelId, ts }, { post: true });
}
