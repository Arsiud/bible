"use strict";

const TRANSLATIONS = {
  KJV: "King James Version",
  WEB: "World English Bible",
  ASV: "American Standard Version",
  ESV: "English Standard Version",
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
  sharedEsvKey: "",                           // from the group database once approved; never saved on the device
  tempBookmark: store.get("tempBookmark", null),   // { book, chapter, verse, created } — unnamed, replaced by the next tap
  bookmarks: store.get("bookmarks", []),           // [{ id, name, notes, book, chapter, verse, created }]
  positionUpdated: store.get("positionUpdated", 0),   // timestamps let the newest device win when syncing
  bookmarksUpdated: store.get("bookmarksUpdated", 0),
};

// connect.js listens for these to sync with the group database.
const emit = (name, detail) => window.dispatchEvent(new CustomEvent(`bible:${name}`, { detail }));
const esvCache = new Map();                   // in-memory only, per ESV API terms

// Public-domain translations bundled with the app (and cached by sw.js for offline use).
const BUNDLED = { WEB: "web.json", ASV: "asv.json" };
const bundled = new Map();                    // code -> Promise of books

function loadBundled(code) {
  if (!bundled.has(code)) {
    bundled.set(code, fetch(BUNDLED[code]).then((r) => r.json()).catch((error) => {
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

/* ---------- Loading chapters ---------- */

async function getVerses() {
  const { translation, book, chapter } = state;
  if (translation === "KJV") return state.books[book].chapters[chapter];
  if (BUNDLED[translation]) return (await loadBundled(translation))[book].chapters[chapter];
  return fetchESV(`${state.books[book].name} ${chapter + 1}`);
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
  const bookName = state.books[state.book].name;
  if (!els.bibleView.hidden) els.title.textContent = `${bookName} ${state.chapter + 1}`;
  els.translationBtn.textContent = state.translation;
  document.title = `${bookName} ${state.chapter + 1} · Bible`;

  let html;
  try {
    const verses = await getVerses();
    if (token !== renderToken) return;   // a newer chapter was requested meanwhile
    html = `<h2>${escapeHTML(bookName)} ${state.chapter + 1}</h2>` +
      verses.map((text, i) => !text ? "" :
        `<p class="verse" id="v${i + 1}" data-verse="${i + 1}"><sup>${i + 1}</sup>${escapeHTML(text)}</p>`
      ).join("") +
      (state.translation === "ESV" ? `<p class="copyright">${ESV_COPYRIGHT}</p>` : "");
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
  const label = (n) => `${state.books[n.book].name} ${n.chapter + 1}`;
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

window.bible = {
  state, store, goTo, reference, escapeHTML, toast,
  ready: false,
  showTab(view) { document.querySelector(`.tab[data-view="${view}"]`).click(); },
  // Adopt bookmarks saved from another device.
  setSharedEsvKey(key) {
    if (key === state.sharedEsvKey) return;
    state.sharedEsvKey = key;
    esvCache.clear();
    if (state.translation === "ESV" && !state.esvKey) render();
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
    els.title.textContent = reading ? `${state.books[state.book].name} ${state.chapter + 1}`
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
  if (!TRANSLATIONS[state.translation]) state.translation = "KJV";
  render();
  window.bible.ready = true;
  emit("ready");
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
start();
