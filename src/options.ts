import { normalizeUrl } from "./search";
import { deleteBookmarks, exportBackup, loadUndo, undoLast, type UndoRecord } from "./actions";

declare const chrome: any;

interface Item {
  id: string;
  title: string;
  url: string;
  path: string;
  folder: string[];
  dateAdded: number;
}

type Tab = "dup" | "untitled" | "http" | "dead" | "tags" | "folders";

interface DeadResult extends Item {
  status: number | null;
  verdict: "dead" | "unknown" | "ok";
  error?: string;
}

let items: Item[] = [];
let folders: { path: string; direct: number; subtree: number }[] = [];
let dupGroups: { key: string; members: Item[] }[] = [];
let deadResults: DeadResult[] = [];
let tagMap: Record<string, string[]> = {};
let activeTab: Tab = "dup";
let selected = new Set<string>();
let undoRecord: UndoRecord | null = null;
let scanning = false;
let scanController: AbortController | null = null;

const content = document.getElementById("content") as HTMLElement;
const summary = document.getElementById("summary") as HTMLElement;
const status = document.getElementById("status") as HTMLElement;
const progress = document.getElementById("progress") as HTMLElement;
const progressBar = document.getElementById("progress-bar") as HTMLElement;
const deleteBtn = document.getElementById("delete") as HTMLButtonElement;
const undoBtn = document.getElementById("undo") as HTMLButtonElement;
const scanBtn = document.getElementById("scan") as HTMLButtonElement;
const scanCancelBtn = document.getElementById("scan-cancel") as HTMLButtonElement;

function setStatus(text: string): void {
  status.textContent = text;
}

async function collect(): Promise<void> {
  const tree: any[] = await chrome.bookmarks.getTree();
  items = [];
  folders = [];
  deadResults = [];
  const counts = new Map<string, { direct: number; subtree: number }>();
  const ROOT_IDS = new Set(["1", "2", "3"]);
  const walk = (node: any, path: string[]): number => {
    if (node.url) {
      items.push({
        id: node.id,
        title: node.title || "",
        url: node.url,
        path: path.join(" / ") || "书签栏",
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

  folders = [...counts.entries()]
    .map(([path, c]) => ({ path, direct: c.direct, subtree: c.subtree }))
    .sort((a, b) => b.subtree - a.subtree);

  const groups = new Map<string, Item[]>();
  for (const item of items) {
    const key = normalizeUrl(item.url);
    const list = groups.get(key) || [];
    list.push(item);
    groups.set(key, list);
  }
  dupGroups = [...groups.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([key, list]) => ({ key, members: list }))
    .sort((a, b) => b.members.length - a.members.length);

  const storedTags = await chrome.storage.local.get("tags");
  tagMap = (storedTags && storedTags.tags) || {};
  undoRecord = await loadUndo();
  resetSelection();
  renderAll();
}

function selectableRows(): { id: string; defaultOn: boolean }[] {
  if (activeTab === "dup") {
    const rows: { id: string; defaultOn: boolean }[] = [];
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

function resetSelection(): void {
  selected = new Set();
  for (const row of selectableRows()) if (row.defaultOn) selected.add(row.id);
  updateToolbar();
}

function updateToolbar(): void {
  deleteBtn.disabled = selected.size === 0;
  deleteBtn.textContent = selected.size ? "删除选中（" + selected.size + "）" : "删除选中";
  if (undoRecord && undoRecord.items.length) {
    undoBtn.hidden = false;
    undoBtn.textContent = "撤销上次（" + undoRecord.items.length + "）";
  } else {
    undoBtn.hidden = true;
  }
  scanBtn.hidden = activeTab !== "dead";
  scanCancelBtn.hidden = !(activeTab === "dead" && scanning);
}

async function saveTags(url: string, tags: string[]): Promise<void> {
  const next = { ...tagMap };
  const cleaned = tags.map((t) => t.trim()).filter(Boolean);
  if (cleaned.length) next[url] = cleaned;
  else delete next[url];
  tagMap = next;
  await chrome.storage.local.set({ tags: next });
  renderSummary();
  renderTable();
}

async function editTags(item: Item): Promise<void> {
  const current = (tagMap[item.url] || []).join(", ");
  const value = window.prompt("标签（逗号分隔，留空清除）", current);
  if (value === null) return;
  await saveTags(item.url, value.split(/[,，]/));
}

function renderSummary(): void {
  const untitled = items.filter((i) => !i.title.trim()).length;
  const http = items.filter((i) => i.url.startsWith("http://")).length;
  const extra = dupGroups.reduce((sum, g) => sum + g.members.length - 1, 0);
  const dead = deadResults.filter((r) => r.verdict === "dead").length;
  const unknown = deadResults.filter((r) => r.verdict === "unknown").length;
  summary.innerHTML =
    "<span>书签 <b>" + items.length + "</b></span>" +
    "<span>文件夹 <b>" + folders.length + "</b></span>" +
    "<span>重复组 <b>" + dupGroups.length + "</b>（多余 " + extra + " 条）</span>" +
    "<span>无标题 <b>" + untitled + "</b></span>" +
    "<span>HTTP <b>" + http + "</b></span>" +
    (deadResults.length ? "<span>疑似失效 <b>" + dead + "</b>，待确认 " + unknown + "</span>" : "") +
    "<span>已打标签 <b>" + Object.keys(tagMap).length + "</b> 条</span>";
}

function cell(text: string, className?: string): HTMLTableCellElement {
  const td = document.createElement("td");
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function checkCell(id: string, disabled = false): HTMLTableCellElement {
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

function renderTable(): void {
  content.textContent = "";
  if (!items.length) {
    content.innerHTML = '<div class="empty">正在读取书签…</div>';
    return;
  }
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const trh = document.createElement("tr");
  const addTh = (text: string, className?: string) => {
    const th = document.createElement("th");
    th.textContent = text;
    if (className) th.className = className;
    trh.appendChild(th);
  };
  const withCheck = activeTab !== "folders" && activeTab !== "tags";
  if (withCheck) addTh("", "check");
  if (activeTab === "dup") ["组", "条数", "标题", "路径", "规范化 URL"].forEach((h) => addTh(h));
  else if (activeTab === "untitled") ["域名", "路径", "URL"].forEach((h) => addTh(h));
  else if (activeTab === "http") ["域名", "标题", "URL"].forEach((h) => addTh(h));
  else if (activeTab === "dead") ["状态", "标题", "路径", "URL"].forEach((h) => addTh(h));
  else if (activeTab === "tags") ["标题", "路径", "标签", "操作"].forEach((h) => addTh(h));
  else ["文件夹", "直接书签", "子树书签"].forEach((h) => addTh(h));
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
        tr.appendChild(cell(member.title || "（无标题）", "truncate"));
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
      tr.appendChild(cell(item.title || "（无标题）", "truncate"));
      tr.appendChild(cell(item.url, "mono truncate"));
      tbody.appendChild(tr);
    });
  } else if (activeTab === "dead") {
    if (!deadResults.length) {
      content.innerHTML = '<div class="empty">还没有扫描结果。点上方「扫描失效链接」开始（会向书签网址发请求，可随时停止）。注意：VPN/代理会影响判定，只有 404/410 会默认勾选，超时和 403/429/5xx 一律标「待确认」。</div>';
      return;
    }
    const rows = [...deadResults].sort((a, b) => {
      const rank = (v: string) => (v === "dead" ? 0 : v === "unknown" ? 1 : 2);
      return rank(a.verdict) - rank(b.verdict);
    });
    rows.forEach((res) => {
      const tr = document.createElement("tr");
      tr.appendChild(checkCell(res.id, res.verdict === "ok"));
      const tdStatus = document.createElement("td");
      const tag = document.createElement("span");
      tag.className = "tag " + (res.verdict === "dead" ? "dead" : res.verdict === "unknown" ? "unknown" : "ok");
      tag.textContent = res.verdict === "dead" ? "失效" : res.verdict === "unknown" ? "待确认" : "正常";
      tdStatus.appendChild(tag);
      if (res.status) tdStatus.appendChild(document.createTextNode(String(res.status)));
      else if (res.error) tdStatus.appendChild(document.createTextNode(res.error));
      tr.appendChild(tdStatus);
      tr.appendChild(cell(res.title || "（无标题）", "truncate"));
      tr.appendChild(cell(res.path, "truncate"));
      tr.appendChild(cell(res.url, "mono truncate"));
      tbody.appendChild(tr);
    });
  } else if (activeTab === "tags") {
    const tagged = items.filter((item) => (tagMap[item.url] || []).length > 0);
    tagged.forEach((item) => {
      const tr = document.createElement("tr");
      tr.appendChild(cell(item.title || "（无标题）", "truncate"));
      tr.appendChild(cell(item.path, "truncate"));
      const tdTags = document.createElement("td");
      (tagMap[item.url] || []).forEach((tag) => {
        const chip = document.createElement("span");
        chip.className = "tag";
        chip.textContent = "#" + tag;
        tdTags.appendChild(chip);
      });
      tr.appendChild(tdTags);
      const tdOps = document.createElement("td");
      const edit = document.createElement("button");
      edit.textContent = "编辑";
      edit.addEventListener("click", () => void editTags(item));
      const clear = document.createElement("button");
      clear.textContent = "清除";
      clear.addEventListener("click", () => void saveTags(item.url, []));
      tdOps.appendChild(edit);
      tdOps.appendChild(clear);
      tr.appendChild(tdOps);
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
    content.innerHTML = '<div class="empty">没有发现需要处理的项目</div>';
  }
}

function renderAll(): void {
  renderSummary();
  renderTable();
  updateToolbar();
}

async function doDelete(): Promise<void> {
  const ids = [...selected];
  if (!ids.length) return;
  const chosen = items.filter((i) => selected.has(i.id));
  const ok = window.confirm("确认删除选中的 " + ids.length + " 条书签？\n\n会先自动导出备份 JSON，删除后可用「撤销上次」恢复。");
  if (!ok) return;
  setStatus("正在备份并删除…");
  try {
    await exportBackup(chosen.map((i) => ({ title: i.title, url: i.url, path: i.path })));
    const record = await deleteBookmarks(ids);
    undoRecord = record;
    setStatus("已删除 " + record.items.length + " 条，可从「撤销上次」恢复");
    await collect();
  } catch (err) {
    setStatus("删除失败：" + String(err));
  }
}

async function doUndo(): Promise<void> {
  if (!undoRecord) return;
  const ok = window.confirm("恢复上次删除的 " + undoRecord.items.length + " 条书签？");
  if (!ok) return;
  setStatus("正在恢复…");
  try {
    const n = await undoLast();
    undoRecord = null;
    setStatus("已恢复 " + n + " 条");
    await collect();
  } catch (err) {
    setStatus("恢复失败：" + String(err));
  }
}

function isPrivateHost(url: string): boolean {
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

async function requestOnce(
  url: string,
  method: "HEAD" | "GET",
  timeoutMs: number,
  signal: AbortSignal
): Promise<{ status: number | null; error?: string }> {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, redirect: "follow", signal: ctrl.signal, cache: "no-store" });
    return { status: res.status };
  } catch {
    return { status: null, error: "请求失败或超时" };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

async function checkUrl(
  url: string,
  signal: AbortSignal
): Promise<{ status: number | null; verdict: "dead" | "unknown" | "ok"; error?: string }> {
  if (!/^https?:/i.test(url)) return { status: null, verdict: "unknown", error: "非 http" };
  if (isPrivateHost(url)) return { status: null, verdict: "unknown", error: "本地地址，跳过" };
  if (signal.aborted) return { status: null, verdict: "unknown", error: "已停止" };

  // 代理/VPN 环境下 HEAD 常被拒或超时，先 HEAD 再 GET，仍失败则退避重试一次。
  let result = await requestOnce(url, "HEAD", 10000, signal);
  if (result.status === 405 || result.status === 501 || result.status === null) {
    result = await requestOnce(url, "GET", 10000, signal);
  }
  if (result.status === null) {
    await new Promise((resolve) => setTimeout(resolve, 900));
    result = await requestOnce(url, "GET", 12000, signal);
  }
  if (result.status === null) {
    return { status: null, verdict: "unknown", error: "请求失败或超时（待确认）" };
  }

  const status = result.status;
  if (status === 404 || status === 410) {
    return { status, verdict: "dead", error: "HTTP " + status };
  }
  if (status >= 200 && status < 400) {
    return { status, verdict: "ok" };
  }
  return { status, verdict: "unknown", error: "HTTP " + status + "（待确认）" };
}

function updateProgress(done: number, total: number): void {
  progress.hidden = false;
  progressBar.style.width = total ? Math.round((done / total) * 100) + "%" : "0%";
  setStatus("扫描中 " + done + " / " + total);
}

async function scanDead(): Promise<void> {
  if (scanning) return;
  const targets = items.filter((i) => /^https?:/i.test(i.url));
  if (!targets.length) {
    setStatus("没有可扫描的 http(s) 书签");
    return;
  }
  scanning = true;
  scanController = new AbortController();
  updateToolbar();
  const results: DeadResult[] = new Array(targets.length);
  let cursor = 0;
  let done = 0;
  updateProgress(0, targets.length);
  const worker = async (): Promise<void> => {
    while (!scanController!.signal.aborted) {
      const index = cursor++;
      if (index >= targets.length) return;
      const item = targets[index];
      const r = await checkUrl(item.url, scanController!.signal);
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
  setStatus("扫描完成：疑似失效 " + dead + " 条，待确认 " + deadResults.filter((r) => r.verdict === "unknown").length + " 条");
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return '"' + value.replace(/"/g, '""') + '"';
  return value;
}

function exportCsv(): void {
  let rows: string[][] = [];
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
  } else if (activeTab === "tags") {
    rows = [["title", "path", "tags", "url"]];
    items
      .filter((i) => (tagMap[i.url] || []).length > 0)
      .forEach((i) => rows.push([i.title, i.path, (tagMap[i.url] || []).join("|"), i.url]));
  } else {
    rows = [["folder", "direct", "subtree"]];
    folders.forEach((f) => rows.push([f.path, String(f.direct), String(f.subtree)]));
  }
  const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\r\n");
  const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "bookmark-health-" + activeTab + "-" + new Date().toISOString().slice(0, 10) + ".csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
  setStatus("已导出 CSV");
}

const tabs = document.querySelectorAll("#tabs button");
tabs.forEach((button) => {
  button.addEventListener("click", () => {
    tabs.forEach((b) => b.classList.remove("active"));
    button.classList.add("active");
    activeTab = (button as HTMLElement).dataset.tab as Tab;
    resetSelection();
    renderTable();
    updateToolbar();
  });
});

document.getElementById("refresh")?.addEventListener("click", () => {
  setStatus("正在检查…");
  void collect().then(() => setStatus("检查完成"));
});
document.getElementById("export")?.addEventListener("click", exportCsv);
deleteBtn.addEventListener("click", () => void doDelete());
undoBtn.addEventListener("click", () => void doUndo());
scanBtn.addEventListener("click", () => void scanDead());
scanCancelBtn.addEventListener("click", () => {
  scanController?.abort();
  setStatus("正在停止扫描…");
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
