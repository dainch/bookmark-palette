declare const chrome: any;

export interface UndoItem {
  parentId: string;
  index: number;
  title: string;
  url: string;
  dateAdded?: number;
}

export interface UndoRecord {
  time: number;
  items: UndoItem[];
}

export interface BackupItem {
  title: string;
  url: string;
  path: string;
}

export async function exportBackup(items: BackupItem[], prefix = "bookmarks-before-clean"): Promise<void> {
  const payload = {
    exportedAt: new Date().toISOString(),
    count: items.length,
    items
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  a.download = prefix + "-" + stamp + ".json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export async function deleteBookmarks(ids: string[]): Promise<UndoRecord> {
  const undoItems: UndoItem[] = [];
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
      // 已被删除或不可读，跳过
    }
  }
  const record: UndoRecord = { time: Date.now(), items: undoItems };
  if (undoItems.length) {
    await chrome.storage.local.set({ lastUndo: record });
  }
  return record;
}

export async function loadUndo(): Promise<UndoRecord | null> {
  try {
    const data = await chrome.storage.local.get("lastUndo");
    const rec = data && data.lastUndo;
    if (rec && Array.isArray(rec.items) && rec.items.length) return rec as UndoRecord;
  } catch {
    // ignore
  }
  return null;
}

export async function clearUndo(): Promise<void> {
  try {
    await chrome.storage.local.remove("lastUndo");
  } catch {
    // ignore
  }
}

export async function undoLast(): Promise<number> {
  const rec = await loadUndo();
  if (!rec) return 0;
  const items = [...rec.items].sort((a, b) => a.index - b.index);
  let restored = 0;
  for (const item of items) {
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
        // 放弃单条
      }
    }
  }
  await clearUndo();
  return restored;
}
