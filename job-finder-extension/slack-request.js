// A request to Freelance Account Checker through Slack (PACKAGE, PORTFOLIO): "<KIND> REQUEST" posted
// to its channel (made if missing), with the request's data in the thread.
// The data goes as base64 text (so Slack leaves it as is), which needs no file scope. Slack splits or
// cuts a message longer than about 4,000 characters, so it's sent in numbered parts ("PACKAGE DATA 2/5")
// of DATA_PART characters, which Freelance Account Checker joins again; data too big for DATA_PARTS_MAX
// parts is uploaded as a file (<kind>.json) instead, and the request names its file ID.
import { findOrCreateChannel, postMessage, uploadFile } from "./slack.js";

const DATA_PART = 3500;
const DATA_PARTS_MAX = 20;
export const REQUEST_MAX = 3900;     // the request message, kept whole for the same reason

// requestText(dataId) → the request's text ("データ: スレッド" or the file ID goes in it).
export async function sendRequest(token, { channel, kind, data, requestText, onProgress = () => {} }) {
  const json = new TextEncoder().encode(JSON.stringify(data));
  let encoded = "";
  for (let i = 0; i < json.length; i += 0x8000) encoded += String.fromCharCode(...json.subarray(i, i + 0x8000));
  encoded = btoa(encoded);
  const parts = [];
  for (let i = 0; i < encoded.length; i += DATA_PART) parts.push(encoded.slice(i, i + DATA_PART));
  const inThread = parts.length <= DATA_PARTS_MAX;
  const dataId = inThread ? "スレッド" : await uploadFile(token, `${kind.toLowerCase()}.json`, new Blob([json], { type: "application/json" }));
  const channelId = await findOrCreateChannel(token, channel);
  const { ts } = await postMessage(token, channelId, fitRequest(requestText(dataId)));
  if (inThread) {
    for (const [i, part] of parts.entries()) {
      onProgress(i + 1, parts.length);
      await postMessage(token, channelId, `${kind} DATA ${i + 1}/${parts.length}\n${part}`, ts);
    }
  }
  return { ts, channelId };
}

const fitRequest = text => (text.length > REQUEST_MAX ? `${text.slice(0, REQUEST_MAX - 1)}…` : text);
