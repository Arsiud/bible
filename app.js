"use strict";

const TRANSLATIONS = {
  KJV: "King James Version",
  ESV: "English Standard Version",
  NKJV: "New King James Version",
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
  translation: store.get("translation", "KJV"),
  book: store.get("book", 0),
  chapter: store.get("chapter", 0),
  verse: store.get("verse", 1),               // last verse at the top of the screen
  esvKey: store.get("esvKey", ""),
};
const esvCache = new Map();                   // in-memory only, per ESV API terms

const $ = (id) => document.getElementById(id);
const els = {
  title: $("title"), chapter: $("chapter"), bibleView: $("bibleView"),
  translationBtn: $("translationBtn"), translationMenu: $("translationMenu"),
  drawer: $("drawer"), scrim: $("scrim"), drawerBody: $("drawerBody"),
  drawerTitle: $("drawerTitle"), drawerBack: $("drawerBack"),
  settings: $("settings"), esvKey: $("esvKey"),
};

function escapeHTML(text) {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/* ---------- Loading chapters ---------- */

async function getVerses() {
  const { translation, book, chapter } = state;
  if (translation === "KJV") return state.books[book].chapters[chapter];
  if (translation === "NKJV") {
    throw new Error("The NKJV is copyrighted and isn't available yet. Pick KJV or ESV for now.");
  }
  return fetchESV(`${state.books[book].name} ${chapter + 1}`);
}

async function fetchESV(reference) {
  const key = state.esvKey.trim();
  if (!key) throw new Error("Add your free ESV API key in Settings to read the ESV.");
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
  const bookName = state.books[state.book].name;
  els.title.textContent = `${bookName} ${state.chapter + 1}`;
  els.translationBtn.textContent = state.translation;
  document.title = `${bookName} ${state.chapter + 1} · Bible`;

  let html;
  try {
    const verses = await getVerses();
    if (token !== renderToken) return;   // a newer chapter was requested meanwhile
    html = `<h2>${escapeHTML(bookName)} ${state.chapter + 1}</h2>` +
      verses.map((text, i) => text == null ? "" :
        `<p class="verse" id="v${i + 1}" data-verse="${i + 1}"><sup>${i + 1}</sup>${escapeHTML(text)}</p>`
      ).join("") +
      (state.translation === "ESV" ? `<p class="copyright">${ESV_COPYRIGHT}</p>` : "");
  } catch (error) {
    if (token !== renderToken) return;
    html = `<div class="empty"><h2>Not available</h2><p>${escapeHTML(error.message)}</p></div>`;
  }
  els.chapter.innerHTML = html + navButtons();

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
  const label = (n) => `${state.books[n.book].name} ${n.chapter + 1}`;
  return `<div class="nav-row">` +
    (prev ? `<button data-go="${prev.book},${prev.chapter}">‹ ${escapeHTML(label(prev))}</button>` : "") +
    `<span class="spacer"></span>` +
    (next ? `<button data-go="${next.book},${next.chapter}">${escapeHTML(label(next))} ›</button>` : "") +
    `</div>`;
}

function goTo(book, chapter) {
  Object.assign(state, { book, chapter, verse: 1 });
  store.set("book", book);
  store.set("chapter", chapter);
  store.set("verse", 1);
  render({ restoreVerse: 1 });
}

els.chapter.addEventListener("click", (event) => {
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
      state.verse = Number(verse.dataset.verse);
      store.set("verse", state.verse);
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
    `${escapeHTML(b.name)}<span class="count">${b.chapters.length}</span></button>`
  ).join("");
  els.drawerBody.innerHTML =
    `<div class="section-label">Old Testament</div>${rows(0, 39)}` +
    `<div class="section-label">New Testament</div>${rows(39, 66)}`;
  els.drawerBody.querySelector(".current")?.scrollIntoView({ block: "center" });
}

function showChapters(book) {
  els.drawerTitle.textContent = state.books[book].name;
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
    return;
  }
  saveVisibleVerse();
  state.translation = button.dataset.translation;
  store.set("translation", state.translation);
  render();
});
els.settings.addEventListener("close", () => {
  const key = els.esvKey.value.trim();
  if (key === state.esvKey) return;
  state.esvKey = key;
  store.set("esvKey", key);
  esvCache.clear();
  if (state.translation === "ESV") render();
});

/* ---------- Bottom tabs ---------- */

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    document.querySelectorAll(".view").forEach((v) => { v.hidden = v.id !== tab.dataset.view; });
    els.translationBtn.style.visibility = tab.dataset.view === "bibleView" ? "" : "hidden";
    els.title.textContent = tab.dataset.view === "bibleView"
      ? `${state.books[state.book].name} ${state.chapter + 1}` : "Connection";
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
  if (!TRANSLATIONS[state.translation]) state.translation = "KJV";
  render();
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
start();
