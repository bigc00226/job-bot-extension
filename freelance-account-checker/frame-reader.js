// Reads a site's page without showing anything on screen: no window or tab is opened. The page is
// loaded in a frame inside this extension's hidden (offscreen) document, frame.html, where it runs as
// usual with this browser's sign-in, and this extension's script in that frame (frame-task.js) reads
// what's asked — the account ID and the profile — and sends it back. No site API is
// called and no cookie or key is read.
// The sites don't allow being shown in another site's frame (X-Frame-Options / CSP frame-ancestors);
// those two headers are dropped only for frames loaded by this extension's hidden document (requests
// that belong to no tab), never for pages in your tabs.
const DOC = "frame.html";
const RULE_ID = 1;
const FRAME_DOMAINS = ["lancers.jp", "coconala.com", "crowdworks.jp", "workana.com"];
const CLOSE_AFTER_MS = 30000;

const pending = new Map(); // id → { task, args, resolve }
let lane = Promise.resolve();
let nextId = 1;
let closeTimer = null;

// The frame's script asks what to do, then sends the answer.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "fac-frame-ready") {
    const job = pending.get(message.id);
    sendResponse(job ? { task: job.task, args: job.args } : null);
  }
  if (message?.type === "fac-frame-result") pending.get(message.id)?.resolve({ ...message.result, url: message.url });
});

// Loads `url` in the hidden frame and runs frame-task.js's `task` there. Resolves with the task's
// answer plus `url` (where the frame ended up, e.g. a login page). One page at a time.
export function readInFrame(url, task, args = [], timeoutMs = 60000) {
  const run = lane.then(() => load(url, task, args, timeoutMs));
  lane = run.catch(() => {});
  return run;
}

async function load(url, task, args, timeoutMs) {
  await prepare();
  const id = `${Date.now().toString(36)}-${nextId++}`;
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the page did not answer (it may not load in the background)")), timeoutMs);
      pending.set(id, { task, args, resolve: value => { clearTimeout(timer); resolve(value); } });
      chrome.runtime.sendMessage({ target: "fac-frame", type: "open", id, url }).catch(err => { clearTimeout(timer); reject(err); });
    });
  } finally {
    pending.delete(id);
    chrome.runtime.sendMessage({ target: "fac-frame", type: "close", id }).catch(() => {});
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => chrome.offscreen.closeDocument().catch(() => {}), CLOSE_AFTER_MS);
  }
}

async function prepare() {
  clearTimeout(closeTimer);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [RULE_ID],
    addRules: [{
      id: RULE_ID,
      priority: 1,
      action: {
        type: "modifyHeaders",
        responseHeaders: [
          { header: "x-frame-options", operation: "remove" },
          { header: "content-security-policy", operation: "remove" }
        ]
      },
      condition: { requestDomains: FRAME_DOMAINS, resourceTypes: ["sub_frame"], tabIds: [chrome.tabs.TAB_ID_NONE] }
    }]
  });
  const open = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (!open.length) {
    await chrome.offscreen.createDocument({
      url: DOC,
      reasons: ["IFRAME_SCRIPTING"],
      justification: "Reads the signed-in accounts' IDs and display names from the sites' pages without opening a window."
    }).catch(err => { if (!/single offscreen/i.test(err.message)) throw err; });
  }
}
