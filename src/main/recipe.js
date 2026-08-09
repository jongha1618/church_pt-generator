"use strict";

/**
 * recipe.js — encodes the church's fixed Sunday-service build recipe as a
 * marker-driven job that the PowerPoint COM engine (engine.ps1) executes.
 *
 * The 2026 Sunday template already contains every fixed liturgy slide (notices,
 * Apostles' Creed, dividers, benediction, ...). Each slide carries a marker in
 * its *speaker notes* (never shown to the congregation). We locate work by those
 * markers, so the recipe survives slide re-ordering.
 *
 * Marker conventions (verified from 2026-Sunday-Template.pptx notes):
 *   NOTES_intro_announcement   the online-worship notice slides (duplicate+fill)
 *   NOTES_intro_export         slides exported to 00-Announce (JPEG)
 *   MK_transparent_titles      title/divider slides exported to 01-Titles (PNG)
 *   MK_praise_worship2         insert 2부 찬양과 경배 song .pptx here
 *   MK_praise_worship2_separator  divider duplicated between songs
 *   MK_announcement:repeat     the announcement slide duplicated per item
 *   MK_opening_hymn            insert 말씀 전 찬양 song .pptx here
 *   MK_special_praise2:repeat  choir/특송 lyric slide duplicated per line
 *   MK_bible_verse:repeat      scripture slide duplicated per verse
 *   MK_transparent_bible_verse slides exported to 02-Verse (PNG)
 *   MK_closing_hymn2           insert 말씀 후 찬양 song .pptx here
 *   MK_closing_praise          insert 예배 후 경배와찬양 song .pptx here
 *   MK_closing_announcement:repeat  closing notice slide duplicated per item
 *   MK_closing_announcement    slides exported to 04-Ending (JPEG)
 *   MK_benediction             benediction divider (token {benediction})
 */

// Weekly-fixed boilerplate the user rarely edits. Shown pre-filled in the form.
const DEFAULT_INTRO_ANNOUNCEMENTS = [
  "임마누엘 선교교회의\n모든 주일 및 주중 예배는\n성전 예배와 온라인 예배로\n드려집니다.",
  "온라인 예배 시 10분 전에\n평소 교회 출석시와 같이\n가족과 함께 모여 기도하며\n예배를 준비합니다.",
  "온라인 예배도 성전예배처럼\n신령과 진정으로 예배드리시기에\n힘쓰시기 바랍니다.",
  "예배 후에는 가족과 함께\n받은 은혜를 나눕니다.",
];

const DEFAULT_CLOSING_ANNOUNCEMENTS = [
  "{service_title}를\n은혜롭게 드렸습니다.\n가족들과 받은 은혜를\n나누시기 바랍니다.",
  "주님과 동행하시는\n복된 한 주간 되시길 바라며\n다음 예배 때 뵙겠습니다.",
];

/**
 * Return a blank weekly service object with sensible defaults. The renderer form
 * edits this; bulletinParser fills what it can from the PDF.
 */
function blankService(config) {
  return {
    date: "", // ISO yyyy-mm-dd
    serviceTitle: config.serviceTitle || "주일 예배",
    sermonTitle: "",
    preacher: "김형길 목사",
    prayer: "", // 대표기도
    benediction: "김형길 목사", // 축도
    // 봉사위원 (this week)
    lunch: "",
    serving: "",
    flower: "",
    cleaning: "",
    offering: "",
    guide: "",
    // scripture
    bibleVersion1: config.bibleKorean || "개역개정",
    bibleVersion2: config.bibleEnglish || "ESV",
    mainVerses: "",
    additionalVerses: "",
    // 성가대 특송 (up to 3 slots, matches {special_praise_titleN}/{singerN})
    specialPraise: [
      { title: "", singer: "" },
      { title: "", singer: "" },
      { title: "", singer: "" },
    ],
    choirLyrics: [], // {special_praise_lyric} lines (성가대 찬양 가사)
    // announcements
    introAnnouncements: DEFAULT_INTRO_ANNOUNCEMENTS.slice(),
    announcements: [],
    closingAnnouncements: DEFAULT_CLOSING_ANNOUNCEMENTS.slice(),
    // song .pptx files to insert (absolute paths). praiseWorship/closingPraise
    // are usually uploaded/picked each week; hymns picked from the 찬송가 library.
    songs: {
      praiseWorship: [],
      openingHymn: [],
      closingHymn: [],
      closingPraise: [],
    },
  };
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const MONTHS_ABBR = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

/** Parse an ISO date (yyyy-mm-dd) into a plain object (no TZ surprises). */
function parseISODate(iso) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec((iso || "").trim());
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return { y, mo, d, weekday: dt.getUTCDay() };
}

/** strftime-like expansion supporting the directives the recipe uses. */
function formatDateSpec(iso, spec) {
  const p = parseISODate(iso);
  if (!p) return spec;
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const map = {
    "%Y": String(p.y),
    "%y": pad(p.y % 100),
    "%m": pad(p.mo),
    "%#m": String(p.mo),
    "%d": pad(p.d),
    "%#d": String(p.d),
    "%A": WEEKDAYS[p.weekday],
    "%a": WEEKDAYS[p.weekday].slice(0, 3),
    "%B": MONTHS[p.mo - 1],
    "%b": MONTHS_ABBR[p.mo - 1],
  };
  // Replace longer keys first so %#m beats %m.
  return spec
    .replace(/%#m/g, map["%#m"])
    .replace(/%#d/g, map["%#d"])
    .replace(/%[YymdAaBb]/g, (t) => (map[t] !== undefined ? map[t] : t));
}

/** Output base name, e.g. 2026-0809-Sunday */
function outputBaseName(iso) {
  return `${formatDateSpec(iso, "%Y-%m%d-%A")}`;
}

/** Substitute {token} and {datetime:spec} inside a text block using str_dict + date. */
function resolveTokensInText(text, strDict, iso) {
  let out = String(text);
  // datetime formats
  out = out.replace(/\{datetime:([^}]*)\}/g, (_, spec) => formatDateSpec(iso, spec));
  // plain string tokens
  for (const [k, v] of Object.entries(strDict)) {
    out = out.split(`{${k}}`).join(v == null ? "" : String(v));
  }
  return out;
}

/**
 * Build the global replacement dictionary applied to every template slide.
 * Keys are the literal {token} strings.
 */
function buildGlobalReplacements(service) {
  const strDict = {
    service_title: service.serviceTitle,
    sermon_title: service.sermonTitle,
    preacher: service.preacher,
    prayer: service.prayer,
    benediction: service.benediction,
    lunch: service.lunch,
    serving: service.serving,
    flower: service.flower,
    cleaning: service.cleaning,
    offering: service.offering,
    guide: service.guide,
    bible_verse1: service.mainVerses,
  };
  (service.specialPraise || []).forEach((sp, i) => {
    strDict[`special_praise_title${i}`] = sp.title || "";
    strDict[`special_praise_singer${i}`] = sp.singer || "";
  });

  const replaceGlobal = {};
  for (const [k, v] of Object.entries(strDict)) {
    replaceGlobal[`{${k}}`] = v == null ? "" : String(v);
  }
  // datetime tokens that appear on title slides
  for (const spec of ["%Y년 %#m월 %#d일", "%Y. %#m. %#d", "%Y-%m%d-%A"]) {
    replaceGlobal[`{datetime:${spec}}`] = formatDateSpec(service.date, spec);
  }
  return { strDict, replaceGlobal };
}

/**
 * Build the job consumed by engine.ps1. `verses` is the resolved bilingual verse
 * list from bible.js (may be empty if lookup failed / no reference).
 */
function buildJob(service, config, verses) {
  const outBase = outputBaseName(service.date);
  const outDir = config.outputDir;
  const { strDict, replaceGlobal } = buildGlobalReplacements(service);

  const resolve = (arr) => (arr || []).map((t) => resolveTokensInText(t, strDict, service.date));

  const steps = [];

  // 1. Intro online-worship notices (duplicate + fill).
  if (service.introAnnouncements && service.introAnnouncements.length) {
    steps.push({
      op: "duplicateFill",
      name: "예배 전 광고",
      repeatMarker: "NOTES_intro_announcement",
      find: "{intro_announcement}",
      texts: resolve(service.introAnnouncements),
    });
  }

  // 2. 찬양과 경배 (2부) song slides.
  if (service.songs.praiseWorship && service.songs.praiseWorship.length) {
    steps.push({
      op: "insertPptx",
      name: "찬양과 경배",
      marker: "MK_praise_worship2",
      separatorMarker: "MK_praise_worship2_separator",
      files: service.songs.praiseWorship,
    });
  }

  // 3. 주일 광고 (duplicate + fill).
  if (service.announcements && service.announcements.length) {
    steps.push({
      op: "duplicateFill",
      name: "주일 광고",
      repeatMarker: "MK_announcement:repeat",
      find: "{announcement}",
      texts: resolve(service.announcements),
    });
  }

  // 4. 말씀 전 찬양 (opening hymn) song slides.
  if (service.songs.openingHymn && service.songs.openingHymn.length) {
    steps.push({
      op: "insertPptx",
      name: "말씀 전 찬양",
      marker: "MK_opening_hymn",
      files: service.songs.openingHymn,
    });
  }

  // 5. 성가대 특송 가사 (duplicate + fill).
  if (service.choirLyrics && service.choirLyrics.length) {
    steps.push({
      op: "duplicateFill",
      name: "성가대 찬양",
      repeatMarker: "MK_special_praise2:repeat",
      find: "{special_praise_lyric}",
      texts: resolve(service.choirLyrics),
    });
  }

  // 6. 성경 구절 (duplicate verse slide + fill each_verse tokens).
  if (verses && verses.length) {
    steps.push({
      op: "bibleVerses",
      name: "성경 구절",
      repeatMarker: "MK_bible_verse:repeat",
      verses: verses.map((v) => ({
        bookLong: v.bookName,
        bookShort: v.bookShort,
        chapter: v.chapter,
        no: v.verseNo,
        text1: v.text1 || "",
        text2: v.text2 || "",
      })),
    });
  }

  // 7. 말씀 후 찬양 (closing hymn) song slides.
  if (service.songs.closingHymn && service.songs.closingHymn.length) {
    steps.push({
      op: "insertPptx",
      name: "말씀 후 찬양",
      marker: "MK_closing_hymn2",
      files: service.songs.closingHymn,
    });
  }

  // 8. 축도 후 축복송 / 예배 후 경배와 찬양. Use the per-week upload if provided,
  //    otherwise fall back to the annual 축복송 configured in Settings.
  const closingPraiseFiles =
    service.songs.closingPraise && service.songs.closingPraise.length
      ? service.songs.closingPraise
      : config.blessingSongPath
      ? [config.blessingSongPath]
      : [];
  if (closingPraiseFiles.length) {
    steps.push({
      op: "insertPptx",
      name: "축복송 / 예배 후 경배와 찬양",
      marker: "MK_closing_praise",
      files: closingPraiseFiles,
    });
  }

  // 9. 예배 후 광고 (duplicate + fill).
  if (service.closingAnnouncements && service.closingAnnouncements.length) {
    steps.push({
      op: "duplicateFill",
      name: "예배 후 광고",
      repeatMarker: "MK_closing_announcement:repeat",
      find: "{closing_announcement}",
      texts: resolve(service.closingAnnouncements),
    });
  }

  const exports = [
    { op: "exportSlides", name: "00-Announce", marker: "NOTES_intro_export", alsoTextContains: ["무음", "진동"], outDir: `${outDir}\\Slide-Images\\00-Announce`, imageType: "JPG", transparent: false },
    { op: "exportShapes", name: "01-Titles", marker: "MK_transparent_titles", outDir: `${outDir}\\Slide-Images\\01-Titles`, imageType: "PNG", transparent: true },
    { op: "exportShapes", name: "02-Verse", marker: "MK_transparent_bible_verse", outDir: `${outDir}\\Slide-Images\\02-Verse`, imageType: "PNG", transparent: true },
    { op: "exportSlides", name: "04-Ending", marker: "MK_closing_announcement", outDir: `${outDir}\\Slide-Images\\04-Ending`, imageType: "JPG", transparent: false },
  ];

  return {
    templatePath: config.templatePath,
    outPptx: `${outDir}\\${outBase}.pptx`,
    outDir,
    replaceGlobal,
    steps,
    exports,
  };
}

module.exports = {
  blankService,
  buildJob,
  buildGlobalReplacements,
  outputBaseName,
  formatDateSpec,
  resolveTokensInText,
  DEFAULT_INTRO_ANNOUNCEMENTS,
  DEFAULT_CLOSING_ANNOUNCEMENTS,
};
