"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const bible = require("./bible");
const osz = require("./osz");
const recipe = require("./recipe");

const UTF16_BOM = "﻿";

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function firstExisting(paths) {
  for (const p of paths) {
    try { if (p && fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

// Candidate locations for a bundled default asset (packaged, then dev repo).
function bundledResource(name) {
  return [
    path.join(process.resourcesPath || "", "template", name),
    path.join(__dirname, "..", "..", "resources", name),
  ];
}

// Use the configured template if it exists; otherwise fall back to the default
// template bundled in the repo/installer.
function resolveTemplatePath(configured) {
  return firstExisting([configured, ...bundledResource("2026-Sunday-Template.pptx")]) || configured;
}

/** Format a single verse token spec (%b %c:%v %t) — mirrors engine.ps1 Format-Verse. */
function formatVerse(fmt, v, useEnglish) {
  const spec = fmt || "%t";
  const text = useEnglish ? v.text2 || "" : v.text1 || "";
  return spec
    .split("%B").join(v.bookName)
    .split("%b").join(v.bookShort)
    .split("%c").join(String(v.chapter))
    .split("%v").join(String(v.verseNo))
    .split("%t").join(text);
}

/** Fill the 예배-Notes.txt template tokens using the service + verses. */
function buildNotesText(service, verses, notesTemplate) {
  const iso = service.date;
  const { strDict } = recipe.buildGlobalReplacements(service);
  let out = notesTemplate;

  // {each_verse1:fmt} → all verses joined by newline (Korean text).
  out = out.replace(/\{each_verse([12]):([^}]*)\}/g, (_, which, fmt) => {
    const useEng = which === "2";
    return (verses || []).map((v) => formatVerse(fmt, v, useEng)).join("\n");
  });
  // {datetime:spec}
  out = out.replace(/\{datetime:([^}]*)\}/g, (_, spec) => recipe.formatDateSpec(iso, spec));
  // plain tokens
  for (const [k, v] of Object.entries(strDict)) {
    out = out.split(`{${k}}`).join(v == null ? "" : String(v));
  }
  return out;
}

/** Minimal notes template if the church's 예배-Notes-Template.txt is not found. */
function fallbackNotesTemplate() {
  return [
    "{datetime:%Y-%#m-%#d} | {service_title} | {sermon_title} | 임마누엘 선교교회",
    "",
    "{datetime:%Y년 %#m월 %#d일} {service_title} (임마누엘 선교교회)",
    "{preacher}",
    "{sermon_title} ({bible_verse1})",
    "",
    "{bible_verse1}",
    "",
    "{each_verse1:%v %t}",
    "",
  ].join("\n");
}

/** 예배 성경구절.txt content — reference caption + one line per verse. */
function buildVersesText(refDisplay, verses) {
  const lines = [refDisplay];
  for (const v of verses) {
    lines.push(`${v.verseNo} ${v.text1 || ""}`.trim());
  }
  return UTF16_BOM + lines.join("\r\n") + "\r\n";
}

/** Collect the OpenLP song items to archive into the .osz. */
function buildOszSongs(service, verses, refDisplay) {
  const songs = [];

  // Scripture as a song (one verse = one bible verse, Korean).
  if (verses && verses.length) {
    songs.push({
      title: refDisplay || "성경봉독",
      verses: verses.map((v) => [`${v.verseNo} ${v.text1 || ""}`.trim()]),
    });
  }
  // Announcements.
  if (service.announcements && service.announcements.length) {
    songs.push({
      title: "광고",
      verses: service.announcements.map((a) => String(a).split("\n")),
    });
  }
  // Choir lyrics.
  if (service.choirLyrics && service.choirLyrics.length) {
    songs.push({
      title: (service.specialPraise?.[2]?.title) || "성가대 찬양",
      verses: service.choirLyrics.map((a) => String(a).split("\n")),
    });
  }
  // Inserted songs — read the sibling OpenLyrics .xml when present.
  const allSongFiles = []
    .concat(service.songs.praiseWorship || [])
    .concat(service.songs.openingHymn || [])
    .concat(service.songs.closingHymn || [])
    .concat(service.songs.closingPraise || []);
  for (const f of allSongFiles) {
    const xml = f.replace(/\.pptx?$/i, ".xml");
    const parsed = osz.readSongXml(xml);
    if (parsed && parsed.verses && parsed.verses.length) {
      songs.push(parsed);
    }
  }
  return songs;
}

function runEngine(jobPath, onLog, onEngineProgress) {
  return new Promise((resolve, reject) => {
    // engine.ps1 ships inside app.asar when packaged; PowerShell's -File cannot
    // read a virtual asar path, so copy the script out to a real temp file first.
    // (Electron's fs can read from inside asar, so readFileSync works either way.)
    const engineSrc = path.join(__dirname, "ppt", "engine.ps1");
    const engineTmp = path.join(os.tmpdir(), `cppt-engine-${Date.now()}.ps1`);
    // Windows PowerShell 5.1 decodes a .ps1 as ANSI unless it starts with a
    // UTF-8 BOM, which mangles the Korean strings in the script. The repo file
    // stays BOM-free (git-friendly); the temp copy gets one.
    const engineText = fs.readFileSync(engineSrc, "utf8").replace(/^﻿/, "");
    fs.writeFileSync(engineTmp, "﻿" + engineText, "utf8");

    const cleanupEngine = () => { try { fs.unlinkSync(engineTmp); } catch {} };

    const ps = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", engineTmp, "-JobPath", jobPath],
      { windowsHide: true }
    );
    let stderr = "";
    let buf = "";
    const flush = (chunk) => {
      buf += chunk.toString("utf8");
      const parts = buf.split(/\r?\n/);
      buf = parts.pop();
      for (const line of parts) {
        if (!line.length) continue;
        // "@@PROGRESS done total label" drives the progress bar, not the log.
        const p = /^@@PROGRESS (\d+) (\d+) ?(.*)$/.exec(line);
        if (p) onEngineProgress(+p[1], +p[2], p[3]);
        else onLog(line);
      }
    };
    ps.stdout.on("data", flush);
    ps.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
      d.toString("utf8").split(/\r?\n/).forEach((l) => { if (l.trim()) onLog("[err] " + l); });
    });
    ps.on("error", (err) => { cleanupEngine(); reject(err); });
    ps.on("close", (code) => {
      if (buf.length) onLog(buf);
      cleanupEngine();
      if (code === 0) resolve();
      else reject(new Error(`engine.ps1 exited with code ${code}. ${stderr}`));
    });
  });
}

/**
 * Generate the 5 outputs (pptx, osz, 2 txt, slide-images) under config.outputDir.
 * onLog(line) streams the engine log; onProgress({percent,label,done}) drives the
 * progress bar. Returns the produced paths.
 */
async function generate(service, config, onLog = () => {}, onProgress = () => {}) {
  const log = (m) => onLog(String(m));

  // The PowerPoint engine is the slow part, so it gets most of the bar. The
  // preparation steps before it share the first PREP_SHARE.
  const PREP_STEPS = ["성경 구절 조회", "노트 저장", "성경구절 저장", "OSZ 저장"];
  const PREP_SHARE = 0.15;
  let prepDone = 0;
  const prep = (label) => {
    const percent = Math.round((prepDone / PREP_STEPS.length) * PREP_SHARE * 100);
    onProgress({ percent, label, done: false });
    prepDone++;
  };

  const outDir = config.outputDir;
  ensureDir(outDir);

  // 1. Scripture lookup (bilingual).
  prep(PREP_STEPS[0]);
  let verses = [];
  let refDisplay = service.mainVerses || "";
  if (service.mainVerses) {
    log(`성경 구절 조회: ${service.mainVerses} (${service.bibleVersion1}/${service.bibleVersion2})`);
    try {
      const res = bible.lookupBilingual({
        bibleDir: config.bibleDir,
        version1: service.bibleVersion1,
        version2: service.bibleVersion2,
        references: service.mainVerses,
        additionalReferences: service.additionalVerses,
      });
      verses = res.verses || [];
      refDisplay = res.refDisplay || service.mainVerses;
      log(`  → ${verses.length}개 절 조회 완료`);
    } catch (e) {
      log(`  ! 성경 조회 실패: ${e.message}`);
    }
  }

  const base = recipe.outputBaseName(service.date);
  const templatePath = resolveTemplatePath(config.templatePath);
  log(`템플릿: ${templatePath}`);

  // 2. 예배-Notes.txt
  prep(PREP_STEPS[1]);
  const notesPath = path.join(outDir, "예배-Notes.txt");
  const notesTplPath = firstExisting([
    path.join(path.dirname(templatePath), "예배-Notes-Template.txt"),
    ...bundledResource("예배-Notes-Template.txt"),
  ]);
  let notesTpl = fallbackNotesTemplate();
  if (notesTplPath) {
    try { notesTpl = fs.readFileSync(notesTplPath, "utf8"); } catch {}
  }
  fs.writeFileSync(notesPath, buildNotesText(service, verses, notesTpl), "utf8");
  log(`노트 저장: ${notesPath}`);

  // 3. 예배 성경구절.txt (UTF-16LE + BOM)
  prep(PREP_STEPS[2]);
  const versesPath = path.join(outDir, "예배 성경구절.txt");
  fs.writeFileSync(versesPath, Buffer.from(buildVersesText(refDisplay, verses), "utf16le"));
  log(`성경구절 저장: ${versesPath}`);

  // 4. .osz service file
  prep(PREP_STEPS[3]);
  const oszPath = path.join(outDir, `${base}.osz`);
  try {
    const songs = buildOszSongs(service, verses, refDisplay);
    osz.writeOsz(oszPath, songs);
    log(`OSZ 저장: ${oszPath} (${songs.length} items)`);
  } catch (e) {
    log(`  ! OSZ 생성 실패: ${e.message}`);
  }

  // 5. PPT + slide-images via PowerPoint COM engine
  const job = recipe.buildJob(service, config, verses);
  job.templatePath = templatePath; // configured path or bundled default
  const jobPath = path.join(os.tmpdir(), `cppt-job-${Date.now()}.json`);
  fs.writeFileSync(jobPath, JSON.stringify(job, null, 2), "utf8");
  log("PowerPoint 엔진 실행 중... (PowerPoint 창이 잠시 열립니다)");
  await runEngine(jobPath, log, (done, total, label) => {
    const frac = total > 0 ? done / total : 0;
    onProgress({
      percent: Math.round((PREP_SHARE + (1 - PREP_SHARE) * frac) * 100),
      label,
      done: false,
    });
  });
  try { fs.unlinkSync(jobPath); } catch {}

  onProgress({ percent: 100, label: "완료", done: true });

  return {
    ok: true,
    outPptx: job.outPptx,
    oszPath,
    notesPath,
    versesPath,
    imagesDir: path.join(outDir, "Slide-Images"),
  };
}

module.exports = { generate, buildNotesText, buildVersesText };
