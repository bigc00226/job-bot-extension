// The confirmation pop-up for a package or portfolio item (package.js, portfolio.js), in the style of
// the new-jobs alert (alert.js): once when it's been sent to Slack, and again with Freelance Account
// Checker's result — green when it went through.
import { showAlert } from "./alert.js";

const show = (account, title, line, badge, green) => showAlert({
  total: 0, account, heading: "Job Finder — Lancers", badge, theme: green ? "green" : "",
  groups: [{ site: "lancers", title, items: [{ title: line, category: account }] }]
});

// kind: "パッケージ" or "ポートフォリオ".
export function noticeSent(kind, title, account) {
  show(account, `${kind}を送信しました`, title || "（タイトル未入力）", "送信済み", true);
}

// reply: the result's text in the request's thread (… SUCCESS / SAVED / FILLED / FAILURE …).
export function noticeResult(kind, title, account, reply) {
  const failed = /FAILURE/.test(reply), partly = !failed && reply.startsWith("⚠️");
  const done = /PACKAGE SUCCESS/.test(reply) ? "Lancers に出品しました" : /PORTFOLIO SAVED/.test(reply) ? "Lancers に保存しました" : "Lancers に入力しました";
  show(account, failed ? `${kind}: Lancers への入力に失敗しました` : partly ? `${kind}: 入力できたところまで入力しました` : `${kind}: ${done}`,
    title || "（タイトル未入力）", failed ? "失敗" : partly ? "要確認" : "完了", !failed && !partly);
}
