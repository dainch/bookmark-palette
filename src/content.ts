import { mountPalette, type PaletteHandle } from "./ui";
import type { BookmarkHit } from "./search";

declare const chrome: any;

const HOST_ID = "bm-palette-host";
const g = globalThis as any;

if (!g.__bmPaletteInstalled) {
  g.__bmPaletteInstalled = true;

  let handle: PaletteHandle | null = null;
  let lastOpen = 0;

  function ensureHandle(): PaletteHandle {
    if (handle) return handle;
    let host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement("div");
      host.id = HOST_ID;
      host.style.all = "initial";
      document.documentElement.appendChild(host);
    }
    const shadow = host.shadowRoot || host.attachShadow({ mode: "open" });
    handle = mountPalette(
      shadow,
      async () => {
        const res = await chrome.runtime.sendMessage({ type: "getIndex" });
        if (!res || res.error) throw new Error(res && res.error ? res.error : "index error");
        return res.items as BookmarkHit[];
      },
      (url, disposition) => {
        void chrome.runtime.sendMessage({ type: "open", url, disposition });
      }
    );
    return handle;
  }

  function trigger(): void {
    const now = Date.now();
    if (now - lastOpen < 250) return;
    lastOpen = now;
    void ensureHandle().open();
  }

  chrome.runtime.onMessage.addListener((msg: any) => {
    if (msg && msg.type === "open-palette") trigger();
  });

  window.addEventListener(
    "keydown",
    (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === "k" || event.key === "K")) {
        event.preventDefault();
        trigger();
      }
    },
    true
  );
}
