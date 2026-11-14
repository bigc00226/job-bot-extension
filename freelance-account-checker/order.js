// Parses an order (a "server" message in Slack, or text pasted into the popup), e.g.
//   https://www.lancers.jp/work/propose_start/5619129?proposeReferer=...   (or https://coconala.com/offers/add/5339131)
//   提案文:
//   ……
//   完了予定日:2026年10月22日
//   契約金額:15000
// CrowdWorks orders (https://crowdworks.jp/proposals/new?job_offer_id=13553719) use
//   時間単価:1500   (or 単価 / 契約金額) and   稼働時間:10   (hours per week, or 稼働時間/週).
// An order may name the account that should submit it (Job Finder's BID does):   アカウント:Lancers-tanaka123
// Returns { site, url, jobId, date: {year, month, day} | null, amount: string | null, hours: string | null,
// account: string | null, proposal: string }, where site is "lancers", "coconala", "crowdworks" or null.

const ORDER_URLS = {
  lancers: /https:\/\/www\.lancers\.jp\/work\/propose_start\/(\d+)[^\s|>]*/,
  coconala: /https:\/\/coconala\.com\/offers\/add\/(\d+)[^\s|>]*/,
  crowdworks: /https:\/\/crowdworks\.jp\/proposals\/new\?(?:[^\s|>]*&(?:amp;)?)?job_offer_id=(\d+)[^\s|>]*/
};
const DATE_LABELS = "完了予定日|期日|有効期限|提案期限|希望納期|納品希望日|納期|お届け予定日";
const AMOUNT_LABELS = "契約金額|予約金額|提案金額|時間単価|単価";
const HOURS_LABELS = "稼働時間(?:\\s*[/／]\\s*週)?";
const PROPOSAL_LABELS = "提案文|提案内容|メッセージ";
const ACCOUNT_LABELS = "アカウント|Account";
const ALL_LABELS = `${DATE_LABELS}|${AMOUNT_LABELS}|${HOURS_LABELS}|${ACCOUNT_LABELS}|${PROPOSAL_LABELS}`;

export function parseProposalOrder(rawText) {
  const [site, urlMatch] = Object.entries(ORDER_URLS)
    .map(([id, pattern]) => [id, rawText.match(pattern)])
    .find(([, match]) => match) || [null, null];
  // (CrowdWorks order URLs carry the job id as job_offer_id=…)
  // Slack wraps links as <url> or <url|label> and escapes &, < and >. Links in the proposal go back to
  // what was typed (the label, when there is one); only the order's own URL is taken out.
  const text = unescapeSlack(rawText.replace(/<((?:https?:\/\/|mailto:|tel:)[^|>]*)(?:\|([^>]*))?>/g,
    (link, url, label) => url === urlMatch?.[0] ? "" : label || url));

  // A label may carry a note in brackets, e.g. 契約金額（税抜）: or 完了予定日（任意）:
  const NOTE = "(?:\\s*[(（][^)）]*[)）])?";
  const accountMatch = text.match(new RegExp(`^\\s*(?:${ACCOUNT_LABELS})\\s*[:：]\\s*(\\S.*)$`, "im"));
  // Job Finder's orders put アカウント first and 提案文 last: then everything after 提案文: is the
  // proposal, whatever it says ("納期：2週間" or "単価：…" lines are part of it, not new fields), and
  // the other fields are read only above it. Other orders keep the old reading (提案文 may come first).
  const proposalAt = text.search(new RegExp(`(?:^|\\n)\\s*(?:${PROPOSAL_LABELS})${NOTE}\\s*[:：]`));
  const proposalLast = !!accountMatch && proposalAt > accountMatch.index;
  const fields = proposalLast ? text.slice(0, proposalAt) : text;
  const dateMatch = fields.match(new RegExp(`(?:${DATE_LABELS})${NOTE}\\s*[:：]\\s*(\\d{4})\\s*[年\\/\\-.]\\s*(\\d{1,2})\\s*[月\\/\\-.]\\s*(\\d{1,2})`));
  const amountMatch = fields.match(new RegExp(`(?:${AMOUNT_LABELS})${NOTE}\\s*[:：]\\s*[¥￥]?\\s*([\\d,，]+)`));
  // "稼働時間:10", "稼働時間/週：20h", "稼働時間 10時間", or "週10時間" anywhere in the message.
  const hoursMatch = fields.normalize("NFKC").match(new RegExp(`(?:${HOURS_LABELS})\\s*[:：]?\\s*(?:週\\s*)?(\\d+)`))
    || fields.normalize("NFKC").match(/週\s*(\d+)\s*時間/);
  const proposalMatch = proposalLast
    ? text.slice(proposalAt).match(new RegExp(`(?:${PROPOSAL_LABELS})${NOTE}\\s*[:：]\\s*([\\s\\S]*)$`))
    : text.match(new RegExp(`(?:${PROPOSAL_LABELS})${NOTE}\\s*[:：]\\s*([\\s\\S]*?)(?=\\n\\s*(?:${ALL_LABELS})${NOTE}\\s*[:：]|$)`));

  return {
    site,
    url: urlMatch ? unescapeSlack(urlMatch[0]) : null,
    jobId: urlMatch ? urlMatch[1] : null,
    date: dateMatch ? { year: +dateMatch[1], month: +dateMatch[2], day: +dateMatch[3] } : null,
    amount: amountMatch ? amountMatch[1].replace(/[,，]/g, "") : null,
    hours: hoursMatch ? hoursMatch[1] : null,
    account: accountMatch ? accountMatch[1].trim() : null,
    proposal: proposalMatch ? proposalMatch[1].trim() : ""
  };
}

function unescapeSlack(text) {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
