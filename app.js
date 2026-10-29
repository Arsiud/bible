"use strict";

const TRANSLATIONS = {
  WEB: "World English Bible",   // the default
  KJV: "King James Version",
  ASV: "American Standard Version",
  RST: "Синодальный перевод (Russian Synodal)",
  ESV: "English Standard Version",
  NIV: "New International Version",
  NASB: "New American Standard Bible (2020)",
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
  book: store.get("book", 0),
  chapter: store.get("chapter", 0),
  verse: store.get("verse", 1),               // last verse at the top of the screen
  esvKey: store.get("esvKey", ""),
  sharedEsvKey: "",                           // from the group database once approved; never saved on the device
  sharedNivKey: "",                           // API.Bible key (NIV and NASB), same rules as the ESV key
  tempBookmark: store.get("tempBookmark", null),   // { book, chapter, verse, created } — unnamed, replaced by the next tap
  bookmarks: store.get("bookmarks", []),           // [{ id, name, notes, book, chapter, verse, created }]
  positionUpdated: store.get("positionUpdated", 0),   // timestamps let the newest device win when syncing
  bookmarksUpdated: store.get("bookmarksUpdated", 0),
};

// connect.js listens for these to sync with the group database.
const emit = (name, detail) => window.dispatchEvent(new CustomEvent(`bible:${name}`, { detail }));
const esvCache = new Map();                   // in-memory only, per ESV API terms

// Public-domain translations bundled with the app (and cached by sw.js for offline use).
const BUNDLED = { WEB: "web.json", ASV: "asv.json", RST: "rst.json" };

// The Russian Synodal (rst.json) was converted to English (KJV) verse numbering so places, bookmarks
// and family notes line up across translations. Book names show in Russian, and Psalms also show the
// Synodal number Russian readers know (English Psalm 23 is Synodal 22).
const RUSSIAN_BOOKS = ("Бытие|Исход|Левит|Числа|Второзаконие|Иисус Навин|Судьи|Руфь|1 Царств|2 Царств|3 Царств|" +
  "4 Царств|1 Паралипоменон|2 Паралипоменон|Ездра|Неемия|Есфирь|Иов|Псалтирь|Притчи|Екклесиаст|Песнь песней|" +
  "Исаия|Иеремия|Плач Иеремии|Иезекииль|Даниил|Осия|Иоиль|Амос|Авдий|Иона|Михей|Наум|Аввакум|Софония|Аггей|" +
  "Захария|Малахия|От Матфея|От Марка|От Луки|От Иоанна|Деяния|Римлянам|1 Коринфянам|2 Коринфянам|Галатам|" +
  "Ефесянам|Филиппийцам|Колоссянам|1 Фессалоникийцам|2 Фессалоникийцам|1 Тимофею|2 Тимофею|Титу|Филимону|" +
  "Евреям|Иакова|1 Петра|2 Петра|1 Иоанна|2 Иоанна|3 Иоанна|Иуды|Откровение").split("|");
let synodalPsalms = null;   // English psalm number -> Synodal number, once rst.json has loaded
const PSALMS = 18;

function bookName(book) {
  return state.translation === "RST" ? RUSSIAN_BOOKS[book] : state.books[book].name;
}
function chapterLabel(book, chapter) {
  const synodal = state.translation === "RST" && book === PSALMS && synodalPsalms?.[chapter];
  return `${bookName(book)} ${chapter + 1}` + (synodal && synodal !== chapter + 1 ? ` (${synodal})` : "");
}
const bundled = new Map();                    // code -> Promise of books

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

async function getVerses() {
  const { translation, book, chapter } = state;
  if (translation === "KJV") return state.books[book].chapters[chapter];
  if (offline[translation]) return offline[translation].books[book].chapters[chapter];
  if (BUNDLED[translation]) return (await loadBundled(translation))[book].chapters[chapter];
  if (isApiTranslation(translation)) return fetchApiChapter(translation, book, chapter);
  return fetchESV(`${state.books[book].name} ${chapter + 1}`);
}

/* The NIV and NASB (2020) come from API.Bible (non-commercial Starter plan), using one shared key.
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
  const found = (await apiBible("/bibles", { language: "eng" }, code)).find(t.find);
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
  if (esvCache.has(reference)) return esvCache.get(reference);

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

/* ---------- Rendering ---------- */

let renderToken = 0;

async function render({ restoreVerse = state.verse } = {}) {
  const token = ++renderToken;
  if (state.translation === "RST") await loadBundled("RST").catch(() => {});   // for Synodal psalm numbers
  if (token !== renderToken) return;
  const label = chapterLabel(state.book, state.chapter);
  if (!els.bibleView.hidden) els.title.textContent = label;
  els.translationBtn.textContent = state.translation;
  document.title = `${label} · Bible`;

  let html;
  try {
    const verses = await getVerses();
    if (token !== renderToken) return;   // a newer chapter was requested meanwhile
    html = `<h2>${escapeHTML(label)}</h2>` +
      verses.map((text, i) => !text ? "" :
        `<p class="verse" id="v${i + 1}" data-verse="${i + 1}"><sup>${i + 1}</sup>${escapeHTML(text)}</p>`
      ).join("") +
      (state.translation === "ESV" ? `<p class="copyright">${ESV_COPYRIGHT}</p>` : "") +
      (isApiTranslation(state.translation) ? copyrightNotice(API_TRANSLATIONS[state.translation]) : "");
  } catch (error) {
    if (token !== renderToken) return;
    html = `<div class="empty"><h2>Not available</h2><p>${escapeHTML(error.message)}</p></div>`;
  }
  els.chapter.innerHTML = html + navButtons();
  updateBookmarkBtn();
  emit("rendered");

  const target = $(`v${restoreVerse}`);
  if (target && restoreVerse > 1) target.scrollIntoView({ block: "start" });
  else els.bibleView.scrollTop = 0;
}

function neighbor(step) {
  const { books, book, chapter } = state;
  const next = chapter + step;
  if (next >= 0 && next < books[book].chapters.length) return { book, chapter: next };
  const nextBook = book + step;
  if (nextBook < 0 || nextBook >= books.length) return null;
  return { book: nextBook, chapter: step > 0 ? 0 : books[nextBook].chapters.length - 1 };
}

function navButtons() {
  const prev = neighbor(-1), next = neighbor(1);
  const label = (n) => `${bookName(n.book)} ${n.chapter + 1}`;
  return `<div class="nav-row">` +
    (prev ? `<button data-go="${prev.book},${prev.chapter}">‹ ${escapeHTML(label(prev))}</button>` : "") +
    `<span class="spacer"></span>` +
    (next ? `<button data-go="${next.book},${next.chapter}">${escapeHTML(label(next))} ›</button>` : "") +
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

els.chapter.addEventListener("click", (event) => {
  const verse = event.target.closest(".verse");
  if (verse) return emit("versetap", { verse: Number(verse.dataset.verse) });
  const button = event.target.closest("[data-go]");
  if (!button) return;
  const [book, chapter] = button.dataset.go.split(",").map(Number);
  goTo(book, chapter);
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
  showBooks();
  els.scrim.hidden = false;
  els.drawer.classList.add("open");
  els.drawer.setAttribute("aria-hidden", "false");
}

function closeDrawer() {
  els.scrim.hidden = true;
  els.drawer.classList.remove("open");
  els.drawer.setAttribute("aria-hidden", "true");
}

function showBooks() {
  els.drawerTitle.textContent = "Books";
  els.drawerBack.hidden = true;
  const rows = (from, to) => state.books.slice(from, to).map((b, i) =>
    `<button class="book-row${from + i === state.book ? " current" : ""}" data-book="${from + i}">` +
    `${escapeHTML(bookName(from + i))}<span class="count">${b.chapters.length}</span></button>`
  ).join("");
  els.drawerBody.innerHTML =
    `<div class="section-label">Old Testament</div>${rows(0, 39)}` +
    `<div class="section-label">New Testament</div>${rows(39, 66)}`;
  els.drawerBody.querySelector(".current")?.scrollIntoView({ block: "center" });
}

function showChapters(book) {
  els.drawerTitle.textContent = bookName(book);
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
  const book = Number(button.dataset.book);
  if (button.dataset.chapter === undefined) return showChapters(book);
  goTo(book, Number(button.dataset.chapter));
  closeDrawer();
});
$("menuBtn").addEventListener("click", openDrawer);
$("drawerClose").addEventListener("click", closeDrawer);
els.drawerBack.addEventListener("click", showBooks);
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
  state.translation = button.dataset.translation;
  store.set("translation", state.translation);
  render();
  if (!$("search").hidden) { $("searchInput").placeholder = `Search the ${state.translation}`; runSearch($("searchInput").value); }
});
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
  return null;   // ESV, NIV and NASB search online
}

async function runSearch(query) {
  const token = ++search.token;
  Object.assign(search, { query: query.trim(), translation: state.translation, results: [], shown: 0, esvPage: 0, esvTotal: 0, nivOffset: 0, nivTotal: 0 });
  $("searchResults").innerHTML = "";
  if (search.query.length < 2) { $("searchStatus").textContent = ""; return; }
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
  search.results = [...exact, ...close.slice(0, 300)];

  const count = (n, what) => `${n ? n.toLocaleString() : "No"} ${what}${n === 1 ? "" : "es"}`;
  $("searchStatus").textContent = exact.length || close.length
    ? `${count(exact.length, "exact match")}${close.length ? ` · ${count(close.length, "close match")}` : ""} in the ${state.translation}`
    : `Nothing found in the ${state.translation}`;
  showMore();
}

function showMore() {
  const start = search.shown;
  const next = search.results.slice(start, start + PAGE);
  search.shown += next.length;
  document.querySelector("#searchResults .more-btn")?.remove();
  let html = "";
  next.forEach((r, i) => {
    const previous = search.results[start + i - 1];
    if (start + i === 0 && !r.close) html += `<div class="results-label">Exact matches</div>`;
    if (r.close && !previous?.close) html += `<div class="results-label">Close matches</div>`;
    html += `<button class="result" data-go="${r.book},${r.chapter},${r.verse}">` +
      `<div class="ref">${escapeHTML(`${bookName(r.book)} ${r.chapter + 1}:${r.verse}`)}</div>` +
      `<div class="snippet">${highlight(r.text, r.close ? search.words : search.exact)}</div></button>`;
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
      const m = r.reference.match(/^(.+) (\d+):(\d+)/);
      const book = m && state.books.findIndex((b) => b.name === (ESV_BOOK_NAMES[m[1]] ?? m[1]));
      if (book >= 0) search.results.push({ book, chapter: Number(m[2]) - 1, verse: Number(m[3]), text: r.content });
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
  const [book, chapter, verse] = result.dataset.go.split(",").map(Number);
  closeSearch();
  showTab("bibleView");
  goTo(book, chapter, verse);
  flashVerse = verse;
});

// Briefly light up the verse you jumped to from search.
let flashVerse = null;
window.addEventListener("bible:rendered", () => {
  if (!flashVerse) return;
  $(`v${flashVerse}`)?.classList.add("flash");
  flashVerse = null;
});

/* ---------- Display mode ---------- */

const DISPLAY_MODES = { device: "Match device", light: "Light", dark: "Dark", photo: "Photo background" };
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

function toggleDisplayMenu(show = $("displayMenu").hidden) {
  if (show) {
    $("displayMenu").innerHTML = Object.entries(DISPLAY_MODES).map(([mode, label]) =>
      `<button data-display="${mode}" role="menuitem">${label}<span class="check">${mode === display.mode && (mode !== "photo" || display.photo) ? "✓" : ""}</span></button>`
    ).join("") + (display.photo ? `<hr><button data-display="change" role="menuitem">Change photo…</button>` : "");
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

/* ---------- Bookmarks ---------- */

const reference = (b) => `${state.books[b.book]?.name ?? "?"} ${b.chapter + 1}` + (b.verse > 1 ? `:${b.verse}` : "");
const isHere = (b) => b && b.book === state.book && b.chapter === state.chapter;

function updateBookmarkBtn() {
  const marked = isHere(state.tempBookmark) || state.bookmarks.some(isHere);
  els.bookmarkBtn.classList.toggle("on", marked);
}

function saveBookmarks({ updated = Date.now(), remote = false } = {}) {
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
  state.tempBookmark = { book, chapter, verse, created: Date.now() };
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

let editing = null;   // "temp" or a saved bookmark id

function openBookmarkDialog(target) {
  const b = target === "temp" ? state.tempBookmark : state.bookmarks.find((x) => x.id === target);
  if (!b) return;
  editing = target;
  els.bookmarkDialogTitle.textContent = target === "temp" ? "Save bookmark" : "Edit bookmark";
  els.bookmarkRef.textContent = reference(b);
  els.bookmarkName.value = b.name ?? "";
  els.bookmarkNotes.value = b.notes ?? "";
  els.bookmarkDelete.hidden = target === "temp";
  els.bookmarkDialog.returnValue = "";
  els.bookmarkDialog.showModal();
}

els.bookmarkDialog.addEventListener("close", () => {
  const action = els.bookmarkDialog.returnValue;
  const name = els.bookmarkName.value.trim();
  const notes = els.bookmarkNotes.value.trim();
  if (action === "save" && name) {
    if (editing === "temp" && state.tempBookmark) {
      const { book, chapter, verse } = state.tempBookmark;
      state.bookmarks.unshift({ id: String(Date.now()), name, notes, book, chapter, verse, created: Date.now() });
      state.tempBookmark = null;   // promoted, so the temporary slot is free again
    } else {
      Object.assign(state.bookmarks.find((x) => x.id === editing) ?? {}, { name, notes });
    }
  } else if (action === "delete") {
    state.bookmarks = state.bookmarks.filter((x) => x.id !== editing);
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
  if (!b) return;
  goTo(b.book, b.chapter, b.verse);
  document.querySelector('.tab[data-view="bibleView"]').click();
});

/* ---------- Hooks for connect.js ---------- */

function showTab(view) { document.querySelector(`.tab[data-view="${view}"]`).click(); }

window.bible = {
  state, store, goTo, reference, escapeHTML, toast,
  ready: false,
  showTab,
  // Adopt bookmarks saved from another device.
  // Keys shared through the group database once you're approved ("esv" or "niv").
  setSharedKey(name, key) {
    if (name === "esv") {
      if (key === state.sharedEsvKey) return;
      state.sharedEsvKey = key;
      esvCache.clear();
      if (state.translation === "ESV" && !state.esvKey) render();
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
    if (tab.dataset.view === "bookmarksView") renderBookmarks();
    // The place may have changed while the reader was hidden (e.g. synced from another device).
    if (reading && state.verse > 1) $(`v${state.verse}`)?.scrollIntoView({ block: "start" });
    els.title.textContent = reading ? chapterLabel(state.book, state.chapter)
      : tab.querySelector("span").textContent;
  });
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
  await loadOffline();
  render();
  window.bible.ready = true;
  emit("ready");
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
start();
