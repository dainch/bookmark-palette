import { readFileSync } from "node:fs";
import { buildIndex, searchBookmarks, topByUsage } from "../src/search.ts";

const path = process.argv[2] || "C:\\Users\\dell\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Bookmarks";
const doc = JSON.parse(readFileSync(path, "utf8"));
const raw = [];
const walk = (node, p) => {
  const name = node.name || node.title || "";
  if (node.url) { raw.push({ id: node.id, title: name, url: node.url, path: p.join(" / ") || "书签栏", dateAdded: node.dateAdded || 0 }); return; }
  const next = name ? [...p, name] : p;
  for (const c of node.children || []) walk(c, next);
};
for (const key of ["bookmark_bar", "other", "synced"]) {
  const root = doc.roots[key];
  if (root?.children) for (const c of root.children) walk(c, []);
}
const index = buildIndex(raw, new Map());
console.log("index size:", index.length);

const queries = ["工程", "gongcheng", "gc", "github", "gh", "跨境", "kj", "规范", "gf", "论文", "lw", "shopee", "sts", "ai", "模型", "moxing", "设计", "sj"];
for (const q of queries) {
  const res = searchBookmarks(index, q, 5);
  console.log("[" + q + "] " + res.map((r) => (r.title || r.url).slice(0, 26) + " @ " + r.path).join(" || "));
}
console.log("---- empty-query top by usage (no history fixture) ----");
console.log(topByUsage(index, 5).length);
