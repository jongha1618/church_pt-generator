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
  hymnDir: "C:\\church\\찬송가",
  // Praise & worship (경배와 찬양) library, organized by Korean initial.
  praiseDir: "C:\\church\\경배와 찬양",
  // Bible text database root: {translation}\bookN.txt
  bibleDir: "C:\\church\\Bible.text",
  // Where the 5 output files are written.
  outputDir: "C:\\church\\onlineservice",
  // Translations used on bilingual scripture slides.
  bibleKorean: "개역개정",
  bibleEnglish: "ESV",
  // Church identity used in notes / titles.
  churchName: "임마누엘 선교교회",
  serviceTitle: "주일 예배",
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
