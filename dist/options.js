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

  // src/actions.ts
  async function exportBackup(items2, prefix = "bookmarks-before-clean") {
    const payload = {
      exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
      count: items2.length,
      items: items2
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const stamp = (/* @__PURE__ */ new Date()).toISOString().slice(0, 19).replace(/[:T]/g, "-");
    a.download = prefix + "-" + stamp + ".json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5e3);
  }
  async function deleteBookmarks(ids) {
    const undoItems = [];
    for (const id of ids) {
      try {
        const nodes = await chrome.bookmarks.get(id);
        const node = nodes && nodes[0];
        if (!node) continue;
        undoItems.push({
          parentId: node.parentId,
          index: typeof node.index === "number" ? node.index : 0,
          title: node.title || "",
          url: node.url || "",
          dateAdded: node.dateAdded
        });
        await chrome.bookmarks.remove(id);
      } catch {
      }
    }
    const record = { time: Date.now(), items: undoItems };
    if (undoItems.length) {
      await chrome.storage.local.set({ lastUndo: record });
    }
    return record;
  }
  async function loadUndo() {
    try {
      const data = await chrome.storage.local.get("lastUndo");
      const rec = data && data.lastUndo;
      if (rec && Array.isArray(rec.items) && rec.items.length) return rec;
    } catch {
    }
    return null;
  }
  async function clearUndo() {
    try {
      await chrome.storage.local.remove("lastUndo");
    } catch {
    }
  }
  async function undoLast() {
    const rec = await loadUndo();
    if (!rec) return 0;
    const items2 = [...rec.items].sort((a, b) => a.index - b.index);
    let restored = 0;
    for (const item of items2) {
      try {
        await chrome.bookmarks.create({
          parentId: item.parentId,
          index: item.index,
          title: item.title,
          url: item.url
        });
        restored += 1;
      } catch {
        try {
          await chrome.bookmarks.create({ title: item.title, url: item.url });
          restored += 1;
        } catch {
        }
      }
    }
    await clearUndo();
    return restored;
  }

  // src/options.ts
  var items = [];
  var folders = [];
  var dupGroups = [];
  var deadResults = [];
  var activeTab = "dup";
  var selected = /* @__PURE__ */ new Set();
  var undoRecord = null;
  var scanning = false;
  var scanController = null;
  var content = document.getElementById("content");
  var summary = document.getElementById("summary");
  var status = document.getElementById("status");
  var progress = document.getElementById("progress");
  var progressBar = document.getElementById("progress-bar");
  var deleteBtn = document.getElementById("delete");
  var undoBtn = document.getElementById("undo");
  var scanBtn = document.getElementById("scan");
  var scanCancelBtn = document.getElementById("scan-cancel");
  function setStatus(text) {
    status.textContent = text;
  }
  async function collect() {
    const tree = await chrome.bookmarks.getTree();
    items = [];
    folders = [];
    deadResults = [];
    const counts = /* @__PURE__ */ new Map();
    const ROOT_IDS = /* @__PURE__ */ new Set(["1", "2", "3"]);
    const walk = (node, path) => {
      if (node.url) {
        items.push({
          id: node.id,
          title: node.title || "",
          url: node.url,
          path: path.join(" / ") || "\u4E66\u7B7E\u680F",
          folder: path,
          dateAdded: node.dateAdded || 0
        });
        return 1;
      }
      const next = node.title ? [...path, node.title] : path;
      let total = 0;
      let direct = 0;
      for (const child of node.children || []) {
        const n = walk(child, next);
        total += n;
        if (child.url) direct += 1;
      }
      if (node.title && !ROOT_IDS.has(node.id)) {
        const name = next.join(" / ");
        const entry = counts.get(name) || { direct: 0, subtree: 0 };
        entry.direct += direct;
        entry.subtree += total;
        counts.set(name, entry);
      }
      return total;
    };
    for (const root of tree) walk(root, []);
    folders = [...counts.entries()].map(([path, c]) => ({ path, direct: c.direct, subtree: c.subtree })).sort((a, b) => b.subtree - a.subtree);
    const groups = /* @__PURE__ */ new Map();
    for (const item of items) {
      const key = normalizeUrl(item.url);
      const list = groups.get(key) || [];
      list.push(item);
      groups.set(key, list);
    }
    dupGroups = [...groups.entries()].filter(([, list]) => list.length > 1).map(([key, list]) => ({ key, members: list })).sort((a, b) => b.members.length - a.members.length);
    undoRecord = await loadUndo();
    resetSelection();
    renderAll();
  }
  function selectableRows() {
    if (activeTab === "dup") {
      const rows = [];
      for (const group of dupGroups) {
        group.members.forEach((m, i) => rows.push({ id: m.id, defaultOn: i > 0 }));
      }
      return rows;
    }
    if (activeTab === "untitled") {
      return items.filter((i) => !i.title.trim()).map((i) => ({ id: i.id, defaultOn: false }));
    }
    if (activeTab === "http") {
      return items.filter((i) => i.url.startsWith("http://")).map((i) => ({ id: i.id, defaultOn: false }));
    }
    if (activeTab === "dead") {
      return deadResults.filter((r) => r.verdict !== "ok").map((r) => ({ id: r.id, defaultOn: r.verdict === "dead" }));
    }
    return [];
  }
  function resetSelection() {
    selected = /* @__PURE__ */ new Set();
    for (const row of selectableRows()) if (row.defaultOn) selected.add(row.id);
    updateToolbar();
  }
  function updateToolbar() {
    deleteBtn.disabled = selected.size === 0;
    deleteBtn.textContent = selected.size ? "\u5220\u9664\u9009\u4E2D\uFF08" + selected.size + "\uFF09" : "\u5220\u9664\u9009\u4E2D";
    if (undoRecord && undoRecord.items.length) {
      undoBtn.hidden = false;
      undoBtn.textContent = "\u64A4\u9500\u4E0A\u6B21\uFF08" + undoRecord.items.length + "\uFF09";
    } else {
      undoBtn.hidden = true;
    }
    scanBtn.hidden = activeTab !== "dead";
    scanCancelBtn.hidden = !(activeTab === "dead" && scanning);
  }
  function renderSummary() {
    const untitled = items.filter((i) => !i.title.trim()).length;
    const http = items.filter((i) => i.url.startsWith("http://")).length;
    const extra = dupGroups.reduce((sum, g) => sum + g.members.length - 1, 0);
    const dead = deadResults.filter((r) => r.verdict === "dead").length;
    const unknown = deadResults.filter((r) => r.verdict === "unknown").length;
    summary.innerHTML = "<span>\u4E66\u7B7E <b>" + items.length + "</b></span><span>\u6587\u4EF6\u5939 <b>" + folders.length + "</b></span><span>\u91CD\u590D\u7EC4 <b>" + dupGroups.length + "</b>\uFF08\u591A\u4F59 " + extra + " \u6761\uFF09</span><span>\u65E0\u6807\u9898 <b>" + untitled + "</b></span><span>HTTP <b>" + http + "</b></span>" + (deadResults.length ? "<span>\u7591\u4F3C\u5931\u6548 <b>" + dead + "</b>\uFF0C\u5F85\u786E\u8BA4 " + unknown + "</span>" : "");
  }
  function cell(text, className) {
    const td = document.createElement("td");
    td.textContent = text;
    if (className) td.className = className;
    return td;
  }
  function checkCell(id, disabled = false) {
    const td = document.createElement("td");
    td.className = "check";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = selected.has(id);
    input.disabled = disabled;
    input.addEventListener("change", () => {
      if (input.checked) selected.add(id);
      else selected.delete(id);
      updateToolbar();
    });
    td.appendChild(input);
    return td;
  }
  function renderTable() {
    content.textContent = "";
    if (!items.length) {
      content.innerHTML = '<div class="empty">\u6B63\u5728\u8BFB\u53D6\u4E66\u7B7E\u2026</div>';
      return;
    }
    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const trh = document.createElement("tr");
    const addTh = (text, className) => {
      const th = document.createElement("th");
      th.textContent = text;
      if (className) th.className = className;
      trh.appendChild(th);
    };
    const withCheck = activeTab !== "folders";
    if (withCheck) addTh("", "check");
    if (activeTab === "dup") ["\u7EC4", "\u6761\u6570", "\u6807\u9898", "\u8DEF\u5F84", "\u89C4\u8303\u5316 URL"].forEach((h) => addTh(h));
    else if (activeTab === "untitled") ["\u57DF\u540D", "\u8DEF\u5F84", "URL"].forEach((h) => addTh(h));
    else if (activeTab === "http") ["\u57DF\u540D", "\u6807\u9898", "URL"].forEach((h) => addTh(h));
    else if (activeTab === "dead") ["\u72B6\u6001", "\u6807\u9898", "\u8DEF\u5F84", "URL"].forEach((h) => addTh(h));
    else ["\u6587\u4EF6\u5939", "\u76F4\u63A5\u4E66\u7B7E", "\u5B50\u6811\u4E66\u7B7E"].forEach((h) => addTh(h));
    thead.appendChild(trh);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    if (activeTab === "dup") {
      dupGroups.forEach((group, index) => {
        group.members.forEach((member, mi) => {
          const tr = document.createElement("tr");
          tr.appendChild(checkCell(member.id));
          if (mi === 0) {
            const tdGroup = cell(String(index + 1));
            tdGroup.rowSpan = group.members.length;
            tr.appendChild(tdGroup);
            const tdCount = cell(String(group.members.length));
            tdCount.rowSpan = group.members.length;
            tr.appendChild(tdCount);
          }
          tr.appendChild(cell(member.title || "\uFF08\u65E0\u6807\u9898\uFF09", "truncate"));
          tr.appendChild(cell(member.path, "truncate"));
          tr.appendChild(cell(member.url, "mono truncate"));
          tbody.appendChild(tr);
        });
      });
    } else if (activeTab === "untitled") {
      items.filter((i) => !i.title.trim()).forEach((item) => {
        const tr = document.createElement("tr");
        tr.appendChild(checkCell(item.id));
        tr.appendChild(cell(item.url.replace(/^https?:\/\//, "").split("/")[0], "truncate"));
        tr.appendChild(cell(item.path, "truncate"));
        tr.appendChild(cell(item.url, "mono truncate"));
        tbody.appendChild(tr);
      });
    } else if (activeTab === "http") {
      items.filter((i) => i.url.startsWith("http://")).forEach((item) => {
        const tr = document.createElement("tr");
        tr.appendChild(checkCell(item.id));
        tr.appendChild(cell(item.url.replace(/^http:\/\//, "").split("/")[0], "truncate"));
        tr.appendChild(cell(item.title || "\uFF08\u65E0\u6807\u9898\uFF09", "truncate"));
        tr.appendChild(cell(item.url, "mono truncate"));
        tbody.appendChild(tr);
      });
    } else if (activeTab === "dead") {
      if (!deadResults.length) {
        content.innerHTML = '<div class="empty">\u8FD8\u6CA1\u6709\u626B\u63CF\u7ED3\u679C\u3002\u70B9\u4E0A\u65B9\u300C\u626B\u63CF\u5931\u6548\u94FE\u63A5\u300D\u5F00\u59CB\uFF08\u4F1A\u5411\u4E66\u7B7E\u7F51\u5740\u53D1\u8BF7\u6C42\uFF0C\u53EF\u968F\u65F6\u505C\u6B62\uFF09\u3002\u6CE8\u610F\uFF1AVPN/\u4EE3\u7406\u4F1A\u5F71\u54CD\u5224\u5B9A\uFF0C\u53EA\u6709 404/410 \u4F1A\u9ED8\u8BA4\u52FE\u9009\uFF0C\u8D85\u65F6\u548C 403/429/5xx \u4E00\u5F8B\u6807\u300C\u5F85\u786E\u8BA4\u300D\u3002</div>';
        return;
      }
      const rows = [...deadResults].sort((a, b) => {
        const rank = (v) => v === "dead" ? 0 : v === "unknown" ? 1 : 2;
        return rank(a.verdict) - rank(b.verdict);
      });
      rows.forEach((res) => {
        const tr = document.createElement("tr");
        tr.appendChild(checkCell(res.id, res.verdict === "ok"));
        const tdStatus = document.createElement("td");
        const tag = document.createElement("span");
        tag.className = "tag " + (res.verdict === "dead" ? "dead" : res.verdict === "unknown" ? "unknown" : "ok");
        tag.textContent = res.verdict === "dead" ? "\u5931\u6548" : res.verdict === "unknown" ? "\u5F85\u786E\u8BA4" : "\u6B63\u5E38";
        tdStatus.appendChild(tag);
        if (res.status) tdStatus.appendChild(document.createTextNode(String(res.status)));
        else if (res.error) tdStatus.appendChild(document.createTextNode(res.error));
        tr.appendChild(tdStatus);
        tr.appendChild(cell(res.title || "\uFF08\u65E0\u6807\u9898\uFF09", "truncate"));
        tr.appendChild(cell(res.path, "truncate"));
        tr.appendChild(cell(res.url, "mono truncate"));
        tbody.appendChild(tr);
      });
    } else {
      folders.forEach((folder) => {
        const tr = document.createElement("tr");
        tr.appendChild(cell(folder.path, "truncate"));
        tr.appendChild(cell(String(folder.direct)));
        tr.appendChild(cell(String(folder.subtree)));
        tbody.appendChild(tr);
      });
    }
    table.appendChild(tbody);
    content.appendChild(table);
    if (withCheck && !tbody.children.length) {
      content.innerHTML = '<div class="empty">\u6CA1\u6709\u53D1\u73B0\u9700\u8981\u5904\u7406\u7684\u9879\u76EE</div>';
    }
  }
  function renderAll() {
    renderSummary();
    renderTable();
    updateToolbar();
  }
  async function doDelete() {
    const ids = [...selected];
    if (!ids.length) return;
    const chosen = items.filter((i) => selected.has(i.id));
    const ok = window.confirm("\u786E\u8BA4\u5220\u9664\u9009\u4E2D\u7684 " + ids.length + " \u6761\u4E66\u7B7E\uFF1F\n\n\u4F1A\u5148\u81EA\u52A8\u5BFC\u51FA\u5907\u4EFD JSON\uFF0C\u5220\u9664\u540E\u53EF\u7528\u300C\u64A4\u9500\u4E0A\u6B21\u300D\u6062\u590D\u3002");
    if (!ok) return;
    setStatus("\u6B63\u5728\u5907\u4EFD\u5E76\u5220\u9664\u2026");
    try {
      await exportBackup(chosen.map((i) => ({ title: i.title, url: i.url, path: i.path })));
      const record = await deleteBookmarks(ids);
      undoRecord = record;
      setStatus("\u5DF2\u5220\u9664 " + record.items.length + " \u6761\uFF0C\u53EF\u4ECE\u300C\u64A4\u9500\u4E0A\u6B21\u300D\u6062\u590D");
      await collect();
    } catch (err) {
      setStatus("\u5220\u9664\u5931\u8D25\uFF1A" + String(err));
    }
  }
  async function doUndo() {
    if (!undoRecord) return;
    const ok = window.confirm("\u6062\u590D\u4E0A\u6B21\u5220\u9664\u7684 " + undoRecord.items.length + " \u6761\u4E66\u7B7E\uFF1F");
    if (!ok) return;
    setStatus("\u6B63\u5728\u6062\u590D\u2026");
    try {
      const n = await undoLast();
      undoRecord = null;
      setStatus("\u5DF2\u6062\u590D " + n + " \u6761");
      await collect();
    } catch (err) {
      setStatus("\u6062\u590D\u5931\u8D25\uFF1A" + String(err));
    }
  }
  function isPrivateHost(url) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (host === "localhost" || host === "::1" || host.endsWith(".local")) return true;
      if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
      if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
      return false;
    } catch {
      return true;
    }
  }
  async function requestOnce(url, method, timeoutMs, signal) {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method, redirect: "follow", signal: ctrl.signal, cache: "no-store" });
      return { status: res.status };
    } catch {
      return { status: null, error: "\u8BF7\u6C42\u5931\u8D25\u6216\u8D85\u65F6" };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }
  async function checkUrl(url, signal) {
    if (!/^https?:/i.test(url)) return { status: null, verdict: "unknown", error: "\u975E http" };
    if (isPrivateHost(url)) return { status: null, verdict: "unknown", error: "\u672C\u5730\u5730\u5740\uFF0C\u8DF3\u8FC7" };
    if (signal.aborted) return { status: null, verdict: "unknown", error: "\u5DF2\u505C\u6B62" };
    let result = await requestOnce(url, "HEAD", 1e4, signal);
    if (result.status === 405 || result.status === 501 || result.status === null) {
      result = await requestOnce(url, "GET", 1e4, signal);
    }
    if (result.status === null) {
      await new Promise((resolve) => setTimeout(resolve, 900));
      result = await requestOnce(url, "GET", 12e3, signal);
    }
    if (result.status === null) {
      return { status: null, verdict: "unknown", error: "\u8BF7\u6C42\u5931\u8D25\u6216\u8D85\u65F6\uFF08\u5F85\u786E\u8BA4\uFF09" };
    }
    const status2 = result.status;
    if (status2 === 404 || status2 === 410) {
      return { status: status2, verdict: "dead", error: "HTTP " + status2 };
    }
    if (status2 >= 200 && status2 < 400) {
      return { status: status2, verdict: "ok" };
    }
    return { status: status2, verdict: "unknown", error: "HTTP " + status2 + "\uFF08\u5F85\u786E\u8BA4\uFF09" };
  }
  function updateProgress(done, total) {
    progress.hidden = false;
    progressBar.style.width = total ? Math.round(done / total * 100) + "%" : "0%";
    setStatus("\u626B\u63CF\u4E2D " + done + " / " + total);
  }
  async function scanDead() {
    if (scanning) return;
    const targets = items.filter((i) => /^https?:/i.test(i.url));
    if (!targets.length) {
      setStatus("\u6CA1\u6709\u53EF\u626B\u63CF\u7684 http(s) \u4E66\u7B7E");
      return;
    }
    scanning = true;
    scanController = new AbortController();
    updateToolbar();
    const results = new Array(targets.length);
    let cursor = 0;
    let done = 0;
    updateProgress(0, targets.length);
    const worker = async () => {
      while (!scanController.signal.aborted) {
        const index = cursor++;
        if (index >= targets.length) return;
        const item = targets[index];
        const r = await checkUrl(item.url, scanController.signal);
        results[index] = { ...item, ...r };
        done += 1;
        if (done % 5 === 0 || done === targets.length) updateProgress(done, targets.length);
      }
    };
    const workers = Array.from({ length: 8 }, () => worker());
    await Promise.all(workers);
    deadResults = results.filter(Boolean);
    scanning = false;
    scanController = null;
    progress.hidden = true;
    resetSelection();
    renderAll();
    const dead = deadResults.filter((r) => r.verdict === "dead").length;
    setStatus("\u626B\u63CF\u5B8C\u6210\uFF1A\u7591\u4F3C\u5931\u6548 " + dead + " \u6761\uFF0C\u5F85\u786E\u8BA4 " + deadResults.filter((r) => r.verdict === "unknown").length + " \u6761");
  }
  function csvEscape(value) {
    if (/[",\n]/.test(value)) return '"' + value.replace(/"/g, '""') + '"';
    return value;
  }
  function exportCsv() {
    let rows = [];
    if (activeTab === "dup") {
      rows = [["group", "count", "normalized_url", "title", "path", "url"]];
      dupGroups.forEach((group, index) => group.members.forEach((m) => rows.push([String(index + 1), String(group.members.length), group.key, m.title, m.path, m.url])));
    } else if (activeTab === "untitled") {
      rows = [["title", "path", "url"]];
      items.filter((i) => !i.title.trim()).forEach((i) => rows.push([i.title, i.path, i.url]));
    } else if (activeTab === "http") {
      rows = [["title", "path", "url"]];
      items.filter((i) => i.url.startsWith("http://")).forEach((i) => rows.push([i.title, i.path, i.url]));
    } else if (activeTab === "dead") {
      rows = [["verdict", "status", "error", "title", "path", "url"]];
      deadResults.forEach((r) => rows.push([r.verdict, r.status ? String(r.status) : "", r.error || "", r.title, r.path, r.url]));
    } else {
      rows = [["folder", "direct", "subtree"]];
      folders.forEach((f) => rows.push([f.path, String(f.direct), String(f.subtree)]));
    }
    const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\r\n");
    const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "bookmark-health-" + activeTab + "-" + (/* @__PURE__ */ new Date()).toISOString().slice(0, 10) + ".csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3e3);
    setStatus("\u5DF2\u5BFC\u51FA CSV");
  }
  var tabs = document.querySelectorAll("#tabs button");
  tabs.forEach((button) => {
    button.addEventListener("click", () => {
      tabs.forEach((b) => b.classList.remove("active"));
      button.classList.add("active");
      activeTab = button.dataset.tab;
      resetSelection();
      renderTable();
      updateToolbar();
    });
  });
  document.getElementById("refresh")?.addEventListener("click", () => {
    setStatus("\u6B63\u5728\u68C0\u67E5\u2026");
    void collect().then(() => setStatus("\u68C0\u67E5\u5B8C\u6210"));
  });
  document.getElementById("export")?.addEventListener("click", exportCsv);
  deleteBtn.addEventListener("click", () => void doDelete());
  undoBtn.addEventListener("click", () => void doUndo());
  scanBtn.addEventListener("click", () => void scanDead());
  scanCancelBtn.addEventListener("click", () => {
    scanController?.abort();
    setStatus("\u6B63\u5728\u505C\u6B62\u626B\u63CF\u2026");
  });
  document.getElementById("select-all")?.addEventListener("click", () => {
    selectableRows().forEach((r) => selected.add(r.id));
    updateToolbar();
    renderTable();
  });
  document.getElementById("select-none")?.addEventListener("click", () => {
    selected.clear();
    updateToolbar();
    renderTable();
  });
  void collect().then(() => setStatus(""));
})();
