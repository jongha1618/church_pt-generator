"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getConfig: () => ipcRenderer.invoke("config:get"),
  saveConfig: (patch) => ipcRenderer.invoke("config:save", patch),

  pickFile: (opts) => ipcRenderer.invoke("dialog:pickFile", opts),
  pickFiles: (opts) => ipcRenderer.invoke("dialog:pickFiles", opts),
  pickDir: (opts) => ipcRenderer.invoke("dialog:pickDir", opts),

  parseBulletin: (pdfPath) => ipcRenderer.invoke("bulletin:parse", pdfPath),
  previewBible: (args) => ipcRenderer.invoke("bible:preview", args),
  bibleVersions: (dir) => ipcRenderer.invoke("bible:versions", dir),
  listHymns: (dir) => ipcRenderer.invoke("hymns:list", dir),

  openPath: (p) => ipcRenderer.invoke("openPath", p),

  generate: (service) => ipcRenderer.invoke("generate", service),
  onGenerateLog: (cb) => {
    const listener = (_e, line) => cb(line);
    ipcRenderer.on("generate:log", listener);
    return () => ipcRenderer.removeListener("generate:log", listener);
  },
});
