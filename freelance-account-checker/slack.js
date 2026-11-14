// Slack Web API helpers. Needs a user token (xoxp-…) with these User Token Scopes:
//   search:read                 – find messages (bot tokens cannot call search.messages)
//   chat:write                  – send messages as you, and delete your own messages
//   channels:read, groups:read  – look up public / private channel IDs by name
//   channels:history, groups:history – read new #lancers / #coconala messages for auto-propose
//   users:read                  – resolve who sent a message (to recognise "server")
//   files:read                  – read the files of Job Finder's PACKAGE REQUEST (Job Finder uploads them
//                                 with files:write)

export async function getSlackToken() {
  const { slackToken } = await chrome.storage.local.get("slackToken");
  return slackToken || "";
}

// Slack answers "ratelimited" (HTTP 429) when called too fast — e.g. while posting a long
// conversation in several parts — so the call waits the time Slack asks for and tries again.
// A call that gets no answer in time fails (a request left hanging — after sleep, a dropped Wi-Fi —
// would otherwise stop the watcher for good).
const TIMEOUT_MS = 30000;
const timedOut = method => err => { throw err.name === "TimeoutError" ? new Error(`Slack didn't answer ${method} within ${TIMEOUT_MS / 1000} s`) : err; };
async function callSlack(method, token, params = {}, { post = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    const url = `https://slack.com/api/${method}`;
    const res = post
      ? await fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(TIMEOUT_MS)
        }).catch(timedOut(method))
      : await fetch(`${url}?${new URLSearchParams(params)}`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
          signal: AbortSignal.timeout(TIMEOUT_MS)
        }).catch(timedOut(method));
    if (res.status === 429 && attempt < 10) {
      await new Promise(r => setTimeout(r, (Number(res.headers.get("Retry-After")) || 5) * 1000));
      continue;
    }
    const data = await res.json();
    // (missing_scope names the scope the Slack app still needs.)
    if (!data.ok) throw new Error(data.error === "missing_scope" && data.needed
      ? `missing_scope — the Slack app needs the "${data.needed}" scope (add it under OAuth & Permissions → User Token Scopes, reinstall, save the new token)`
      : data.error || `HTTP ${res.status}`);
    return data;
  }
}

export async function testSlackToken(token) {
  const data = await callSlack("auth.test", token);
  return `${data.user} @ ${data.team}`;
}

export async function getSlackUserId(token) {
  return (await callSlack("auth.test", token)).user_id;
}

// Returns { count, matches } for messages in #channel containing `name`, newest first.
export async function searchSlack(token, channel, name) {
  const query = `"${name.replace(/"/g, "")}" in:#${channel}`;
  const data = await callSlack("search.messages", token, { query, sort: "timestamp", sort_dir: "desc", count: 20 });
  return {
    count: data.messages.total,
    matches: data.messages.matches.map(m => ({
      ts: m.ts,
      channelId: m.channel.id,
      text: m.text,
      user: m.user,
      username: m.username,
      permalink: m.permalink
    }))
  };
}

const channelIdCache = new Map();

export async function findChannelId(token, channelName) {
  if (channelIdCache.has(channelName)) return channelIdCache.get(channelName);
  let cursor = "";
  do {
    const data = await callSlack("conversations.list", token, {
      types: "public_channel,private_channel", exclude_archived: true, limit: 1000, cursor
    });
    const found = data.channels.find(c => c.name === channelName);
    if (found) {
      channelIdCache.set(channelName, found.id);
      return found.id;
    }
    cursor = data.response_metadata?.next_cursor || "";
  } while (cursor);
  throw new Error(`channel #${channelName} not found`);
}

// The channel's ID; the channel is created (public) when it doesn't exist yet.
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

// Link previews are turned off so the job and conversation links don't pull the site's title and
// description into the post. With `threadTs`, it's posted as a reply in that message's thread.
export async function postMessage(token, channelId, text, blocks, threadTs) {
  const params = { channel: channelId, text, unfurl_links: false, unfurl_media: false, ...(blocks && { blocks }), ...(threadTs && { thread_ts: threadTs }) };
  const data = await callSlack("chat.postMessage", token, params, { post: true });
  return { ts: data.ts, channelId: data.channel };
}

// New top-level messages after `oldest`, oldest first.
export async function getChannelHistory(token, channelId, oldest) {
  const data = await callSlack("conversations.history", token, { channel: channelId, oldest, inclusive: false, limit: 100 });
  return data.messages
    .filter(m => !m.subtype || m.subtype === "bot_message")
    .sort((a, b) => Number(a.ts) - Number(b.ts));
}

// The channel's latest top-level messages (up to `max`), newest first.
export async function getRecentMessages(token, channelId, max = 1000) {
  const messages = [];
  let cursor = "";
  do {
    const data = await callSlack("conversations.history", token, { channel: channelId, limit: 200, cursor });
    messages.push(...data.messages);
    cursor = data.response_metadata?.next_cursor || "";
  } while (cursor && messages.length < max);
  return messages;
}

const userNameCache = new Map();

// Every name a message's sender could go by (bot name, webhook username, user's display/real/handle name).
export async function getSenderNames(token, msg) {
  const names = [msg.username, msg.bot_profile?.name, msg.user_profile?.display_name, msg.user_profile?.real_name];
  if (msg.user) {
    if (!userNameCache.has(msg.user)) {
      const { user } = await callSlack("users.info", token, { user: msg.user });
      userNameCache.set(msg.user, [user.name, user.real_name, user.profile?.display_name, user.profile?.real_name]);
    }
    names.push(...userNameCache.get(msg.user));
  }
  return names.filter(Boolean);
}

// A thread's replies (without its first message), oldest first.
export async function getReplies(token, channelId, ts) {
  const data = await callSlack("conversations.replies", token, { channel: channelId, ts, limit: 200 });
  return data.messages.filter(m => m.ts !== ts);
}

// A file's contents (ArrayBuffer), by its ID — e.g. what Job Finder uploaded for a package. Needs the
// files:read scope (and the file must be readable by this token's user: Job Finder uploads them
// privately with the same Slack user's token).
export async function downloadFile(token, fileId) {
  const { file } = await callSlack("files.info", token, { file: fileId });
  const res = await fetch(file.url_private_download || file.url_private, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(120000) })
    .catch(err => { throw err.name === "TimeoutError" ? new Error(`Downloading ${file.name || "a file"} from Slack took over 2 minutes`) : err; });
  if (!res.ok) throw new Error(`downloading ${file.name}: HTTP ${res.status}`);
  // (Slack answers a sign-in page instead of the file when the token can't read it.)
  if (/text\/html/.test(res.headers.get("content-type") || "") && !/\.html?$/i.test(file.name)) throw new Error(`downloading ${file.name}: Slack refused (is the files:read scope added?)`);
  return { name: file.name, type: file.mimetype || "", data: await res.arrayBuffer() };
}

// Slack only allows deleting your own messages (workspace admins excepted).
export async function deleteMessage(token, channelId, ts) {
  await callSlack("chat.delete", token, { channel: channelId, ts }, { post: true });
}
