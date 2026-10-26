"use strict";

const fs = require("fs");
const path = require("path");
const { app } = require("electron");

/**
 * Per-user configuration. Stored as JSON in Electron's userData directory so it
 * survives updates and never lands in the git repo. First-run defaults point at
 * the church's known asset locations; every path is editable in the Settings UI
 * so other computers / other churches can re-point them.
 */

const DEFAULTS = {
  // The PowerPoint template that contains the {token} placeholders + anchor slides.
  templatePath: "C:\\Users\\Jongha Jin\\Dropbox\\EMC\\OnlineService\\template\\2026-Sunday-Template.pptx",
  // Hymn library: one pptx per hymn, named "NNN - title.pptx".
  // Both song libraries live on the church's shared Google Drive; either field
  // may list several roots separated by ';'.
  hymnDir: "G:\\.shortcut-targets-by-id\\0B6xGXJiLbl4SRWlkX3Y4RGJoNWM\\ppt\\1새찬송가",
  // Praise & worship (경배와 찬양) library, organized by Korean initial.
  praiseDir: "G:\\.shortcut-targets-by-id\\0B6xGXJiLbl4SRWlkX3Y4RGJoNWM\\ppt\\2경배와찬양-악보",
  // 사도신경 (Apostles' Creed) slides. The template only carries the title slide
  // and an anchor, so the recited text is inserted from this file every week.
  creedSongPath:
    "G:\\.shortcut-targets-by-id\\0B6xGXJiLbl4SRWlkX3Y4RGJoNWM\\ppt\\1한영찬송\\0사도신경-한영.pptx",
  // 축복송 (blessing song), inserted right after the 축도. Changes yearly, so it
  // is set in Settings; the UI pre-fills it so it is visible and replaceable.
  blessingSongPath:
    "G:\\.shortcut-targets-by-id\\0B6xGXJiLbl4SRWlkX3Y4RGJoNWM\\ppt\\2경배와찬양-악보\\ㅇ\\여호와는 너에게 복을 주시기를 원하며(하나님의 약속) - 2.pptx",
  // Bible text database root: {translation}\bookN.txt
  bibleDir: "C:\\church\\Bible.text",
  // Where the 5 output files are written.
  outputDir: "C:\\church\\onlineservice",
  // Where the weekly 주보 PDF lands (the file dialog opens here). Empty = Downloads.
  bulletinDir: "",
  // Translations used on bilingual scripture slides.
  bibleKorean: "개역개정",
  bibleEnglish: "ESV",
  // Church identity used in notes / titles.
  churchName: "임마누엘 선교교회",
  serviceTitle: "주일 예배",
  // Preacher/benediction used when the bulletin names nobody (the 담임목사).
  defaultPastor: "김형길 목사",
};

let cachedPath = null;

function configPath() {
  if (!cachedPath) {
    cachedPath = path.join(app.getPath("userData"), "config.json");
  }
  return cachedPath;
}

function load() {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch (err) {
    return { ...DEFAULTS };
  }
}

function save(patch) {
  const merged = { ...load(), ...patch };
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(merged, null, 2), "utf8");
  return merged;
}

module.exports = { DEFAULTS, load, save, configPath };
