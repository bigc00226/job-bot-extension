// Job Finder Helper (native/JobFinderHelper.cs, installed with native/install.cmd): a small Windows
// program reached through Chrome's native messaging. It shows the alerts above every window and puts
// the pinned window on every virtual desktop. Without it, helperSend() returns false and callers fall
// back to what Chrome can do on its own.
const HOST = "com.jobfinder.helper";
const RETRY_MS = 60000; // a missing helper is looked for again after this long

let port = null, connecting = null, failedAt = 0, lastError = "", version = "";
const listeners = new Set();

// Resolves to the open connection, or null when the helper isn't installed / doesn't answer.
function connect() {
  if (port) return Promise.resolve(port);
  if (connecting) return connecting;
  if (Date.now() - failedAt < RETRY_MS) return Promise.resolve(null);
  connecting = new Promise(resolve => {
    let candidate;
    const fail = message => {
      lastError = message || "Not installed";
      failedAt = Date.now();
      port = null;
      resolve(null);
    };
    try {
      candidate = chrome.runtime.connectNative(HOST);
    } catch (err) {
      fail(err.message);
      return;
    }
    const timer = setTimeout(() => { candidate.disconnect(); fail("The helper didn't answer"); }, 3000);
    candidate.onMessage.addListener(message => {
      if (message?.type === "pong" && candidate !== port) {
        clearTimeout(timer);
        version = message.version || "";
        lastError = "";
        port = candidate;
        resolve(port);
        return;
      }
      for (const fn of listeners) fn(message);
    });
    candidate.onDisconnect.addListener(() => {
      clearTimeout(timer);
      const reason = chrome.runtime.lastError?.message || "";
      if (port === candidate) { port = null; failedAt = 0; return; } // closed later: reconnect next time
      fail(/not found/i.test(reason) ? "Not installed" : reason);
    });
    candidate.postMessage({ type: "ping" });
  }).finally(() => { connecting = null; });
  return connecting;
}

// Sends a message to the helper; false when it isn't available.
export async function helperSend(message) {
  const p = await connect();
  if (!p) return false;
  try {
    p.postMessage(message);
    return true;
  } catch {
    port = null;
    return false;
  }
}

export function onHelperMessage(fn) {
  listeners.add(fn);
}

// { installed, version, error } — `force` looks again even right after a failed attempt.
export async function helperStatus({ force = false } = {}) {
  if (force) failedAt = 0;
  const p = await connect();
  return { installed: !!p, version, error: p ? "" : lastError };
}
