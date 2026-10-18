import { buildIndex, normalizeUrl, type BookmarkHit, type HistoryStat, type RawBookmark } from "./search";

declare const chrome: any;

const INDEX_TTL = 5 * 60 * 1000;
const STATS_TTL = 10 * 60 * 1000;

let index: BookmarkHit[] | null = null;
let indexBuiltAt = 0;
let indexDirty = true;
let stats = new Map<string, HistoryStat>();
let statsAt = 0;
let tagMap: Record<string, string[]> = {};

async function loadTags(): Promise<void> {
  try {
    const data = await chrome.storage.local.get("tags");
    tagMap = (data && data.tags) || {};
  } catch {
    tagMap = {};
  }
}

void loadTags();

chrome.storage.onChanged.addListener((changes: any, area: string) => {
  if (area === "local" && changes.tags) {
    tagMap = changes.tags.newValue || {};
  }
});

async function collectBookmarks(): Promise<RawBookmark[]> {
  const tree = await chrome.bookmarks.getTree();
  const out: RawBookmark[] = [];
  const walk = (node: any, path: string[]): void => {
    if (node.url) {
      out.push({
        id: node.id,
        title: node.title || "",
        url: node.url,
        path: path.join(" / ") || "书签栏",
        dateAdded: node.dateAdded || 0
      });
      return;
    }
    const nextPath = node.title ? [...path, node.title] : path;
    for (const child of node.children || []) walk(child, nextPath);
  };
  for (const root of tree) walk(root, []);
  return out;
}

async function loadStats(force = false): Promise<Map<string, HistoryStat>> {
  if (!force && stats.size > 0 && Date.now() - statsAt < STATS_TTL) return stats;
  const since = Date.now() - 90 * 86400000;
  let found: any[] = [];
  try {
    found = await chrome.history.search({ text: "", startTime: since, maxResults: 50000 });
  } catch {
    found = [];
  }
  const map = new Map<string, HistoryStat>();
  for (const h of found) {
    if (!h.url) continue;
    const stat: HistoryStat = { visits: h.visitCount || 0, last: h.lastVisitTime || 0 };
    map.set(h.url, stat);
    const norm = normalizeUrl(h.url);
    if (!map.has(norm)) map.set(norm, stat);
  }
  stats = map;
  statsAt = Date.now();
  return stats;
}

async function ensureIndex(force = false): Promise<BookmarkHit[]> {
  if (!force && index && !indexDirty && Date.now() - indexBuiltAt < INDEX_TTL) return index;
  const [raw, st] = await Promise.all([collectBookmarks(), loadStats()]);
  index = buildIndex(raw, st);
  indexBuiltAt = Date.now();
  indexDirty = false;
  return index;
}

async function openUrl(url: string, disposition: string, senderTabId?: number): Promise<void> {
  if (disposition === "newtab") {
    await chrome.tabs.create({ url, active: false });
    return;
  }
  if (disposition === "window") {
    await chrome.windows.create({ url, focused: true });
    return;
  }
  if (typeof senderTabId === "number") {
    try {
      await chrome.tabs.update(senderTabId, { url });
      return;
    } catch {
      // fall through
    }
  }
  await chrome.tabs.create({ url });
}

async function openPalette(): Promise<void> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  if (!tab || typeof tab.id !== "number") return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    await chrome.tabs.sendMessage(tab.id, { type: "open-palette" });
  } catch {
    await chrome.tabs.create({ url: chrome.runtime.getURL("palette.html") });
  }
}

chrome.runtime.onMessage.addListener((msg: any, sender: any, sendResponse: any) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "getIndex") {
    ensureIndex()
      .then((items) => sendResponse({ items: items.map((item) => ({ ...item, tags: tagMap[item.url] || [] })), builtAt: indexBuiltAt }))
      .catch((err) => sendResponse({ error: String(err) }));
    return true;
  }
  if (msg.type === "open" && typeof msg.url === "string") {
    void openUrl(msg.url, msg.disposition, sender && sender.tab ? sender.tab.id : undefined);
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === "setTags" && typeof msg.url === "string" && Array.isArray(msg.tags)) {
    const tags = msg.tags.map((t: string) => String(t).trim()).filter(Boolean);
    const next = { ...tagMap };
    if (tags.length) next[msg.url] = tags;
    else delete next[msg.url];
    chrome.storage.local
      .set({ tags: next })
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === "refresh") {
    indexDirty = true;
    statsAt = 0;
    ensureIndex(true)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
});

chrome.commands.onCommand.addListener((command: string) => {
  if (command === "open-palette") void openPalette();
});

chrome.action.onClicked.addListener(() => {
  void openPalette();
});

for (const eventName of ["onCreated", "onRemoved", "onChanged", "onMoved"]) {
  const event = chrome.bookmarks[eventName];
  if (event && event.addListener) event.addListener(() => { indexDirty = true; });
}

chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.contextMenus.create({
      id: "bm-save-suggest",
      title: "书签秒搜：收藏到推荐文件夹",
      contexts: ["page", "link"]
    });
  } catch {
    // 已存在
  }
  void ensureIndex(true).catch(() => undefined);
});

chrome.contextMenus.onClicked.addListener((info: any, tab: any) => {
  const url = (info && info.linkUrl) || (tab && tab.url) || "";
  const title = (tab && tab.title) || "";
  void chrome.tabs.create({
    url: chrome.runtime.getURL("suggest.html") + "?url=" + encodeURIComponent(url) + "&title=" + encodeURIComponent(title)
  });
});
