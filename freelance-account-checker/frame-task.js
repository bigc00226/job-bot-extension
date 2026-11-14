// This extension's script in the site pages that frame-reader.js loads in its hidden frame. It does
// nothing anywhere else (your own tabs included): it only acts in a frame named "fac-task-…" inside this
// extension's own hidden document. It asks the service worker what to read, reads it from the page as
// shown, and sends the answer back.
(() => {
  if (window === window.top || !window.name.startsWith("fac-task-")) return;
  if (location.ancestorOrigins?.[0] !== `chrome-extension://${chrome.runtime.id}`) return;
  const id = window.name.slice("fac-task-".length);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // (What's shown is decided from the page's styles: an element hidden by display / visibility /
  // opacity, itself or through a parent — also across web components' shadow roots — isn't shown.)
  const parentOf = n => n.parentElement || (n.parentNode instanceof ShadowRoot ? n.parentNode.host : null);
  const visible = el => {
    for (let n = el; n && n.nodeType === 1; n = parentOf(n)) {
      const style = getComputedStyle(n);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0" || n.hidden) return false;
    }
    return true;
  };
  const signedOut = () => [...document.querySelectorAll("input[type='password']")].some(visible);
  // Coconala's header is made of web components (Lit): its buttons live inside shadow roots, which
  // document.querySelectorAll / closest don't enter. These do.
  const closestDeep = (el, selector) => {
    for (let n = el; n; n = parentOf(n)) if (n.matches?.(selector)) return n;
    return null;
  };
  const allElements = () => {
    const out = [];
    const walk = root => {
      for (const el of root.querySelectorAll("*")) {
        out.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    if (document.body) walk(document.body);
    return out;
  };

  // The numbers on the header's buttons: { signedOut, header, icons: [{ kind, count, href }] }
  // (kind message / transaction / notification; count -1 = a red dot without a number). Only the
  // numbers are read — never the messages or transactions themselves. Examples:
  //   Coconala   <a href="/message"><app-icon name="mail"> <div class="headerNotifications_badge-count">1</div>
  //   Lancers    <a href="/todo_list…"><div count="1" class="css-1bwq5l5">1</div> <svg data-icon="clipboard-check">
  //   CrowdWorks <button title="メッセージ"> … <span class="_count_1jc54_15">1</span>
  async function header() {
    if (signedOut()) return { signedOut: true, icons: [] };
    const HEADER = "header, [class*='header' i], [id*='header' i], [class*='navbar' i], [class*='global-nav' i], [class*='globalnav' i]";
    const inHeader = el => !!closestDeep(el, HEADER) && !closestDeep(el, "main, footer, [role='main'], [class*='footer' i]");
    const BADGE_CLASS = /badge|count|num|unread|notice|notif|alert|bubble|pill|dot|mark/i;
    const red = (el, parentToo = true) => (parentToo ? [el, el.parentElement] : [el]).some(n => {
      const m = n && getComputedStyle(n).backgroundColor.match(/\d+(\.\d+)?/g);
      if (!m || (m.length > 3 && Number(m[3]) === 0)) return false;
      const [r, g, b] = m.map(Number);
      return r >= 180 && r - g >= 70 && r - b >= 50;
    });
    const badgeLike = el => red(el) || el.hasAttribute("count") || BADGE_CLASS.test(`${el.getAttribute("class") || ""} ${el.id}`);
    const KINDS = [
      ["message", /message|mail|inbox|direct_?message|talk|envelope|chat|メッセージ|受信/i],
      ["transaction", /todo|to-do|task|transaction|取引|やること|clipboard|check-?list|list-check|order/i],
      ["notification", /notif|bell|news|お知らせ|通知|alert/i]
    ];
    const clickableOf = el => closestDeep(el, "a, button, [role='button']") ||
      [el.parentElement, el.parentElement?.parentElement].map(p => p?.querySelector("a, button, [role='button']")).find(Boolean);
    const signature = el => [el, ...el.querySelectorAll("*")].slice(0, 30)
      .map(n => [n.getAttribute("href"), n.getAttribute("aria-label"), n.getAttribute("title"), n.getAttribute("class"), n.getAttribute("data-icon"), n.getAttribute("name"),
        n.getAttribute("xlink:href"), n.tagName === "use" ? n.getAttribute("href") : "", n.getAttribute("alt"), n.id].filter(Boolean).join(" "))
      .join(" ");

    // Single-page sites draw the header (and its numbers) after loading, one badge at a time: wait
    // until two reads in a row (½ s apart) give the same numbers, so a badge drawn late isn't missed.
    let found = [];
    let last = null;
    for (let tries = 0; tries < 20; tries++) {
      const marks = allElements().filter(el => {
        if (el.children.length > 1 || /^(SCRIPT|STYLE|TEMPLATE|svg|path|IMG|INPUT|SELECT|OPTION)$/i.test(el.tagName) || !inHeader(el) || !visible(el)) return false;
        const text = el.textContent.trim();
        if (/^\d{1,4}\+?$/.test(text)) return badgeLike(el);
        // A red dot: a small red mark without text. (An empty badge holder, like CrowdWorks'
        // <span class="_normanHeaderBadge_…"></span> when there's nothing new, has no colour: not a dot.)
        if (text || el.children.length) return false;
        const width = parseFloat(getComputedStyle(el).width);
        return red(el, false) && (Number.isNaN(width) || (width >= 4 && width <= 14));
      });
      found = [];
      for (const mark of marks) {
        const target = clickableOf(mark);
        if (!target || found.some(f => f.target === target)) continue;
        const text = mark.textContent.trim();
        const kind = KINDS.find(([, pattern]) => pattern.test(signature(closestDeep(target, "li") || target)))?.[0] || "notification";
        found.push({ target, kind, count: text ? parseInt(text, 10) : -1, href: closestDeep(target, "a[href]")?.href || "" });
      }
      const summary = found.map(f => `${f.kind}:${f.count}`).sort().join(",");
      if (found.length && summary === last) break;
      if (!found.length && tries >= 10) break; // no numbers at all after a while: nothing new
      last = summary;
      await sleep(500);
    }
    return {
      signedOut: false,
      header: !!document.querySelector("header, [class*='header' i]") || allElements().some(el => el.tagName.includes("-")),
      icons: found.map(({ kind, count, href }) => ({ kind, count, href }))
    };
  }

  // Your account ID from the header's link to your own profile: { signedOut, id }.
  async function account(patternSource, flags) {
    const pattern = new RegExp(patternSource, flags);
    const idsIn = scope => [...new Set(
      [...scope.querySelectorAll("a[href]")].map(a => a.getAttribute("href").match(pattern)?.[1]).filter(Boolean)
    )];
    const read = () => {
      for (const selector of ["header", "nav", "[class*='header' i]", "[class*='navbar' i]", "[class*='usermenu' i]", "[class*='user-menu' i]"]) {
        for (const scope of document.querySelectorAll(selector)) {
          const ids = idsIn(scope);
          if (ids.length === 1) return ids[0];
        }
      }
      const ids = idsIn(document);
      return ids.length === 1 ? ids[0] : "";
    };
    for (let tries = 0; tries < 8; tries++) {
      if (signedOut()) return { signedOut: true, id: "" };
      const id = read();
      if (id) return { signedOut: false, id };
      await sleep(1000);
    }
    return { signedOut: false, id: "" };
  }

  // The profile page's og:title / og:image (display name and avatar).
  async function profile() {
    const meta = property => document.querySelector(`meta[property="${property}"]`)?.getAttribute("content")?.trim() || "";
    for (let tries = 0; tries < 5 && !meta("og:title"); tries++) await sleep(1000);
    return { title: meta("og:title") || document.title || "", image: meta("og:image") };
  }

  // A message list page (Coconala https://coconala.com/message): every conversation row as shown —
  // { signedOut, rows: [{ from, time, text, unread, url }] }, newest first. `unread` is the number on
  // the row (Coconala's blue "2"), 0 when it has none. The rows are the page's longest run of alike
  // entries (same tag and classes) outside its header / menus; each row's lines are told apart by
  // what they are: the time ("4分前", "10月19日"), the unread number, the sender (first line) and
  // the message (the longest of the rest; short labels like "ビジネス利用" are left out).
  async function messageList() {
    const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|svg|IMG|INPUT|SELECT|TEXTAREA|BUTTON)$/i;
    const BLOCK = /^(block|flex|grid|list-item|table|table-row|table-cell|flow-root)$/;
    const TIME = /^(\d+\s*(秒|分|時間|日|週間|か月|ヶ月|年)前|たった今|昨日|今日|(\d{4}[年/.-])?\d{1,2}[月/.-]\d{1,2}日?(\s*\(.\))?(\s*\d{1,2}:\d{2})?|\d{1,2}:\d{2})$/;
    const outside = el => !closestDeep(el, "header, footer, nav, aside, [role='navigation'], [role='banner'], [role='dialog'], [role='menu'], [class*='modal' i], [class*='sidebar' i], [class*='header' i], [class*='footer' i]");
    // A row's text with its lines, from the page's styles (through web components' shadow roots and slots).
    const lines = (root, leaveOut = new Set()) => {
      let out = "";
      const walk = node => {
        if (node.nodeType === 3) { out += node.nodeValue.replace(/\s+/g, " "); return; }
        if (node.nodeType !== 1 || SKIP.test(node.tagName) || leaveOut.has(node)) return;
        const style = getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden") return;
        const block = BLOCK.test(style.display) || node.tagName === "BR";
        if (block) out += "\n";
        const kids = node.tagName === "SLOT" ? node.assignedNodes({ flatten: true }) : [];
        for (const child of kids.length ? kids : (node.shadowRoot || node).childNodes) walk(child);
        if (block) out += "\n";
      };
      walk(root);
      return out.split("\n").map(l => l.trim()).filter(Boolean);
    };
    const signature = el => `${el.tagName}.${[...el.classList].filter(c => !/active|unread|read|new|is-|--|current|selected/i.test(c)).sort().join(".")}`;
    const findRows = () => {
      let best = null;
      const roots = [document.body, ...allElements(), ...allElements().map(el => el.shadowRoot).filter(Boolean)];
      for (const parent of roots) {
        if (!parent?.children?.length || (parent.nodeType === 1 && (SKIP.test(parent.tagName) || !outside(parent)))) continue;
        const groups = new Map();
        for (const child of parent.children) groups.set(signature(child), [...(groups.get(signature(child)) || []), child]);
        for (const members of groups.values()) {
          if (members.length < 2 && !/^(LI|ARTICLE)$/.test(members[0].tagName)) continue;
          const shown = members.filter(visible);
          const sizes = shown.map(m => m.textContent.replace(/\s+/g, " ").trim().length);
          if (!shown.length || sizes.some(n => n < 4 || n > 2000)) continue;
          // Conversation rows have a picture (the sender's) and a link.
          const withPicture = shown.filter(m => m.querySelector("img, [style*='background-image'], app-avatar, [class*='avatar' i]")).length;
          const score = shown.length * Math.min(sizes.reduce((a, b) => a + b, 0) / shown.length, 200) * (withPicture >= shown.length / 2 ? 2 : 1);
          if (!best || score > best.score) best = { score, members: shown };
        }
      }
      return best?.members || [];
    };
    const deepAll = root => [root, ...root.querySelectorAll("*"), ...[...root.querySelectorAll("*")].flatMap(el => el.shadowRoot ? [...el.shadowRoot.querySelectorAll("*")] : [])];
    const read = () => findRows().slice(0, 40).map(row => {
      const leaves = deepAll(row).filter(el => el.children.length === 0);
      // The time and the unread number are elements of their own; they're taken out first, so they
      // don't run into the name or the message when they share a line with them.
      const timeEl = leaves.find(el => TIME.test(el.textContent.trim()));
      const badge = leaves.find(el => el !== timeEl && /^\d{1,3}\+?$/.test(el.textContent.trim()) && !el.closest?.("time"));
      const unread = badge ? parseInt(badge.textContent, 10) : 0;
      const all = lines(row, new Set([timeEl, badge].filter(Boolean)));
      const time = timeEl?.textContent.trim() || all.find(l => TIME.test(l)) || "";
      let rest = all.filter(l => l !== time);
      const from = (rest.shift() || "").replace(/\s*[|｜].*$/, "");
      rest = rest.filter(l => !/^[|｜]/.test(l));
      const text = rest.sort((a, b) => b.length - a.length)[0] || "";
      const link = row.matches("a[href]") ? row : row.querySelector("a[href]") || closestDeep(row, "a[href]");
      return { from, time, text, unread, url: link && /^https?:/.test(link.href) ? link.href : "" };
    }).filter(r => r.from || r.text);

    // The list is loaded after the page: wait until it's there and stops changing.
    let last = "", rows = [];
    for (let tries = 0; tries < 20; tries++) {
      if (signedOut()) return { signedOut: true, rows: [] };
      await sleep(1000);
      rows = read();
      const now = JSON.stringify(rows);
      if (rows.length && now === last) break;
      last = now;
    }
    return { signedOut: false, rows };
  }

  const TASKS = { account, profile, header, messageList };
  chrome.runtime.sendMessage({ type: "fac-frame-ready", id, url: location.href }).then(async job => {
    if (!job || !TASKS[job.task]) return;
    let result;
    try {
      result = await TASKS[job.task](...job.args);
    } catch (err) {
      result = { error: err.message };
    }
    chrome.runtime.sendMessage({ type: "fac-frame-result", id, url: location.href, result }).catch(() => {});
  }).catch(() => {});
})();
