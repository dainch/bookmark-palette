(() => {
  // src/search.ts
  function normalizeUrl(raw) {
    try {
      const u = new URL(raw);
      u.hash = "";
      u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
      const params = [...u.searchParams.entries()].sort((a, b) => {
        if (a[0] === b[0]) return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
        return a[0] < b[0] ? -1 : 1;
      });
      u.search = "";
      for (const [key, value] of params) u.searchParams.append(key, value);
      let s = u.toString();
      if (s.endsWith("/") && u.pathname !== "/") s = s.slice(0, -1);
      return s;
    } catch {
      return raw.trim();
    }
  }
  function subsequenceScore(hay, needle) {
    if (!hay || !needle) return 0;
    let pos = 0;
    let gaps = 0;
    let matched = 0;
    for (const ch of needle) {
      const idx = hay.indexOf(ch, pos);
      if (idx < 0) return 0;
      gaps += idx - pos;
      matched += 1;
      pos = idx + 1;
    }
    const coverage = matched / needle.length;
    return Math.max(0, Math.round(120 * coverage - gaps * 1.5));
  }
  var BOUNDARY = /[\s\-_/|（）()\[\]【】:：·.,;!?"'“”‘’+&@#]/;
  function indexScore(hay, token, boundaryScore, midScore) {
    let idx = hay.indexOf(token);
    if (idx < 0) return 0;
    let best = 0;
    while (idx >= 0) {
      const boundary = idx === 0 || BOUNDARY.test(hay.charAt(idx - 1));
      const score = boundary ? boundaryScore - Math.min(idx, 40) : midScore - Math.min(idx, 200);
      if (score > best) best = score;
      if (boundary) break;
      idx = hay.indexOf(token, idx + 1);
    }
    return best;
  }
  function scoreToken(item, token) {
    let best = 0;
    if (item.titleLower === token) best = 1500;
    best = Math.max(best, indexScore(item.titleLower, token, 900, 430));
    best = Math.max(best, indexScore(item.pathLower, token, 800, 380));
    best = Math.max(best, indexScore(item.domain, token, 700, 330));
    best = Math.max(best, indexScore(item.urlLower, token, 400, 220));
    if (!/[\u3400-\u9fff]/.test(token)) {
      best = Math.max(best, indexScore(item.pinyinInitials, token, 1150, 480));
      best = Math.max(best, indexScore(item.pinyinFull, token, 1e3, 460));
    }
    if (best === 0) {
      const sub = Math.max(
        subsequenceScore(item.titleLower, token),
        subsequenceScore(item.pinyinFull, token)
      );
      if (sub > 0) best = sub;
    }
    return best;
  }
  function freqBoost(item) {
    if (!item.visits) return 0;
    return Math.min(120, Math.log2(1 + item.visits) * 22);
  }
  function recencyBoost(item) {
    if (!item.lastVisit) return 0;
    const days = (Date.now() - item.lastVisit) / 864e5;
    if (days <= 1) return 80;
    if (days <= 7) return 50;
    if (days <= 30) return 25;
    return 0;
  }
  function searchBookmarks(index, query, limit = 30) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const tokens = q.split(/\s+/).filter(Boolean);
    const out = [];
    for (const item of index) {
      let total = 0;
      let ok = true;
      for (const token of tokens) {
        const s = scoreToken(item, token);
        if (s <= 0) {
          ok = false;
          break;
        }
        total += s;
      }
      if (!ok) continue;
      total += freqBoost(item) + recencyBoost(item);
      out.push({ ...item, score: total });
    }
    out.sort((a, b) => b.score - a.score || a.title.length - b.title.length || a.title.localeCompare(b.title));
    return out.slice(0, limit);
  }
  function topByUsage(index, limit = 12) {
    return index.filter((i) => i.visits > 0 || i.lastVisit > 0).sort((a, b) => b.visits - a.visits || b.lastVisit - a.lastVisit).slice(0, limit);
  }
  function collapseDuplicates(hits) {
    const seen = /* @__PURE__ */ new Map();
    const out = [];
    for (const hit of hits) {
      const key = normalizeUrl(hit.url);
      const existing = seen.get(key);
      if (existing) {
        existing.dupeCount += 1;
        if (existing.dupePaths.length < 4) existing.dupePaths.push(hit.path);
        continue;
      }
      const item = { ...hit, dupeCount: 1, dupePaths: [hit.path] };
      seen.set(key, item);
      out.push(item);
    }
    return out;
  }

  // src/ui.ts
  var CSS = `
:host { all: initial; }
.bm-wrap {
  position: fixed; inset: 0; z-index: 2147483647;
  display: none; align-items: flex-start; justify-content: center;
  padding-top: 10vh; background: rgba(15, 23, 42, 0.38);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}
.bm-wrap.bm-open { display: flex; }
.bm-panel {
  width: min(720px, 92vw); background: #fff; color: #0f172a;
  border-radius: 14px; overflow: hidden;
  box-shadow: 0 24px 60px rgba(15, 23, 42, 0.35);
  border: 1px solid rgba(15, 23, 42, 0.08);
}
.bm-input {
  width: 100%; box-sizing: border-box; padding: 16px 18px;
  font-size: 17px; line-height: 1.4; border: 0; outline: none;
  color: inherit; background: transparent;
  font-family: inherit;
}
.bm-input::placeholder { color: #94a3b8; }
.bm-status { padding: 0 18px 6px; font-size: 12px; color: #64748b; min-height: 16px; }
.bm-list { max-height: 55vh; overflow-y: auto; padding: 4px 6px 8px; }
.bm-row { display: flex; gap: 10px; align-items: center; padding: 8px 12px; border-radius: 9px; cursor: pointer; }
.bm-row.bm-selected { background: #eef2ff; }
.bm-avatar {
  width: 26px; height: 26px; border-radius: 8px; color: #fff;
  font-size: 13px; font-weight: 600; display: flex; align-items: center;
  justify-content: center; flex: 0 0 auto;
}
.bm-main { min-width: 0; flex: 1 1 auto; }
.bm-title { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bm-sub { font-size: 12px; color: #64748b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
.bm-badge { font-size: 10px; color: #b45309; background: #fef3c7; border-radius: 999px; padding: 1px 6px; margin-left: 8px; flex: 0 0 auto; }
.bm-domain { font-size: 11px; color: #94a3b8; margin-left: auto; padding-left: 8px; flex: 0 0 auto; max-width: 28%; overflow: hidden; text-overflow: ellipsis; }
.bm-foot { display: flex; gap: 14px; padding: 8px 16px; border-top: 1px solid #e2e8f0; font-size: 11px; color: #94a3b8; }
.bm-kbd { border: 1px solid #cbd5e1; border-radius: 4px; padding: 0 4px; font-size: 10px; }
.bm-empty { padding: 30px 18px; text-align: center; color: #64748b; font-size: 13px; }
@media (prefers-color-scheme: dark) {
  .bm-panel { background: #1e293b; color: #e2e8f0; border-color: rgba(255,255,255,0.08); }
  .bm-input { color: #e2e8f0; }
  .bm-input::placeholder { color: #64748b; }
  .bm-status { color: #94a3b8; }
  .bm-row.bm-selected { background: #334155; }
  .bm-title { color: #f1f5f9; }
  .bm-sub { color: #94a3b8; }
  .bm-foot { border-top-color: rgba(255,255,255,0.08); color: #64748b; }
  .bm-kbd { border-color: #475569; }
  .bm-empty { color: #94a3b8; }
}
`;
  function applyCss(target) {
    if (target instanceof ShadowRoot) {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      target.adoptedStyleSheets = [sheet];
    } else {
      const style = document.createElement("style");
      style.textContent = CSS;
      target.appendChild(style);
    }
  }
  function colorFor(seed) {
    const hues = [210, 260, 330, 20, 140, 182, 280];
    let h = 0;
    for (let i = 0; i < seed.length; i += 1) h = h * 31 + seed.charCodeAt(i) >>> 0;
    return "hsl(" + hues[h % hues.length] + " 68% 45%)";
  }
  function mountPalette(container, getItems, openUrl) {
    applyCss(container);
    const wrap = document.createElement("div");
    wrap.className = "bm-wrap";
    const panel = document.createElement("div");
    panel.className = "bm-panel";
    const input = document.createElement("input");
    input.className = "bm-input";
    input.type = "text";
    input.placeholder = "\u641C\u7D22\u4E66\u7B7E\uFF1A\u6807\u9898\u3001\u7F51\u5740\u3001\u8DEF\u5F84\uFF0C\u6216\u62FC\u97F3\u9996\u5B57\u6BCD\uFF08\u5982 gc \u627E \u5DE5\u7A0B\uFF09";
    input.spellcheck = false;
    const status = document.createElement("div");
    status.className = "bm-status";
    const list = document.createElement("div");
    list.className = "bm-list";
    list.setAttribute("role", "listbox");
    const foot = document.createElement("div");
    foot.className = "bm-foot";
    foot.innerHTML = "<span><span class='bm-kbd'>\u2191</span> <span class='bm-kbd'>\u2193</span> \u9009\u62E9</span><span><span class='bm-kbd'>Enter</span> \u5F53\u524D\u6807\u7B7E\u6253\u5F00</span><span><span class='bm-kbd'>Ctrl+Enter</span> \u65B0\u6807\u7B7E</span><span><span class='bm-kbd'>Shift+Enter</span> \u65B0\u7A97\u53E3</span><span><span class='bm-kbd'>Esc</span> \u5173\u95ED</span>";
    panel.appendChild(input);
    panel.appendChild(status);
    panel.appendChild(list);
    panel.appendChild(foot);
    wrap.appendChild(panel);
    (container instanceof ShadowRoot ? container : container).appendChild(wrap);
    let items = null;
    let loading = null;
    let results = [];
    let selected = 0;
    let isOpen = false;
    function load() {
      if (items) return Promise.resolve(items);
      if (loading) return loading;
      status.textContent = "\u6B63\u5728\u52A0\u8F7D\u4E66\u7B7E\u7D22\u5F15\u2026";
      loading = getItems().then((data) => {
        items = data;
        return data;
      }).catch(() => {
        items = [];
        return [];
      }).finally(() => {
        loading = null;
      });
      return loading;
    }
    function compute() {
      const q = input.value.trim();
      const raw = q ? searchBookmarks(items || [], q, 40) : topByUsage(items || [], 12);
      return collapseDuplicates(raw);
    }
    function render() {
      results = compute();
      selected = results.length ? Math.min(selected, results.length - 1) : 0;
      list.textContent = "";
      const q = input.value.trim();
      if (!items) {
        status.textContent = "\u6B63\u5728\u52A0\u8F7D\u4E66\u7B7E\u7D22\u5F15\u2026";
        return;
      }
      status.textContent = q ? results.length + " \u6761\u7ED3\u679C \xB7 \u5171 " + items.length + " \u6761\u4E66\u7B7E" : "\u5E38\u7528\u4E66\u7B7E\uFF08\u6309\u8BBF\u95EE\u9891\u6B21\uFF09\xB7 \u5171 " + items.length + " \u6761\u4E66\u7B7E";
      if (!results.length) {
        const empty = document.createElement("div");
        empty.className = "bm-empty";
        empty.textContent = q ? "\u6CA1\u6709\u627E\u5230\u5339\u914D\u7684\u4E66\u7B7E" : "\u8FD8\u6CA1\u6709\u8BBF\u95EE\u8BB0\u5F55\uFF0C\u76F4\u63A5\u8F93\u5165\u5173\u952E\u8BCD\u641C\u7D22";
        list.appendChild(empty);
        return;
      }
      results.forEach((item, index) => {
        const row = document.createElement("div");
        row.className = "bm-row" + (index === selected ? " bm-selected" : "");
        row.setAttribute("role", "option");
        row.dataset.index = String(index);
        const avatar = document.createElement("div");
        avatar.className = "bm-avatar";
        const seed = (item.title || "").trim() || item.domain || "?";
        avatar.style.background = colorFor(item.domain || seed);
        avatar.textContent = seed.charAt(0).toUpperCase();
        const main = document.createElement("div");
        main.className = "bm-main";
        const title = document.createElement("div");
        title.className = "bm-title";
        title.textContent = item.title || item.url;
        const sub = document.createElement("div");
        sub.className = "bm-sub";
        sub.textContent = item.path || "\u4E66\u7B7E\u680F";
        main.appendChild(title);
        main.appendChild(sub);
        const domain = document.createElement("div");
        domain.className = "bm-domain";
        domain.textContent = item.domain || "";
        row.appendChild(avatar);
        row.appendChild(main);
        if (item.dupeCount > 1) {
          const badge = document.createElement("span");
          badge.className = "bm-badge";
          badge.textContent = "\u91CD\u590D \xD7" + item.dupeCount;
          badge.title = item.dupePaths.join("\n");
          row.appendChild(badge);
        }
        row.appendChild(domain);
        row.addEventListener("mousemove", () => {
          if (selected !== index) {
            selected = index;
            updateSelection();
          }
        });
        row.addEventListener("click", () => openSelected("current"));
        list.appendChild(row);
      });
      updateSelection();
    }
    function updateSelection() {
      const rows = list.querySelectorAll(".bm-row");
      rows.forEach((row, index) => {
        row.classList.toggle("bm-selected", index === selected);
      });
      const current = rows[selected];
      if (current && typeof current.scrollIntoView === "function") {
        current.scrollIntoView({ block: "nearest" });
      }
    }
    function move(delta) {
      if (!results.length) return;
      selected = (selected + delta + results.length) % results.length;
      updateSelection();
    }
    function openSelected(disposition) {
      const item = results[selected];
      if (!item) return;
      openUrl(item.url, disposition);
      close();
    }
    function close() {
      isOpen = false;
      wrap.classList.remove("bm-open");
      input.value = "";
      results = [];
      selected = 0;
    }
    async function open() {
      isOpen = true;
      wrap.classList.add("bm-open");
      input.value = "";
      selected = 0;
      input.focus();
      const data = await load();
      if (!isOpen) return;
      items = data;
      render();
      input.focus();
    }
    input.addEventListener("input", () => {
      selected = 0;
      render();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        move(1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        move(-1);
      } else if (event.key === "Enter") {
        event.preventDefault();
        const disposition = event.ctrlKey || event.metaKey ? "newtab" : event.shiftKey ? "window" : "current";
        openSelected(disposition);
      }
    });
    wrap.addEventListener("mousedown", (event) => {
      if (event.target === wrap) close();
    });
    return { open, close };
  }

  // src/palette.ts
  var handle = mountPalette(
    document.body,
    async () => {
      const res = await chrome.runtime.sendMessage({ type: "getIndex" });
      if (!res || res.error) throw new Error(res && res.error ? res.error : "index error");
      return res.items;
    },
    (url, disposition) => {
      if (disposition === "newtab") {
        void chrome.tabs.create({ url, active: false });
      } else if (disposition === "window") {
        void chrome.windows.create({ url, focused: true });
      } else {
        void chrome.tabs.create({ url });
        window.close();
      }
    }
  );
  void handle.open();
})();
