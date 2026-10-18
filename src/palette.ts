import { mountPalette } from "./ui";
import type { BookmarkHit } from "./search";

declare const chrome: any;

const handle = mountPalette(
  document.body,
  async () => {
    const res = await chrome.runtime.sendMessage({ type: "getIndex" });
    if (!res || res.error) throw new Error(res && res.error ? res.error : "index error");
    return res.items as BookmarkHit[];
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
