import { collapseDuplicates, searchBookmarks, topByUsage, type BookmarkHit } from "./search";

export type Disposition = "current" | "newtab" | "window";

export interface PaletteHandle {
  open(): Promise<void>;
  close(): void;
}

const CSS = `
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
.bm-tags { display: flex; gap: 4px; margin-top: 3px; flex-wrap: wrap; }
.bm-tag { font-size: 10px; color: #4f46e5; background: #eef2ff; border-radius: 999px; padding: 0 6px; }
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

function applyCss(target: ShadowRoot | HTMLElement): void {
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

function colorFor(seed: string): string {
  const hues = [210, 260, 330, 20, 140, 182, 280];
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return "hsl(" + hues[h % hues.length] + " 68% 45%)";
}

export function mountPalette(
  container: ShadowRoot | HTMLElement,
  getItems: () => Promise<BookmarkHit[]>,
  openUrl: (url: string, disposition: Disposition) => void,
  saveTags?: (url: string, tags: string[]) => Promise<void>
): PaletteHandle {
  applyCss(container);

  const wrap = document.createElement("div");
  wrap.className = "bm-wrap";

  const panel = document.createElement("div");
  panel.className = "bm-panel";

  const input = document.createElement("input");
  input.className = "bm-input";
  input.type = "text";
  input.placeholder = "搜索书签：标题、网址、路径，或拼音首字母（如 gc 找 工程）";
  input.spellcheck = false;

  const status = document.createElement("div");
  status.className = "bm-status";

  const list = document.createElement("div");
  list.className = "bm-list";
  list.setAttribute("role", "listbox");

  const foot = document.createElement("div");
  foot.className = "bm-foot";
  foot.innerHTML =
    "<span><span class='bm-kbd'>↑</span> <span class='bm-kbd'>↓</span> 选择</span>" +
    "<span><span class='bm-kbd'>Enter</span> 当前标签打开</span>" +
    "<span><span class='bm-kbd'>Ctrl+Enter</span> 新标签</span>" +
    "<span><span class='bm-kbd'>Shift+Enter</span> 新窗口</span>" +
    "<span><span class='bm-kbd'>Ctrl+T</span> 标签</span><span><span class='bm-kbd'>Esc</span> 关闭</span>";

  panel.appendChild(input);
  panel.appendChild(status);
  panel.appendChild(list);
  panel.appendChild(foot);
  wrap.appendChild(panel);
  (container instanceof ShadowRoot ? container : container).appendChild(wrap);

  let items: BookmarkHit[] | null = null;
  let loading: Promise<BookmarkHit[]> | null = null;
  let results: BookmarkHit[] = [];
  let selected = 0;
  let isOpen = false;

  function load(): Promise<BookmarkHit[]> {
    if (items) return Promise.resolve(items);
    if (loading) return loading;
    status.textContent = "正在加载书签索引…";
    loading = getItems()
      .then((data) => {
        items = data;
        return data;
      })
      .catch(() => {
        items = [];
        return [];
      })
      .finally(() => {
        loading = null;
      });
    return loading;
  }

  function compute(): BookmarkHit[] {
    const q = input.value.trim();
    const tagMatch = q.match(/^tag:(\S+)\s*(.*)$/i);
    if (tagMatch) {
      const tag = tagMatch[1].toLowerCase();
      const rest = tagMatch[2].trim();
      let pool = (items || []).filter((i) => (i.tags || []).some((t) => t.toLowerCase() === tag));
      if (rest) pool = searchBookmarks(pool, rest, 40);
      return collapseDuplicates(pool);
    }
    const raw = q ? searchBookmarks(items || [], q, 40) : topByUsage(items || [], 12);
    return collapseDuplicates(raw);
  }

  function render(): void {
    results = compute();
    selected = results.length ? Math.min(selected, results.length - 1) : 0;
    list.textContent = "";

    const q = input.value.trim();
    if (!items) {
      status.textContent = "正在加载书签索引…";
      return;
    }
    status.textContent = q
      ? results.length + " 条结果 · 共 " + items.length + " 条书签"
      : "常用书签（按访问频次）· 共 " + items.length + " 条书签";

    if (!results.length) {
      const empty = document.createElement("div");
      empty.className = "bm-empty";
      empty.textContent = q ? "没有找到匹配的书签" : "还没有访问记录，直接输入关键词搜索";
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
      sub.textContent = item.path || "书签栏";
      main.appendChild(title);
      main.appendChild(sub);
      if (item.tags && item.tags.length) {
        const tagWrap = document.createElement("div");
        tagWrap.className = "bm-tags";
        item.tags.slice(0, 4).forEach((tag) => {
          const chip = document.createElement("span");
          chip.className = "bm-tag";
          chip.textContent = "#" + tag;
          tagWrap.appendChild(chip);
        });
        main.appendChild(tagWrap);
      }

      const domain = document.createElement("div");
      domain.className = "bm-domain";
      domain.textContent = item.domain || "";

      row.appendChild(avatar);
      row.appendChild(main);
      if (item.dupeCount > 1) {
        const badge = document.createElement("span");
        badge.className = "bm-badge";
        badge.textContent = "重复 ×" + item.dupeCount;
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

  function updateSelection(): void {
    const rows = list.querySelectorAll(".bm-row");
    rows.forEach((row, index) => {
      row.classList.toggle("bm-selected", index === selected);
    });
    const current = rows[selected] as HTMLElement | undefined;
    if (current && typeof current.scrollIntoView === "function") {
      current.scrollIntoView({ block: "nearest" });
    }
  }

  function move(delta: number): void {
    if (!results.length) return;
    selected = (selected + delta + results.length) % results.length;
    updateSelection();
  }

  function openSelected(disposition: Disposition): void {
    const item = results[selected];
    if (!item) return;
    openUrl(item.url, disposition);
    close();
  }

  async function editTags(): Promise<void> {
    const item = results[selected];
    if (!item || !saveTags) return;
    const current = (item.tags || []).join(", ");
    const inputValue = window.prompt("给这条书签打标签（逗号分隔，留空清除）", current);
    if (inputValue === null) return;
    const tags = inputValue
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter(Boolean);
    try {
      await saveTags(item.url, tags);
      item.tags = tags;
      const index = (results || []).findIndex((r) => r.url === item.url);
      if (index >= 0) results[index] = item;
      render();
      status.textContent = tags.length ? "已保存标签：" + tags.join(", ") : "已清除标签";
    } catch {
      status.textContent = "标签保存失败";
    }
  }

  function close(): void {
    isOpen = false;
    wrap.classList.remove("bm-open");
    input.value = "";
    results = [];
    selected = 0;
  }

  async function open(): Promise<void> {
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

  input.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "t") {
      event.preventDefault();
      void editTags();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const disposition: Disposition = event.ctrlKey || event.metaKey ? "newtab" : event.shiftKey ? "window" : "current";
      openSelected(disposition);
    }
  });

  wrap.addEventListener("mousedown", (event) => {
    if (event.target === wrap) close();
  });

  return { open, close };
}
