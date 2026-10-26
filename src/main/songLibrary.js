"use strict";

/**
 * songLibrary.js — indexes the church's song .pptx libraries and matches the
 * song titles printed in the 주보 to actual files, so a bulletin drop-in can
 * build the whole deck without the user hand-picking every file.
 *
 * Two libraries (both configurable in Settings):
 *   hymnDir   flat   "NNN - title.pptx"      (새찬송가)
 *   praiseDir nested "<초성>/title.pptx"      (경배와 찬양 악보)
 *
 * Either setting may hold several ';'-separated roots; all are scanned.
 * Matching is normalized (spacing/punctuation in the bulletin never matches the
 * filename exactly) and always reports what it could NOT find, because the
 * libraries are genuinely missing some songs.
 */

const fs = require("fs");
const path = require("path");

const SONG_EXT = /\.pptx?$/i;

/** Collapse a title to a comparison key: no spaces, no punctuation, NFC. */
function normalize(s) {
  return String(s || "")
    .normalize("NFC")
    .replace(/[‘’´`]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase()
    .replace(/[\s.,!?~\-_·/\\'"()[\]{}:;]/g, "");
}

/**
 * Filenames carry bookkeeping suffixes the bulletin never prints:
 *   "주님 다시 오실 때까지1"  "재 대신 화관을.355"  "주 보좌로부터(…)-edit"
 * Strip them for matching, but remember they were there so a clean file wins
 * the tie-break over a suffixed one.
 */
function stripSuffix(base) {
  const before = base;
  let s = base;
  s = s.replace(/\.\d{1,4}$/, ""); // ".1102" / ".355"
  s = s.replace(/\s*-\s*(edit|수정|복사본)$/i, ""); // "-edit"
  s = s.replace(/([가-힣a-zA-Z)])\d{1,2}$/, "$1"); // trailing "1" / "2"
  return { title: s.trim(), suffixed: s !== before };
}

/**
 * Candidate titles for one file. "주 보좌로부터(주님의 강이).ppt" is findable
 * under either name, so both are indexed — but the outside-parens name is the
 * primary and scores higher.
 */
function titlesOf(base) {
  const { title, suffixed } = stripSuffix(base);
  const main = title.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  const alts = [];
  const re = /\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(title))) {
    const a = m[1].replace(/\s+/g, " ").trim();
    if (a && /[가-힣a-zA-Z]/.test(a)) alts.push(a);
  }
  return { main: main || title, alts, suffixed };
}

/** A dir setting may list several roots, separated by ';'. */
function splitRoots(dirSetting) {
  return String(dirSetting || "")
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean);
}

function walk(root, out, depth = 0) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      if (depth < 3) walk(full, out, depth + 1);
    } else if (SONG_EXT.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

function makeEntry(file) {
  const base = path.basename(file).replace(SONG_EXT, "").normalize("NFC");
  const { main, alts, suffixed } = titlesOf(base);
  return {
    file,
    name: path.basename(file),
    base,
    title: main,
    alts,
    suffixed,
    pptx: /\.pptx$/i.test(file),
  };
}

/** 새찬송가 index — "094 - 주 예수보다 더 귀한 것은 없네.pptx" → {num:94,…}. */
function indexHymns(hymnDir) {
  const items = [];
  for (const root of splitRoots(hymnDir)) {
    for (const file of walk(root, [])) {
      const e = makeEntry(file);
      const m = /^(\d{1,3})\s*[-.]?\s*(.+)$/.exec(e.base);
      if (m) {
        e.num = parseInt(m[1], 10);
        e.title = m[2].replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
      } else {
        e.num = null;
      }
      items.push(e);
    }
  }
  return items;
}

/** 경배와 찬양 index (recursive — the library is foldered by 초성). */
function indexPraise(praiseDir) {
  const items = [];
  for (const root of splitRoots(praiseDir)) {
    for (const file of walk(root, [])) items.push(makeEntry(file));
  }
  return items;
}

/**
 * Last-modified time, read lazily — only candidates that actually tie on score
 * get stat'd, which keeps indexing the ~3,400-file library fast.
 */
function mtimeOf(entry) {
  if (entry._mtime === undefined) {
    try {
      entry._mtime = fs.statSync(entry.file).mtimeMs;
    } catch {
      entry._mtime = 0;
    }
  }
  return entry._mtime;
}

/**
 * Later-listed candidates only win on a strictly better score.
 *
 * `rank` is the position of the candidate's library in the search order, so the
 * caller decides which library to trust first (a "찬 N장" song is looked up in
 * the 찬송가 library first, a plain title in 경배와찬양).
 *
 * Within one library a song accumulates several files ("… .pptx", "…1.pptx",
 * "… - 2.pptx", "…-edit.ppt"). Whoever maintains the library saves the reworked
 * version as a new file, so among equally good matches the newest one is the
 * one actually in use.
 */
function better(a, b) {
  if (!a) return true;
  if (b.score !== a.score) return b.score > a.score;
  if (b.rank !== a.rank) return b.rank < a.rank; // preferred library first
  const [ma, mb] = [mtimeOf(a.entry), mtimeOf(b.entry)];
  if (mb !== ma) return mb > ma; // newest file wins
  if (b.entry.pptx !== a.entry.pptx) return b.entry.pptx; // .pptx over .ppt
  if (b.entry.suffixed !== a.entry.suffixed) return !b.entry.suffixed;
  return b.entry.base.length < a.entry.base.length; // least decorated name
}

/**
 * Length of the longest common subsequence — the basis of the fuzzy fallback
 * that absorbs the odd typo in the bulletin ("옳은 갈 따르라" for "옳은 길 …").
 */
function lcsLen(a, b) {
  if (!a.length || !b.length) return 0;
  let prev = new Array(b.length + 1).fill(0);
  let cur = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const t = prev;
    prev = cur;
    cur = t;
  }
  return prev[b.length];
}

/**
 * Score one index entry against a normalized bulletin title. 0 means no match.
 * Exact (100) > file name starts with what the bulletin printed (80) >
 * the bulletin printed a longer form of the file name (70) > contains (55) >
 * near-identical apart from a typo (40–50).
 * Alias (parenthesized) matches score 10 lower than primary-title matches.
 */
function scoreEntry(entry, q) {
  if (q.length < 2) return 0;
  let best = 0;
  const cands = [{ t: normalize(entry.title), bonus: 0 }];
  for (const a of entry.alts) cands.push({ t: normalize(a), bonus: -10 });
  for (const c of cands) {
    const t = c.t;
    if (!t) continue;
    let s = 0;
    if (t === q) s = 100;
    else if (q.length >= 4 && t.startsWith(q)) s = 80;
    else if (t.length >= 4 && q.startsWith(t)) s = 70;
    else if (q.length >= 5 && t.includes(q)) s = 55;
    // The bulletin drops a word the filename keeps ("우리는 (주의) 움직이는 교회"):
    // every character of the printed title still appears, in order.
    else if (q.length >= 6 && q.length / t.length >= 0.7 && lcsLen(t, q) === q.length) s = 50;
    else if (q.length >= 6 && Math.abs(t.length - q.length) <= 2) {
      const ratio = lcsLen(t, q) / Math.max(t.length, q.length);
      if (ratio >= 0.85) s = 40 + Math.round((ratio - 0.85) * 60);
    }
    if (s) best = Math.max(best, s + c.bonus);
  }
  return best;
}

/** Best-scoring entry for a title; earlier indexes are the preferred library. */
function bestByTitle(indexes, title) {
  const q = normalize(title);
  if (!q) return null;
  let win = null;
  indexes.forEach((index, rank) => {
    for (const entry of index) {
      const score = scoreEntry(entry, q);
      if (score && better(win, { entry, score, rank })) win = { entry, score, rank };
    }
  });
  return win;
}

/** Best praise-library file for a printed title, or null. */
function matchPraise(index, title) {
  const win = bestByTitle([index], title);
  return win ? win.entry : null;
}

/** Every hymn file carrying this 찬송가 number — newest, then cleanest name. */
function bestByNumber(index, num) {
  let win = null;
  for (const entry of index) {
    if (entry.num !== num) continue;
    const cand = { entry, score: 1, rank: 0 };
    if (better(win, cand)) win = cand;
  }
  return win;
}

/** Best hymn file — by number when the bulletin printed one, else by title. */
function matchHymn(index, item) {
  const found = findSong(item || {}, index, []);
  return found ? found.entry : null;
}

/**
 * Resolve one printed song to a file.
 *
 * The bulletin sometimes prints the 통일찬송가 number next to a 새찬송가 title
 * ("찬 48장. 만유의 주재" — 48 is 거룩하신 주 하나님 in the 새찬송가). When the
 * numbered file's own title disagrees with the printed title and the title
 * matches some other file strongly, the title wins and the clash is reported.
 */
function findSong(item, hymnIndex, praiseIndex) {
  const title = (item && item.title) || "";
  const q = normalize(title);
  // A printed 찬 N장 means the 찬송가 library is authoritative for the title too;
  // a bare title is a CCM song, so 경배와찬양 comes first.
  const byTitle = (item && item.num)
    ? bestByTitle([hymnIndex, praiseIndex], title)
    : bestByTitle([praiseIndex, hymnIndex], title);

  if (item && item.num) {
    const byNum = bestByNumber(hymnIndex, item.num);
    if (!byNum) return byTitle ? { ...byTitle, note: `찬송가 ${item.num}장 파일 없음 — 제목으로 찾음` } : null;
    if (!q) return byNum;
    if (scoreEntry(byNum.entry, q) >= 70) return byNum; // number and title agree
    if (byTitle && byTitle.score >= 80) {
      return { ...byTitle, note: `주보의 ${item.num}장과 제목이 달라 제목 기준으로 찾음` };
    }
    return { ...byNum, note: `제목(${title})과 파일 제목이 다름 — 번호 기준` };
  }
  return byTitle;
}

/**
 * The slots the bulletin can fill, in service order. 1부 and 2부 have separate
 * blocks. closingPraise (축복송) is deliberately absent: it is the same song all
 * year, set in Settings rather than printed in the 주보.
 */
const SONG_SLOTS = [
  "praiseWorship1",
  "praiseWorship",
  "openingHymn",
  "closingHymn1",
  "closingHymn",
];

// parsed key → template slot. 성찬식 찬송 shares the opening-hymn anchor
// (it precedes the sermon); the 2부 blocks keep the historical slot names.
const SLOT_OF = {
  praiseWorship1: "praiseWorship1",
  praiseWorship2: "praiseWorship",
  openingHymn: "openingHymn",
  communion: "openingHymn",
  closingHymn1: "closingHymn1",
  closingHymn2: "closingHymn",
};

/**
 * Resolve every song the parser found in the 주보 into file paths.
 *
 * `parsedSongs` comes from bulletinParser.parseSongs(). Hymn entries carry a
 * 찬송가 number; praise entries carry only a title.
 *
 * Returns { songs, matched[], unmatched[] } — `unmatched` is surfaced in the UI
 * so the user knows exactly which files to add by hand.
 */
function resolveSongs(parsedSongs, config) {
  const hymnIndex = indexHymns(config.hymnDir);
  const praiseIndex = indexPraise(config.praiseDir);

  const songs = {};
  for (const s of SONG_SLOTS) songs[s] = [];
  const matched = [];
  const unmatched = [];

  const resolveOne = (item, slot) => {
    const found = findSong(item, hymnIndex, praiseIndex);
    const label = item.num ? `찬 ${item.num}장 ${item.title || ""}`.trim() : item.title;
    if (found) {
      songs[slot].push(found.entry.file);
      matched.push({ slot, label, file: found.entry.file, name: found.entry.name, note: found.note || "" });
    } else {
      unmatched.push({ slot, label });
    }
  };

  for (const [key, slot] of Object.entries(SLOT_OF)) {
    for (const it of (parsedSongs && parsedSongs[key]) || []) resolveOne(it, slot);
  }

  return {
    songs,
    matched,
    unmatched,
    counts: { hymns: hymnIndex.length, praise: praiseIndex.length },
  };
}

module.exports = {
  SONG_SLOTS,
  indexHymns,
  indexPraise,
  matchHymn,
  matchPraise,
  findSong,
  resolveSongs,
  normalize,
};
