'use strict';

/**
 * bible.js - Pure-Node reimplementation of the church "MyBible" reader.
 *
 * Reads a MyBible text database (index.txt + book1..book66.txt) and resolves
 * scripture references bilingually. Semantics replicate the Python engine in
 * service_ppt-master/bible/{mybible,bibcore,biblang}.py.
 *
 * Only Node built-ins are used (fs, path, Buffer).
 */

const fs = require('fs');
const path = require('path');

const UNICODE_BOM = '﻿';
const REMOVE_CHARS = '○'; // '○'

// ---------------------------------------------------------------------------
// Encoding detection + decoding (BOM-driven, per-file)
// ---------------------------------------------------------------------------

/**
 * Read a file and decode it using its BOM.
 *   FF FE       => utf16le
 *   FE FF       => utf16be (byte-swap then utf16le)
 *   EF BB BF    => utf8
 *   (otherwise) => utf8
 * The leading BOM char (﻿) is stripped from the decoded string.
 */
function readDecodedFile(filePath) {
  const buf = fs.readFileSync(filePath);
  let text;

  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    // UTF-16 LE
    text = buf.toString('utf16le', 2);
  } else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16 BE: swap byte pairs then decode as LE
    const body = buf.subarray(2);
    const swapped = Buffer.from(body); // copy
    // Buffer.swap16 requires even length; guard it.
    if (swapped.length % 2 === 0) {
      swapped.swap16();
    }
    text = swapped.toString('utf16le');
  } else if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    // UTF-8 with BOM
    text = buf.toString('utf8', 3);
  } else {
    // default utf8 (no BOM)
    text = buf.toString('utf8');
  }

  // Strip a leading BOM char if the byte-level strip missed one.
  if (text.length > 0 && text[0] === UNICODE_BOM) {
    text = text.slice(1);
  }
  return text;
}

// ---------------------------------------------------------------------------
// index.txt parsing
// ---------------------------------------------------------------------------

function expectString(line, prefix) {
  if (line != null && line.startsWith(prefix)) {
    return line.slice(prefix.length).trim();
  }
  return null;
}

/**
 * loadIndex(bibleDir, version)
 *   -> { name, language, books:[{index,long,short}], nameToIndex:Map }
 * nameToIndex maps BOTH long and short names (all whitespace removed) -> index.
 */
function loadIndex(bibleDir, version) {
  const indexPath = path.join(bibleDir, version, 'index.txt');
  const text = readDecodedFile(indexPath);
  // Split on any newline flavour.
  const lines = text.split(/\r\n|\r|\n/);

  let ptr = 0;
  const nextLine = () => (ptr < lines.length ? lines[ptr++] : '');

  let line = nextLine().trim();
  if (line !== 'INDEX FILE') {
    throw new Error(`Not an index file: ${indexPath}`);
  }

  const name = expectString(nextLine(), 'NAME=');
  if (!name) {
    throw new Error(`Missing NAME= in ${indexPath}`);
  }

  const bookCountStr = expectString(nextLine(), 'BOOKCOUNT=');
  if (!bookCountStr) {
    throw new Error(`Missing BOOKCOUNT= in ${indexPath}`);
  }
  const bookCount = parseInt(bookCountStr, 10);

  // 4th line: either LANGUAGE= or the first BOOK=
  let usePreviousLine = false;
  line = nextLine();
  let language = expectString(line, 'LANGUAGE=');
  if (!language) {
    language = 'en';
    usePreviousLine = true; // the line we just read is actually the first BOOK=
  }

  const books = [];
  const nameToIndex = new Map();

  const stripAllWs = (s) => s.replace(/\s+/g, '');

  for (let b = 0; b < bookCount; b++) {
    if (usePreviousLine) {
      usePreviousLine = false;
    } else {
      line = nextLine();
    }

    const bookName = expectString(line, 'BOOK=');
    if (bookName == null) {
      throw new Error(`Missing BOOK= (book ${b}) in ${indexPath}`);
    }
    const parts = bookName.split(',');
    const longName = parts[0];
    const shortName = parts.length >= 2 ? parts[1] : parts[0];

    // CHAPTERS= line -- read and IGNORE the offsets entirely.
    const chapLine = nextLine();
    expectString(chapLine, 'CHAPTERS='); // presence not required for our purposes

    books.push({ index: b, long: longName, short: shortName });

    if (longName) nameToIndex.set(stripAllWs(longName), b);
    if (shortName) nameToIndex.set(stripAllWs(shortName), b);
  }

  return { name, language, books, nameToIndex };
}

// ---------------------------------------------------------------------------
// bookN.txt parsing
// ---------------------------------------------------------------------------

const RE_VERSE = /^(\d+)(-\d+)?\s*([\s\S]*)$/;

/**
 * Read and parse book file for a 0-based Protestant-canon book index.
 * File is book{bookIndex0+1}.txt.
 * Returns { chapters: [ { no, verses: [ { no, number1, number2, text } ] } ] }.
 * Blank lines delimit chapters (chapter no starts at 1).
 * A non-numeric line becomes a verse with no=null (header / section title).
 */
function readBook(bibleDir, version, bookIndex0) {
  const bookPath = path.join(bibleDir, version, `book${bookIndex0 + 1}.txt`);
  const text = readDecodedFile(bookPath);
  const lines = text.split(/\r\n|\r|\n/);

  const chapters = [];
  let chapter = null;
  let c = 1;

  for (let raw of lines) {
    const line = raw.trim();
    if (!line) {
      chapter = null;
      continue;
    }

    let no = null;
    let number1 = null;
    let number2 = null;
    let vtext;

    const m = RE_VERSE.exec(line);
    if (m) {
      const v1 = m[1];
      no = v1;
      number1 = parseInt(v1, 10);
      if (m[2]) {
        const v2 = m[2].slice(1); // drop leading '-'
        no = v1 + '-' + v2;
        number2 = parseInt(v2, 10);
      }
      vtext = m[3].trim();
    } else {
      vtext = line;
    }

    if (chapter === null) {
      chapter = { no: c, verses: [] };
      chapters.push(chapter);
      c += 1;
    }

    // Strip the special char '○'.
    if (vtext.indexOf(REMOVE_CHARS) !== -1) {
      vtext = vtext.split(REMOVE_CHARS).join('');
    }

    chapter.verses.push({ no, number1, number2, text: vtext });
  }

  return { chapters };
}

// ---------------------------------------------------------------------------
// A loaded version wrapper with lazy book caching.
// ---------------------------------------------------------------------------

function loadVersion(bibleDir, version) {
  const index = loadIndex(bibleDir, version);
  const bookCache = new Map();
  return {
    version,
    index,
    getBook(bookIndex0) {
      if (!bookCache.has(bookIndex0)) {
        bookCache.set(bookIndex0, readBook(bibleDir, version, bookIndex0));
      }
      return bookCache.get(bookIndex0);
    },
  };
}

// ---------------------------------------------------------------------------
// Verse intersection logic (replicates bibcore.Verse.in_range)
// ---------------------------------------------------------------------------

function intersect(v, v1, v2) {
  return v1 <= v && v <= v2;
}

function intersectTwo(u1, u2, v1, v2) {
  if (v1 < u1) return v2 >= u1;
  if (v1 <= u2) return true;
  return false;
}

function verseInRange(verse, v1, v2) {
  if (verse.number1 == null) return false; // no === None
  const n1 = verse.number1;
  const n2 = verse.number2;

  if (n2 != null) {
    if (v2 != null) return intersectTwo(v1, v2, n1, n2);
    return intersect(v1, n1, n2);
  }
  if (v2 != null) return intersect(n1, v1, v2);
  return v1 === n1;
}

function maxVerseNo(chapter) {
  let vmax = null;
  for (const v of chapter.verses) {
    const m = v.number2 != null ? v.number2 : v.number1;
    if (m != null && (vmax == null || m > vmax)) vmax = m;
  }
  return vmax;
}

/**
 * Replicates bibcore.Bible.extract_texts_from_bible_index.
 * Returns an array of verse objects (each augmented with `chapterNo`),
 * or [] if nothing matched.
 */
function extractVerses(book, ct1, vs1, ct2, vs2) {
  const out = [];
  for (const ch of book.chapters) {
    if (ch.no < ct1) continue;

    if (ct2 != null) {
      if (ch.no > ct2) break;
      if (ch.no === ct2) {
        for (const v of ch.verses) {
          if (verseInRange(v, 1, vs2)) out.push(Object.assign({ chapterNo: ch.no }, v));
        }
      } else if (ch.no === ct1) {
        const vmax = maxVerseNo(ch);
        for (const v of ch.verses) {
          if (verseInRange(v, vs1, vmax)) out.push(Object.assign({ chapterNo: ch.no }, v));
        }
      } else {
        // ct1 < ch.no < ct2
        const vmax = maxVerseNo(ch);
        for (const v of ch.verses) {
          if (verseInRange(v, 1, vmax)) out.push(Object.assign({ chapterNo: ch.no }, v));
        }
      }
    } else {
      for (const v of ch.verses) {
        if (verseInRange(v, vs1, vs2)) out.push(Object.assign({ chapterNo: ch.no }, v));
      }
      break; // single chapter only
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reference string parsing
// ---------------------------------------------------------------------------

// Korean form (try first). Groups: book, ch1, v1, ch2?, v2?
const RE_KO = /^(.*?)\s*(\d+)\s*[장편:]\s*(\d+)(?:-(?:(\d+)[장편:])?(\d+))?\s*절?$/;
// English/default fallback. Groups: book, ch1, v1, ch2?, v2?
const RE_EN = /^(.*?)\s*(\d+):(\d+)(?:-(?:(\d+):)?(\d+))?$/;
// Bare verse fragment (inherits previous book+chapter). Groups: v1, v2?
const RE_BARE = /^(\d+)(?:-(\d+))?\s*절?$/;

function hasChapterMarker(fragment) {
  return /[:장편]/.test(fragment);
}

/**
 * Parse a fragment that contains a chapter marker into
 * { book, ct1, vs1, ct2, vs2 } (numbers, ct2/vs2 may be null) or null.
 */
function parseMarkedFragment(fragment) {
  let m = RE_KO.exec(fragment);
  if (!m) m = RE_EN.exec(fragment);
  if (!m) return null;

  const book = m[1].trim();
  const ct1 = parseInt(m[2], 10);
  const vs1 = parseInt(m[3], 10);
  const ct2 = m[4] != null ? parseInt(m[4], 10) : null;
  const vs2 = m[5] != null ? parseInt(m[5], 10) : null;
  return { book, ct1, vs1, ct2, vs2 };
}

/**
 * Parse a full reference string (comma-separated) into a list of
 * { book, ct1, vs1, ct2, vs2 } specs. Fragments with no chapter marker
 * inherit the previous fragment's book + chapter.
 */
function parseReferenceSpecs(referenceString) {
  const specs = [];
  if (!referenceString) return specs;

  const fragments = referenceString.split(',');
  let lastBook = null;
  let lastChapter = null;

  for (const rawFrag of fragments) {
    const frag = rawFrag.trim();
    if (!frag) continue;

    if (hasChapterMarker(frag)) {
      const parsed = parseMarkedFragment(frag);
      if (!parsed) continue;
      specs.push(parsed);
      lastBook = parsed.book;
      lastChapter = parsed.ct1;
    } else {
      // bare verse -> inherit prior book/chapter
      const bm = RE_BARE.exec(frag);
      if (!bm || lastBook == null || lastChapter == null) continue;
      const vs1 = parseInt(bm[1], 10);
      const vs2 = bm[2] != null ? parseInt(bm[2], 10) : null;
      specs.push({ book: lastBook, ct1: lastChapter, vs1, ct2: null, vs2 });
    }
  }

  return specs;
}

// ---------------------------------------------------------------------------
// Public: listVersions
// ---------------------------------------------------------------------------

function listVersions(bibleDir) {
  let entries;
  try {
    entries = fs.readdirSync(bibleDir, { withFileTypes: true });
  } catch (e) {
    return [];
  }
  const versions = [];
  for (const ent of entries) {
    if (ent.isDirectory()) {
      const idx = path.join(bibleDir, ent.name, 'index.txt');
      if (fs.existsSync(idx)) versions.push(ent.name);
    }
  }
  return versions;
}

// ---------------------------------------------------------------------------
// Public: parseReferences
// ---------------------------------------------------------------------------

/**
 * parseReferences(bibleDir, version1, referenceString, additionalReferenceString)
 *   -> [{ bookIndex0, bookLong, bookShort, chapter, vStart, vEnd }]
 * One entry per resolved verse (a merged file verse "18-19" stays a single
 * entry with vStart=18, vEnd=19). Book names are resolved via version1's index.
 */
function parseReferences(bibleDir, version1, referenceString, additionalReferenceString) {
  const ver = loadVersion(bibleDir, version1);
  return parseReferencesWithVersion(ver, referenceString, additionalReferenceString);
}

function parseReferencesWithVersion(ver, referenceString, additionalReferenceString) {
  const stripAllWs = (s) => s.replace(/\s+/g, '');
  const specs = parseReferenceSpecs(referenceString).concat(
    parseReferenceSpecs(additionalReferenceString)
  );

  const results = [];
  for (const spec of specs) {
    const bookIndex0 = ver.index.nameToIndex.get(stripAllWs(spec.book));
    if (bookIndex0 == null) continue;
    const meta = ver.index.books[bookIndex0];
    const book = ver.getBook(bookIndex0);

    const verses = extractVerses(book, spec.ct1, spec.vs1, spec.ct2, spec.vs2);
    for (const v of verses) {
      results.push({
        bookIndex0,
        bookLong: meta.long,
        bookShort: meta.short,
        chapter: v.chapterNo,
        vStart: v.number1,
        vEnd: v.number2 != null ? v.number2 : v.number1,
        // internal helpers (also useful to callers):
        verseNo: v.no,
        text: v.text,
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Public: lookupBilingual
// ---------------------------------------------------------------------------

/**
 * Find the text of a given verse position within a (second) version's book.
 * Matches by the starting verse number falling within a stored verse's range,
 * which makes exact numbering match and tolerates differing merged groupings.
 * Returns '' when not found.
 */
function findVerseText(book, chapterNo, vStart) {
  for (const ch of book.chapters) {
    if (ch.no !== chapterNo) continue;
    for (const v of ch.verses) {
      if (v.number1 == null) continue;
      const n1 = v.number1;
      const n2 = v.number2 != null ? v.number2 : v.number1;
      if (n1 <= vStart && vStart <= n2) return v.text;
    }
    return '';
  }
  return '';
}

/**
 * lookupBilingual({ bibleDir, version1, version2, references, additionalReferences })
 *   -> { verses: [ { bookName, bookShort, chapter, verseNo, text1, text2 } ], refDisplay }
 * text1 from version1. text2 from version2, or null if version2 is falsy/missing;
 * '' when the verse is absent in version2. Positions come from version1's book map.
 */
function lookupBilingual({ bibleDir, version1, version2, references, additionalReferences }) {
  const ver1 = loadVersion(bibleDir, version1);

  let ver2 = null;
  if (version2) {
    try {
      ver2 = loadVersion(bibleDir, version2);
    } catch (e) {
      ver2 = null;
    }
  }

  const resolved = parseReferencesWithVersion(ver1, references, additionalReferences);

  const verses = resolved.map((r) => {
    let text2;
    if (!ver2) {
      text2 = null;
    } else {
      const book2 = ver2.getBook(r.bookIndex0);
      text2 = findVerseText(book2, r.chapter, r.vStart);
    }
    return {
      bookName: r.bookLong,
      bookShort: r.bookShort,
      chapter: r.chapter,
      verseNo: r.verseNo,
      text1: r.text,
      text2,
    };
  });

  const refDisplay = (references || '').trim();
  return { verses, refDisplay };
}

// ---------------------------------------------------------------------------

module.exports = {
  listVersions,
  loadIndex,
  parseReferences,
  lookupBilingual,
  // exported for potential reuse/testing:
  readDecodedFile,
  readBook,
};

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

if (require.main === module) {
  const result = lookupBilingual({
    bibleDir: 'C:\\church\\Bible.text',
    version1: '개역개정',
    version2: 'ESV',
    references: '히브리서 12:18-24',
  });

  console.log('refDisplay:', result.refDisplay);
  console.log('verse count:', result.verses.length, '(expect 7)');
  console.log('');

  const first = result.verses[0];
  const last = result.verses[result.verses.length - 1];

  console.log('--- FIRST verse ---');
  console.log(`${first.bookName} ${first.chapter}:${first.verseNo}`);
  console.log('KO:', first.text1);
  console.log('EN:', first.text2);
  console.log('');
  console.log('--- LAST verse ---');
  console.log(`${last.bookName} ${last.chapter}:${last.verseNo}`);
  console.log('KO:', last.text1);
  console.log('EN:', last.text2);
}
