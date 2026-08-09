"use strict";

const DEFAULT_INTRO = [
  "임마누엘 선교교회의\n모든 주일 및 주중 예배는\n성전 예배와 온라인 예배로\n드려집니다.",
  "온라인 예배 시 10분 전에\n평소 교회 출석시와 같이\n가족과 함께 모여 기도하며\n예배를 준비합니다.",
  "온라인 예배도 성전예배처럼\n신령과 진정으로 예배드리시기에\n힘쓰시기 바랍니다.",
  "예배 후에는 가족과 함께\n받은 은혜를 나눕니다.",
];
const DEFAULT_CLOSING = [
  "{service_title}를\n은혜롭게 드렸습니다.\n가족들과 받은 은혜를\n나누시기 바랍니다.",
  "주님과 동행하시는\n복된 한 주간 되시길 바라며\n다음 예배 때 뵙겠습니다.",
];

let config = {};
let hymns = [];
const state = {
  songs: { praiseWorship: [], openingHymn: [], closingHymn: [], closingPraise: [] },
};

const $ = (id) => document.getElementById(id);

function blocksToText(arr) {
  return (arr || []).join("\n\n");
}
function textToBlocks(text) {
  return String(text || "")
    .split(/\n\s*\n/)
    .map((b) => b.replace(/\s+$/g, "").replace(/^\s+/g, ""))
    .filter((b) => b.length);
}

// ---------- init -------------------------------------------------------------

async function init() {
  config = await window.api.getConfig();
  fillSettings();

  // bible versions
  const vres = await window.api.bibleVersions(config.bibleDir);
  const v1 = $("bibleVersion1");
  const v2 = $("bibleVersion2");
  v1.innerHTML = "";
  v2.innerHTML = "";
  (vres.versions || []).forEach((name) => {
    v1.add(new Option(name, name));
    v2.add(new Option(name, name));
  });
  v1.value = config.bibleKorean;
  v2.value = config.bibleEnglish;

  // hymns for datalist
  const hres = await window.api.listHymns(config.hymnDir);
  hymns = hres.items || [];
  const dl = $("hymnList");
  dl.innerHTML = "";
  hymns.forEach((h) => {
    const opt = document.createElement("option");
    opt.value = h.num ? `${h.num} - ${h.title}` : h.title;
    dl.appendChild(opt);
  });

  // default form values
  $("serviceTitle").value = config.serviceTitle || "주일 예배";
  $("preacher").value = "김형길 목사";
  $("benediction").value = "김형길 목사";
  $("introAnnouncements").value = blocksToText(DEFAULT_INTRO);
  $("closingAnnouncements").value = blocksToText(DEFAULT_CLOSING);

  renderAllChips();
  bindEvents();
}

// ---------- settings ---------------------------------------------------------

function fillSettings() {
  for (const k of ["templatePath","hymnDir","praiseDir","bibleDir","outputDir","bibleKorean","bibleEnglish"]) {
    const el = $("set_" + k);
    if (el) el.value = config[k] || "";
  }
}

async function saveSettings() {
  const patch = {};
  for (const k of ["templatePath","hymnDir","praiseDir","bibleDir","outputDir","bibleKorean","bibleEnglish"]) {
    patch[k] = $("set_" + k).value.trim();
  }
  config = await window.api.saveConfig(patch);
  $("settingsModal").classList.add("hidden");
  init(); // reload versions/hymns with new paths
}

// ---------- bulletin ---------------------------------------------------------

async function pickPdf() {
  const p = await window.api.pickFile({ filters: [{ name: "PDF", extensions: ["pdf"] }] });
  if (!p) return;
  $("pdfName").textContent = p.split(/[\\/]/).pop();
  $("pdfName").classList.remove("muted");
  const res = await window.api.parseBulletin(p);
  if (!res.ok) {
    $("pdfName").textContent = "파싱 실패: " + res.error;
    return;
  }
  $("rawText").textContent = res.rawText || "";
  applyParsed(res.service, res.hints);
}

function applyParsed(s, hints) {
  if (!s) return;
  const setIf = (id, val) => { if (val) $(id).value = val; };
  setIf("date", s.date);
  setIf("sermonTitle", s.sermonTitle);
  setIf("preacher", s.preacher);
  setIf("prayer", s.prayer);
  setIf("benediction", s.benediction);
  setIf("mainVerses", s.mainVerses);
  if (s.specialPraise) {
    const slot = (i, t, sg) => {
      setIf(t, s.specialPraise[i]?.title);
      setIf(sg, s.specialPraise[i]?.singer);
    };
    slot(0, "sp0t", "sp0s");
    slot(1, "sp1t", "sp1s");
    slot(2, "sp2t", "sp2s");
  }
  if (s.announcements && s.announcements.length) {
    $("announcements").value = blocksToText(s.announcements);
  }
  // pre-fill hymn candidates as chips in opening hymn (user can move/remove)
  if (hints && hints.hymnNumbers && hints.hymnNumbers.length) {
    hints.hymnNumbers.forEach((n) => {
      const h = hymns.find((x) => x.num === n);
      if (h) state.songs.openingHymn.push(h.file);
    });
    renderChips("openingHymn");
  }
}

// ---------- bible preview ----------------------------------------------------

async function previewBible() {
  const args = {
    bibleDir: config.bibleDir,
    version1: $("bibleVersion1").value,
    version2: $("bibleVersion2").value,
    references: $("mainVerses").value.trim(),
    additionalReferences: $("additionalVerses").value.trim(),
  };
  if (!args.references) return;
  $("bibleStatus").textContent = "조회 중…";
  const res = await window.api.previewBible(args);
  if (!res.ok) {
    $("bibleStatus").textContent = "실패: " + res.error;
    $("biblePreview").textContent = "";
    return;
  }
  $("bibleStatus").textContent = `${res.verses.length}개 절`;
  $("biblePreview").textContent = res.verses
    .map((v) => `${v.bookShort} ${v.chapter}:${v.verseNo}\n  ${v.text1}\n  ${v.text2 || ""}`)
    .join("\n\n");
}

// ---------- songs / chips ----------------------------------------------------

function renderChips(key) {
  const group = document.querySelector(`.songgroup[data-key="${key}"] .chips`);
  if (!group) return;
  group.innerHTML = "";
  state.songs[key].forEach((file, idx) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.innerHTML = `<span>${file.split(/[\\/]/).pop()}</span>`;
    const x = document.createElement("button");
    x.textContent = "×";
    x.title = "제거";
    x.onclick = () => { state.songs[key].splice(idx, 1); renderChips(key); };
    chip.appendChild(x);
    group.appendChild(chip);
  });
}
function renderAllChips() {
  Object.keys(state.songs).forEach(renderChips);
}

async function pickSongFiles(key) {
  const defaultPath = key === "praiseWorship" || key === "closingPraise" ? config.praiseDir : config.hymnDir;
  const files = await window.api.pickFiles({
    filters: [{ name: "PowerPoint", extensions: ["pptx", "ppt"] }],
    defaultPath,
  });
  (files || []).forEach((f) => state.songs[key].push(f));
  renderChips(key);
}

function addHymn(key, text) {
  const t = (text || "").trim();
  if (!t) return;
  const numMatch = /^(\d{1,3})/.exec(t);
  let h = null;
  if (numMatch) h = hymns.find((x) => x.num === parseInt(numMatch[1], 10));
  if (!h) h = hymns.find((x) => x.title && x.title.includes(t.replace(/^\d+\s*-?\s*/, "")));
  if (!h) { alert("찬송가를 찾지 못했습니다: " + t); return; }
  state.songs[key].push(h.file);
  renderChips(key);
}

// ---------- collect + generate ----------------------------------------------

function collectService() {
  const sp = (t, s) => ({ title: $(t).value.trim(), singer: $(s).value.trim() });
  return {
    date: $("date").value,
    serviceTitle: $("serviceTitle").value.trim(),
    sermonTitle: $("sermonTitle").value.trim(),
    preacher: $("preacher").value.trim(),
    prayer: $("prayer").value.trim(),
    benediction: $("benediction").value.trim(),
    lunch: $("lunch").value.trim(),
    serving: $("serving").value.trim(),
    flower: $("flower").value.trim(),
    offering: $("offering").value.trim(),
    guide: $("guide").value.trim(),
    cleaning: $("cleaning").value.trim(),
    bibleVersion1: $("bibleVersion1").value,
    bibleVersion2: $("bibleVersion2").value,
    mainVerses: $("mainVerses").value.trim(),
    additionalVerses: $("additionalVerses").value.trim(),
    specialPraise: [sp("sp0t", "sp0s"), sp("sp1t", "sp1s"), sp("sp2t", "sp2s")],
    choirLyrics: textToBlocks($("choirLyrics").value),
    introAnnouncements: textToBlocks($("introAnnouncements").value),
    announcements: textToBlocks($("announcements").value),
    closingAnnouncements: textToBlocks($("closingAnnouncements").value),
    songs: state.songs,
  };
}

async function generate() {
  const service = collectService();
  if (!service.date) { alert("날짜를 입력하세요."); return; }
  $("log").textContent = "";
  $("results").classList.add("hidden");
  $("genStatus").textContent = "생성 중…";
  $("btnGenerate").disabled = true;

  const unsub = window.api.onGenerateLog((line) => {
    $("log").textContent += line + "\n";
    $("log").scrollTop = $("log").scrollHeight;
  });

  try {
    const res = await window.api.generate(service);
    if (res.ok) {
      $("genStatus").textContent = "완료 ✅";
      showResults(res);
    } else {
      $("genStatus").textContent = "실패 ❌ " + (res.error || "");
    }
  } finally {
    unsub && unsub();
    $("btnGenerate").disabled = false;
  }
}

function showResults(res) {
  const box = $("results");
  box.innerHTML = "";
  const add = (label, p) => {
    const a = document.createElement("a");
    a.textContent = `${label}: ${p}`;
    a.onclick = () => window.api.openPath(p);
    box.appendChild(a);
  };
  add("PPTX", res.outPptx);
  add("OSZ", res.oszPath);
  add("노트", res.notesPath);
  add("성경구절", res.versesPath);
  add("이미지 폴더", res.imagesDir);
  box.classList.remove("hidden");
}

// ---------- events -----------------------------------------------------------

function bindEvents() {
  $("btnPickPdf").onclick = pickPdf;
  $("btnPreviewBible").onclick = previewBible;
  $("btnGenerate").onclick = generate;
  $("btnOpenOut").onclick = () => window.api.openPath(config.outputDir);

  $("btnSettings").onclick = () => { fillSettings(); $("settingsModal").classList.remove("hidden"); };
  $("btnCloseSettings").onclick = () => $("settingsModal").classList.add("hidden");
  $("btnSaveSettings").onclick = saveSettings;

  document.querySelectorAll(".modal [data-pick]").forEach((btn) => {
    btn.onclick = async () => {
      const kind = btn.getAttribute("data-pick");
      const target = btn.getAttribute("data-target");
      let p = null;
      if (kind === "file") p = await window.api.pickFile({ filters: [{ name: "PPTX", extensions: ["pptx"] }] });
      else p = await window.api.pickDir();
      if (p) $(target).value = p;
    };
  });

  document.querySelectorAll(".songgroup").forEach((g) => {
    const key = g.getAttribute("data-key");
    const pf = g.querySelector(".pick-file");
    if (pf) pf.onclick = () => pickSongFiles(key);
    const ah = g.querySelector(".add-hymn");
    if (ah) ah.onclick = () => { const inp = g.querySelector(".hymn-input"); addHymn(key, inp.value); inp.value = ""; };
  });
}

window.addEventListener("DOMContentLoaded", init);
