(() => {
  // src/suggest.ts
  var titleInput = document.getElementById("title");
  var urlInput = document.getElementById("url");
  var list = document.getElementById("list");
  var status = document.getElementById("status");
  function tokens(text) {
    const out = /* @__PURE__ */ new Set();
    const lower = text.toLowerCase();
    for (const word of lower.match(/[a-z0-9][a-z0-9-]{1,}/g) || []) out.add(word);
    const cjk = (lower.match(/[\u3400-\u9fff]/g) || []).join("");
    for (let i = 0; i + 1 < cjk.length; i += 1) out.add(cjk.slice(i, i + 2));
    return out;
  }
  var folders = [];
  var folderById = /* @__PURE__ */ new Map();
  async function collect() {
    const tree = await chrome.bookmarks.getTree();
    const ROOT_IDS = /* @__PURE__ */ new Set(["1", "2", "3"]);
    const walk = (node, path) => {
      if (node.url) return;
      const next = node.title ? [...path, node.title] : path;
      let info = null;
      if (node.title && !ROOT_IDS.has(node.id)) {
        info = {
          id: node.id,
          path: next.join(" / "),
          tokens: tokens(next.join(" ")),
          bookmarkCount: 0,
          hosts: /* @__PURE__ */ new Set()
        };
        folders.push(info);
        folderById.set(node.id, info);
      }
      for (const child of node.children || []) {
        if (child.url && info) {
          info.bookmarkCount += 1;
          let host = "";
          try {
            host = new URL(child.url).hostname.replace(/^www\./, "");
          } catch {
            host = "";
          }
          if (host) info.hosts.add(host);
          for (const t of tokens((child.title || "") + " " + child.url)) info.tokens.add(t);
        }
        walk(child, next);
      }
    };
    for (const root of tree) walk(root, []);
  }
  function recommend(title, url) {
    const target = tokens(title + " " + url);
    let host = "";
    try {
      host = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      host = "";
    }
    const results = folders.map((folder) => {
      let score = 0;
      for (const t of target) {
        if (folder.tokens.has(t)) score += 4;
      }
      if (host && [...folder.hosts].some((h) => h === host || h.endsWith("." + host))) score += 8;
      score += Math.min(4, folder.bookmarkCount / 40);
      return { folder, score };
    });
    results.sort((a, b) => b.score - a.score);
    return results.filter((r) => r.score > 0).slice(0, 8);
  }
  function render() {
    const title = titleInput.value.trim();
    const url = urlInput.value.trim();
    list.textContent = "";
    if (!url) {
      list.innerHTML = '<div class="empty">\u8BF7\u5148\u586B\u5199\u7F51\u5740</div>';
      return;
    }
    const items = recommend(title, url);
    const chosen = items.length ? items : folders.slice().sort((a, b) => b.bookmarkCount - a.bookmarkCount).slice(0, 8).map((folder) => ({ folder, score: 0 }));
    for (const { folder, score } of chosen) {
      const row = document.createElement("div");
      row.className = "row";
      const path = document.createElement("div");
      path.className = "path";
      path.textContent = folder.path;
      const count = document.createElement("span");
      count.className = "count";
      count.textContent = folder.bookmarkCount + " \u6761";
      const scoreEl = document.createElement("span");
      scoreEl.className = "score";
      scoreEl.textContent = score > 0 ? "\u5339\u914D " + Math.round(score) : "\u6309\u89C4\u6A21";
      row.appendChild(path);
      row.appendChild(count);
      row.appendChild(scoreEl);
      row.addEventListener("click", () => void save(folder));
      list.appendChild(row);
    }
  }
  async function save(folder) {
    const title = titleInput.value.trim() || urlInput.value;
    const url = urlInput.value.trim();
    if (!url) return;
    try {
      await chrome.bookmarks.create({ parentId: folder.id, title, url });
      status.textContent = "\u5DF2\u4FDD\u5B58\u5230\uFF1A" + folder.path;
      setTimeout(() => window.close(), 900);
    } catch (err) {
      status.textContent = "\u4FDD\u5B58\u5931\u8D25\uFF1A" + String(err);
    }
  }
  async function saveToRoot() {
    const title = titleInput.value.trim() || urlInput.value;
    const url = urlInput.value.trim();
    if (!url) return;
    try {
      await chrome.bookmarks.create({ title, url });
      status.textContent = "\u5DF2\u4FDD\u5B58\u5230\u4E66\u7B7E\u680F";
      setTimeout(() => window.close(), 900);
    } catch (err) {
      status.textContent = "\u4FDD\u5B58\u5931\u8D25\uFF1A" + String(err);
    }
  }
  (async () => {
    const params = new URLSearchParams(location.search);
    titleInput.value = params.get("title") || "";
    urlInput.value = params.get("url") || "";
    await collect();
    render();
    titleInput.addEventListener("input", render);
    urlInput.addEventListener("input", render);
    document.getElementById("save-root")?.addEventListener("click", () => void saveToRoot());
    if (!urlInput.value) urlInput.focus();
  })();
})();
