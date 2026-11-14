// Per-site settings. Accounts are identified only by their ID, taken from the link to your
// own profile on `checkUrl` (`idPattern`'s first group). If a site changes its URLs, adjust
// `checkUrl` or `idPattern` here — nothing else needs to change.
// Accounts are shown and reported as "<name>-<id>", e.g. "Lancers-tanaka123".
export const SITES = [
  {
    id: "lancers",
    name: "Lancers",
    slackChannel: "lancers",
    checkUrl: "https://www.lancers.jp/mypage",
    idPattern: /^(?:https:\/\/www\.lancers\.jp)?\/profile\/([A-Za-z0-9_-]+)/,
    profileUrl: id => `https://www.lancers.jp/profile/${id}`,
    loginUrlPattern: /\/user\/login|\/login|\/signin/i,
    boardPattern: /\/mypage\/message\?[^#]*boardId=\d+/,   // one conversation, e.g. /mypage/message?boardId=9115322
    clientPattern: /\/client\/[A-Za-z0-9_-]+\/?$/           // a job's client profile
  },
  {
    id: "coconala",
    name: "Coconala",
    slackChannel: "coconala",
    checkUrl: "https://coconala.com/mypage/user",
    idPattern: /^(?:https:\/\/coconala\.com)?\/users\/(\d+)/,
    profileUrl: id => `https://coconala.com/users/${id}`,
    loginUrlPattern: /\/login|\/signin/i,
    boardPattern: /\/(?:mypage\/)?(?:direct_message|direct_messages|talkrooms)\/\d+/,
    clientPattern: /\/users\/\d+\/?$/
  },
  {
    id: "crowdworks",
    name: "CrowdWorks",
    slackChannel: "crowdworks",
    checkUrl: "https://crowdworks.jp/dashboard",
    idPattern: /^(?:https:\/\/crowdworks\.jp)?\/public\/employees\/(\d+)/,
    profileUrl: id => `https://crowdworks.jp/public/employees/${id}`,
    loginUrlPattern: /\/login|\/signin/i,
    boardPattern: /\/(?:messages|message_threads|contracts\/\d+\/messages)\/?\d*/,
    clientPattern: /\/public\/employers\/\d+\/?$/
  },
  {
    id: "workana",
    name: "Workana",
    slackChannel: "workana",
    checkUrl: "https://www.workana.com/dashboard",
    idPattern: /^(?:https:\/\/www\.workana\.com)?(?:\/[a-z]{2})?\/freelancer\/([A-Za-z0-9_-]+)/,
    profileUrl: id => `https://www.workana.com/freelancer/${id}`,
    loginUrlPattern: /\/login|\/signin|\/signup/i,
    boardPattern: /\/(?:[a-z]{2}\/)?(?:inbox|messages)\/[A-Za-z0-9_-]+/,
    clientPattern: /\/(?:[a-z]{2}\/)?(?:u|client|clients)\/[A-Za-z0-9_-]+\/?$/
  }
];

// Newly found accounts are announced here (platform, display name, avatar), once each.
// (Slack channel names are lowercase; setup-slack.ps1 creates this channel too.)
export const ACCOUNTS = { slackChannel: "accounts" };

// Job Finder's Lancers / Workana DM requests come here. setup-slack.ps1 creates it too.
export const MESSAGES = { slackChannel: "messages" };

// A new message or transaction on an account (alert-check.js) is announced here, naming the account.
// setup-slack.ps1 creates it too (and the extension creates it if it's missing).
export const ALERTS = { slackChannel: "alert" };

// Job Finder's Lancers packages: PACKAGE REQUEST (with the package's details in its text, so the
// channel can be searched) is posted here; FAC fills Lancers' package form and answers in its thread.
export const PACKAGES = { slackChannel: "package" };

// Job Finder's Lancers portfolio items: PORTFOLIO REQUEST (searchable the same way) is posted here; FAC
// fills Lancers' portfolio form (myportfolio › 新規作成), saves it and answers in its thread.
export const PORTFOLIOS = { slackChannel: "portfolio" };

export const accountLabel = (site, id) => `${site.name}-${id}`;
