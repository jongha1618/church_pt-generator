"use strict";

/**
 * osz.js - Pure-Node reimplementation of the Python OpenLP service + OpenLyrics
 * engine (hymn/openlpservice.py + hymn/openlyrics.py).
 *
 * Writes OpenLP service files (.osz) and reads/writes OpenLyrics song XML.
 *
 * Data model
 * ----------
 * A "song" is { title, verses }.
 *   verses : Array of verses.
 *   verse  : Array of lines.
 *   line   : either a plain string, or { text, optionalBreak:true }.
 */

const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");

// Deterministic modifiedDate — the engine's real value is not meaningful.
const MODIFIED_DATE = "2020-01-01T00:00:00";
const APP_ID = "church-ppt-generator";
const NS = "http://openlyrics.info/namespace/2009/song";

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

/** XML entity escaping for text content / attribute values (& < >). */
function xmlEscape(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Reverse of the entity escaping done by writers (also handles quotes). */
function xmlUnescape(s) {
  return String(s == null ? "" : s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#34;/g, '"')
    .replace(/&amp;/g, "&");
}

/** Normalize a single line into { text, optionalBreak }. */
function normalizeLine(line) {
  if (line == null) return { text: "", optionalBreak: false };
  if (typeof line === "string") return { text: line, optionalBreak: false };
  return {
    text: line.text == null ? "" : String(line.text),
    optionalBreak: !!line.optionalBreak,
  };
}

/**
 * Normalize a verses input into an array of { name, lines:[{text,optionalBreak}] }.
 * Accepts:
 *   - verse as array of lines
 *   - verse as object { name?, lines:[...] }
 * Names default to v1, v2, ... when not supplied.
 */
function normalizeVerses(verses) {
  const list = Array.isArray(verses) ? verses : [];
  return list.map((verse, i) => {
    let name = null;
    let lines = verse;
    if (verse && !Array.isArray(verse) && typeof verse === "object") {
      name = verse.name != null ? String(verse.name) : null;
      lines = verse.lines;
    }
    const normLines = (Array.isArray(lines) ? lines : []).map(normalizeLine);
    return { name: name || `v${i + 1}`, lines: normLines };
  });
}

/**
 * Join a verse's lines into a raw_slide string: lines joined by "\n", with
 * "\n[---]" appended after any line flagged optionalBreak.
 * (Mirrors merge_lines() in openlpservice.py.)
 */
function mergeLines(lines) {
  let text = "";
  for (const l of lines) {
    if (text) text += "\n";
    text += l.text;
    if (l.optionalBreak) text += "\n[---]";
  }
  return text;
}

// --------------------------------------------------------------------------
// OpenLyrics XML writer
// --------------------------------------------------------------------------

/**
 * Build an OpenLyrics <song> XML document (multi-line / pretty).
 * @param {{title:string, verses:Array}} song
 * @returns {string}
 */
function buildOpenLyricsXml({ title, verses }) {
  const norm = normalizeVerses(verses);
  const lines = [];
  lines.push('<?xml version="1.0" encoding="utf-8"?>');
  lines.push(
    `<song xmlns="${NS}" version="0.8" createdIn="${APP_ID}" modifiedIn="${APP_ID}" modifiedDate="${MODIFIED_DATE}">`
  );
  lines.push(" <properties>");
  lines.push(`  <titles><title>${xmlEscape(title)}</title></titles>`);
  lines.push(" </properties>");
  lines.push(" <lyrics>");
  for (const verse of norm) {
    let inner = "";
    for (const l of verse.lines) {
      const brk = l.optionalBreak ? ' break="optional"' : "";
      inner += `<lines${brk}>${xmlEscape(l.text)}</lines>`;
    }
    lines.push(`  <verse name="${xmlEscape(verse.name)}">${inner}</verse>`);
  }
  lines.push(" </lyrics>");
  lines.push("</song>");
  return lines.join("\n");
}

// --------------------------------------------------------------------------
// OpenLyrics XML reader
// --------------------------------------------------------------------------

/**
 * Read a sibling OpenLyrics .xml file.
 * @param {string} xmlPath
 * @returns {{title:string, verses:Array<Array<{text:string,optionalBreak:boolean}>>}|null}
 *          null if the file is missing or unparseable.
 */
function readSongXml(xmlPath) {
  let xml;
  try {
    xml = fs.readFileSync(xmlPath, "utf8");
  } catch (e) {
    return null;
  }
  if (!xml || xml.indexOf("<song") === -1) return null;

  try {
    // Title: first <title>...</title>
    let title = "";
    const titleMatch = xml.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch) title = xmlUnescape(titleMatch[1].trim());

    // Restrict to the <lyrics> section if present.
    let lyrics = xml;
    const lyricsMatch = xml.match(/<lyrics\b[^>]*>([\s\S]*?)<\/lyrics>/i);
    if (lyricsMatch) lyrics = lyricsMatch[1];

    const verses = [];
    const verseRe = /<verse\b[^>]*>([\s\S]*?)<\/verse>/gi;
    let vm;
    while ((vm = verseRe.exec(lyrics)) !== null) {
      const verseBody = vm[1];
      const verseLines = [];
      const linesRe = /<lines\b([^>]*)>([\s\S]*?)<\/lines>/gi;
      let lm;
      while ((lm = linesRe.exec(verseBody)) !== null) {
        const attrs = lm[1] || "";
        let raw = lm[2] || "";
        const optionalBreak = /\bbreak\s*=\s*["']optional["']/i.test(attrs);
        // <br/> (any form) becomes a newline.
        raw = raw.replace(/<br\s*\/?>/gi, "\n");
        // Strip any other tags.
        raw = raw.replace(/<[^>]+>/g, "");
        const text = xmlUnescape(raw);
        verseLines.push({ text, optionalBreak });
      }
      verses.push(verseLines);
    }

    if (verses.length === 0) return null;
    return { title, verses };
  } catch (e) {
    return null;
  }
}

// --------------------------------------------------------------------------
// OpenLP service item
// --------------------------------------------------------------------------

/**
 * Build a { serviceitem: { header, data } } object for one song.
 * (Mirrors serviceitem_from_file() in openlpservice.py.)
 * @param {{title:string, verses:Array}} song
 * @returns {object}
 */
function buildServiceItem({ title, verses }) {
  const norm = normalizeVerses(verses);
  const xmlVersion = buildOpenLyricsXml({ title, verses: norm })
    .replace(/\r?\n/g, ""); // strip newlines for header xml_version

  const header = {
    start_time: 0,
    search: "",
    icon: ":/plugins/plugin_songs.png",
    will_auto_start: false,
    footer: [`${title}`],
    auto_play_slides_loop: false,
    title: `${title}`,
    xml_version: xmlVersion,
    theme: null,
    from_plugin: false,
    data: { title: `${title} @` },
    media_length: 0,
    capabilities: [2, 1, 5, 8, 9, 13],
    processor: null,
    auto_play_slides_once: false,
    end_time: 0,
    audit: [`${title}`, [], "", ""],
    name: "songs",
    theme_overwritten: false,
    type: 1,
    background_audio: [],
    plugin: "songs",
    notes: "",
    timed_slide_interval: 0,
  };

  const data = norm.map((verse) => {
    const line0 = verse.lines.length > 0 ? verse.lines[0].text : "";
    return {
      verseTag: verse.name,
      title: line0,
      raw_slide: mergeLines(verse.lines),
    };
  });

  return { serviceitem: { header, data } };
}

// --------------------------------------------------------------------------
// .osz writer
// --------------------------------------------------------------------------

/**
 * Write an .osz service file.
 * @param {string} oszPath  target path (…/name.osz)
 * @param {Array<{title:string, verses:Array}>} songs
 * @returns {string} oszPath
 */
function writeOsz(oszPath, songs) {
  const list = [];
  list.push({ openlp_core: { "service-theme": "Transparent", "lite-service": false } });
  for (const song of songs || []) {
    list.push(buildServiceItem(song));
  }
  const json = JSON.stringify(list);

  // basename of the osz (without extension) + ".osj"
  const base = path.basename(oszPath, path.extname(oszPath));
  const osjName = base + ".osj";

  const dir = path.dirname(oszPath);
  if (dir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const zip = new AdmZip();
  zip.addFile(osjName, Buffer.from(json, "utf8"));
  zip.writeZip(oszPath);

  return oszPath;
}

module.exports = {
  buildOpenLyricsXml,
  readSongXml,
  buildServiceItem,
  writeOsz,
};

// --------------------------------------------------------------------------
// Self-test
// --------------------------------------------------------------------------

if (require.main === module) {
  const os = require("os");

  const songs = [];

  // Song 1: plain-text verses (mix of plain strings and {text,optionalBreak}).
  songs.push({
    title: "Test Hymn <A&B>",
    verses: [
      [
        { text: "Line one of verse 1", optionalBreak: true },
        "Line two of verse 1",
      ],
      ["Verse 2 line 1", "Verse 2 line 2"],
    ],
  });

  // Song 2: read from a real hymn xml if it exists, else skip.
  const hymnPath = "C:\\church\\찬송가\\001 - 만복의 근원 하나님.xml";
  let hymnParsed = false;
  const read = readSongXml(hymnPath);
  if (read) {
    hymnParsed = true;
    songs.push({ title: read.title, verses: read.verses });
    console.log(`readSongXml OK: title="${read.title}", verses=${read.verses.length}`);
    console.log("  first verse lines:", JSON.stringify(read.verses[0]));
  } else {
    console.log("readSongXml: real hymn .xml not found or unparseable — skipping song 2");
  }

  // Write .osz to scratchpad / temp dir.
  const outDir = path.join(os.tmpdir(), "osz_selftest");
  const oszPath = path.join(outDir, "2026-0808-selftest.osz");
  writeOsz(oszPath, songs);
  console.log(`\nwriteOsz -> ${oszPath}`);

  // Re-open and verify round-trip.
  const zip = new AdmZip(oszPath);
  const entries = zip.getEntries();
  console.log("zip entries:", entries.map((e) => e.entryName));

  const osjEntry = entries[0];
  console.log("osj entry name:", osjEntry.entryName);

  const parsed = JSON.parse(zip.readAsText(osjEntry));
  console.log("JSON.parse succeeded:", Array.isArray(parsed));
  console.log("element count:", parsed.length);

  const firstItem = parsed[1];
  console.log("first serviceitem header.title:", firstItem.serviceitem.header.title);
  console.log("first serviceitem data length:", firstItem.serviceitem.data.length);
  console.log("first serviceitem data[0]:", JSON.stringify(firstItem.serviceitem.data[0]));

  console.log("\nreal hymn .xml parsed:", hymnParsed);
}
