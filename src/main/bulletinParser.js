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
  const lines = rawText.split(/\n/).map((l) => l.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    // dash / bullet led, of reasonable length, containing Hangul
    if (/^[-•·]\s*/.test(line) && /[가-힣]/.test(line) && line.length > 6) {
      const t = line.replace(/^[-•·]\s*/, "").trim();
      // skip obvious non-announcements (worship-order labels)
      if (/^(대표기도|광고|찬양|찬송|성경봉독|말씀|축도|헌금|성가대)\b/.test(t)) continue;
      out.push(t);
    }
  }
  return out;
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

  // 성가대찬양: "2부: 성가대: 이제야 보이네" → special praise slot 2
  const choir2 = afterLabel(text, /성가대\s*찬양/);
  const specialPraise = [
    { title: "", singer: "" },
    { title: "", singer: "" },
    { title: "", singer: "" },
  ];
  const choirTitleMatch = /(?:2부[:：]?\s*)?성가대[:：]\s*([^\n\/]+)/.exec(text);
  if (choirTitleMatch) {
    specialPraise[2] = { title: stripQuotes(choirTitleMatch[1]), singer: "성가대" };
  }

  const service = {
    date: parseDate(text),
    sermonTitle,
    preacher: parsePreacher(text) || "김형길 목사",
    prayer: parsePrayer(text),
    benediction: parseBenediction(text) || "김형길 목사",
    mainVerses: normalizeScriptureRef(scriptureRaw),
    specialPraise,
    announcements: parseAnnouncements(rawText),
  };

  return {
    service,
    rawText,
    hints: {
      hymnNumbers: parseHymnNumbers(text),
      choir: choir2,
    },
  };
}

module.exports = { parseBulletin, normalizeScriptureRef, parseDate };
