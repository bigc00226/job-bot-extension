// Account check, run by the service worker for the popup ("Check now") and when the extension is
// switched on. Only through the sites' own pages, with nothing shown on screen: each site's my-page is
// loaded in this extension's hidden frame (frame-reader.js), the ID is read from the link to your own
// profile in its header, then the profile page is loaded the same way for the display name and avatar.
// No window or tab is opened, no site API is called and no cookie or key is read.
import { SITES, ACCOUNTS, accountLabel } from "./sites.js";
import { getSlackToken, findChannelId, postMessage, getRecentMessages } from "./slack.js";
import { readInFrame } from "./frame-reader.js";

// (readInFrame reads one page at a time, so sites asked for together are checked in turn.)
export async function checkSite(site) {
  try {
    const page = await readInFrame(site.checkUrl, "account", [site.idPattern.source, site.idPattern.flags]);
    if (page.error) return { state: "error", message: page.error };
    if (page.signedOut || site.loginUrlPattern.test(new URL(page.url).pathname)) return { state: "signed-out" };
    if (!page.id) return { state: "unknown" };
    const profile = await readProfile(site, page.id).catch(() => ({ name: "", avatar: "", profileUrl: site.profileUrl(page.id) }));
    return { state: "signed-in", id: page.id, label: accountLabel(site, page.id), ...profile };
  } catch (err) {
    return { state: "error", message: err.message };
  }
}

export async function checkAllSites() {
  const results = {};
  for (const site of SITES) results[site.id] = await checkSite(site);
  return results;
}

// Display name and avatar from the account's public profile page (its og:title / og:image,
// which every platform fills in for sharing). The site-name parts of the title are trimmed off.
async function readProfile(site, id) {
  const profileUrl = site.profileUrl(id);
  const read = await readInFrame(profileUrl, "profile", [], 30000);
  if (!read || read.error) return { name: "", avatar: "", profileUrl };
  const name = read.title
    .replace(/\s*[|｜].*$/, "")
    .replace(/\s+[-–—]\s+(Workana|CrowdWorks|クラウドワークス|Lancers|ランサーズ|ココナラ|coconala).*$/i, "")
    .replace(/さん?\s*[(（][^)）]*[)）]\s*の?プロフィール.*$/, "")
    .replace(/(さん)?の?プロフィール.*$/, "")
    .replace(/\s*[(（][^)）]*[)）]\s*$/, "")
    .trim();
  const image = read.image;
  // A generic site logo / share image is not an avatar.
  const avatar = image && !/ogp|logo|og-image|og_image|share|default/i.test(image) ? new URL(image, profileUrl).href : "";
  return { name, avatar, profileUrl };
}

// Saves the latest results (shown when the popup opens) and each account's label, name and avatar,
// which the proposal runs use in their Slack reports.
export async function storeAccountResults(results) {
  const { accountLabels = {}, accountInfo = {} } = await chrome.storage.local.get(["accountLabels", "accountInfo"]);
  for (const [siteId, result] of Object.entries(results)) {
    if (result.state !== "signed-in") continue;
    accountLabels[siteId] = result.label;
    accountInfo[siteId] = { label: result.label, name: result.name || "", avatar: result.avatar || "", profileUrl: result.profileUrl || "" };
  }
  await chrome.storage.local.set({ accountResults: { at: new Date().toLocaleString(), results }, accountLabels, accountInfo });
}

// Posts each found account to #accounts: platform (Coconala / Workana / Lancers / CrowdWorks),
// display name and avatar. An account already posted with the same details is not posted again;
// if a name or avatar changes — or its post was deleted from #accounts (e.g. Job Finder's
// "Clear Slack channels") — it is posted once more. With `force` (Job Finder's ACCOUNT REQUEST)
// every signed-in account is posted. Returns { sent, error }.
export async function reportNewAccounts(results, { force = false } = {}) {
  const token = await getSlackToken();
  if (!token) return { sent: [], error: "" };

  const { sentAccountInfo = [] } = await chrome.storage.local.get("sentAccountInfo");
  const found = SITES.map(site => ({ site, result: results[site.id] }))
    .filter(({ result }) => result?.state === "signed-in")
    .map(({ site, result }) => ({ site, result, signature: [site.id, result.id, result.name || "", result.avatar || ""].join("|") }));
  if (!found.length) return { sent: [], error: "" };
  const sent = [];
  try {
    const channelId = await findChannelId(token, ACCOUNTS.slackChannel);
    // What #accounts holds now decides what is "already posted"; only if it can't be read is the
    // local memory of earlier posts used instead.
    let alreadyPosted;
    if (force) alreadyPosted = () => false;
    else try {
      const inChannel = (await getRecentMessages(token, channelId)).map(readAccountPost).filter(Boolean);
      // (A post whose picture Slack refused went out without it, so a missing picture still matches.)
      alreadyPosted = ({ site, result }) => inChannel.some(p => p.label === result.label && p.name === (result.name || "")
        && (!p.avatar || p.avatar === (result.avatar || "")));
    } catch {
      alreadyPosted = ({ signature }) => sentAccountInfo.includes(signature);
    }
    const fresh = found.filter(account => !alreadyPosted(account));
    if (fresh.length) {
      for (const { site, result, signature } of fresh) {
        const text = `${site.name.toUpperCase()}: ${result.name || result.label}`;
        const lines = [`*${site.name.toUpperCase()}*`, `*Display name:* ${result.name || "(not found)"}`, `*Account:* ${result.label}`];
        if (result.profileUrl) lines.push(`<${result.profileUrl}|Profile>`);
        const section = { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } };
        try {
          await postMessage(token, channelId, text, [
            result.avatar ? { ...section, accessory: { type: "image", image_url: result.avatar, alt_text: result.name || result.label } } : section
          ]);
        } catch (err) {
          // Slack refuses image blocks it can't download; post without the picture rather than not at all.
          if (!result.avatar || !/invalid_blocks|downloading image/i.test(err.message)) throw err;
          await postMessage(token, channelId, text, [section]);
        }
        sent.push(signature);
      }
    }
    return { sent, error: "" };
  } catch (err) {
    return { sent, error: err.message };
  } finally {
    // Only what was actually posted is remembered, so a failed post is retried next check.
    if (sent.length) await chrome.storage.local.set({ sentAccountInfo: [...sentAccountInfo, ...sent] });
  }
}

// Reads back an #accounts post made above: { label, name, avatar }, or null for other messages.
function readAccountPost(message) {
  const section = message.blocks?.find(b => b.type === "section" && /\*Account:\*/.test(b.text?.text || ""));
  if (!section) return null;
  const line = label => (section.text.text.match(new RegExp(`\\*${label}:\\*\\s*(.*)`))?.[1].trim() || "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"); // Slack escapes these
  const name = line("Display name");
  return { label: line("Account"), name: name === "(not found)" ? "" : name, avatar: section.accessory?.image_url || "" };
}
