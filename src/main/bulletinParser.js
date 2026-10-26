"use strict";

/**
 * bulletinParser.js — extracts the weekly fields from the 주보 PDF.
 *
 * PDF text extraction loses column structure, so the two printed tables (예배
 * 순서 and 봉사위원) are reconstructed heuristically. Everything is still shown
 * in an editable review form, but the goal is that a bulletin drop-in needs no
 * edits at all for a normal week.
 *
 * Two structures do most of the work:
 *   parseOrder()   the order of worship, split into labelled entries. Entries
 *                  carry 1부/2부 variants; the online deck uses 2부 (11:00AM).
 *   parseServers() the 4-column 봉사위원 table — column 1 is this Sunday.
 */

const fs = require("fs");

// Korean Bible book long-names → the canonical name we feed to bible.js. We keep
// the name as-is (bible.js matches against the version's own index.txt names),
// so this map is mostly for normalizing common abbreviations found in bulletins.
function normalizeScriptureRef(raw) {
  if (!raw) return "";
  let s = raw.replace(/\s+/g, " ").trim();
  // Drop a trailing English gloss: "에베소서5장20절(Ephesians 5:20)".
  s = s.replace(/\([^)]*[A-Za-z][^)]*\)\s*$/, "").trim();
  // "히브리서12장18-24" / "히브리서 12장 18-24절" / "히 12:18-24" → "히브리서 12:18-24"
  // Convert 장/편/절 markers to ':' — but only after a digit, so the 편 in the
  // book name 시편 survives.
  s = s.replace(/(\d)\s*[장편]\s*/g, "$1:").replace(/(\d)\s*절/g, "$1");
  // "요한복음 9장1-12장" (the bulletin's own typo for 12절) leaves a dangling ':'.
  s = s.replace(/::+/g, ":").replace(/[:\s]+$/, "");
  // Insert a space between a trailing Hangul book name and the first digit.
  s = s.replace(/([가-힣])\s*(\d)/, "$1 $2");
  // Collapse spaces around : and -
  s = s.replace(/\s*:\s*/g, ":").replace(/\s*-\s*/g, "-");
  return s.trim();
}

function collapse(text) {
  return text.replace(/[ \t ]+/g, " ").replace(/\r/g, "");
}

function stripQuotes(s) {
  return (s || "").replace(/^[\s"'“”‘’<>]+|[\s"'“”‘’<>]+$/g, "").trim();
}

// Drop "(Sermon)" / "(Elder Ko)" style English glosses, keeping Korean parens
// (song titles legitimately use them).
function dropEnglishGloss(s) {
  return String(s || "")
    .replace(/\([^)]*[A-Za-z][^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const TITLES = "안수집사|전도사|목사|장로|집사|권사|사모|성도|선교사";
// Role words that precede a title but are not part of anyone's name.
const NOT_A_NAME = /^(담임|부|협동|원로|인도자?|사회자?|전체|모든)$/;

// A person as printed in the bulletin — "전홍욱 안수집사", "월터 리 목사".
// The name group is lazy so "전홍욱 안수집사" does not come out as
// "전홍욱 안수" + "집사". Only apply to text already scoped to one field;
// on free text it over-captures.
function personIn(s) {
  const re = new RegExp(`([가-힣]{1,4}(?:\\s[가-힣]{1,4}){0,2}?)\\s*(${TITLES})`, "g");
  const text = dropEnglishGloss(s);
  let m;
  while ((m = re.exec(text))) {
    const name = m[1].replace(/\s+/g, " ").trim();
    if (!NOT_A_NAME.test(name)) return `${name} ${m[2]}`;
  }
  return "";
}

function isoDate(y, mo, d) {
  return `${y}-${String(+mo).padStart(2, "0")}-${String(+d).padStart(2, "0")}`;
}

/**
 * The bulletin contains several dates (cell meetings, events, the 성경통독 range
 * "2025년11월15일-2026년11월15일", ...). The authoritative service date is the one
 * printed with the volume/issue header, e.g. "제45권 32호  2026. 8. 9". We prefer
 * that, and otherwise skip any date that is part of a range (touching '-'/'~').
 */
function parseDate(text) {
  // 1) Highest priority: date right after the 권/호 header.
  let m = /제\s*\d+\s*권\s*\d+\s*호[^0-9]{0,6}(\d{4})\s*\.\s*(\d{1,2})\s*\.\s*(\d{1,2})/.exec(text);
  if (m) return isoDate(m[1], m[2], m[3]);

  // 2) "YYYY. M. D" not adjacent to a range marker.
  const dotRe = /(?<![\d.~-])(\d{4})\s*\.\s*(\d{1,2})\s*\.\s*(\d{1,2})(?!\s*[-~])/g;
  let best = dotRe.exec(text);
  if (best) return isoDate(best[1], best[2], best[3]);

  // 3) "YYYY년 M월 D일" not adjacent to a range marker.
  const korRe = /(?<![\d~-])(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일(?!\s*[-~])/g;
  best = korRe.exec(text);
  if (best) return isoDate(best[1], best[2], best[3]);

  return "";
}

// The masthead above "(Sunday Worship Service)", e.g. "주일 예배",
// "2026 추수감사주일". Falls back to the configured default.
function parseServiceTitle(rawText) {
  const m = /\n\s*([0-9]{0,4}\s*[가-힣][가-힣\s]{1,14}?)\s*\n\s*\(\s*Sunday Worship Service/i.exec(rawText);
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

// ---------------------------------------------------------------------------
// Order of worship
// ---------------------------------------------------------------------------

/**
 * Slice the printed 예배 순서 and split it into labelled entries.
 *
 * A new entry starts on a line whose first non-space character is a bullet
 * ('*' for congregation-standing items, '-' otherwise); everything else is a
 * continuation (wrapped song lists, the 1부/2부 sub-lines).
 *
 * Each entry: { label, gloss, body, raw }
 *   label  Korean label with the English gloss removed ("찬양과 경배")
 *   gloss  the English gloss, which disambiguates 찬양과 경배 / 찬양 ("Closing Hymn")
 *   body   everything after the label's ':' or '/', continuations appended
 */
function parseOrder(rawText) {
  const start = rawText.search(/[*\-•]?\s*예배로의\s*부름/);
  if (start < 0) return [];
  let block = rawText.slice(start);
  const end = block.search(/\(\s*\*\s*는\s*일어서서|EMC111/);
  if (end > 0) block = block.slice(0, end);

  const chunks = [];
  for (const line of block.split(/\n/)) {
    if (/^\s*[*\-•]\s*[가-힣]/.test(line) || !chunks.length) chunks.push([line]);
    else chunks[chunks.length - 1].push(line);
  }

  return chunks.map((lines) => {
    const first = lines[0].replace(/^\s*[*\-•]\s*/, "");
    const rest = lines.slice(1).join("\n");
    // Split the label off at the first ':' / '/' that follows the Korean label
    // (the English gloss in parentheses may itself contain neither).
    const m = /^([^:：/]*?)\s*(?:\(([^)]*)\))?\s*[:：/]\s*([\s\S]*)$/.exec(first);
    const label = m ? m[1].trim() : first.trim();
    const gloss = m && m[2] ? m[2].trim() : "";
    const head = m ? m[3] : "";
    return {
      label: label.replace(/\s+/g, " "),
      gloss,
      body: [head, rest].filter((s) => s && s.trim()).join("\n"),
      raw: lines.join("\n"),
    };
  });
}

function findEntry(entries, labelRe, glossRe) {
  return (
    entries.find((e) => labelRe.test(e.label) && (!glossRe || glossRe.test(e.gloss))) || null
  );
}

/**
 * Split an entry body into its 1부 / 2부 variants. Returns { "1":…, "2":…, all }
 * — `all` is the whole body, used when the bulletin lists no per-service split.
 */
function partsOf(body) {
  const t = String(body || "").replace(/\n/g, " ").replace(/\s+/g, " ").trim();
  const re = /([12])\s*부\s*[:：]?\s*/g;
  const hits = [];
  let m;
  while ((m = re.exec(t))) hits.push(m);
  const out = { all: t };
  hits.forEach((h, i) => {
    const s = h.index + h[0].length;
    const e = i + 1 < hits.length ? hits[i + 1].index : t.length;
    out[h[1]] = t.slice(s, e).trim();
  });
  return out;
}


// "찬 48장. 만유의 주재" → {num:48, title:"만유의 주재"};  plain titles → {title}
function parseSongItem(raw) {
  // "(후렴) 온 맘 다해" / "하나님 아버지의 마음(후렴)" — the 후렴 note is not
  // part of the title.
  let s = dropEnglishGloss(raw)
    .replace(/[(（]\s*후렴\s*[)）]/g, " ")
    .replace(/^[\s.,·/]+|[\s.,·/]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return null;
  const m = /^찬(?:송가)?\s*(\d{1,3})\s*장\s*[.·]?\s*(.*)$/.exec(s);
  if (m) return { num: parseInt(m[1], 10), title: m[2].trim() };
  return { num: null, title: s };
}

/** A comma/slash separated song list → [{num,title}]. */
function parseSongList(body) {
  return String(body || "")
    .replace(/\n/g, " ")
    .split(/\s*[,、]\s*/)
    .map(parseSongItem)
    .filter((x) => x && x.title.length > 1);
}

/**
 * Split one entry's songs into the 1부 (8:30AM) and 2부 (11:00AM) columns.
 * When the bulletin prints no split, the songs come back under `shared`.
 */
function partSongs(entry) {
  if (!entry) return { 1: [], 2: [], shared: [] };
  const p = partsOf(entry.body);
  if (p["1"] || p["2"]) return { 1: parseSongList(p["1"]), 2: parseSongList(p["2"]), shared: [] };
  return { 1: [], 2: [], shared: parseSongList(p.all) };
}

/**
 * The song files to insert, bucketed by the template's anchor markers. The deck
 * serves both services, so the 1부 and 2부 blocks are filled independently
 * (MK_praise_worship1/2, MK_closing_hymn1/2). 찬송 (Hymn) and 성찬식 share a
 * single anchor, so an unsplit list goes there as-is.
 */
function parseSongs(entries) {
  const pw = findEntry(entries, /^찬양과\s*경배/);
  const hymn = findEntry(entries, /^찬송$/) || findEntry(entries, /^찬송/, /Hymn/i);
  const closing =
    findEntry(entries, /^찬양$/, /Closing/i) ||
    entries.find((e) => /^찬양$/.test(e.label) && e !== pw);
  const communion = findEntry(entries, /^성찬식/);

  const pwP = partSongs(pw);
  const clP = partSongs(closing);
  const hyP = partSongs(hymn);

  return {
    praiseWorship1: pwP[1],
    praiseWorship2: pwP[2].length ? pwP[2] : pwP.shared,
    openingHymn: hyP.shared.length ? hyP.shared : hyP[2].length ? hyP[2] : hyP[1],
    closingHymn1: clP[1],
    closingHymn2: clP[2].length ? clP[2] : clP.shared,
    communion: communion ? parseSongList(communion.body) : [],
  };
}

/**
 * 성가대/특송: "1부:남성중창단(Men's Choir)  2부:성가대(Choir): 주 안에 있는 나에게"
 * → 3 template slots; slot0 = 1부, slot2 = 2부 (matches special_praise0/2).
 */
function parseChoir(entries) {
  const slots = [
    { title: "", singer: "" },
    { title: "", singer: "" },
    { title: "", singer: "" },
  ];
  const e = findEntry(entries, /^성가대/) || findEntry(entries, /^특송/);
  if (!e) return slots;
  const parts = partsOf(e.body);

  const parseOne = (frag) => {
    const f = dropEnglishGloss(frag).replace(/[’']/g, "'").replace(/[-*·/]+\s*$/g, "").trim();
    if (!f) return { title: "", singer: "" };
    const mm = /^(.*?)\s*[:：]\s*(.+)$/.exec(f); // "성가대 : 주 안에 있는 나에게"
    if (mm && mm[2]) return { singer: mm[1].trim(), title: mm[2].trim() };
    return { singer: f, title: "" }; // team only, e.g. 남성중창단
  };

  slots[0] = parseOne(parts["1"] || "");
  slots[2] = parseOne(parts["2"] || (parts["1"] ? "" : parts.all));
  return slots;
}

// ---------------------------------------------------------------------------
// 봉사위원 (this week's servers)
// ---------------------------------------------------------------------------

/**
 * The table has 4 date columns (this Sunday + the next 3). PDF extraction
 * flattens it, so we take column 1:
 *  - per-week rows (대표기도/친교음식/헌화) list 4 cells; cells are separated by
 *    runs of 2+ spaces, and long cells wrap onto their own lines.
 *  - month-wide rows (헌금위원/친교분배/안내위원/교회청소) print one value, plus
 *    sometimes a "11월 …" line for next month — which we drop.
 */
function parseServers(rawText) {
  const res = { prayer: "", lunch: "", serving: "", flower: "", offering: "", guide: "", cleaning: "" };
  const start = rawText.search(/봉사\s*위원/);
  if (start < 0) return res;
  let block = rawText.slice(start);
  const end = block.search(/-\s*오늘\s*예배|이달의\s*행사|예배\s*시간\s*안내/);
  if (end > 0) block = block.slice(0, end);

  // Longest first: "친교분배" must win over the bare "친교" fallback.
  const LABELS = ["대표기도", "친교음식", "친교분배", "헌금위원", "안내위원", "교회청소", "헌화", "친교"].sort(
    (a, b) => b.length - a.length
  );
  const labelAt = (line) => LABELS.find((lb) => line.replace(/^\s+/, "").startsWith(lb)) || null;

  // label → the lines that belong to its row (first line keeps same-line value).
  const rows = new Map();
  let cur = null;
  for (const raw of block.split(/\n/)) {
    if (!raw.trim()) continue;
    const lb = labelAt(raw);
    if (lb) {
      cur = lb;
      if (!rows.has(cur)) rows.set(cur, []);
      rows.get(cur).push(raw.replace(/^\s*/, "").slice(lb.length));
    } else if (cur) {
      rows.get(cur).push(raw);
    }
  }

  // Next-month overrides ("11월 1부: …") are not this week's.
  const thisMonthLines = (lb) =>
    (rows.get(lb) || []).filter((l) => l.trim() && !/^\s*\d{1,2}\s*월/.test(l));

  // Column 1 of a per-week row: first non-empty cell of the first value line.
  const firstCell = (lb) => {
    const lines = thisMonthLines(lb);
    if (!lines.length) return "";
    const cells = lines[0].split(/\s{2,}/).map((c) => c.trim()).filter(Boolean);
    const cell = cells[0] || lines[0].trim();
    return personIn(cell) || cell;
  };

  // Month-wide rows are taken verbatim (they read "1부: … / 2부: …").
  const wholeCell = (lb) => {
    const lines = thisMonthLines(lb);
    return lines.length ? lines[0].replace(/\s+/g, " ").trim() : "";
  };

  res.prayer = firstCell("대표기도");
  res.lunch = firstCell("친교음식") || firstCell("친교");
  res.flower = firstCell("헌화");
  res.offering = wholeCell("헌금위원");
  res.serving = wholeCell("친교분배");
  res.guide = wholeCell("안내위원");
  res.cleaning = wholeCell("교회청소");
  return res;
}

// ---------------------------------------------------------------------------
// 교회소식 (announcements)
// ---------------------------------------------------------------------------

// Announcements: the 교회소식 block lists items, in the bulletin usually as
// dash-led lines. We collect plausible announcement lines and let the user prune.
function parseAnnouncements(rawText) {
  // Scope to the 교회소식 announcement block: from the first "- 오늘 예배에 참석…"
  // bullet up to "* 이달의 행사" (which lists events, not weekly announcements).
  const startIdx = rawText.search(/-\s*오늘\s*예배/);
  const endIdx = rawText.search(/[*]?\s*이달의\s*행사/);
  let scope = rawText;
  if (startIdx >= 0) scope = rawText.slice(startIdx, endIdx > startIdx ? endIdx : startIdx + 3000);

  const lines = scope.split(/\n/);
  const items = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.trim()) items.push(cur.replace(/\s+/g, " ").trim());
    cur = null;
  };
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    if (/^[-•·]\s*/.test(t)) {
      flush();
      cur = t.replace(/^[-•·]\s*/, "").trim();
    } else if (cur !== null) {
      cur += " " + t; // wrapped continuation line
    }
  }
  flush();

  return items.filter(
    (t) =>
      /[가-힣]/.test(t) &&
      t.length > 6 &&
      !/^(대표기도|광고|찬양|찬송|성경봉독|말씀|축도|헌금기도|성가대|헌금위원|친교|안내위원|교회청소)\b/.test(t)
  );
}

// Hymn numbers referenced in the order of worship (찬 38장 / 찬송가 183장).
function parseHymnNumbers(text) {
  const nums = [];
  const re = /찬(?:송가)?\s*(\d{1,3})\s*장/g;
  let m;
  while ((m = re.exec(text))) nums.push(+m[1]);
  return Array.from(new Set(nums));
}

// ---------------------------------------------------------------------------

async function parseBulletin(pdfPath, opts = {}) {
  const defaultPastor = opts.defaultPastor || "김형길 목사";

  const pdfParse = require("pdf-parse");
  const buffer = fs.readFileSync(pdfPath);
  const data = await pdfParse(buffer);
  const rawText = data.text || "";
  const text = collapse(rawText);

  const entries = parseOrder(rawText);
  const sermonEntry = findEntry(entries, /^말씀/) || findEntry(entries, /^설교/);
  const scriptureEntry = findEntry(entries, /^성경\s*봉독/);
  const prayerEntry = findEntry(entries, /^대표\s*기도/);
  const benedictionEntry = findEntry(entries, /^축도/);

  // "말씀 (Sermon): “다윗이 물려준 신앙유산” 김용배 목사" — the quoted part is the
  // title; whatever follows it is the preacher.
  let sermonTitle = "";
  let preacher = "";
  if (sermonEntry) {
    const body = sermonEntry.body.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
    const q = /[“"'‘]\s*([^”"'’]+?)\s*[”"'’]/.exec(body);
    if (q) {
      sermonTitle = q[1].trim();
      preacher = personIn(body.slice(q.index + q[0].length));
    } else {
      sermonTitle = stripQuotes(dropEnglishGloss(body).replace(/[/·]\s*[^/]*$/, ""));
      preacher = personIn(body);
    }
  }
  const benediction = (benedictionEntry && personIn(benedictionEntry.body)) || "";
  if (!preacher) {
    // The bulletin omits the preacher on a normal week: he is the presider named
    // in the masthead ("인도: 김형길 목사") and he also gives the benediction.
    // Scope to the masthead — "인도" also occurs in 교회소식 ("새벽기도회 인도-…").
    const head = /\(\s*Sunday Worship Service[\s\S]{0,200}?예배로의\s*부름/i.exec(rawText);
    const masthead = head && /(?:인도|사회)\s*[:：]\s*([^\n]{0,24})/.exec(head[0]);
    preacher = (masthead && personIn(masthead[1])) || benediction;
  }

  const servers = parseServers(rawText);
  const songs = parseSongs(entries);

  const service = {
    date: parseDate(text),
    serviceTitle: parseServiceTitle(rawText),
    sermonTitle,
    preacher: preacher || defaultPastor,
    prayer: (prayerEntry && personIn(prayerEntry.body)) || servers.prayer,
    benediction: benediction || defaultPastor,
    lunch: servers.lunch,
    serving: servers.serving,
    flower: servers.flower,
    offering: servers.offering,
    guide: servers.guide,
    cleaning: servers.cleaning,
    mainVerses: normalizeScriptureRef(stripQuotes(scriptureEntry ? scriptureEntry.body : "")),
    specialPraise: parseChoir(entries),
    announcements: parseAnnouncements(rawText),
  };

  return {
    service,
    songs,
    rawText,
    hints: {
      hymnNumbers: parseHymnNumbers(text),
      order: entries.map((e) => ({ label: e.label, gloss: e.gloss, body: e.body })),
    },
  };
}

module.exports = {
  parseBulletin,
  normalizeScriptureRef,
  parseDate,
  parseOrder,
  parseSongs,
  parseChoir,
  parseServers,
  parseAnnouncements,
  parseServiceTitle,
};
