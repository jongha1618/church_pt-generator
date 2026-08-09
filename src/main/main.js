"use strict";

const path = require("path");
const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");

const config = require("./config");
const bible = require("./bible");
const { parseBulletin } = require("./bulletinParser");
const { generate } = require("./generator");

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 900,
    minWidth: 900,
    minHeight: 640,
    title: "Church PPT Generator",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// ---------- IPC --------------------------------------------------------------

ipcMain.handle("config:get", () => config.load());
ipcMain.handle("config:save", (_e, patch) => config.save(patch || {}));

ipcMain.handle("dialog:pickFile", async (_e, opts = {}) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: opts.filters || [],
    defaultPath: opts.defaultPath,
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle("dialog:pickFiles", async (_e, opts = {}) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile", "multiSelections"],
    filters: opts.filters || [],
    defaultPath: opts.defaultPath,
  });
  return res.canceled ? [] : res.filePaths;
});

ipcMain.handle("dialog:pickDir", async (_e, opts = {}) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
    defaultPath: opts.defaultPath,
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle("bulletin:parse", async (_e, pdfPath) => {
  try {
    return { ok: true, ...(await parseBulletin(pdfPath)) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle("bible:preview", async (_e, args) => {
  try {
    const res = bible.lookupBilingual(args);
    return { ok: true, ...res };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle("bible:versions", async (_e, bibleDir) => {
  try {
    return { ok: true, versions: bible.listVersions(bibleDir) };
  } catch (e) {
    return { ok: false, error: e.message, versions: [] };
  }
});

ipcMain.handle("hymns:list", async (_e, hymnDir) => {
  const fs = require("fs");
  try {
    const files = fs.readdirSync(hymnDir).filter((f) => /\.pptx$/i.test(f));
    const items = files.map((f) => {
      const m = /^(\d{1,3})\s*-\s*(.+)\.pptx$/i.exec(f);
      return {
        file: path.join(hymnDir, f),
        num: m ? parseInt(m[1], 10) : null,
        title: m ? m[2] : f.replace(/\.pptx$/i, ""),
        name: f,
      };
    });
    items.sort((a, b) => (a.num || 9999) - (b.num || 9999));
    return { ok: true, items };
  } catch (e) {
    return { ok: false, error: e.message, items: [] };
  }
});

ipcMain.handle("openPath", async (_e, p) => {
  if (p) await shell.openPath(p);
});

ipcMain.handle("generate", async (event, service) => {
  const cfg = config.load();
  const onLog = (line) => event.sender.send("generate:log", line);
  try {
    const result = await generate(service, cfg, onLog);
    return { ok: true, ...result };
  } catch (e) {
    onLog("[error] " + e.message);
    return { ok: false, error: e.message };
  }
});
