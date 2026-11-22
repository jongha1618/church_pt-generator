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

/**
 * The Korean service name from the masthead sitting just above the order of
 * worship — "주일 예배", "2026 추수감사주일". The English half may be one line
 * ("(Sunday Worship Service)") or two ("(Thanksgiving Sunday" / "Worship
 * Service)"), so we take the last Hangul-only line before it and ignore the
 * service-time lines ("2부: 11:00 AM"). Falls back to the configured default.
 */
function parseServiceTitle(rawText, orderStart) {
  const from = orderStart > 0 ? Math.max(0, orderStart - 400) : 0;
  let window = rawText.slice(from, orderStart > 0 ? orderStart : undefined);
  const eng = window.search(/Worship\s*Service/i);
  if (eng > 0) window = window.slice(0, eng);

  const lines = window.split("\n").map((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!/[가-힣]/.test(l)) continue;
    if (/[:：]|\d\s*[AaPp]\.?[Mm]/.test(l)) continue; // "2부: 11:00 AM", "사회:"
    if (/^[0-9]{0,4}\s*[가-힣][가-힣\s0-9]{0,14}$/.test(l)) return l.replace(/\s+/g, " ");
  }
  return "";
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
/**
 * Locate the order of worship inside the extracted text.
 *
 * It used to be anchored on "예배로의 부름", but the 절기 bulletins
 * (추수감사주일, 성탄주일 …) print a different order that drops that line
 * entirely. What every bulletin does have is a run of bulleted lines ending at
 * the standing note / EMC111 block, so we find that end and walk back over the
 * run. Blank and indented lines (wrapped song lists, the masthead's 사회 lines)
 * are stepped over; the masthead itself stops the walk.
 */
function orderBlock(rawText) {
  let end = rawText.search(/\(\s*\*\s*는\s*일어서서|EMC111/);
  if (end < 0) end = rawText.length;
  const head = rawText.slice(0, end);

  // "Worship Service" also shows up in 이달의 행사 ("…End Of Year Worship
  // Service"), so the masthead is the LAST one before the standing note.
  let anchor = -1;
  const mast = /Worship\s*Service/gi;
  let m;
  while ((m = mast.exec(head))) anchor = m.index;
  if (anchor < 0) {
    const call = /(^|\n)\s*[*\-•]?\s*예배로의\s*부름/.exec(head);
    anchor = call ? call.index : 0;
  }

  // The order begins at the first bulleted line below the masthead. Its own
  // lines are not all indented, so the block simply runs to the standing note.
  const rel = head.slice(anchor).search(/(^|\n)\s*[*\-•]\s*[가-힣]/);
  if (rel < 0) return { text: "", start: -1 };
  let start = anchor + rel;
  if (head[start] === "\n") start += 1;

  const text = head.slice(start);
  // Every service ends with a benediction; without one we grabbed the wrong run.
  if (!/축도|성경\s*봉독|헌금\s*기도/.test(text)) return { text: "", start: -1 };
  return { text, start };
}

function parseOrderFrom(block) {
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
      // Labels are sometimes letter-spaced in the PDF ("말 씀", "찬 송"), so
      // matching runs against the space-free form.
      key: label.replace(/\s+/g, ""),
      gloss,
      body: [head, rest].filter((s) => s && s.trim()).join("\n"),
      raw: lines.join("\n"),
    };
  });
}

function parseOrder(rawText) {
  return parseOrderFrom(orderBlock(rawText).text);
}

function findEntry(entries, labelRe, glossRe) {
  return (
    entries.find((e) => labelRe.test(e.key) && (!glossRe || glossRe.test(e.gloss))) || null
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

/**
 * Some Sundays run the two services differently — their own preacher, passage
 * and benediction ("말씀: 1부: … / 2부: …"). The deck follows the 11:00AM 2부,
 * so take that half when a body splits; otherwise the body stands as it is.
 * Returns "" for `split` when there was nothing to split.
 */
function servicePart(body) {
  const p = partsOf(body);
  const split = p["2"] || p["1"] || "";
  return { split, text: split || String(body || "") };
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

// Some weeks name who leads instead of what is sung — "찬양과 경배 / 찬양팀",
// "특별찬양 / 연합성가대". Those are performers, never song files to insert.
const PERFORMER = new RegExp(
  `^(?:찬양팀|워십팀|워십|찬양대|성가대|연합성가대|[가-힣]*중창단|[가-힣]*찬양단|` +
    `다같이|인도자|회중|전교인|[가-힣]{1,4}(?:\\s[가-힣]{1,4}){0,2}\\s*(?:${TITLES}))$`
);

/** A comma separated song list → [{num,title}]. */
function parseSongList(body) {
  return String(body || "")
    .replace(/\n/g, " ")
    .split(/\s*[,、]\s*/)
    .map(parseSongItem)
    .filter((x) => x && x.title.length > 1 && !PERFORMER.test(x.title));
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
  const e =
    findEntry(entries, /^성가대/) || findEntry(entries, /^특송/) || findEntry(entries, /^특별찬양/);
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
    let cell = cells[0] || lines[0].trim();
    // A cell that is not a person's name can wrap onto the next line
    // ("추수감사" / "만찬"); stitch the two halves back together.
    if (cells.length <= 1 && !personIn(cell) && lines[1]) {
      const next = lines[1].split(/\s{2,}/).map((c) => c.trim()).filter(Boolean);
      if (next.length === 1 && !personIn(next[0])) cell = `${cell} ${next[0]}`.trim();
    }
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
  // Scope to the 교회소식 block: from the welcome notice up to "* 이달의 행사"
  // (events, not weekly notices). The notice marker is a dash most weeks and a
  // number on 절기 bulletins, so accept either when locating the start.
  const endIdx = rawText.search(/[*]?\s*이달의\s*행사/);
  let startIdx = rawText.search(/(?:^|\n)\s*(?:[-•·]|\d+\s*[.)])\s*오늘\s*예배/);
  if (startIdx < 0) {
    // No welcome line: fall back to the first marked line after 봉사위원.
    const after = rawText.search(/봉사\s*위원/);
    if (after >= 0) {
      const rel = rawText.slice(after, endIdx > after ? endIdx : undefined).search(/\n\s*(?:[-•·]|\d+\s*[.)])\s*[가-힣]/);
      if (rel >= 0) startIdx = after + rel;
    }
  }
  let scope = rawText;
  if (startIdx >= 0) scope = rawText.slice(startIdx, endIdx > startIdx ? endIdx : startIdx + 3000);

  const lines = scope.split(/\n/);
  // 절기 bulletins number their notices ("1. …") and print an English rendering
  // under each one. Follow whichever marker this bulletin actually uses, so a
  // numbered notice's own sub-points are not torn out as separate notices.
  const numbered = lines.filter((l) => /^\s*\d+\s*[.)]\s*\S/.test(l)).length >= 3;
  const marker = numbered ? /^\d+\s*[.)]\s*/ : /^[-•·]\s*/;

  const items = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.trim()) items.push(cur.replace(/\s+/g, " ").trim());
    cur = null;
  };
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    if (!/[가-힣]/.test(t)) continue; // the English rendering — slides are Korean
    if (marker.test(t)) {
      flush();
      cur = t.replace(marker, "").trim();
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

  const order = orderBlock(rawText);
  const entries = parseOrderFrom(order.text);
  const sermonEntry = findEntry(entries, /^말씀/) || findEntry(entries, /^설교/);
  const scriptureEntry = findEntry(entries, /^성경봉독/);
  const prayerEntry = findEntry(entries, /^대표기도/);
  const benedictionEntry = findEntry(entries, /^축도/);
  const warnings = [];

  // "말씀 (Sermon): “다윗이 물려준 신앙유산” 김용배 목사" — the quoted part is the
  // title; whatever follows it is the preacher.
  let sermonTitle = "";
  let preacher = "";
  let sermonVerses = "";
  if (sermonEntry) {
    const sermonBody = servicePart(sermonEntry.body).text;
    const body = sermonBody.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
    const q = /[“"'‘]\s*([^”"'’]+?)\s*[”"'’]/.exec(body);
    if (q) {
      sermonTitle = q[1].trim();
      preacher = personIn(body.slice(q.index + q[0].length));
    } else {
      // Unquoted, as on 절기 bulletins: "말 씀(Scripture & Sermon) / 감사제
      // (시116:1-19)", with the English rendering on the line below. The title
      // is the first line, minus any passage printed after it.
      let line = sermonBody.split("\n")[0].trim();
      const ref = /[（(]\s*([^()]*\d[^()]*)\s*[)）]\s*$/.exec(line);
      if (ref && /[가-힣]/.test(ref[1])) {
        sermonVerses = normalizeScriptureRef(ref[1]);
        line = line.slice(0, ref.index).trim();
      }
      sermonTitle = stripQuotes(dropEnglishGloss(line).replace(/\s*[/·]\s*[^/·]*$/, "").trim());
      preacher = personIn(body);
    }
  }
  const benediction =
    (benedictionEntry && personIn(servicePart(benedictionEntry.body).text)) || "";
  if (!preacher) {
    // The bulletin omits the preacher on a normal week: he is the pastor named
    // in the masthead ("인도: 김형길 목사" / "사회: 김형길 목사"), and he also
    // gives the benediction. Scope to the masthead directly above the order —
    // "인도" also occurs in 교회소식 ("새벽기도회 인도-…"). The name often sits on
    // the line below the label, so the capture spans the line break.
    const head = order.start > 0 ? rawText.slice(Math.max(0, order.start - 400), order.start) : "";
    const masthead = /(?:인도|사회)\s*[:：]\s*([\s\S]{0,40})/.exec(head);
    const presider = masthead ? personIn(masthead[1]) : "";
    preacher = (/목사$/.test(presider) ? presider : "") || benediction;
  }

  const servers = parseServers(rawText);
  const songs = parseSongs(entries);

  // The verse slides normally follow 성경봉독, which on an ordinary week is the
  // sermon passage anyway. When the 말씀 line names its own passage and the two
  // disagree, the 성경봉독 line is usually last week's left over, so the sermon
  // passage wins — and the swap is reported so it can be checked.
  const readVerses = normalizeScriptureRef(
    servicePart(stripQuotes(scriptureEntry ? scriptureEntry.body : "")).text
  );
  const mainVerses = sermonVerses || readVerses;
  if (readVerses && sermonVerses && readVerses !== sermonVerses) {
    warnings.push(
      `성경봉독(${readVerses})과 말씀 본문(${sermonVerses})이 다릅니다 — 말씀 본문을 사용합니다`
    );
  }
  if (!entries.length) warnings.push("예배 순서를 찾지 못했습니다 — 아래 항목을 직접 채워주세요");
  if (!sermonTitle) warnings.push("설교 제목을 찾지 못했습니다");
  if (!mainVerses) warnings.push("성경 본문을 찾지 못했습니다");

  const service = {
    date: parseDate(text),
    serviceTitle: parseServiceTitle(rawText, order.start),
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
    mainVerses,
    specialPraise: parseChoir(entries),
    announcements: parseAnnouncements(rawText),
  };

  return {
    service,
    songs,
    warnings,
    rawText,
    hints: {
      hymnNumbers: parseHymnNumbers(text),
      sermonVerses,
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
