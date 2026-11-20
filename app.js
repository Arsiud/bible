"use strict";

const TRANSLATIONS = {
  GN: "Good News (our translation)",   // the family's own translation of the KJV (1_Projects/bible-translation)
  WEB: "World English Bible",   // the default
  KJV: "King James Version",
  ASV: "American Standard Version",
  RST: "Синодальный перевод (Russian Synodal)",
  ESV: "English Standard Version",
  NIV: "New International Version",
  NASB: "New American Standard Bible (2020)",
  NTV: "Nueva Traducción Viviente (Spanish)",
};

const ESV_COPYRIGHT =
  "Scripture quotations are from the ESV® Bible (The Holy Bible, English Standard Version®), " +
  "© 2001 by Crossway. Used by permission. All rights reserved.";

// localStorage can throw (private mode, blocked storage), so reads and writes are guarded.
const store = {
  get(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : JSON.parse(value);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  },
};

const state = {
  books: [],                                  // [{ name, chapters: [[verse text]] }] from kjv.json
  translation: store.get("translation", "WEB"),
  order: store.get("order", "canon"),         // "canon" (the printed order) or "chrono" (chronological, chrono.js)
  book: store.get("book", 0),
  chapter: store.get("chapter", 0),
  verse: store.get("verse", 1),               // last verse at the top of the screen
  esvKey: store.get("esvKey", ""),
  sharedEsvKey: "",                           // from the group database once approved; never saved on the device
  sharedNivKey: "",                           // API.Bible key (NIV, NASB, NTV), same rules as the ESV key
  tempBookmark: store.get("tempBookmark", null),   // { book, chapter, verse, created } — unnamed, replaced by the next tap
  bookmarks: store.get("bookmarks", []),           // [{ id, name, notes, book, chapter, verse, created }]
  positionUpdated: store.get("positionUpdated", 0),   // timestamps let the newest device win when syncing
  bookmarksUpdated: store.get("bookmarksUpdated", 0),
  progress: store.get("progress", { marks: {}, reset: 0 }),   // chronological passages read (see Reading progress)
};

// connect.js listens for these to sync with the group database.
const emit = (name, detail) => window.dispatchEvent(new CustomEvent(`bible:${name}`, { detail }));
const esvCache = new Map();                   // in-memory only, per ESV API terms

// Public-domain translations bundled with the app (and cached by sw.js for offline use).
const BUNDLED = { GN: "gn.json", WEB: "web.json", ASV: "asv.json", RST: "rst.json" };

// The Russian Synodal (rst.json) was converted to English (KJV) verse numbering so places, bookmarks
// and family notes line up across translations. Book names show in Russian, and Psalms also show the
// Synodal number Russian readers know (English Psalm 23 is Synodal 22).
const RUSSIAN_BOOKS = ("Бытие|Исход|Левит|Числа|Второзаконие|Иисус Навин|Судьи|Руфь|1 Царств|2 Царств|3 Царств|" +
  "4 Царств|1 Паралипоменон|2 Паралипоменон|Ездра|Неемия|Есфирь|Иов|Псалтирь|Притчи|Екклесиаст|Песнь песней|" +
  "Исаия|Иеремия|Плач Иеремии|Иезекииль|Даниил|Осия|Иоиль|Амос|Авдий|Иона|Михей|Наум|Аввакум|Софония|Аггей|" +
  "Захария|Малахия|От Матфея|От Марка|От Луки|От Иоанна|Деяния|Римлянам|1 Коринфянам|2 Коринфянам|Галатам|" +
  "Ефесянам|Филиппийцам|Колоссянам|1 Фессалоникийцам|2 Фессалоникийцам|1 Тимофею|2 Тимофею|Титу|Филимону|" +
  "Евреям|Иакова|1 Петра|2 Петра|1 Иоанна|2 Иоанна|3 Иоанна|Иуды|Откровение").split("|");
// The NTV (Spanish) shows Spanish book names; its verse numbers are the English ones.
const SPANISH_BOOKS = ("Génesis|Éxodo|Levítico|Números|Deuteronomio|Josué|Jueces|Rut|1 Samuel|2 Samuel|1 Reyes|2 Reyes|" +
  "1 Crónicas|2 Crónicas|Esdras|Nehemías|Ester|Job|Salmos|Proverbios|Eclesiastés|Cantar de los Cantares|Isaías|" +
  "Jeremías|Lamentaciones|Ezequiel|Daniel|Oseas|Joel|Amós|Abdías|Jonás|Miqueas|Nahúm|Habacuc|Sofonías|Hageo|" +
  "Zacarías|Malaquías|Mateo|Marcos|Lucas|Juan|Hechos|Romanos|1 Corintios|2 Corintios|Gálatas|Efesios|Filipenses|" +
  "Colosenses|1 Tesalonicenses|2 Tesalonicenses|1 Timoteo|2 Timoteo|Tito|Filemón|Hebreos|Santiago|1 Pedro|2 Pedro|" +
  "1 Juan|2 Juan|3 Juan|Judas|Apocalipsis").split("|");
const BOOK_NAMES = { RST: RUSSIAN_BOOKS, NTV: SPANISH_BOOKS };
let synodalPsalms = null;   // English psalm number -> Synodal number, once rst.json has loaded
const PSALMS = 18;

function bookName(book) {
  return BOOK_NAMES[state.translation]?.[book] ?? state.books[book].name;
}
function chapterLabel(book, chapter) {
  const synodal = state.translation === "RST" && book === PSALMS && synodalPsalms?.[chapter];
  return `${bookName(book)} ${chapter + 1}` + (synodal && synodal !== chapter + 1 ? ` (${synodal})` : "");
}
const bundled = new Map();                    // code -> Promise of books

// The chronological order as a list of passages (verses from-to of one chapter), each knowing its era
// (built from chrono.js). A range that runs into the next chapter becomes one passage per chapter.
const chrono = { eras: [], list: [], at: new Map() };   // at: "book,chapter" -> the chapter's passages, by verse
const chapterEnd = (book, chapter) => state.books[book].chapters[chapter].length;
function chapterParts(book, range) {
  const [a, z] = range.trim().split("-");
  const [c1, v1] = a.split(":").map(Number);
  let c2, v2;
  if (z === undefined) [c2, v2] = [c1, v1];                        // 5 or 5:3
  else if (z.includes(":")) [c2, v2] = z.split(":").map(Number);   // 5:3-6:2
  else if (v1 !== undefined) [c2, v2] = [c1, Number(z)];           // 5:3-9
  else c2 = Number(z);                                             // 5-7
  const parts = [];
  for (let c = c1; c <= c2; c++) {
    parts.push({ chapter: c - 1, from: c === c1 && v1 ? v1 : 1,
      to: c === c2 && v2 ? v2 : chapterEnd(book, c - 1) });
  }
  return parts;
}
function buildChrono() {
  CHRONO_ERAS.forEach(([title, readings], era) => {
    const start = chrono.list.length;
    for (const part of readings.split(";")) {
      const [, abbreviation, ranges] = part.trim().match(/^(\S+) (.+)$/);
      const book = CHRONO_ABBREVIATIONS.indexOf(abbreviation);
      for (const range of ranges.split(",")) {
        for (const { chapter, from, to } of chapterParts(book, range)) {
          const last = chrono.list.at(-1);
          // Pieces that simply continue each other read as one passage.
          if (last && last.era === era && last.book === book && last.chapter === chapter && last.to + 1 === from) last.to = to;
          else chrono.list.push({ book, chapter, from, to, era });
        }
      }
    }
    chrono.eras.push({ title, start, end: chrono.list.length });
  });
  chrono.list.forEach((p, i) => {
    const key = `${p.book},${p.chapter}`;
    if (!chrono.at.has(key)) chrono.at.set(key, []);
    chrono.at.get(key).push(i);
  });
  for (const places of chrono.at.values()) places.sort((a, b) => chrono.list[a].from - chrono.list[b].from);
}
const chronological = () => state.order === "chrono";
// The passage holding this verse (the screen shows one passage at a time in chronological order).
function chronoPlace(book = state.book, chapter = state.chapter, verse = state.verse) {
  const places = chrono.at.get(`${book},${chapter}`) ?? [0];
  return places.findLast((i) => chrono.list[i].from <= verse) ?? places[0];
}
// What's on screen: the current passage, or in the usual order the whole chapter.
function passage(book = state.book, chapter = state.chapter, verse = state.verse) {
  if (chronological()) return chrono.list[chronoPlace(book, chapter, verse)];
  return { book, chapter, from: 1, to: chapterEnd(book, chapter) };
}
// The chapter's last verse in KJV numbering; a translation with an extra verse there still shows it.
const inPassage = (p, verse) => verse >= p.from && (verse <= p.to || p.to === chapterEnd(p.book, p.chapter));
function passageLabel(p) {
  const label = chapterLabel(p.book, p.chapter);
  if (p.from === 1 && p.to === chapterEnd(p.book, p.chapter)) return label;
  return `${label}:${p.from}` + (p.to > p.from ? `–${p.to}` : "");
}
const samePassage = (a, b) => a.book === b.book && a.chapter === b.chapter && a.from === b.from;

/* ---------- Reading progress (chronological) ---------- */

// Each passage gets a mark when it's finished (moved past, or listened to the end): a time, negative when
// marked unread again. "Start over" sets reset; marks older than it no longer count. Devices merge by keeping
// the newer of two marks, so the order things sync in doesn't matter.
const passageKey = (p) => `${p.book}_${p.chapter}_${p.from}`;
const isRead = (p) => (state.progress.marks[passageKey(p)] ?? 0) > state.progress.reset;
function mergeProgress(a, b) {
  const reset = Math.max(a?.reset ?? 0, b?.reset ?? 0), marks = {};
  for (const m of [a?.marks ?? {}, b?.marks ?? {}]) {
    for (const [key, t] of Object.entries(m)) {
      if (Math.abs(t) > reset && Math.abs(t) > Math.abs(marks[key] ?? 0)) marks[key] = t;
    }
  }
  return { marks, reset };
}
function saveProgress() {
  store.set("progress", state.progress);
  emit("progress");
}
function markRead(p, read = true) {
  if (isRead(p) === read) return;
  const key = passageKey(p);
  const t = Math.max(Date.now(), Math.abs(state.progress.marks[key] ?? 0) + 1, state.progress.reset + 1);
  state.progress.marks[key] = read ? t : -t;
  saveProgress();
}
// Moving on from a passage (swipe, the next button, or the audio finishing it) counts it as read.
const finished = (p) => { if (chronological() && p) markRead(p); };
function progressCounts(from = 0, to = chrono.list.length) {
  let done = 0, verses = 0;
  for (let i = from; i < to; i++) {
    const p = chrono.list[i];
    if (isRead(p)) { done++; verses += p.to - p.from + 1; }
  }
  return { done, total: to - from, verses };
}

function loadBundled(code) {
  if (!bundled.has(code)) {
    bundled.set(code, fetch(BUNDLED[code]).then((r) => r.json()).then((books) => {
      if (code === "RST") synodalPsalms = books[PSALMS].synodalChapters;
      return books;
    }).catch((error) => {
      bundled.delete(code);
      throw new Error(`Couldn't load the ${code}. Check your connection and try again.`);
    }));
  }
  return bundled.get(code);
}

const $ = (id) => document.getElementById(id);
const els = {
  title: $("title"), chapter: $("chapter"), bibleView: $("bibleView"),
  translationBtn: $("translationBtn"), translationMenu: $("translationMenu"),
  drawer: $("drawer"), scrim: $("scrim"), drawerBody: $("drawerBody"),
  drawerTitle: $("drawerTitle"), drawerBack: $("drawerBack"),
  settings: $("settings"), esvKey: $("esvKey"),
  bookmarkBtn: $("bookmarkBtn"), bookmarks: $("bookmarks"),
  bookmarkDialog: $("bookmarkDialog"), bookmarkDialogTitle: $("bookmarkDialogTitle"),
  bookmarkRef: $("bookmarkRef"), bookmarkName: $("bookmarkName"),
  bookmarkNotes: $("bookmarkNotes"), bookmarkDelete: $("bookmarkDelete"),
};

function escapeHTML(text) {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/* ---------- Offline licensed copies ---------- */

// Lockman permits a private family copy of the NASB 2020 (letter of Oct 28, 2026: up to 10 people,
// free, family only). The owner copies it into the private database once; each permitted person's
// devices keep it in IndexedDB, never in the public site's files or the service worker cache.
const offline = {};   // code -> { books, copied }

function idb(mode, work) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("bible-offline", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("translations");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction("translations", mode);
      const req = work(tx.objectStore("translations"));
      tx.oncomplete = () => { open.result.close(); resolve(req.result); };
      tx.onerror = () => { open.result.close(); reject(tx.error); };
    };
  });
}

async function loadOffline() {
  try {
    const saved = await idb("readonly", (store) => store.get("NASB"));
    if (saved?.books) offline.NASB = saved;
  } catch (error) { console.warn("Offline copies unavailable", error); }
}

// Everything in the Bible from API.Bible, chapter by chapter, for the owner's one-time copy.
// Not reported to FUMS: copying isn't reading. onProgress(done, total).
async function copyFromApi(code, onProgress) {
  const id = await apiBibleId(code);
  const books = state.books.map((b) => ({ name: b.name, chapters: b.chapters.map(() => null) }));
  const jobs = books.flatMap((b, bi) => b.chapters.map((_, ci) => [bi, ci]));
  let done = 0;
  const worker = async () => {
    for (let job; (job = jobs.shift());) {
      const [bi, ci] = job;
      for (let attempt = 1; ; attempt++) {
        try {
          const data = await apiBible(`/bibles/${id}/chapters/${BOOK_CODES[bi]}.${ci + 1}`, {
            "content-type": "text", "include-verse-numbers": "true", "include-titles": "false",
            "include-notes": "false", "include-chapter-numbers": "false",
          }, code, { report: false });
          books[bi].chapters[ci] = splitVerses(data.content);
          break;
        } catch (error) {
          if (attempt === 4) throw new Error(`Stopped at ${books[bi].name} ${ci + 1}: ${error.message}`);
          await new Promise((r) => setTimeout(r, 2000 * attempt));
        }
      }
      onProgress?.(++done, books.reduce((n, b) => n + b.chapters.length, 0));
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return books;
}

/* ---------- Loading chapters ---------- */

const getVerses = () => versesFor(state.translation, state.book, state.chapter);

async function versesFor(translation, book, chapter) {
  if (translation === "KJV") return state.books[book].chapters[chapter];
  if (offline[translation]) return offline[translation].books[book].chapters[chapter];
  if (BUNDLED[translation]) return (await loadBundled(translation))[book].chapters[chapter];
  if (isApiTranslation(translation)) return fetchApiChapter(translation, book, chapter);
  // In one-chapter books (Obadiah, Philemon, 2 and 3 John, Jude) the ESV reads "Jude 1" as verse 1,
  // so those are asked for by the book's name.
  const { name, chapters } = state.books[book];
  return fetchESV(chapters.length === 1 ? name : `${name} ${chapter + 1}`);
}

/* The NIV, NASB (2020) and NTV (Spanish) come from API.Bible (non-commercial Starter plan), using one shared key.
   Its terms allow keeping fewer than 500 consecutive verses, so chapters are cached in memory only,
   like the ESV. (The offline NASB is kept by Lockman's own permission; see "Offline licensed copies".) Web apps must report what's read through API.Bible's FUMS script (in index.html). */
const API_BIBLE = "https://rest.api.bible/v1";
const BOOK_CODES = ("GEN EXO LEV NUM DEU JOS JDG RUT 1SA 2SA 1KI 2KI 1CH 2CH EZR NEH EST JOB PSA PRO ECC SNG " +
  "ISA JER LAM EZK DAN HOS JOL AMO OBA JON MIC NAM HAB ZEP HAG ZEC MAL MAT MRK LUK JHN ACT ROM 1CO 2CO GAL " +
  "EPH PHP COL 1TH 2TH 1TI 2TI TIT PHM HEB JAS 1PE 2PE 1JN 2JN 3JN JUD REV").split(" ");
const API_TRANSLATIONS = {
  NIV: {
    find: (b) => /New International Version/i.test(b.name),
    copyright: "Scripture quotations taken from The Holy Bible, New International Version® NIV®. " +
      "Copyright © 1973, 1978, 1984, 2011 by Biblica, Inc.™ Used by permission. All rights reserved worldwide.",
  },
  NASB: {
    find: (b) => /New American Standard Bible 2020/i.test(b.name),   // never the 1995 edition
    // Wording from Lockman's permission letter (Oct 28, 2026); www.Lockman.org must be a working link.
    link: "https://www.Lockman.org",
    fixedNotice: true,
    copyright: "Scripture quotations taken from the New American Standard Bible® (NASB® 2020) Copyright © 1960, " +
      "1971, 1977, 1995, 2020 by The Lockman Foundation. Used by permission. All rights reserved.",
  },
  NTV: {
    language: "spa",
    find: (b) => /Nueva Traducci[oó]n Viviente/i.test(b.name) || b.abbreviation === "NTV",
    // Tyndale's standard notice; replaced by API.Bible's own copyright line once it loads.
    copyright: "Texto bíblico tomado de la Santa Biblia, Nueva Traducción Viviente, © Tyndale House Foundation, 2010. " +
      "Usado con permiso de Tyndale House Publishers, Inc., Carol Stream, Illinois 60188. Todos los derechos reservados.",
  },
};
for (const t of Object.values(API_TRANSLATIONS)) Object.assign(t, { bibleId: null, cache: new Map() });
const isApiTranslation = (code) => code in API_TRANSLATIONS;

function copyrightNotice(t) {
  const link = t.link ? ` <a href="${t.link}" target="_blank" rel="noopener">${t.link.replace("https://", "")}</a>` : "";
  return `<p class="copyright">${escapeHTML(t.copyright)}${link}</p>`;
}

async function apiBible(path, params = {}, code = state.translation, { report = true } = {}) {
  const key = state.sharedNivKey;
  if (!key) throw new Error(`Sign in on the Connection tab to read the ${code}.`);
  let response;
  try {
    response = await fetch(`${API_BIBLE}${path}?${new URLSearchParams(params)}`, { headers: { "api-key": key } });
  } catch {
    throw new Error(`Couldn't reach the ${code}. Reading the ${code} needs an internet connection.`);
  }
  if (response.status === 401 || response.status === 403) throw new Error(`The ${code} key was rejected. Ask the owner to check it.`);
  if (!response.ok) throw new Error(`Couldn't load this from the ${code}.`);
  const body = await response.json();
  const token = body.meta?.fumsToken ?? body.meta?.fumsId;
  if (report && token && window.fums) window.fums("trackView", token);
  return body.data;
}

// Finds this translation among the Bibles the key may use.
async function apiBibleId(code) {
  const t = API_TRANSLATIONS[code];
  if (t.bibleId) return t.bibleId;
  const found = (await apiBible("/bibles", { language: t.language ?? "eng" }, code)).find(t.find);
  if (!found) throw new Error(`The ${code} isn't enabled for this key yet. Add it in the API.Bible dashboard.`);
  t.bibleId = found.id;
  apiBible(`/bibles/${found.id}`, {}, code).then((b) => { if (b?.copyright && !t.fixedNotice) t.copyright = b.copyright; }).catch(() => {});
  return t.bibleId;
}

async function fetchApiChapter(code, book, chapter) {
  const t = API_TRANSLATIONS[code];
  const id = `${BOOK_CODES[book]}.${chapter + 1}`;
  if (t.cache.has(id)) return t.cache.get(id);
  const data = await apiBible(`/bibles/${await apiBibleId(code)}/chapters/${id}`, {
    "content-type": "text", "include-verse-numbers": "true", "include-titles": "false",
    "include-notes": "false", "include-chapter-numbers": "false",
  }, code);
  const verses = splitVerses(data.content);
  t.cache.set(id, verses);
  return verses;
}

async function fetchESV(reference) {
  const key = state.esvKey.trim() || state.sharedEsvKey;
  if (!key) throw new Error("Sign in on the Connection tab to read the ESV, or add your own free ESV API key in Settings.");
  if (esvCache.has(reference)) {
    const verses = esvCache.get(reference);
    esvCache.delete(reference);   // most recently read goes last, so it's dropped last
    esvCache.set(reference, verses);
    return verses;
  }

  const params = new URLSearchParams({
    q: reference,
    "include-passage-references": "false",
    "include-verse-numbers": "true",
    "include-first-verse-numbers": "true",
    "include-footnotes": "false",
    "include-headings": "false",
    "include-short-copyright": "false",
    "indent-paragraphs": "0",
    "indent-poetry": "false",
  });
  let response;
  try {
    response = await fetch(`https://api.esv.org/v3/passage/text/?${params}`, {
      headers: { Authorization: `Token ${key}` },
    });
  } catch {
    throw new Error("Couldn't reach the ESV. Check your internet connection.");
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error("The ESV API key was rejected. Check it in Settings.");
  }
  if (!response.ok) throw new Error("Couldn't load this chapter from the ESV.");

  const text = (await response.json()).passages?.[0] ?? "";
  const verses = splitVerses(text);
  esvCache.set(reference, verses);
  // The ESV API's terms allow keeping up to 500 verses, so the chapters read longest ago are let go.
  let kept = 0;
  for (const v of esvCache.values()) kept += v.length;
  for (const [ref, v] of esvCache) {
    if (kept <= 500 || ref === reference) break;
    esvCache.delete(ref);
    kept -= v.length;
  }
  return verses;
}

/** "[1] In the beginning... [2] The earth..." -> ["In the beginning...", "The earth..."] */
function splitVerses(text) {
  const verses = [];
  const parts = text.split(/\[(\d+)\]/);
  for (let i = 1; i < parts.length; i += 2) {
    verses[Number(parts[i]) - 1] = parts[i + 1].replace(/\s+/g, " ").trim();
  }
  return verses;
}

/* ---------- Translation notes (Good News) ---------- */

// Our translation comes with the notes made while translating it (tools/app_export.py): ordinary notes
// (KJV wording, manuscripts, measures, customs) and Original language notes (the Hebrew, Aramaic or Greek
// behind a word). A small mark after a verse opens them; notes on a whole chapter or book sit under the title.
const translationNotes = new Map();   // book -> Promise of { book: [note], chapters: {c: [note]}, verses: {"c:v": [note]} }
function notesFor(book) {
  if (!translationNotes.has(book)) {
    translationNotes.set(book, fetch(`gn-notes/${book}.json`).then((r) => r.json())
      .catch((error) => { translationNotes.delete(book); throw error; }));
  }
  return translationNotes.get(book);
}
const showingNotes = () => state.translation === "GN" && store.get("translationNotes", true);
const noteLanguage = (note) => note.o ? (note.t.match(/\((Greek|Hebrew|Aramaic)\b/)?.[1] ?? "") : "";
function noteMark(verse, notes) {
  const original = notes.some((n) => n.o);
  return `<button class="note-mark${original ? " original" : ""}" data-note="${verse}" ` +
    `aria-label="${notes.length} note${notes.length === 1 ? "" : "s"} on verse ${verse}">${original ? "α" : "†"}</button>`;
}
function noteHTML(note, book) {
  const kind = note.o ? `Original language${noteLanguage(note) ? ` · ${noteLanguage(note)}` : ""}` : "Note";
  return `<div class="tnote${note.o ? " original" : ""}"><div class="tnote-kind">${kind}` +
    (note.r ? ` · on ${escapeHTML(note.r)}` : "") + `</div><p>${formatNote(note.t, book)}</p></div>`;
}
function aboutSection(notes, here) {
  if (here.from !== 1) return "";
  const intro = state.chapter === 0 ? notes.book : [];
  const about = notes.chapters[state.chapter + 1] ?? [];
  if (!intro.length && !about.length) return "";
  const title = intro.length ? `About ${bookName(state.book)}` : state.book === PSALMS ? "About this psalm" : "About this chapter";
  return `<details class="about-notes"><summary>${title}</summary>` +
    [...intro, ...about].map((n) => noteHTML(n, state.book)).join("") + `</details>`;
}

// A note's lead ("Loved" (Greek agapao):) in bold, and Bible references in it made into links.
let referencePattern = null;
function formatNote(text, book) {
  let html = escapeHTML(text);
  const colon = html.indexOf(": ");
  if (colon > 0 && colon < 140) html = `<b>${html.slice(0, colon)}</b>${html.slice(colon)}`;
  if (!referencePattern) {
    const names = state.books.map((b) => b.name).concat("Psalm").sort((a, b) => b.length - a.length)
      .map((n) => n.replace(/ /g, "\\s+"));
    referencePattern = new RegExp(`\\b(${names.join("|")})\\s+(\\d+)(?::(\\d+)(?:-(\\d+)(?!:))?)?|(?<![\\w:])(\\d+):(\\d+)(?:-(\\d+)(?!:))?|([.;]\\s)`, "g");
  }
  let current = book;   // bare "48:22" means the book named last in the sentence, or the note's own
  return html.replace(referencePattern, (match, name, chapter, verse, verseEnd, bareChapter, bareVerse, bareEnd, stop, at, whole) => {
    if (stop) { current = book; return match; }
    let target = current;
    if (name) {
      target = name === "Psalm" ? PSALMS : state.books.findIndex((b) => b.name === name.replace(/\s+/g, " "));
      current = target;
    } else {
      // "1 Enoch 1:9" and the like: a number after a name that isn't a Bible book is not ours to link.
      const before = whole.slice(Math.max(0, at - 20), at);
      if (/[A-Z][a-z]+\s+$/.test(before) && !/\b(?:See|Compare|Also|And|In|At|From|To|Verse|Verses)\s+$/.test(before)) return match;
      [chapter, verse, verseEnd] = [bareChapter, bareVerse, bareEnd];
    }
    const c = Number(chapter) - 1, v = Number(verse ?? 1);
    if (!state.books[target]?.chapters[c]?.[v - 1]) return match;
    return `<button class="note-link" data-xref="${target},${c},${v},${Number(verseEnd ?? v)}">${match}</button>`;
  });
}

async function openNotes(verse) {
  const notes = (await notesFor(state.book))?.verses[`${state.chapter + 1}:${verse}`] ?? [];
  if (!notes.length) return;
  $("notesTitle").textContent = `Notes on ${bookName(state.book)} ${state.chapter + 1}:${verse}`;
  $("notesList").innerHTML = notes.map((n) => noteHTML(n, state.book)).join("") +
    `<p class="related-credit">Notes made while translating this version from the King James Version, ` +
    `checked against the Hebrew, Aramaic and Greek.</p>`;
  $("notesSheet").hidden = false;
  $("notesSheet").scrollTop = 0;
}
$("notesClose").addEventListener("click", () => { $("notesSheet").hidden = true; });
$("notesList").addEventListener("click", (event) => {
  const link = event.target.closest("[data-xref]");
  if (!link) return;
  $("notesSheet").hidden = true;
  goToRelated(link);
});

/* ---------- Rendering ---------- */

let renderToken = 0;

async function render({ restoreVerse = state.verse } = {}) {
  const token = ++renderToken;
  if (state.translation === "RST") await loadBundled("RST").catch(() => {});   // for Synodal psalm numbers
  if (token !== renderToken) return;
  const here = passage();
  const label = passageLabel(here);
  if (!els.bibleView.hidden) els.title.textContent = label;
  els.translationBtn.textContent = state.translation;
  document.title = `${label} · Bible`;

  let html;
  try {
    const [verses, related, notes] = await Promise.all([getVerses(), relatedFor(state.book),
      showingNotes() ? notesFor(state.book).catch(() => null) : null]);
    if (token !== renderToken) return;   // a newer chapter was requested meanwhile
    const era = chronological() ? chrono.eras[here.era].title : "";
    html = (era ? `<p class="era">Chronological · ${escapeHTML(era)}</p>` : "") +
      `<h2>${escapeHTML(label)}</h2>` + listenButton() + (notes ? aboutSection(notes, here) : "") +
      verses.map((text, i) => !text || !inPassage(here, i + 1) ? "" :
        `<p class="verse" id="v${i + 1}" data-verse="${i + 1}"><sup>${i + 1}</sup>${escapeHTML(text)}` +
        (notes?.verses[`${state.chapter + 1}:${i + 1}`] ? noteMark(i + 1, notes.verses[`${state.chapter + 1}:${i + 1}`]) : "") + `</p>`
      ).join("") +
      (state.translation === "ESV" ? `<p class="copyright">${ESV_COPYRIGHT}</p>` : "") +
      (isApiTranslation(state.translation) ? copyrightNotice(API_TRANSLATIONS[state.translation]) : "") +
      relatedSection(related?.[state.chapter], here);
  } catch (error) {
    if (token !== renderToken) return;
    html = `<div class="empty"><h2>Not available</h2><p>${escapeHTML(error.message)}</p></div>`;
  }
  els.chapter.innerHTML = html + navButtons();
  updateBookmarkBtn();
  emit("rendered");

  const target = $(`v${restoreVerse}`);
  if (target && restoreVerse > here.from) target.scrollIntoView({ block: "start" });
  else els.bibleView.scrollTop = 0;
}

// The passage before or after one (by default the one on screen): { book, chapter, from, to }.
function neighbor(step, { book, chapter, from } = passage()) {
  const { books } = state;
  if (chronological()) return chrono.list[chronoPlace(book, chapter, from) + step] ?? null;
  const next = chapter + step;
  const whole = (b, c) => ({ book: b, chapter: c, from: 1, to: chapterEnd(b, c) });
  if (next >= 0 && next < books[book].chapters.length) return whole(book, next);
  const nextBook = book + step;
  if (nextBook < 0 || nextBook >= books.length) return null;
  return whole(nextBook, step > 0 ? 0 : books[nextBook].chapters.length - 1);
}

function navButtons() {
  const prev = neighbor(-1), next = neighbor(1);
  return `<div class="nav-row">` +
    (prev ? `<button data-go="${prev.book},${prev.chapter},${prev.from}">‹ ${escapeHTML(passageLabel(prev))}</button>` : "") +
    `<span class="spacer"></span>` +
    (next ? `<button data-go="${next.book},${next.chapter},${next.from}" data-next>${escapeHTML(passageLabel(next))} ›</button>` : "") +
    `</div>`;
}

function goTo(book, chapter, verse = 1, { updated = Date.now() } = {}) {
  Object.assign(state, { book, chapter, verse, positionUpdated: updated });
  store.set("book", book);
  store.set("chapter", chapter);
  store.set("verse", verse);
  store.set("positionUpdated", updated);
  render({ restoreVerse: verse });
  emit("position");
}

/* ---------- Swiping between chapters ---------- */

// Swipe left for the next chapter, right for the previous one. A drag counts if it starts out within
// about 50° of sideways (a thumb's swipe curves); from then on the page follows the finger and scrolling is held off. It turns after
// 80 px, or on a quick flick; a short slow drag springs back. Screen edges are left to Safari (back/forward).
const swipe = { id: null, x: 0, y: 0, dx: 0, t: 0, sideways: null, turning: false, justSwiped: false };
const EDGE = 20;
const calm = matchMedia("(prefers-reduced-motion: reduce)");
const slide = (x, ms) => {
  els.chapter.style.transition = ms && !calm.matches ? `transform ${ms}ms ease-out, opacity ${ms}ms ease-out` : "none";
  els.chapter.style.transform = x ? `translateX(${x}px)` : "";
  els.chapter.style.opacity = x ? Math.max(0.3, 1 - Math.abs(x) / innerWidth) : "";
};
const settled = () => new Promise((done) => setTimeout(done, calm.matches ? 0 : 180));

els.bibleView.addEventListener("touchstart", (event) => {
  if (event.touches.length !== 1 || swipe.turning) return void (swipe.id = null);
  const touch = event.touches[0];
  if (touch.clientX < EDGE || touch.clientX > innerWidth - EDGE) return void (swipe.id = null);
  Object.assign(swipe, { id: touch.identifier, x: touch.clientX, y: touch.clientY, dx: 0, t: event.timeStamp,
    sideways: null, justSwiped: false });
}, { passive: true });
els.bibleView.addEventListener("touchmove", (event) => {
  const touch = [...event.changedTouches].find((t) => t.identifier === swipe.id);
  if (!touch) return;
  if (event.touches.length > 1) { swipe.id = null; if (swipe.sideways) slide(0, 180); return; }   // pinch
  const dx = touch.clientX - swipe.x, dy = touch.clientY - swipe.y;
  if (swipe.sideways === null && Math.hypot(dx, dy) > 14) swipe.sideways = Math.abs(dx) > 0.8 * Math.abs(dy);   // within ~50°: thumbs arc
  if (!swipe.sideways) return;
  event.preventDefault();   // it's ours now: no scrolling while turning the page
  swipe.dx = dx;
  slide(neighbor(dx < 0 ? 1 : -1) ? dx : dx / 4);   // nothing past Genesis 1 or Revelation 22: only a little give
}, { passive: false });
async function swipeEnd(event) {
  if (![...event.changedTouches].some((t) => t.identifier === swipe.id)) return;
  swipe.id = null;
  if (!swipe.sideways) return;
  swipe.justSwiped = true;   // the click that follows the release is not a tap on a verse
  setTimeout(() => { swipe.justSwiped = false; }, 400);
  const next = neighbor(swipe.dx < 0 ? 1 : -1);
  const far = Math.abs(swipe.dx) >= Math.min(80, innerWidth / 5);
  const flick = Math.abs(swipe.dx) >= 25 && Math.abs(swipe.dx) / (event.timeStamp - swipe.t) > 0.25;   // px per ms, start to finish
  if (!next || !(far || flick)) return slide(0, 180);
  swipe.turning = true;
  const out = swipe.dx < 0 ? -innerWidth : innerWidth;
  slide(out, 160);
  await settled();
  const rendered = new Promise((done) => {
    addEventListener("bible:rendered", done, { once: true });
    setTimeout(done, 4000);
  });
  if (swipe.dx < 0) finished(passage());
  goTo(next.book, next.chapter, next.from);
  await rendered;
  slide(-out / 3, 0);
  els.chapter.getBoundingClientRect();   // start the slide-in from the other side
  slide(0, 180);
  await settled();
  els.chapter.style.transition = "";
  swipe.turning = false;
}
els.bibleView.addEventListener("touchend", swipeEnd);
els.bibleView.addEventListener("touchcancel", swipeEnd);   // a turn already dragged far enough still counts

els.chapter.addEventListener("click", (event) => {
  if (swipe.justSwiped) return void (swipe.justSwiped = false);
  if (event.target.closest("[data-listen]")) return toggleListening();
  const mark = event.target.closest("[data-note]");
  if (mark && !heldVerse && !selection) return void openNotes(Number(mark.dataset.note));
  const xref = event.target.closest("[data-xref]");
  if (xref) return goToRelated(xref);
  const verse = event.target.closest(".verse");
  if (verse) {
    if (heldVerse) return void (heldVerse = false);   // a long press already picked it
    const number = Number(verse.dataset.verse);
    if (selection) return stretchSelection(number);
    if (followingHere()) return void jumpToVerse(number);
    const hints = store.get("pickHints", 0);   // remind a few times how to pick verses
    if (hints < 3) {
      store.set("pickHints", hints + 1);
      toast("Hold a verse to pick it for a note, bookmark or copy.");
    }
    return;
  }
  const button = event.target.closest("[data-go]");
  if (!button) return;
  const [book, chapter, from] = button.dataset.go.split(",").map(Number);
  if (button.dataset.next !== undefined) finished(passage());
  goTo(book, chapter, from);
});

/* ---------- Listening (ESV audio) ---------- */

// The ESV read by David Cochran Heath, streamed chapter by chapter from Crossway's audio server.
// Offered to anyone who can read the ESV (shared or own key), whichever translation is on screen.
const audio = $("audio");
// A passage (verses from-to of a chapter) is played from its first verse; stop and seek are in seconds,
// once the verse timings are in: where the next passage starts, and where to jump when the recording loads.
const listening = { book: null, chapter: null, from: 1, to: 1, stop: null, seek: null, timings: null, verse: 0 };
const listeningHere = () => listening.book !== null && samePassage(listening, passage());
const isPlayingHere = () => listeningHere() && !audio.paused;
const canListen = () => !!(state.esvKey.trim() || state.sharedEsvKey);
const listenLabel = () => isPlayingHere() ? "❚❚ Pause" : state.translation === "ESV" ? "▶ Listen" : "▶ Listen (ESV)";

function listenButton() {
  if (!canListen()) return "";
  return `<button class="listen-btn" data-listen>${listenLabel()}</button>`;
}
function updateListenButton() {
  const button = els.chapter.querySelector("[data-listen]");
  if (button) button.textContent = listenLabel();
}

// "43003001-43003999" is John 3 (book 43, chapter 3, every verse).
const audioUrl = (book, chapter) => {
  const bbccc = String(book + 1).padStart(2, "0") + String(chapter + 1).padStart(3, "0");
  return `https://audio.esv.org/hw/mq/${bbccc}001-${bbccc}999.mp3`;
};

// Playback speed, kept on this device; a new chapter keeps it.
const SPEEDS = [1, 1.25, 1.5, 1.75, 2, 0.75];
let speed = store.get("audioSpeed", 1);
function applySpeed() {
  audio.defaultPlaybackRate = audio.playbackRate = speed;
  $("speedBtn").textContent = `${speed}×`;
}
$("speedBtn").addEventListener("click", () => {
  speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
  store.set("audioSpeed", speed);
  applySpeed();
});
audio.addEventListener("loadedmetadata", applySpeed);   // some browsers reset the speed for each new recording
applySpeed();

function listen({ book, chapter, from, to }) {
  Object.assign(listening, { book, chapter, from, to, stop: null, seek: null });
  audio.src = audioUrl(book, chapter);
  applySpeed();
  const whole = from === 1 && to === chapterEnd(book, chapter);
  const title = `${state.books[book].name} ${chapter + 1}` + (whole ? "" : `:${from}` + (to > from ? `–${to}` : ""));
  if (!whole) {
    verseTimings().then((timings) => {
      if (listening.book !== book || listening.chapter !== chapter || listening.from !== from) return;
      const starts = timings?.[book]?.[chapter] ?? [];
      const start = starts.slice(from - 1).find((t) => t !== null);
      const stop = starts.slice(to).find((t) => t !== null);   // the first verse after the passage
      if (stop !== undefined) listening.stop = stop / 10;
      if (from > 1 && start !== undefined) {
        if (audio.readyState >= 1) audio.currentTime = start / 10;
        else listening.seek = start / 10;
      }
    });
  }
  $("playerTitle").textContent = title;
  $("player").hidden = false;
  document.body.classList.add("listening");
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title, artist: "David Cochran Heath", album: "ESV Bible",
    });
  }
  audio.play().catch((error) => { if (error.name !== "AbortError") toast("Couldn't play the audio. Check your connection."); });
}

function toggleListening() {
  if (listeningHere()) {
    if (audio.paused) audio.play().catch(() => toast("Couldn't play the audio. Check your connection."));
    else audio.pause();
  } else listen(passage());
}

function stopListening() {
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  Object.assign(listening, { book: null, chapter: null });
  followAlong();
  $("player").hidden = true;
  document.body.classList.remove("listening");
  updateListenButton();
}

// Next or previous chapter (or passage, in chronological order); the reader follows along if it was
// showing the one being read.
function listenStep(step) {
  if (listening.book === null) return;
  const following = listeningHere();
  const next = neighbor(step, listening);
  if (step > 0) finished(passage(listening.book, listening.chapter, listening.from));
  if (!next) return stopListening();
  if (following) goTo(next.book, next.chapter, next.from);
  listen(next);
}
audio.addEventListener("loadedmetadata", () => {
  if (listening.seek === null) return;
  audio.currentTime = listening.seek;
  listening.seek = null;
});
// A passage that ends mid-chapter moves on where the next verse starts.
audio.addEventListener("timeupdate", () => {
  if (listening.stop !== null && audio.currentTime >= listening.stop) listenStep(1);
});

// Follow along: highlight the verse being read. Verse start times come from the recordings' own
// chapter marks (tools/esv_audio_timings.py), fetched the first time someone listens.
function verseTimings() {
  listening.timings ??= fetch("esv-audio-timings.json").then((r) => r.json()).catch(() => { listening.timings = null; return null; });
  return listening.timings;
}
const isVisible = (el) => {
  const view = els.bibleView.getBoundingClientRect(), box = el.getBoundingClientRect();
  return box.bottom > view.top && box.top < view.bottom;
};
// The passage on screen is the one being read (Russian verse numbers differ, so not there).
const followingHere = () => listeningHere() && state.translation !== "RST";

async function followAlong() {
  const here = followingHere();
  let verse = 0;
  if (here) {
    const starts = (await verseTimings())?.[listening.book]?.[listening.chapter] ?? [];
    const now = audio.currentTime * 10;
    starts.forEach((start, i) => { if (start !== null && start <= now) verse = i + 1; });
  }
  if (verse === listening.verse && els.chapter.querySelector(".verse.reading")) return;
  const old = els.chapter.querySelector(".verse.reading");
  old?.classList.remove("reading");
  listening.verse = verse;
  const el = verse && $(`v${verse}`);
  if (!el) return;
  el.classList.add("reading");
  // Keep it on screen, unless the reader has scrolled away to look at something else.
  if ((!old || isVisible(old)) && !isVisible(el)) el.scrollIntoView({ block: "center", behavior: "smooth" });
}
audio.addEventListener("timeupdate", followAlong);

// Holding a verse picks it (see Picking verses). While listening, tapping a verse plays from there.
async function jumpToVerse(verse) {
  const starts = (await verseTimings())?.[listening.book]?.[listening.chapter] ?? [];
  const start = starts.slice(verse - 1).find((t) => t !== null);   // a verse the ESV omits: the next one
  if (start === undefined) return toast("Couldn't find that verse in the recording.");
  audio.currentTime = start / 10;
  if (audio.paused) audio.play().catch(() => toast("Couldn't play the audio. Check your connection."));
  followAlong();
}

let heldVerse = false, holdTimer = null, holdStart = null;   // holdStart: [x, y, the finger or pointer holding]
els.chapter.addEventListener("pointerdown", (event) => {
  const verse = event.target.closest(".verse");
  heldVerse = false;
  if (!verse) return;
  holdStart = [event.clientX, event.clientY, event.pointerId];
  holdTimer = setTimeout(() => {
    heldVerse = true;
    const number = Number(verse.dataset.verse);
    pick(number, number);   // a new pick (while changing a note's verses, it starts over there)
  }, 500);
});
els.chapter.addEventListener("pointermove", (event) => {
  if (holdTimer && event.pointerId === holdStart[2] && Math.hypot(event.clientX - holdStart[0], event.clientY - holdStart[1]) > 10) clearTimeout(holdTimer);
});
for (const type of ["pointerup", "pointercancel"]) els.chapter.addEventListener(type, () => clearTimeout(holdTimer));
els.chapter.addEventListener("contextmenu", (event) => { if (event.target.closest(".verse")) event.preventDefault(); });
window.addEventListener("bible:rendered", () => { listening.verse = 0; if (listening.book !== null) followAlong(); });

audio.addEventListener("ended", () => listenStep(1));
audio.addEventListener("play", updateListenButton);
audio.addEventListener("pause", updateListenButton);
audio.addEventListener("error", () => { if (audio.getAttribute("src")) toast("Couldn't play the audio. Listening needs an internet connection."); });
$("playerClose").addEventListener("click", stopListening);
if ("mediaSession" in navigator) {
  navigator.mediaSession.setActionHandler("nexttrack", () => listenStep(1));
  navigator.mediaSession.setActionHandler("previoustrack", () => listenStep(-1));
}

/* ---------- Picking verses ---------- */

// Hold a verse to pick it, then tap others to stretch the pick to them; tapping an end verse lets it go.
// The bar at the bottom acts on the pick: a note, a bookmark, copy, or compare translations.
// Changing the verses of a note or bookmark is the same pick, started from its verses, with Save and Cancel.
let selection = null;   // { book, chapter, start, end, changing?: { label, save(start, end) } }
const bar = $("verseBar");
// "John 3:16" or "John 3:16–18", always with the verse (unlike reference(), which leaves out verse 1).
const verseRef = (b, name = state.books[b.book]?.name ?? "?") =>
  `${name} ${b.chapter + 1}:${b.verse}` + (b.verseEnd > b.verse ? `–${b.verseEnd}` : "");
const pickRef = (s, name) => verseRef({ book: s.book, chapter: s.chapter, verse: s.start, verseEnd: s.end }, name);

function pick(start, end, changing = selection?.changing) {
  selection = { book: state.book, chapter: state.chapter, start, end, changing };
  showSelection();
}

function stretchSelection(verse) {
  let { start, end } = selection;
  if (verse < start) start = verse;
  else if (verse > end) end = verse;
  else if (start === end) return clearSelection();   // the only verse: let it go
  else if (verse === start) start++;
  else end = verse === end ? end - 1 : verse;        // the last verse, or one inside: end there
  pick(start, end);
}

function clearSelection() {
  selection = null;
  showSelection();
}

function showSelection() {
  els.chapter.querySelectorAll(".verse.picked").forEach((v) => v.classList.remove("picked"));
  document.body.classList.toggle("picking", !!selection);
  bar.hidden = !selection;
  if (!selection) return;
  for (let v = selection.start; v <= selection.end; v++) $(`v${v}`)?.classList.add("picked");
  const ref = escapeHTML(pickRef(selection, bookName(selection.book)));
  if (selection.changing) {
    bar.innerHTML = `<div class="bar-ref">${escapeHTML(selection.changing.label)}: ${ref}</div>` +
      `<div class="bar-actions"><button data-act="cancel">Cancel</button><button data-act="save" class="bar-main">Save verses</button></div>`;
    return;
  }
  const notes = window.bible.noteCount?.(selection) ?? 0;
  bar.innerHTML = `<div class="bar-top"><div class="bar-ref">${ref}</div>` +
    `<button data-act="close" class="bar-close" aria-label="Done">✕</button></div><div class="bar-actions">` +
    `<button data-act="note">${notes ? `Notes (${notes})` : "Note"}</button><button data-act="bookmark">Bookmark</button>` +
    `<button data-act="copy">Copy</button><button data-act="compare">Compare</button><button data-act="related">Related</button></div>`;
}

bar.addEventListener("click", (event) => {
  const act = event.target.closest("[data-act]")?.dataset.act;
  const s = selection;
  if (!act || !s) return;
  if (act === "copy") return copyVerses(s);
  clearSelection();
  if (act === "save") s.changing.save(s.start, s.end);
  else if (act === "note") emit("notes", { book: s.book, chapter: s.chapter, verse: s.start, verseEnd: s.end });
  else if (act === "bookmark") openBookmarkDialog("new", s);
  else if (act === "compare") openCompare(s);
  else if (act === "related") openRelated(s);
});
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && selection && !document.querySelector("dialog[open]")) clearSelection(); });
// A new chapter ends the pick (and a change of verses, which stays within its chapter).
window.addEventListener("bible:rendered", () => {
  if (selection && (selection.book !== state.book || selection.chapter !== state.chapter)) clearSelection();
  else showSelection();
});

// Change which verses a note or bookmark is on: back in its chapter with its verses picked.
function changeVerses(item, label, save) {
  showTab("bibleView");
  const begin = () => {
    pick(item.verse, item.verseEnd ?? item.verse, { label, save });
    $(`v${item.verse}`)?.scrollIntoView({ block: "center" });
  };
  if (item.book === state.book && item.chapter === state.chapter) return begin();
  addEventListener("bible:rendered", begin, { once: true });
  goTo(item.book, item.chapter, item.verse);
}

// The words of a verse, without its number.
const verseText = (el) => [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join("");

function copyVerses(s) {
  const several = s.end > s.start;
  const parts = [];
  for (let v = s.start; v <= s.end; v++) {
    const el = $(`v${v}`);
    if (el) parts.push((several ? `${v} ` : "") + verseText(el));
  }
  const text = `${parts.join(" ")}\n— ${pickRef(s, bookName(s.book))} (${state.translation})`;
  const done = () => { toast(`Copied ${pickRef(s, bookName(s.book))}`); clearSelection(); };
  const fallback = () => copyTheOldWay(text) ? done() : toast("Couldn't copy on this device.");
  // The clipboard call has to start right away, within the tap.
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, fallback);
  else fallback();
}
function copyTheOldWay(text) {
  const area = Object.assign(document.createElement("textarea"), { value: text, readOnly: true });
  area.style.cssText = "position:fixed;opacity:0";
  document.body.append(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  return ok;
}

/* ---------- Compare translations ---------- */

// The picked verses in every translation this person can read, the one on screen first.
// Tapping one switches to it. Licensed texts show their notices, as on their own pages.
let compareToken = 0;
const canRead = (code) => code in BUNDLED || code === "KJV" || !!offline[code] ||
  (code === "ESV" ? canListen() : !!state.sharedNivKey);   // NIV, NASB and NTV share the API.Bible key

function openCompare(s) {
  const token = ++compareToken;
  const codes = [state.translation, ...Object.keys(TRANSLATIONS).filter((c) => c !== state.translation)].filter(canRead);
  const missing = Object.keys(TRANSLATIONS).filter((c) => !canRead(c));
  $("compareTitle").textContent = pickRef(s);
  $("compareList").innerHTML = codes.map((code) =>
    `<button class="result compare-row" data-translation="${code}" data-verse="${s.start}">` +
    `<div class="ref">${code} <span class="compare-name">${escapeHTML(TRANSLATIONS[code])}</span></div>` +
    `<div class="snippet" id="compare-${code}"><span class="hint">Loading…</span></div></button>`
  ).join("") +
    (missing.length ? `<p class="hint compare-missing">Sign in on the Connection tab (once approved) to compare with the ${missing.join(", ")}.</p>` : "") +
    `<div id="compareNotices"></div>`;
  $("compare").hidden = false;
  $("compare").scrollTop = 0;
  const notices = [];
  codes.forEach(async (code) => {
    let html;
    try {
      const verses = await versesFor(code, s.book, s.chapter);
      const parts = [];
      for (let v = s.start; v <= s.end; v++) {
        if (verses[v - 1]) parts.push((s.end > s.start ? `<sup>${v}</sup>` : "") + escapeHTML(verses[v - 1]));
      }
      html = parts.join(" ") || `<span class="hint">Not in this translation</span>`;
      if (code === "ESV") notices.push(`<p class="copyright">${ESV_COPYRIGHT}</p>`);
      if (isApiTranslation(code)) notices.push(copyrightNotice(API_TRANSLATIONS[code]));
    } catch (error) {
      html = `<span class="hint">${escapeHTML(error.message)}</span>`;
    }
    if (token !== compareToken) return;
    $(`compare-${code}`).innerHTML = html;
    $("compareNotices").innerHTML = notices.join("");
  });
}
const closeCompare = () => { compareToken++; $("compare").hidden = true; };
$("compareClose").addEventListener("click", closeCompare);
$("compareList").addEventListener("click", (event) => {
  const row = event.target.closest("[data-translation]");
  if (!row || event.target.closest("a")) return;
  closeCompare();
  setTranslation(row.dataset.translation, Number(row.dataset.verse));
});

/* ---------- Related passages ---------- */

// OpenBible.info's cross references (CC BY), one small file per book (tools/cross_references.py),
// kept for offline use by sw.js. They use English verse numbers, like every translation in the app.
// Under each chapter: the strongest few for each verse. Related, on picked verses, shows more, with their words.
const relatedFiles = new Map();
function relatedFor(book) {
  if (!relatedFiles.has(book)) {
    relatedFiles.set(book, fetch(`xrefs/${book}.json`).then((r) => r.json()).catch(() => { relatedFiles.delete(book); return null; }));
  }
  return relatedFiles.get(book);
}
const relatedRef = ([book, chapter, verse, verseEnd]) => verseRef({ book, chapter, verse, verseEnd }, bookName(book));
const RELATED_CREDIT = `Related passages: <a href="https://www.openbible.info/labs/cross-references/" target="_blank" rel="noopener">OpenBible.info</a> (CC BY)`;

// { "16": [strong, [book, chapter, verse, verseEnd?], ...] } -> a folded list under the chapter
function relatedSection(links, here) {
  const rows = Object.entries(links ?? {}).map(([verse, [strong, ...to]]) => [Number(verse), to.slice(0, strong)])
    .filter(([verse, to]) => to.length && inPassage(here, verse)).sort((a, b) => a[0] - b[0]);
  const count = rows.reduce((n, [, to]) => n + to.length, 0);
  if (!count) return "";
  return `<details class="related"${store.get("relatedOpen", false) ? " open" : ""}><summary>Related passages (${count})</summary>` +
    rows.map(([verse, to]) => `<div class="related-row"><span class="related-verse">v. ${verse}</span> ` +
      to.map((t) => `<button data-xref="${t.join(",")}">${escapeHTML(relatedRef(t))}</button>`).join(" · ") + `</div>`).join("") +
    `<p class="related-credit">${RELATED_CREDIT}</p></details>`;
}
// Open or folded stays that way for the next chapters.
els.chapter.addEventListener("toggle", (event) => {
  if (event.target.matches?.("details.related")) store.set("relatedOpen", event.target.open);
}, true);

function goToRelated(button) {
  const [book, chapter, verse, verseEnd] = button.dataset.xref.split(",").map(Number);
  jumpTo(book, chapter, verse, verseEnd || verse);
}

// The picked verses' related passages, each with its words (in a translation that's on the device:
// this one, or else the WEB, so a list of passages doesn't send a stream of requests to the ESV or API.Bible).
let relatedToken = 0;
async function openRelated(s) {
  const token = ++relatedToken;
  const file = await relatedFor(s.book);
  const local = state.translation === "KJV" || state.translation in BUNDLED || offline[state.translation];
  const code = local ? state.translation : "WEB";
  const groups = [];
  for (let v = s.start; v <= s.end; v++) {
    const entry = file?.[s.chapter]?.[v];
    if (entry) groups.push([v, entry.slice(1)]);
  }
  $("relatedTitle").textContent = `Related to ${pickRef(s, bookName(s.book))}`;
  $("relatedList").innerHTML = !file ? `<p class="list-empty">Related passages need an internet connection the first time.</p>`
    : !groups.length ? `<p class="list-empty">No related passages are listed for ${escapeHTML(pickRef(s, bookName(s.book)))}.</p>`
    : groups.map(([v, to]) => (s.end > s.start ? `<div class="results-label">Verse ${v}</div>` : "") +
      to.map((t) => `<button class="result" data-xref="${t.join(",")}"><div class="ref">${escapeHTML(relatedRef(t))}</div>` +
        `<div class="snippet"></div></button>`).join("")).join("") +
      (code !== state.translation ? `<p class="hint related-note">The words are shown in the WEB.</p>` : "") +
      `<p class="hint related-note">${RELATED_CREDIT}</p>`;
  $("related").hidden = false;
  $("related").scrollTop = 0;
  for (const button of $("relatedList").querySelectorAll("[data-xref]")) {
    const [book, chapter, verse, verseEnd] = button.dataset.xref.split(",").map(Number);
    versesFor(code, book, chapter).then((verses) => {
      if (token !== relatedToken) return;
      button.querySelector(".snippet").textContent = verses.slice(verse - 1, verseEnd || verse).filter(Boolean).join(" ");
    }).catch(() => {});
  }
}
$("relatedClose").addEventListener("click", () => { $("related").hidden = true; });
$("relatedList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-xref]");
  if (!button) return;
  $("related").hidden = true;
  goToRelated(button);
});

/* ---------- Back to where I was ---------- */

// Jumping somewhere (a search result, a reference, a bookmark, a note) offers a way back to where
// you were reading. A string of jumps still leads back to where the first one started.
let backTo = null;   // { book, chapter, verse }
let flash = null;    // { start, end }: verses to light up briefly once the chapter shows

function jumpTo(book, chapter, verse = 1, verseEnd = verse) {
  saveVisibleVerse();
  const there = passage(book, chapter, verse);
  if (!samePassage(there, passage())) backTo ??= { book: state.book, chapter: state.chapter, verse: state.verse };
  if (backTo && samePassage(there, passage(backTo.book, backTo.chapter, backTo.verse))) backTo = null;   // back where it started anyway
  flash = { start: verse, end: verseEnd };
  showTab("bibleView");
  goTo(book, chapter, verse);
  showBack();
}

function showBack() {
  $("backBar").hidden = !backTo;
  document.body.classList.toggle("has-back", !!backTo);
  if (backTo) $("backBtn").textContent = `‹ Back to ${chapterLabel(backTo.book, backTo.chapter)}` + (backTo.verse > 1 ? `:${backTo.verse}` : "");
}
$("backBtn").addEventListener("click", () => {
  const to = backTo;
  backTo = null;
  showBack();
  goTo(to.book, to.chapter, to.verse);
});
$("backClose").addEventListener("click", () => { backTo = null; showBack(); });

window.addEventListener("bible:rendered", () => {
  if (!flash) return;
  for (let v = flash.start; v <= flash.end; v++) $(`v${v}`)?.classList.add("flash");
  flash = null;
});

/* ---------- Remembering the reading position ---------- */

let scrollTimer;
els.bibleView.addEventListener("scroll", () => {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(saveVisibleVerse, 150);
}, { passive: true });

function saveVisibleVerse() {
  const top = els.bibleView.getBoundingClientRect().top;
  for (const verse of els.chapter.querySelectorAll(".verse")) {
    if (verse.getBoundingClientRect().bottom > top + 8) {
      const number = Number(verse.dataset.verse);
      if (number === state.verse) return;
      state.verse = number;
      state.positionUpdated = Date.now();
      store.set("verse", state.verse);
      store.set("positionUpdated", state.positionUpdated);
      emit("position");
      return;
    }
  }
}

/* ---------- Table of contents drawer ---------- */

function openDrawer() {
  showContents();
  els.scrim.hidden = false;
  els.drawer.classList.add("open");
  els.drawer.setAttribute("aria-hidden", "false");
}

function closeDrawer() {
  els.scrim.hidden = true;
  els.drawer.classList.remove("open");
  els.drawer.setAttribute("aria-hidden", "true");
}

const showContents = () => chronological() ? showEras() : showBooks();

function showBooks() {
  delete els.drawerBody.dataset.era;
  els.drawerTitle.textContent = "Books";
  els.drawerBack.hidden = true;
  const rows = (from, to) => state.books.slice(from, to).map((b, i) =>
    `<button class="book-row${from + i === state.book ? " current" : ""}" data-book="${from + i}">` +
    `${escapeHTML(bookName(from + i))}<span class="count">${b.chapters.length}</span></button>`
  ).join("");
  els.drawerBody.innerHTML =
    `<div class="section-label">Old Testament</div>${rows(0, 39)}` +
    `<div class="section-label">New Testament</div>${rows(39, 66)}` +
    `<button class="help-link" data-help>How to use this app</button>`;
  els.drawerBody.querySelector(".current")?.scrollIntoView({ block: "center" });
}

// Chronological: the eras, then an era's chapters in reading order.
function showEras() {
  delete els.drawerBody.dataset.era;
  els.drawerTitle.textContent = "Chronological";
  els.drawerBack.hidden = true;
  const current = passage().era;
  const rows = (from, to) => chrono.eras.slice(from, to).map((e, i) => {
    const { done, total } = progressCounts(e.start, e.end);
    return `<button class="book-row era-row${from + i === current ? " current" : ""}${done === total ? " done" : ""}" ` +
      `data-era="${from + i}" style="--done:${(100 * done / total).toFixed(1)}%">${escapeHTML(e.title)}` +
      `<span class="count">${done === total ? "✓" : done ? `${done} / ${total}` : total}</span></button>`;
  }).join("");
  const nt = chrono.eras.findIndex((e) => chrono.list[e.start].book >= 39);
  const all = progressCounts(), verses = chrono.list.reduce((n, p) => n + p.to - p.from + 1, 0);
  const percent = all.verses && Math.max(1, Math.floor(100 * all.verses / verses));
  els.drawerBody.innerHTML =
    `<div class="progress-line">${all.done ? `${percent}% of the Bible read · ${all.done.toLocaleString()} of ` +
      `${all.total.toLocaleString()} passages` : `${all.total.toLocaleString()} passages · each one you finish is marked here`}</div>` +
    `<div class="section-label">Old Testament</div>${rows(0, nt)}` +
    `<div class="section-label">New Testament</div>${rows(nt)}` +
    (all.done ? `<button class="help-link" data-reset>Start over (clear reading progress)</button>` : "") +
    `<button class="help-link" data-help>How to use this app</button>`;
  els.drawerBody.querySelector(".current")?.scrollIntoView({ block: "center" });
}

function showEra(era, { keepScroll = false } = {}) {
  const { title, start, end } = chrono.eras[era];
  const scroll = els.drawerBody.scrollTop;
  els.drawerTitle.textContent = title;
  els.drawerBack.textContent = "‹ Eras";
  els.drawerBack.hidden = false;
  els.drawerBody.innerHTML = `<div class="chapter-grid era-grid">` +
    chrono.list.slice(start, end).map((p) =>
      `<button class="${samePassage(p, passage()) ? "current" : ""}${isRead(p) ? " read" : ""}" data-chapter="${p.chapter}" ` +
      `data-book="${p.book}" data-verse="${p.from}" data-place="${chrono.list.indexOf(p)}">${escapeHTML(passageLabel(p))}</button>`
    ).join("") + `</div>` + `<p class="drawer-hint">Hold a passage to mark it read or unread.</p>`;
  els.drawerBody.dataset.era = era;
  if (keepScroll) return void (els.drawerBody.scrollTop = scroll);
  els.drawerBody.scrollTop = 0;
  els.drawerBody.querySelector(".current")?.scrollIntoView({ block: "center" });
}

function showChapters(book) {
  delete els.drawerBody.dataset.era;
  els.drawerTitle.textContent = bookName(book);
  els.drawerBack.textContent = "‹ Books";
  els.drawerBack.hidden = false;
  els.drawerBody.innerHTML = `<div class="chapter-grid">` +
    state.books[book].chapters.map((_, c) =>
      `<button class="${book === state.book && c === state.chapter ? "current" : ""}" data-chapter="${c}" data-book="${book}">${c + 1}</button>`
    ).join("") + `</div>`;
  els.drawerBody.scrollTop = 0;
}

els.drawerBody.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.help !== undefined) { closeDrawer(); $("help").hidden = false; $("help").scrollTop = 0; return; }
  if (heldPassage) return void (heldPassage = false);   // a hold already marked it
  if (button.dataset.reset !== undefined) {
    if (!confirm("Clear your chronological reading progress on all your devices? Your place, bookmarks and notes stay.")) return;
    state.progress = { marks: {}, reset: Math.max(Date.now(), state.progress.reset + 1) };
    saveProgress();
    return showEras();
  }
  if (button.dataset.era !== undefined) return showEra(Number(button.dataset.era));
  const book = Number(button.dataset.book);
  if (button.dataset.chapter === undefined) return showChapters(book);
  goTo(book, Number(button.dataset.chapter), Number(button.dataset.verse ?? 1));
  closeDrawer();
});
// Holding a passage in an era's list marks it read or unread.
let heldPassage = false, passageTimer = null, holdScroll = 0;
els.drawerBody.addEventListener("pointerdown", (event) => {
  const button = event.target.closest("[data-place]");
  heldPassage = false;
  clearTimeout(passageTimer);
  if (!button) return;
  holdScroll = els.drawerBody.scrollTop;
  passageTimer = setTimeout(() => {
    heldPassage = true;
    const p = chrono.list[Number(button.dataset.place)];
    markRead(p, !isRead(p));
    toast(`${passageLabel(p)}: marked ${isRead(p) ? "read" : "unread"}.`);
    showEra(Number(els.drawerBody.dataset.era), { keepScroll: true });
  }, 500);
});
for (const type of ["pointerup", "pointercancel", "pointerleave"]) els.drawerBody.addEventListener(type, () => clearTimeout(passageTimer));
els.drawerBody.addEventListener("scroll", () => {   // a finger scrolling the list isn't holding a passage
  if (Math.abs(els.drawerBody.scrollTop - holdScroll) > 10) clearTimeout(passageTimer);
}, { passive: true });
els.drawerBody.addEventListener("contextmenu", (event) => { if (event.target.closest("[data-place]")) event.preventDefault(); });
$("menuBtn").addEventListener("click", openDrawer);
$("helpClose").addEventListener("click", () => { $("help").hidden = true; });
$("drawerClose").addEventListener("click", closeDrawer);
els.drawerBack.addEventListener("click", showContents);
els.scrim.addEventListener("click", closeDrawer);

/* ---------- Translation menu and settings ---------- */

function toggleTranslationMenu(show = els.translationMenu.hidden) {
  if (show) {
    els.translationMenu.innerHTML = Object.entries(TRANSLATIONS).map(([code, name]) =>
      `<button data-translation="${code}" role="menuitem">${name}<span class="check">${code === state.translation ? "✓" : ""}</span></button>`
    ).join("") + `<hr><button data-settings role="menuitem">Settings…</button>`;
  }
  els.translationMenu.hidden = !show;
}

els.translationBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleDisplayMenu(false);
  toggleTranslationMenu();
});
document.addEventListener("click", (event) => {
  if (!els.translationMenu.hidden && !els.translationMenu.contains(event.target)) toggleTranslationMenu(false);
});
els.translationMenu.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  toggleTranslationMenu(false);
  if (button.dataset.settings !== undefined) {
    els.esvKey.value = state.esvKey;
    els.settings.showModal();
    // The offline cache is named after the app version (see sw.js), so this shows which one is running.
    caches.keys().then((keys) => {
      $("appVersion").textContent = `App version: ${keys.find((k) => k.startsWith("bible-"))?.replace("bible-", "") ?? "not installed"}`;
    }).catch(() => {});
    return;
  }
  saveVisibleVerse();
  setTranslation(button.dataset.translation);
});

function setTranslation(code, restoreVerse = state.verse) {
  state.translation = code;
  store.set("translation", code);
  render({ restoreVerse });
  if (!$("search").hidden) { $("searchInput").placeholder = `Search the ${code}`; runSearch($("searchInput").value); }
}
els.settings.addEventListener("close", () => {
  const key = els.esvKey.value.trim();
  if (key === state.esvKey) return;
  state.esvKey = key;
  store.set("esvKey", key);
  esvCache.clear();
  if (state.translation === "ESV") render();
});

/* ---------- Search ---------- */

const PAGE = 100;
const search = { query: "", results: [], shown: 0, token: 0, esvPage: 0, esvTotal: 0, exact: null, words: null };

// Small words that don't help find a verse when matching loosely.
const STOP_WORDS = new Set(("a an and are as at be but by for from he her him his i in is it its me my of on or " +
  "our she so that the their them then there they this thou thy thee to unto us was we were which who will " +
  "with ye you your " +
  "и в во не на я что он с со а как к ко по но его от о об у же бы то же ли ни да за из ее её их мы вы ты").split(" "));

// Words in any alphabet (Latin or Cyrillic); \b and \w only understand Latin letters.
const queryWords = (query) => query.toLowerCase().replace(/[’‘]/g, "'").match(/[\p{L}\p{N}']+/gu) ?? [];
const WORD_START = "(?<![\\p{L}\\p{N}])";
const BETWEEN_WORDS = "[^\\p{L}\\p{N}]+";
// Each word matches from its start, so "love" also finds "loved" and "loveth" (but not "beloved").
const wordPattern = (w) => w.replace(/'/g, "['’]");

// "god so love" -> matches "God so loved", ignoring case and punctuation between words.
function searchPattern(query) {
  const words = queryWords(query);
  return words.length ? new RegExp(`${WORD_START}${words.map(wordPattern).join(BETWEEN_WORDS)}`, "giu") : null;
}

function highlight(text, pattern) {
  let html = "", last = 0;
  for (const m of text.matchAll(pattern)) {
    html += escapeHTML(text.slice(last, m.index)) + `<mark>${escapeHTML(m[0])}</mark>`;
    last = m.index + m[0].length;
  }
  return html + escapeHTML(text.slice(last));
}

async function bibleForSearch() {
  if (state.translation === "KJV") return state.books;
  if (offline[state.translation]) return offline[state.translation].books;
  if (BUNDLED[state.translation]) return loadBundled(state.translation);
  return null;   // ESV, NIV, NASB and NTV search online
}

async function runSearch(query) {
  const token = ++search.token;
  Object.assign(search, { query: query.trim(), translation: state.translation, results: [], shown: 0, esvPage: 0, esvTotal: 0, nivOffset: 0, nivTotal: 0 });
  $("searchResults").innerHTML = "";
  $("searchStatus").textContent = "";
  if (search.query.length < 2) return;
  // "jn 3:16" or "1 cor 13" goes there; a book's name alone ("Job") offers it above the word matches.
  const ref = parseReference(search.query);
  if (ref) {
    $("searchResults").innerHTML = `<button class="result go-ref" data-go="${ref.book},${ref.chapter},${ref.verse},${ref.verseEnd}">` +
      `<div class="ref">Go to ${escapeHTML(refLabel(ref))}</div></button>`;
    if (ref.typedChapter) return;
  }
  search.exact = searchPattern(search.query);
  if (!search.exact) return;

  const books = await bibleForSearch().catch(() => null);
  if (token !== search.token) return;
  if (!books) return isApiTranslation(state.translation) ? runApiSearch(token) : runEsvSearch(token);

  // Close matches: verses with most of the meaningful words, in any order and with any wording between.
  const keywords = [...new Set(queryWords(search.query).filter((w) => !STOP_WORDS.has(w)))];
  const keyPatterns = keywords.map((w) => new RegExp(`${WORD_START}${wordPattern(w)}`, "iu"));
  const needed = keywords.length < 2 ? Infinity : keywords.length === 2 ? 2 : Math.ceil(keywords.length * 0.6);
  search.words = keywords.length ? new RegExp(`${WORD_START}(?:${keywords.map(wordPattern).join("|")})`, "giu") : null;

  const exact = [], close = [];
  books.forEach((b, bi) => b.chapters.forEach((chapter, ci) => chapter.forEach((text, vi) => {
    if (!text) return;
    const hit = { book: bi, chapter: ci, verse: vi + 1, text };
    search.exact.lastIndex = 0;
    if (search.exact.test(text)) return exact.push(hit);
    if (needed === Infinity) return;
    const at = keyPatterns.map((p) => text.search(p)).filter((i) => i >= 0);
    // Rank by how many words match, then by how close together they are.
    if (at.length >= needed) close.push({ ...hit, score: at.length, span: Math.max(...at) - Math.min(...at), close: true });
  })));
  close.sort((a, b) => b.score - a.score || a.span - b.span);

  // Our translation's notes are searched too, so "hesed" or "agape" finds every note on the word.
  const inNotes = [];
  if (state.translation === "GN") {
    const all = await Promise.all(state.books.map((_, b) => notesFor(b).catch(() => null)));
    if (token !== search.token) return;
    all.forEach((notes, b) => Object.entries(notes?.verses ?? {}).forEach(([key, list]) => list.forEach((note) => {
      search.exact.lastIndex = 0;
      if (!search.exact.test(note.t)) return;
      const [c, v] = key.split(":").map(Number);
      inNotes.push({ book: b, chapter: c - 1, verse: v, text: note.t, note: true });
    })));
  }
  search.results = [...exact, ...inNotes, ...close.slice(0, 300)];

  const count = (n, what) => `${n ? n.toLocaleString() : "No"} ${what}${n === 1 ? "" : "es"}`;
  $("searchStatus").textContent = exact.length || close.length || inNotes.length
    ? `${count(exact.length, "exact match")}${close.length ? ` · ${count(close.length, "close match")}` : ""} in the ${state.translation}` +
      (inNotes.length ? ` · ${inNotes.length.toLocaleString()} in the notes` : "")
    : `Nothing found in the ${state.translation}`;
  showMore();
}

// A long note shown around the words that matched.
function excerpt(text) {
  search.exact.lastIndex = 0;
  const at = Math.max(0, text.search(search.exact));
  const from = Math.max(0, text.lastIndexOf(" ", Math.max(0, at - 80)));
  const to = text.indexOf(" ", Math.min(text.length, at + 160));
  return (from > 0 ? "… " : "") + text.slice(from, to < 0 ? text.length : to).trim() + (to > 0 ? " …" : "");
}
function showMore() {
  const start = search.shown;
  const next = search.results.slice(start, start + PAGE);
  search.shown += next.length;
  document.querySelector("#searchResults .more-btn")?.remove();
  let html = "";
  next.forEach((r, i) => {
    const previous = search.results[start + i - 1];
    if (start + i === 0 && !r.close && !r.note) html += `<div class="results-label">Exact matches</div>`;
    if (r.note && !previous?.note) html += `<div class="results-label">In the translation notes</div>`;
    if (r.close && !previous?.close) html += `<div class="results-label">Close matches</div>`;
    html += `<button class="result" data-go="${r.book},${r.chapter},${r.verse}">` +
      `<div class="ref">${escapeHTML(`${bookName(r.book)} ${r.chapter + 1}:${r.verse}`)}${r.note ? " · note" : ""}</div>` +
      `<div class="snippet">${highlight(r.note ? excerpt(r.text) : r.text, r.close ? search.words : search.exact)}</div></button>`;
  });
  if (search.shown < search.results.length || search.esvPage < search.esvTotal || search.nivOffset < search.nivTotal) {
    html += `<button class="more-btn" data-more>Show more</button>`;
  }
  $("searchResults").insertAdjacentHTML("beforeend", html);
}

// API.Bible's search matches the words (with some spelling tolerance) and ranks by relevance.
async function runApiSearch(token, offset = 0) {
  const code = state.translation;
  if (offset === 0) $("searchStatus").textContent = `Searching the ${code}…`;
  try {
    const data = await apiBible(`/bibles/${await apiBibleId(code)}/search`, { query: search.query, limit: PAGE, offset }, code);
    if (token !== search.token) return;
    search.exact = search.words = new RegExp(`${WORD_START}(?:${queryWords(search.query).map(wordPattern).join("|")})`, "giu");
    for (const v of data.verses ?? []) {
      const [code, c, verse] = v.id.split(".");
      const book = BOOK_CODES.indexOf(code);
      if (book >= 0) search.results.push({ book, chapter: Number(c) - 1, verse: Number(verse), text: v.text });
    }
    search.nivOffset = offset + PAGE;
    search.nivTotal = data.total ?? 0;
    const n = search.nivTotal;
    $("searchStatus").textContent = n ? `${n.toLocaleString()} verse${n === 1 ? "" : "s"} in the ${code}` : `Nothing found in the ${code}`;
    showMore();
  } catch (error) {
    if (token === search.token) $("searchStatus").textContent = error.message;
  }
}

const ESV_BOOK_NAMES = { Psalm: "Psalms" };

async function runEsvSearch(token, page = 1) {
  const key = state.esvKey.trim() || state.sharedEsvKey;
  if (!key) { $("searchStatus").textContent = "Sign in on the Connection tab to search the ESV."; return; }
  if (page === 1) $("searchStatus").textContent = "Searching the ESV…";
  try {
    const params = new URLSearchParams({ q: search.query, "page-size": PAGE, page });
    const response = await fetch(`https://api.esv.org/v3/passage/search/?${params}`, { headers: { Authorization: `Token ${key}` } });
    if (!response.ok) throw new Error();
    const data = await response.json();
    if (token !== search.token) return;
    search.esvPage = data.page;
    search.esvTotal = data.total_pages;
    // ESV's search matches all the words, so mark them one by one.
    search.exact = search.words = new RegExp(`${WORD_START}(?:${queryWords(search.query).map(wordPattern).join("|")})`, "giu");
    for (const r of data.results) {
      // "John 3:16", or "Jude 5" in one-chapter books
      const m = r.reference.match(/^(.+?) (?:(\d+):)?(\d+)/);
      const book = m ? state.books.findIndex((b) => b.name === (ESV_BOOK_NAMES[m[1]] ?? m[1])) : -1;
      if (book >= 0) search.results.push({ book, chapter: Number(m[2] ?? 1) - 1, verse: Number(m[3]), text: r.content });
    }
    const n = data.total_results;
    $("searchStatus").textContent = n ? `${n.toLocaleString()} verse${n === 1 ? "" : "s"} in the ESV` : "Nothing found in the ESV";
    showMore();
  } catch {
    if (token === search.token) $("searchStatus").textContent = "Couldn't reach the ESV. Searching the ESV needs an internet connection.";
  }
}

function openSearch() {
  closeDrawer();
  $("search").hidden = false;
  $("searchInput").placeholder = `Search the ${state.translation}`;
  // Results from another translation are stale: search again in this one.
  if (search.query && search.translation !== state.translation) runSearch($("searchInput").value);
  $("searchInput").focus();
  $("searchInput").select();
}
const closeSearch = () => { $("search").hidden = true; };

let searchTimer;
$("searchInput").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch($("searchInput").value), 250);
});
$("searchForm").addEventListener("submit", (event) => {
  event.preventDefault();
  clearTimeout(searchTimer);
  $("searchInput").blur();   // hide the phone keyboard so the results show
  const ref = parseReference($("searchInput").value);
  if (ref?.typedChapter) { closeSearch(); return jumpTo(ref.book, ref.chapter, ref.verse, ref.verseEnd); }
  if ($("searchInput").value.trim() !== search.query) runSearch($("searchInput").value);
});
$("searchBtn").addEventListener("click", openSearch);
$("searchClose").addEventListener("click", closeSearch);
$("searchResults").addEventListener("click", (event) => {
  if (event.target.closest("[data-more]")) {
    if (search.shown < search.results.length) showMore();
    else if (isApiTranslation(state.translation)) runApiSearch(search.token, search.nivOffset);
    else runEsvSearch(search.token, search.esvPage + 1);
    return;
  }
  const result = event.target.closest("[data-go]");
  if (!result) return;
  const [book, chapter, verse, verseEnd] = result.dataset.go.split(",").map(Number);
  closeSearch();
  jumpTo(book, chapter, verse, verseEnd || verse);
});

/* ---------- Going to a reference ---------- */

// Common short forms. Anything else works by its start ("revel", "philip"); a number in front picks
// 1, 2 or 3 John and the like. Russian names and short forms work too ("Ин 3:16", "1 Кор 13").
const BOOK_ALIASES = {
  genesis: "gen gn ge", exodus: "ex exo exod", leviticus: "lev lv le", numbers: "num nm nu nb",
  deuteronomy: "deut dt de deu", joshua: "josh jos jsh", judges: "judg jdg jg jdgs", ruth: "ru rth rt",
  samuel: "sam sa sm", kings: "kgs ki kin", chronicles: "chr ch chron", ezra: "ezr", nehemiah: "neh ne",
  esther: "esth est es", job: "jb", psalms: "ps psa psm pss psalm", proverbs: "prov pr prv pro",
  ecclesiastes: "eccl ec ecc qoh", songofsolomon: "song sos so sng cant songofsongs songs", isaiah: "isa is",
  jeremiah: "jer je jr", lamentations: "lam la", ezekiel: "ezek eze ezk", daniel: "dan da dn", hosea: "hos ho",
  joel: "jl", amos: "am", obadiah: "obad ob", jonah: "jon jnh", micah: "mic mc", nahum: "nah na",
  habakkuk: "hab hb", zephaniah: "zeph zep zp", haggai: "hag hg", zechariah: "zech zec zc", malachi: "mal ml",
  matthew: "matt mt mat", mark: "mk mr mrk", luke: "lk lu luk", john: "jn jhn joh", acts: "ac act",
  romans: "rom ro rm", corinthians: "cor co", galatians: "gal ga", ephesians: "eph ephes",
  philippians: "phil php pp", colossians: "col", thessalonians: "thess th thes", timothy: "tim ti tm",
  titus: "tit", philemon: "philem phm phlm", hebrews: "heb", james: "jas jm", peter: "pet pe pt",
  jude: "jd", revelation: "rev re rv revelations",
  бытие: "быт", исход: "исх", левит: "лев", числа: "чис", второзаконие: "втор", иисуснавин: "нав",
  судьи: "суд", руфь: "руф", царств: "цар", паралипоменон: "пар", ездра: "езд", неемия: "неем",
  есфирь: "есф", псалтирь: "пс псалом псалмы", притчи: "притч", екклесиаст: "еккл", песньпесней: "песн",
  исаия: "ис", иеремия: "иер", плачиеремии: "плач", иезекииль: "иез", даниил: "дан", осия: "ос",
  иоиль: "иоил", авдий: "авд", иона: "ион", михей: "мих", аввакум: "авв", софония: "соф", аггей: "агг",
  захария: "зах", малахия: "мал", матфея: "мф мат", марка: "мк мар", луки: "лк лук", иоанна: "ин иоан",
  деяния: "деян", римлянам: "рим", коринфянам: "кор", галатам: "гал", ефесянам: "еф",
  филиппийцам: "флп фил", колоссянам: "кол", фессалоникийцам: "фес", тимофею: "тим", титу: "тит",
  филимону: "флм", евреям: "евр", иакова: "иак", петра: "пет", иуды: "иуд", откровение: "откр отк",
};
const ALIAS = new Map(Object.entries(BOOK_ALIASES).flatMap(([base, short]) => [[base, base], ...short.split(" ").map((s) => [s, base])]));
let bookKeys = null;   // [{ book, num, base }] in English and Russian, made once the books have loaded

function splitName(name) {
  const m = name.toLowerCase().replace(/^от /, "").match(/^(?:(\d) )?(.+)$/);
  return { num: Number(m[1] ?? 0), base: m[2].replace(/\s+/g, "") };
}

// -> { book, chapter, verse, verseEnd, typedChapter } or null
function parseReference(text) {
  const m = text.trim().toLowerCase().replace(/ё/g, "е").replace(/\./g, " ")
    .match(/^(?:([123])\s*|(i{1,3}|first|second|third)\s+)?(\p{L}[\p{L}\s]*?)\s*(?:(\d+)(?:\s*[:,]\s*(\d+)(?:\s*[-–—]\s*(\d+))?)?)?$/u);
  if (!m || !state.books.length) return null;
  bookKeys ??= state.books.flatMap((b, book) => [{ book, ...splitName(b.name) }, { book, ...splitName(RUSSIAN_BOOKS[book]) },
    { book, ...splitName(SPANISH_BOOKS[book]) }]);
  const num = Number(m[1] ?? { i: 1, ii: 2, iii: 3, first: 1, second: 2, third: 3 }[m[2]] ?? 0);
  const letters = m[3].replace(/\s+/g, "");
  const base = ALIAS.get(letters);
  // A short form or full name; otherwise the first book whose name starts that way (3 letters at least).
  const matches = base ? bookKeys.filter((k) => k.base === base)
    : letters.length >= 3 ? bookKeys.filter((k) => k.base.startsWith(letters)) : [];
  const match = matches.find((k) => k.num === num) ?? (num === 0 ? matches.find((k) => k.num === 1) : undefined);
  if (!match) return null;
  const { book } = match;
  // A book alone needs its name (or 4 letters of it): "is" or "gen" on their own are more likely words.
  if (m[4] === undefined && letters !== match.base && (ALIAS.has(letters) || letters.length < 4)) return null;
  let chapter = Number(m[4] ?? 1), verse = Number(m[5] ?? 1), verseEnd = Number(m[6] ?? verse);
  const chapters = state.books[book].chapters;
  if (chapters.length === 1 && m[4] !== undefined && m[5] === undefined) [chapter, verse, verseEnd] = [1, chapter, chapter];   // "Jude 5"
  if (chapter < 1 || chapter > chapters.length || verse < 1 || verseEnd < verse) return null;
  if (verse > chapters[chapter - 1].length + 1) return null;   // (+1: a few chapters have a verse more in some translations)
  return { book, chapter: chapter - 1, verse, verseEnd, typedChapter: m[4] !== undefined };
}
const refLabel = (r) => r.verse > 1 || r.verseEnd > r.verse || r.typedChapter && state.books[r.book].chapters.length === 1
  ? verseRef({ book: r.book, chapter: r.chapter, verse: r.verse, verseEnd: r.verseEnd }, bookName(r.book))
  : chapterLabel(r.book, r.chapter);

/* ---------- Display mode ---------- */

const DISPLAY_MODES = { device: "Match device", light: "Light", dark: "Dark", gray: "Gray", photo: "Photo background" };
const display = {
  mode: store.get("display", "device"),
  photo: store.get("bgPhoto", null),      // { url (JPEG data URL), tone: "light" | "dark" }
};

function applyDisplay() {
  const root = document.documentElement;
  const photo = display.mode === "photo" && display.photo;
  const theme = photo ? display.photo.tone : display.mode === "device" ? null : display.mode;
  if (theme) root.dataset.theme = theme; else delete root.dataset.theme;
  if (photo) root.dataset.photo = ""; else delete root.dataset.photo;
  $("backdrop").hidden = !photo;
  $("backdrop").style.backgroundImage = photo ? `url("${display.photo.url}")` : "";
  document.querySelector('meta[name="theme-color"]').content = getComputedStyle(root).getPropertyValue("--bg").trim();
}

// Shrinks the photo so it fits in the device's storage, and measures how bright it is
// so the text can go dark on light photos and light on dark ones.
function preparePhoto(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const sample = document.createElement("canvas");
      sample.width = sample.height = 24;
      sample.getContext("2d").drawImage(canvas, 0, 0, 24, 24);
      const px = sample.getContext("2d").getImageData(0, 0, 24, 24).data;
      let light = 0;
      for (let i = 0; i < px.length; i += 4) light += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
      URL.revokeObjectURL(img.src);
      resolve({ url: canvas.toDataURL("image/jpeg", 0.8), tone: light / (px.length / 4) > 140 ? "light" : "dark" });
    };
    img.onerror = () => reject(new Error("Couldn't open that photo."));
    img.src = URL.createObjectURL(file);
  });
}

// Text size and line spacing for the Bible text, kept on this device.
const TEXT_SIZES = [0.8, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2];
const SPACINGS = [["Tight", 1.45], ["Normal", 1.7], ["Roomy", 2], ["Extra roomy", 2.35]];
const textPrefs = { size: store.get("textSize", 2), spacing: store.get("spacing", 1) };

function applyText() {
  const root = document.documentElement.style;
  root.setProperty("--text-scale", TEXT_SIZES[textPrefs.size]);
  root.setProperty("--leading", SPACINGS[textPrefs.spacing][1]);
  if ($("textSize")) {
    $("textSize").textContent = `${Math.round(TEXT_SIZES[textPrefs.size] * 100)}%`;
    $("textSpacing").textContent = SPACINGS[textPrefs.spacing][0];
  }
}

function changeText(what, step) {
  const max = (what === "size" ? TEXT_SIZES : SPACINGS).length - 1;
  textPrefs[what] = Math.min(max, Math.max(0, textPrefs[what] + step));
  store.set(what === "size" ? "textSize" : "spacing", textPrefs[what]);
  applyText();
  $(`v${state.verse}`)?.scrollIntoView({ block: "start" });   // stay at the same verse
}

function toggleDisplayMenu(show = $("displayMenu").hidden) {
  if (show) {
    $("displayMenu").innerHTML = Object.entries(DISPLAY_MODES).map(([mode, label]) =>
      `<button data-display="${mode}" role="menuitem">${label}<span class="check">${mode === display.mode && (mode !== "photo" || display.photo) ? "✓" : ""}</span></button>`
    ).join("") + (display.photo ? `<hr><button data-display="change" role="menuitem">Change photo…</button>` : "") +
      `<hr><div class="text-row"><span>Text size</span><button data-text="size" data-step="-1" aria-label="Smaller text">A−</button>` +
      `<span id="textSize" class="text-value"></span><button data-text="size" data-step="1" aria-label="Larger text">A+</button></div>` +
      `<div class="text-row"><span>Spacing</span><button data-text="spacing" data-step="-1" aria-label="Less space between lines">−</button>` +
      `<span id="textSpacing" class="text-value"></span><button data-text="spacing" data-step="1" aria-label="More space between lines">+</button></div>` +
      (state.translation === "GN" ? `<hr><button data-notes role="menuitem">Translation notes<span class="check">` +
        `${store.get("translationNotes", true) ? "✓" : ""}</span></button>` : "");
    applyText();
  }
  $("displayMenu").hidden = !show;
}

$("displayBtn").addEventListener("click", (event) => {
  event.stopPropagation();
  toggleTranslationMenu(false);
  toggleDisplayMenu();
});
document.addEventListener("click", (event) => {
  if (!$("displayMenu").hidden && !$("displayMenu").contains(event.target)) toggleDisplayMenu(false);
});
$("displayMenu").addEventListener("click", (event) => {
  const textButton = event.target.closest("[data-text]");
  if (textButton) return changeText(textButton.dataset.text, Number(textButton.dataset.step));   // the menu stays open
  if (event.target.closest("[data-notes]")) {
    store.set("translationNotes", !store.get("translationNotes", true));
    toggleDisplayMenu(false);
    return render();
  }
  const choice = event.target.closest("[data-display]")?.dataset.display;
  if (!choice) return;
  toggleDisplayMenu(false);
  if (choice === "change" || (choice === "photo" && !display.photo)) return $("photoInput").click();
  display.mode = choice;
  store.set("display", choice);
  applyDisplay();
});
$("photoInput").addEventListener("change", async () => {
  const file = $("photoInput").files[0];
  $("photoInput").value = "";
  if (!file) return;
  try {
    const photo = await preparePhoto(file);
    store.set("bgPhoto", photo);
    if (store.get("bgPhoto", null)?.url !== photo.url) toast("That photo is too big to keep. It'll reset when the app restarts.");
    Object.assign(display, { photo, mode: "photo" });
    store.set("display", "photo");
    applyDisplay();
  } catch (error) { toast(error.message); }
});
applyDisplay();
applyText();

/* ---------- Bookmarks ---------- */

// "John 3", "John 3:16", or "John 3:16–18" for a few verses (verseEnd).
const reference = (b) => `${state.books[b.book]?.name ?? "?"} ${b.chapter + 1}` +
  (b.verseEnd > b.verse ? `:${b.verse}–${b.verseEnd}` : b.verse > 1 ? `:${b.verse}` : "");
const isHere = (b) => b && b.book === state.book && b.chapter === state.chapter;

function updateBookmarkBtn() {
  const marked = isHere(state.tempBookmark) || state.bookmarks.some(isHere);
  els.bookmarkBtn.classList.toggle("on", marked);
}

// A change here is always newer than anything this device has seen, even if another device's clock runs ahead.
function saveBookmarks({ updated = Math.max(Date.now(), state.bookmarksUpdated + 1), remote = false } = {}) {
  state.bookmarksUpdated = updated;
  store.set("tempBookmark", state.tempBookmark);
  store.set("bookmarks", state.bookmarks);
  store.set("bookmarksUpdated", updated);
  updateBookmarkBtn();
  renderBookmarks();
  if (!remote) emit("bookmarks");
}

let toastTimer;
function toast(message) {
  let el = document.querySelector(".toast");
  if (!el) { el = document.createElement("div"); el.className = "toast"; document.body.append(el); }
  el.textContent = message;
  el.style.opacity = 1;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.opacity = 0; }, 1800);
}

// Tapping the ribbon drops the temporary bookmark here, replacing the old one.
els.bookmarkBtn.addEventListener("click", () => {
  saveVisibleVerse();
  const { book, chapter, verse } = state;
  state.tempBookmark = { book, chapter, verse, created: Math.max(Date.now(), (state.tempBookmark?.created ?? 0) + 1) };
  saveBookmarks();
  toast(`Bookmarked ${reference(state.tempBookmark)} — name it in Bookmarks to keep it`);
});

function card(b, temp) {
  const title = temp ? "Temporary bookmark" : escapeHTML(b.name);
  const notes = !temp && b.notes ? `<div class="card-notes">${escapeHTML(b.notes)}</div>` : "";
  const target = temp ? "temp" : b.id;
  return `<div class="card${temp ? " temp" : ""}">` +
    `<button class="card-main" data-open="${target}"><div class="card-title">${title}</div>` +
    `<div class="card-ref">${escapeHTML(reference(b))}</div>${notes}</button>` +
    `<button class="card-btn" data-edit="${target}">${temp ? "Name" : "Edit"}</button></div>`;
}

function renderBookmarks() {
  const { tempBookmark: temp, bookmarks } = state;
  els.bookmarks.innerHTML =
    `<div class="section-label">Temporary</div>` +
    (temp ? card(temp, true) : `<p class="list-empty">Tap the ribbon at the top while reading to drop a temporary bookmark.</p>`) +
    `<div class="section-label">Saved</div>` +
    (bookmarks.length ? bookmarks.map((b) => card(b, false)).join("")
      : `<p class="list-empty">Name your temporary bookmark to save it here, with notes.</p>`);
}

let editing = null;      // "temp", a saved bookmark's id, or "new" (verses picked in the text)
let newBookmark = null;  // { book, chapter, verse, verseEnd? } while saving picked verses

function openBookmarkDialog(target, picked) {
  newBookmark = picked ? { book: picked.book, chapter: picked.chapter, verse: picked.start,
    ...(picked.end > picked.start ? { verseEnd: picked.end } : {}) } : null;
  const b = newBookmark ?? (target === "temp" ? state.tempBookmark : state.bookmarks.find((x) => x.id === target));
  if (!b) return;
  editing = target;
  const saved = target !== "temp" && target !== "new";
  els.bookmarkDialogTitle.textContent = saved ? "Edit bookmark" : "Save bookmark";
  els.bookmarkRef.textContent = newBookmark ? verseRef(b) : reference(b);
  els.bookmarkName.value = b.name ?? "";
  els.bookmarkNotes.value = b.notes ?? "";
  els.bookmarkDelete.hidden = !saved;
  $("bookmarkVerses").hidden = !saved;
  els.bookmarkDialog.returnValue = "";
  els.bookmarkDialog.showModal();
}

els.bookmarkDialog.addEventListener("close", () => {
  const action = els.bookmarkDialog.returnValue;
  const name = els.bookmarkName.value.trim();
  const notes = els.bookmarkNotes.value.trim();
  const saved = state.bookmarks.find((x) => x.id === editing);
  if (action === "save" && name) {
    if (editing === "new") {
      state.bookmarks.unshift({ id: String(Date.now()), name, notes, ...newBookmark, created: Date.now() });
    } else if (editing === "temp" && state.tempBookmark) {
      const { book, chapter, verse } = state.tempBookmark;
      state.bookmarks.unshift({ id: String(Date.now()), name, notes, book, chapter, verse, created: Date.now() });
      state.tempBookmark = null;   // promoted, so the temporary slot is free again
    } else {
      Object.assign(saved ?? {}, { name, notes });
    }
  } else if (action === "delete") {
    state.bookmarks = state.bookmarks.filter((x) => x.id !== editing);
  } else if (action === "verses" && saved) {
    if (name) Object.assign(saved, { name, notes });   // keep anything typed before tapping Change verses
    return changeVerses(saved, `Verses for “${saved.name}”`, (start, end) => {
      saved.verse = start;
      if (end > start) saved.verseEnd = end; else delete saved.verseEnd;
      saveBookmarks();
      toast(`“${saved.name}” is now on ${verseRef(saved)}`);
    });
  } else return;
  saveBookmarks();
});

els.bookmarks.addEventListener("click", (event) => {
  const edit = event.target.closest("[data-edit]");
  if (edit) return openBookmarkDialog(edit.dataset.edit);
  const open = event.target.closest("[data-open]");
  if (!open) return;
  const id = open.dataset.open;
  const b = id === "temp" ? state.tempBookmark : state.bookmarks.find((x) => x.id === id);
  if (b) jumpTo(b.book, b.chapter, b.verse, b.verseEnd ?? b.verse);
});

/* ---------- Hooks for connect.js ---------- */

function showTab(view) { document.querySelector(`.tab[data-view="${view}"]`).click(); }

window.bible = {
  state, store, goTo, jumpTo, reference, verseRef, changeVerses, escapeHTML, toast,
  ready: false,
  showTab,
  noteCount: null,   // set by connect.js: how many notes are on the picked verses
  // Adopt bookmarks saved from another device.
  // Keys shared through the group database once you're approved ("esv" or "niv").
  setSharedKey(name, key) {
    if (name === "esv") {
      if (key === state.sharedEsvKey) return;
      state.sharedEsvKey = key;
      esvCache.clear();
      if (!key && !state.esvKey.trim()) stopListening();
      if (!state.esvKey) render();   // the ESV and its Listen button come and go with the key
    } else if (name === "niv") {
      if (key === state.sharedNivKey) return;
      state.sharedNivKey = key;
      for (const t of Object.values(API_TRANSLATIONS)) Object.assign(t, { bibleId: null, cache: new Map() });
      if (isApiTranslation(state.translation)) render();
    }
  },
  // Licensed offline copies (NASB): connect.js decides who may keep one.
  offline: {
    copied: (code) => offline[code]?.copied ?? 0,
    copyFromApi,
    async save(code, books, copied) {
      await idb("readwrite", (store) => store.put({ books, copied }, code));
      offline[code] = { books, copied };
      if (state.translation === code) render();
    },
    async remove(code) {
      if (!offline[code]) return;
      delete offline[code];
      await idb("readwrite", (store) => store.delete(code)).catch(() => {});
      if (state.translation === code) render();
    },
  },
  // Reading progress from the account (merged, never replaced: see Reading progress).
  applyProgress(remote) {
    const merged = mergeProgress(state.progress, remote);
    if (JSON.stringify(merged) === JSON.stringify(state.progress)) return;
    state.progress = merged;
    store.set("progress", merged);
    if (els.drawer.classList.contains("open") && chronological() && !els.drawerBody.dataset.era) showEras();
  },
  mergeProgress,
  applyBookmarks({ bookmarks, tempBookmark, updated }) {
    state.bookmarks = bookmarks ?? [];
    state.tempBookmark = tempBookmark ?? null;
    saveBookmarks({ updated, remote: true });
  },
};

/* ---------- Bottom tabs ---------- */

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    document.querySelectorAll(".view").forEach((v) => { v.hidden = v.id !== tab.dataset.view; });
    const reading = tab.dataset.view === "bibleView";
    els.translationBtn.style.visibility = reading ? "" : "hidden";
    els.bookmarkBtn.style.visibility = reading ? "" : "hidden";
    document.body.classList.toggle("off-bible", !reading);   // the back button and verse bar belong to the reader
    if (!reading && selection && !selection.changing) clearSelection();
    if (tab.dataset.view === "bookmarksView") renderBookmarks();
    // The place may have changed while the reader was hidden (e.g. synced from another device).
    if (reading && state.verse > 1) $(`v${state.verse}`)?.scrollIntoView({ block: "start" });
    els.title.textContent = reading ? passageLabel(passage())
      : tab.querySelector("span").textContent;
  });
});

/* ---------- Bible order: hold the Bible tab ---------- */

// Holding the Bible tab chooses the order: the printed one, or chronological (the same verses in the
// order of events, a passage at a time). Places, bookmarks and notes are verses either way.
const bibleTab = document.querySelector('.tab[data-view="bibleView"]');
const orderMenu = $("orderMenu");
let tabHeld = false, tabTimer = null;

function showOrder() {
  bibleTab.querySelector("span").textContent = chronological() ? "Chronological" : "Bible";
}
function toggleOrderMenu(show = orderMenu.hidden) {
  if (show) {
    orderMenu.innerHTML = [["canon", "Bible", "Books in the usual order"], ["chrono", "Chronological Bible", "Passages in the order things happened"]]
      .map(([order, name, about]) => `<button data-order="${order}" role="menuitem"><span>${name}<small>${about}</small></span>` +
        `<span class="check">${order === state.order ? "✓" : ""}</span></button>`).join("");
  }
  orderMenu.hidden = !show;
}
function setOrder(order) {
  if (order === state.order) return;
  state.order = order;
  store.set("order", order);
  showOrder();
  if (els.bibleView.hidden) showTab("bibleView");
  render();
  toast(chronological() ? "Chronological: ☰ lists the eras, and each passage leads to the next in time." : "Back to the usual order of the books.");
}

bibleTab.addEventListener("pointerdown", () => {
  tabHeld = false;
  clearTimeout(tabTimer);
  tabTimer = setTimeout(() => { tabHeld = true; toggleOrderMenu(true); }, 500);
});
for (const type of ["pointerup", "pointercancel", "pointerleave"]) bibleTab.addEventListener(type, () => clearTimeout(tabTimer));
bibleTab.addEventListener("contextmenu", (event) => event.preventDefault());
bibleTab.addEventListener("click", (event) => {
  if (tabHeld) { tabHeld = false; event.stopImmediatePropagation(); }   // the hold opened the menu; don't also switch tabs
}, { capture: true });
document.addEventListener("click", (event) => {
  if (!orderMenu.hidden && !orderMenu.contains(event.target) && !bibleTab.contains(event.target)) toggleOrderMenu(false);
});
orderMenu.addEventListener("click", (event) => {
  const button = event.target.closest("[data-order]");
  if (!button) return;
  toggleOrderMenu(false);
  setOrder(button.dataset.order);
});

/* ---------- Start ---------- */

async function start() {
  try {
    state.books = await (await fetch("kjv.json")).json();
  } catch {
    els.chapter.innerHTML = `<div class="empty"><h2>Couldn't load the Bible</h2><p>Check your connection and reopen the app.</p></div>`;
    return;
  }
  // Guard against a stale or corrupted saved position.
  if (!state.books[state.book]) state.book = 0;
  if (!state.books[state.book].chapters[state.chapter]) state.chapter = 0;
  if (!TRANSLATIONS[state.translation]) state.translation = "WEB";
  buildChrono();
  if (state.order !== "chrono") state.order = "canon";
  showOrder();
  await loadOffline();
  render();
  window.bible.ready = true;
  emit("ready");
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
start();
