import { pinyin } from "pinyin-pro";

export interface RawBookmark {
  id: string;
  title: string;
  url: string;
  path: string;
  dateAdded: number;
}

export interface HistoryStat {
  visits: number;
  last: number;
}

export interface BookmarkHit extends RawBookmark {
  titleLower: string;
  pathLower: string;
  urlLower: string;
  domain: string;
  pinyinFull: string;
  pinyinInitials: string;
  visits: number;
  lastVisit: number;
  score?: number;
}

export function normalizeUrl(raw: string): string {
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

export function extractDomain(raw: string): string {
  try {
    return new URL(raw).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function toPinyin(text: string): { full: string; initials: string } {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return { full: "", initials: "" };
  try {
    const full = pinyin(clean, { toneType: "none", type: "array" }).join("").toLowerCase();
    const initials = pinyin(clean, { pattern: "first", toneType: "none", type: "array" }).join("").toLowerCase();
    return { full, initials };
  } catch {
    return { full: "", initials: "" };
  }
}

export function buildIndex(raw: RawBookmark[], stats: Map<string, HistoryStat>): BookmarkHit[] {
  return raw.map((item) => {
    const stat = stats.get(item.url) || (stats.get(normalizeUrl(item.url)) as HistoryStat | undefined);
    const domain = extractDomain(item.url);
    const py = toPinyin(item.title + " " + item.path);
    return {
      ...item,
      titleLower: item.title.toLowerCase(),
      pathLower: item.path.toLowerCase(),
      urlLower: item.url.toLowerCase(),
      domain,
      pinyinFull: py.full,
      pinyinInitials: py.initials,
      visits: stat ? stat.visits : 0,
      lastVisit: stat ? stat.last : 0
    };
  });
}

function subsequenceScore(hay: string, needle: string): number {
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

const BOUNDARY = /[\s\-_/|（）()\[\]【】:：·.,;!?"'“”‘’+&@#]/;

function indexScore(hay: string, token: string, boundaryScore: number, midScore: number): number {
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

function scoreToken(item: BookmarkHit, token: string): number {
  let best = 0;
  if (item.titleLower === token) best = 1500;

  best = Math.max(best, indexScore(item.titleLower, token, 900, 430));
  best = Math.max(best, indexScore(item.pathLower, token, 800, 380));
  best = Math.max(best, indexScore(item.domain, token, 700, 330));
  best = Math.max(best, indexScore(item.urlLower, token, 400, 220));

  if (!/[\u3400-\u9fff]/.test(token)) {
    best = Math.max(best, indexScore(item.pinyinInitials, token, 1150, 480));
    best = Math.max(best, indexScore(item.pinyinFull, token, 1000, 460));
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

function freqBoost(item: BookmarkHit): number {
  if (!item.visits) return 0;
  return Math.min(120, Math.log2(1 + item.visits) * 22);
}

function recencyBoost(item: BookmarkHit): number {
  if (!item.lastVisit) return 0;
  const days = (Date.now() - item.lastVisit) / 86400000;
  if (days <= 1) return 80;
  if (days <= 7) return 50;
  if (days <= 30) return 25;
  return 0;
}

export function searchBookmarks(index: BookmarkHit[], query: string, limit = 30): BookmarkHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const tokens = q.split(/\s+/).filter(Boolean);
  const out: BookmarkHit[] = [];
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
  out.sort((a, b) => (b.score! - a.score!) || (a.title.length - b.title.length) || a.title.localeCompare(b.title));
  return out.slice(0, limit);
}

export function topByUsage(index: BookmarkHit[], limit = 12): BookmarkHit[] {
  return index
    .filter((i) => i.visits > 0 || i.lastVisit > 0)
    .sort((a, b) => (b.visits - a.visits) || (b.lastVisit - a.lastVisit))
    .slice(0, limit);
}

export interface CollapsedHit extends BookmarkHit {
  dupeCount: number;
  dupePaths: string[];
}

export function collapseDuplicates(hits: BookmarkHit[]): CollapsedHit[] {
  const seen = new Map<string, CollapsedHit>();
  const out: CollapsedHit[] = [];
  for (const hit of hits) {
    const key = normalizeUrl(hit.url);
    const existing = seen.get(key);
    if (existing) {
      existing.dupeCount += 1;
      if (existing.dupePaths.length < 4) existing.dupePaths.push(hit.path);
      continue;
    }
    const item: CollapsedHit = { ...hit, dupeCount: 1, dupePaths: [hit.path] };
    seen.set(key, item);
    out.push(item);
  }
  return out;
}
