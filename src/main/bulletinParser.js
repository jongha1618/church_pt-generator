"use strict";

/**
 * bulletinParser.js — best-effort extraction of weekly fields from the 주보 PDF.
 *
 * PDF text extraction loses most spacing/column structure, so every field here
 * is a heuristic guess. The renderer always shows an editable review form
 * (pre-filled with these guesses) plus the raw extracted text for reference, so
 * imperfect parsing is expected and safe — the human confirms before generating.
 */

const fs = require("fs");

// Korean Bible book long-names → the canonical name we feed to bible.js. We keep
// the name as-is (bible.js matches against the version's own index.txt names),
// so this map is mostly for normalizing common abbreviations found in bulletins.
function normalizeScriptureRef(raw) {
  if (!raw) return "";
  let s = raw.replace(/\s+/g, " ").trim();
  // "히브리서12장18-24" / "히브리서 12장 18-24절" / "히 12:18-24" → "히브리서 12:18-24"
  // Convert 장/절 markers to :  and collapse.
  s = s.replace(/\s*장\s*/g, ":").replace(/\s*편\s*/g, ":").replace(/\s*절\s*/g, "");
  // Insert a space between a trailing Hangul book name and the first digit.
  s = s.replace(/([가-힣])\s*(\d)/, "$1 $2");
  // Collapse spaces around : and -
  s = s.replace(/\s*:\s*/g, ":").replace(/\s*-\s*/g, "-");
  return s.trim();
}

function collapse(text) {
  return text.replace(/[ \t ]+/g, " ").replace(/\r/g, "");
}

// Grab the value after a Korean label up to end-of-line. Tolerant of the English
// gloss + punctuation the bulletin uses, e.g. "말씀(Sermon): "시내산과 시온산"".
function afterLabel(text, labelRegex) {
  const re = new RegExp(labelRegex.source + String.raw`\s*(?:\([^)]*\))?\s*[:：\/]?\s*([^\n]+)`, labelRegex.flags);
  const m = re.exec(text);
  return m ? m[1].trim() : "";
}

function stripQuotes(s) {
  return (s || "").replace(/^[\s"'“”‘’<>()]+|[\s"'“”‘’<>()]+$/g, "").trim();
}

// Extract a "이름 직분" (name + title) — or "" if none is found. Returning ""
// (never the raw text) prevents unrelated text from leaking into {preacher} etc.
function personName(s) {
  const m = /([가-힣]{2,4})\s*(목사|장로|집사|권사|전도사|사모|안수집사|성도)/.exec(s || "");
  return m ? `${m[1]} ${m[2]}` : "";
}

// Preacher: prefer the worship-order "인도: <이름> 목사"; else the first "<이름> 목사"
// in the bulletin; else "" (caller applies the default pastor).
function parsePreacher(text) {
  let m = /인도\s*[:：]\s*([가-힣]{2,4})\s*목사/.exec(text);
  if (m) return `${m[1]} 목사`;
  m = /([가-힣]{2,4})\s*목사/.exec(text);
  return m ? `${m[1]} 목사` : "";
}

function parseBenediction(text) {
  const m = /축도[^\n]{0,20}?([가-힣]{2,4})\s*목사/.exec(text);
  return m ? `${m[1]} 목사` : "";
}

function parsePrayer(text) {
  const m = /대표\s*기도[^\n]{0,20}?([가-힣]{2,4})\s*(장로|목사|집사|권사|전도사|안수집사|성도)/.exec(text);
  return m ? `${m[1]} ${m[2]}` : "";
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

// 성가대/특송 찬양: e.g. "성가대찬양(Choir): 1부:남성중창단(Men's Choir) 2부:성가대(Choir): 이제야 보이네"
// → up to 3 slots [{title,singer}]: slot0 = 1부, slot2 = 2부 (matches template special_praise0/2).
function parseChoir(text) {
  const slots = [
    { title: "", singer: "" },
    { title: "", singer: "" },
    { title: "", singer: "" },
  ];
  const start = text.search(/성가대\s*찬양/);
  if (start < 0) return slots;
  let scope = text.slice(start, start + 240).replace(/\n/g, " ");
  const stop = scope.search(/성경\s*봉독|성경봉독|말씀\s*[(:：]/);
  if (stop > 0) scope = scope.slice(0, stop);

  const clean = (s) =>
    (s || "")
      .replace(/\([^)]*\)/g, " ") // drop (Choir)/(Men's Choir) glosses
      .replace(/[’']/g, "'")
      .replace(/[-*·/]+\s*$/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const parseOne = (frag) => {
    const f = clean(frag);
    if (!f) return { title: "", singer: "" };
    const mm = /^(.*?)\s*[:：]\s*(.+)$/.exec(f); // "성가대 : 이제야 보이네"
    if (mm && mm[2]) return { singer: mm[1].trim(), title: mm[2].trim() };
    return { singer: f, title: "" }; // team only, e.g. 남성중창단
  };

  const parts = scope.split(/2\s*부\s*[:：]?/);
  const m1 = /1\s*부\s*[:：]?\s*(.*)$/.exec(parts[0] || "");
  slots[0] = parseOne(m1 ? m1[1] : "");
  slots[2] = parseOne(parts[1] || "");
  return slots;
}

// 봉사위원 (this-week servers table). The table has 4 date columns (this week +
// next 3); PDF extraction flattens it, so this is best-effort for THIS week only.
//  - 헌금위원/친교분배/안내위원/교회청소 usually span all weeks → value is on the
//    same line as the label (reliable).
//  - 대표기도/친교음식/헌화 vary per week → take the first name after the label.
function parseServers(rawText) {
  const res = { prayer: "", lunch: "", serving: "", flower: "", offering: "", guide: "", cleaning: "" };
  const start = rawText.search(/봉사\s*위원/);
  if (start < 0) return res;
  let block = rawText.slice(start, start + 1000);
  const end = block.search(/-\s*오늘\s*예배|이달의\s*행사|예배\s*시간\s*안내/);
  if (end > 0) block = block.slice(0, end);
  const lines = block.split(/\n/).map((l) => l.trim()).filter(Boolean);
  const labels = ["대표기도", "친교음식", "친교", "헌화", "헌금위원", "친교분배", "안내위원", "교회청소"];
  const nameRe = /[가-힣]{2,4}\s*(집사|권사|장로|목사|사모|전도사|안수집사|성도)/;
  const isLabel = (l) => labels.some((lb) => l.startsWith(lb));

  const sameLineValue = (label) => {
    const line = lines.find((l) => l.startsWith(label));
    if (!line) return "";
    return line.slice(label.length).replace(/^[:：\s]+/, "").trim();
  };
  const firstCellAfter = (label) => {
    const idx = lines.findIndex((l) => l.startsWith(label));
    if (idx < 0) return "";
    const same = lines[idx].slice(label.length).replace(/^[:：\s]+/, "").trim();
    if (same && (nameRe.test(same) || /^EM\b/.test(same))) {
      const m = nameRe.exec(same);
      return m ? same.slice(0, same.indexOf(m[0]) + m[0].length).trim() : same;
    }
    for (let i = idx + 1; i < lines.length; i++) {
      if (isLabel(lines[i])) break;
      if (nameRe.test(lines[i]) || /^EM$/.test(lines[i])) return lines[i];
    }
    return "";
  };

  res.prayer = firstCellAfter("대표기도");
  res.lunch = firstCellAfter("친교음식") || firstCellAfter("친교");
  res.flower = firstCellAfter("헌화");
  res.offering = sameLineValue("헌금위원");
  res.serving = sameLineValue("친교분배");
  res.guide = sameLineValue("안내위원");
  res.cleaning = sameLineValue("교회청소");
  return res;
}

// Hymn numbers referenced in the order of worship (찬 38장 / 찬송가 183장).
function parseHymnNumbers(text) {
  const nums = [];
  const re = /찬(?:송가)?\s*(\d{1,3})\s*장/g;
  let m;
  while ((m = re.exec(text))) nums.push(+m[1]);
  return Array.from(new Set(nums));
}

async function parseBulletin(pdfPath) {
  const pdfParse = require("pdf-parse");
  const buffer = fs.readFileSync(pdfPath);
  const data = await pdfParse(buffer);
  const rawText = data.text || "";
  const text = collapse(rawText);

  const sermonTitle = stripQuotes(afterLabel(text, /말씀/));
  const scriptureRaw = stripQuotes(afterLabel(text, /성경\s*봉독/));

  const specialPraise = parseChoir(text);
  const servers = parseServers(rawText);

  const service = {
    date: parseDate(text),
    sermonTitle,
    preacher: parsePreacher(text) || "김형길 목사",
    prayer: parsePrayer(text) || servers.prayer,
    benediction: parseBenediction(text) || "김형길 목사",
    lunch: servers.lunch,
    serving: servers.serving,
    flower: servers.flower,
    offering: servers.offering,
    guide: servers.guide,
    cleaning: servers.cleaning,
    mainVerses: normalizeScriptureRef(scriptureRaw),
    specialPraise,
    announcements: parseAnnouncements(rawText),
  };

  return {
    service,
    rawText,
    hints: {
      hymnNumbers: parseHymnNumbers(text),
    },
  };
}

module.exports = { parseBulletin, normalizeScriptureRef, parseDate, parseChoir, parseServers, parseAnnouncements };
