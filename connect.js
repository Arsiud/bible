// Connection: groups that see each other's reading place and share verse notes,
// plus syncing your own place and bookmarks across devices.
//
// Sign-in is Firebase Auth (email + password, or Google). New people get 7 days of
// temporary access, then need the owner's approval. The database rules in
// ../firebase/firestore.rules enforce all of this; the checks here only shape the UI.
//
// Firestore layout:
//   users/{uid}                    { nickname, email, approved, blocked, created, groups: [code],
//                                    position, bookmarks, tempBookmark, bookmarksUpdated,
//                                    progress: { marks: { "book_chapter_verse": time }, reset }  (chronological reading)
//                                    offline: ["nasb"] (set by the owner only) }
//   library/nasb                   { copied, verses }   the owner's private NASB 2020 copy
//   library/nasb/books/{0..65}     { name, chapters }   chapters as JSON text
//   config/esv                     { key }   shared ESV key, readable once approved
//   groups/{code}                  { name, created, createdBy }
//   groups/{code}/members/{uid}    { nickname, book, chapter, updated }
//   users/{uid}/notes/{id}         { book, chapter, verse, verseEnd?, text, created, edited? }   "Just me" notes
//   groups/{code}/notes/{id}       { uid, nickname, book, chapter, verse, verseEnd?, text, created, edited? }
//   groups/{code}/replies/{id}     { note, uid, nickname, text, created }   replies to a group note

import { initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signInWithPopup, GoogleAuthProvider, sendPasswordResetEmail, signOut as authSignOut,
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, deleteField, collection, addDoc, onSnapshot,
  query, orderBy, limit, arrayUnion, arrayRemove, serverTimestamp, runTransaction,
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";
import { firebaseConfig, ownerUid } from "./firebase-config.js";

const bible = window.bible;
const { state, store, escapeHTML, toast, reference } = bible;
const app = firebaseConfig ? initializeApp(firebaseConfig) : null;
const db = app && getFirestore(app);
const auth = app && getAuth(app);

const $ = (id) => document.getElementById(id);
const view = $("connection");
const noteDialog = $("noteDialog");
const connectionTab = document.querySelector('.tab[data-view="connectionView"] span');

const TRIAL_DAYS = 7;
const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // no 0/O or 1/I mix-ups

let authKnown = false;    // false until Firebase has said whether we're signed in
let user = null;          // Firebase Auth user
let profile = null;       // users/{uid} document, kept live
let needsNickname = false;
let signInMode = "signin";
const groups = new Map(); // code -> { name, members: [], notes: [], replies: [], unsubs: [] }
let privateNotes = [];    // your "Just me" notes
let people = [];          // owner only: everyone's profile
let managing = null;      // owner only: the group whose Add people panel is open
let unsubs = [];
let positionChecked = false;

const isOwner = () => !!user && user.uid === ownerUid;
const createdAt = () => profile?.created?.toMillis?.() ?? Date.now();
const trialEnds = () => createdAt() + TRIAL_DAYS * 86400000;
const isActive = () => isOwner() || (!!profile && !profile.blocked && (profile.approved || Date.now() < trialEnds()));
const userRef = () => doc(db, "users", user.uid);
const memberRef = (code) => doc(db, "groups", code, "members", user.uid);

const whenReady = new Promise((resolve) => {
  if (bible.ready) resolve();
  else window.addEventListener("bible:ready", resolve, { once: true });
});

function ago(time) {
  const minutes = Math.round((Date.now() - time) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

async function attempt(work) {
  try { return await work(); } catch (error) {
    console.error(error);
    toast(error.code === "permission-denied" ? "You don't have access to that yet."
      : "Couldn't reach the group server. Check your connection.");
  }
}

/* ---------- Signing in ---------- */

const AUTH_ERRORS = {
  "auth/invalid-credential": "Wrong email or password.",
  "auth/invalid-email": "That email doesn't look right.",
  "auth/email-already-in-use": "There's already an account with that email. Sign in instead.",
  "auth/weak-password": "Use a password with at least 6 characters.",
  "auth/too-many-requests": "Too many tries. Wait a minute and try again.",
  "auth/network-request-failed": "Couldn't connect. Check your internet connection.",
  "auth/popup-blocked": "The Google window was blocked. Try again.",
};

if (auth) onAuthStateChanged(auth, async (signedIn) => {
  stopListening();
  authKnown = true;
  user = signedIn;
  profile = null;
  needsNickname = false;
  keysLoaded = false;
  if (!user) {
    bible.setSharedKey("esv", "");
    bible.setSharedKey("niv", "");
    nasbChecked = false;
    bible.offline.remove("NASB");   // the licensed copy stays only with signed-in, permitted people
    renderView();
    highlightVerses();
    return;
  }
  const snap = await readProfile(signedIn);
  if (!snap) return;
  if (snap.exists()) listen();
  else { needsNickname = true; renderView(); }
});

// The profile can't be read while offline (say, the app was opened without signal), so keep trying:
// otherwise nothing would sync until the app was closed and opened again.
async function readProfile(signedIn) {
  for (let delay = 2000; user === signedIn; delay = Math.min(delay * 2, 30000)) {
    try { return await getDoc(userRef()); } catch (error) {
      if (error.code === "permission-denied") { console.error(error); return null; }
    }
    await new Promise((r) => setTimeout(r, delay));
  }
  return null;
}

// First sign-in: create the profile, keeping any bookmarks already on this device.
async function createProfile(nickname) {
  await setDoc(userRef(), {
    nickname, email: user.email ?? "", approved: false, blocked: false,
    created: serverTimestamp(), groups: [],
    bookmarks: state.bookmarks, tempBookmark: state.tempBookmark, bookmarksUpdated: state.bookmarksUpdated,
    progress: state.progress,
  });
  needsNickname = false;
  listen();
}

async function rename(nickname) {
  await setDoc(userRef(), { nickname }, { merge: true });
  await Promise.all([...groups.keys()].map((code) => setDoc(memberRef(code), { nickname }, { merge: true })));
}

/* ---------- Live updates ---------- */

function listen() {
  positionChecked = false;
  unsubs.push(onSnapshot(userRef(), async (snap) => {
    const firstLoad = !profile;
    profile = snap.data();
    if (!profile) return;

    if (firstLoad) watchPrivateNotes();
    if (firstLoad && isOwner()) watchPeople();
    syncBookmarks(profile);
    bible.applyProgress(profile.progress);
    if (progressUnsent()) pushProgress();
    if (!positionChecked) {
      positionChecked = true;
      await whenReady;
      applyPosition(profile.position);
      pushPosition(true);
      handlePendingJoin();
    }
    loadSharedKeys();
    syncNasb();

    const codes = new Set(isActive() ? profile.groups ?? [] : []);
    for (const [code, group] of groups) {
      if (!codes.has(code)) { group.unsubs.forEach((u) => u()); groups.delete(code); }
    }
    codes.forEach((code) => { if (!groups.has(code)) watchGroup(code); });
    renderView();
    highlightVerses();
  }, (error) => console.error(error)));
}

function stopListening() {
  unsubs.forEach((u) => u());
  unsubs = [];
  groups.forEach((group) => group.unsubs.forEach((u) => u()));
  groups.clear();
  people = [];
  privateNotes = [];
  renderPrivateNotes();
}

function watchGroup(code) {
  const group = { name: code, members: [], notes: [], replies: [], unsubs: [] };
  groups.set(code, group);
  const refresh = () => { renderView(); highlightVerses(); refreshNotes(); };
  const failed = (error) => console.error(code, error);
  group.unsubs.push(
    onSnapshot(doc(db, "groups", code), (snap) => { group.name = snap.data()?.name ?? code; refresh(); }, failed),
    onSnapshot(collection(db, "groups", code, "members"), (snap) => {
      group.members = snap.docs.map((d) => ({ uid: d.id, ...d.data() })).sort((a, b) => b.updated - a.updated);
      refresh();
    }, failed),
    onSnapshot(query(collection(db, "groups", code, "notes"), orderBy("created", "desc"), limit(200)), (snap) => {
      group.notes = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      refresh();
    }, failed),
    onSnapshot(query(collection(db, "groups", code, "replies"), orderBy("created", "desc"), limit(500)), (snap) => {
      group.replies = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      refresh();
    }, failed),
  );
}

// Translation keys the owner shares with approved people (config/esv, config/niv).
const SHARED_KEYS = { esv: "ESV", niv: "API.Bible (NIV, NASB, NTV)" };   // "niv" holds the API.Bible key
let keysLoaded = false;
async function loadSharedKeys() {
  if (keysLoaded || !(isOwner() || (profile.approved && !profile.blocked))) return;
  keysLoaded = true;
  try {
    for (const name of Object.keys(SHARED_KEYS)) {
      bible.setSharedKey(name, (await getDoc(doc(db, "config", name))).data()?.key ?? "");
    }
  } catch (error) {
    console.warn("ESV key not loaded yet", error.code);
    keysLoaded = false;   // try again on the next profile update
  }
}

/* ---------- NASB 2020 offline ---------- */

// Lockman's permission (Oct 28, 2026) covers up to 10 copies for private family use. Lockman
// confirmed by email (Oct 29, 2026) that one copy means one person, on all their own devices;
// the owner counts as one of the 10. The owner copies the text from
// API.Bible into library/nasb once and picks who may keep it; their devices download it, and it's
// deleted from a device when its person is taken off the list, blocked, or signs out.
const NASB_LIMIT = 10;
let nasbLibrary = null;   // library/nasb: { copied, verses }
let nasbChecked = false, nasbSyncing = false, nasbCopying = false;
const hasNasbGrant = (p) => !!p && p.approved && !p.blocked && (p.offline ?? []).includes("nasb");
const mayKeepNasb = () => isOwner() || hasNasbGrant(profile);
const nasbPeople = () => 1 + people.filter((p) => p.uid !== ownerUid && hasNasbGrant(p)).length;

async function syncNasb() {
  if (!mayKeepNasb()) {
    if (bible.offline.copied("NASB")) {
      await bible.offline.remove("NASB");
      toast("The offline NASB was removed from this device");
    }
    return;
  }
  if (nasbChecked || nasbSyncing) return;
  nasbSyncing = true;
  try {
    nasbLibrary = (await getDoc(doc(db, "library", "nasb"))).data() ?? null;
    nasbChecked = true;
    if (nasbLibrary?.copied > bible.offline.copied("NASB")) {
      const books = [];
      (await getDocs(collection(db, "library", "nasb", "books"))).forEach((d) => {
        books[Number(d.id)] = { name: d.data().name, chapters: JSON.parse(d.data().chapters) };
      });
      if (books.length !== state.books.length || books.some((b) => !b)) throw new Error("NASB copy is incomplete");
      if (!mayKeepNasb()) return;   // permission was withdrawn while downloading
      await bible.offline.save("NASB", books, nasbLibrary.copied);
      toast("The NASB is now saved on this device for offline reading");
    }
  } catch (error) {
    console.warn("NASB offline copy not downloaded", error);
  } finally {
    nasbSyncing = false;
    renderView();
  }
}

// Owner only: copy all of the NASB 2020 from API.Bible into the private library.
async function copyNasb() {
  nasbCopying = true;
  renderView();
  const progress = (text) => { const el = $("nasbProgress"); if (el) el.textContent = text; };
  try {
    const books = await bible.offline.copyFromApi("NASB", (done, total) => progress(`Copying… ${done} of ${total} chapters`));
    const verses = books.reduce((n, b) => n + b.chapters.reduce((m, c) => m + c.filter(Boolean).length, 0), 0);
    if (books.some((b) => b.chapters.some((c) => !c?.length)) || verses < 30000) {
      throw new Error(`The copy looks incomplete (${verses} verses), so it wasn't saved.`);
    }
    progress("Saving to your private database…");
    for (const [i, b] of books.entries()) {
      await setDoc(doc(db, "library", "nasb", "books", String(i)), { name: b.name, chapters: JSON.stringify(b.chapters) });
    }
    const copied = Date.now();
    await setDoc(doc(db, "library", "nasb"), { copied, verses });
    nasbLibrary = { copied, verses };
    await bible.offline.save("NASB", books, copied);
    toast(`NASB copied: ${verses.toLocaleString()} verses`);
  } catch (error) {
    console.error(error);
    toast(error.message.length < 120 ? error.message : "Couldn't finish copying the NASB.");
  }
  nasbCopying = false;
  renderView();
}

function renderNasbOwner() {
  const status = nasbCopying ? `<span id="nasbProgress">Starting…</span>`
    : nasbLibrary ? `Copied ${new Date(nasbLibrary.copied).toLocaleDateString()} · ${nasbLibrary.verses.toLocaleString()} verses`
    : "Not copied yet. Copying takes a few minutes; keep the app open.";
  return `<div class="section-label">NASB 2020 offline</div><div class="group">` +
    `<div class="person"><div class="person-main"><div class="person-sub">${status}</div>` +
    `<div class="person-sub">Allowed: ${nasbPeople()} of ${NASB_LIMIT} people, including you (Lockman permission)</div></div>` +
    `<div class="person-actions"><button class="card-btn" data-copy-nasb ${nasbCopying ? "disabled" : ""}>` +
    `${nasbLibrary ? "Copy again" : "Copy NASB"}</button></div></div></div>`;
}

/* ---------- Your place and bookmarks ---------- */

// Jump to where you were reading on another device, if that was more recent.
function applyPosition(position) {
  if (!position || position.updated <= state.positionUpdated) return;
  if (!state.books[position.book]?.chapters[position.chapter]) return;
  bible.goTo(position.book, position.chapter, position.verse, { updated: position.updated });
  toast(`Picked up where you left off: ${reference(position)}`);
}

// Your exact place is saved on the device right away, but sent to the database at most
// every 30 seconds (and when you leave the app) to stay well inside the free plan.
const POSITION_EVERY = 30000;
let positionTimer = null, lastPositionWrite = 0, lastShared = "";

function pushPosition(now = false) {
  if (!profile) return;
  if (now) { clearTimeout(positionTimer); positionTimer = null; writePosition(); return; }
  if (positionTimer) return;
  positionTimer = setTimeout(() => { positionTimer = null; writePosition(); },
    Math.max(0, lastPositionWrite + POSITION_EVERY - Date.now()));
}

function writePosition() {
  const { book, chapter, verse, positionUpdated: updated } = state;
  if (!profile || updated <= (profile.position?.updated ?? 0)) return;
  lastPositionWrite = Date.now();
  attempt(async () => {
    await setDoc(userRef(), { position: { book, chapter, verse, updated } }, { merge: true });
    // The group only sees the chapter, so only tell them when it changes.
    const where = `${book}:${chapter}`;
    if (where === lastShared || !isActive()) return;
    lastShared = where;
    await Promise.all([...groups.keys()].map((code) =>
      setDoc(memberRef(code), { nickname: profile.nickname, book, chapter, updated: Date.now() }, { merge: true })));
  });
}

// Bookmarks can change on two devices before they hear from each other: one was offline, or was
// closed before it could send. "Synced" is the database's bookmarksUpdated as this device last saw it
// (with everything up to then included here), so each side's changes since then can be told apart and
// an old copy never comes back on its own. A device that has never synced this account keeps both sides.
const syncedKey = () => `bookmarksSynced:${user.uid}`;
const getSynced = () => store.get(syncedKey(), null);
const setSynced = (updated) => store.set(syncedKey(), updated);
const mine = () => ({ bookmarks: state.bookmarks, tempBookmark: state.tempBookmark, bookmarksUpdated: state.bookmarksUpdated });

// A change from the database.
function syncBookmarks(remote) {
  if (writing) return;   // writeBookmarks picks it up
  const remoteUpdated = remote.bookmarksUpdated ?? 0, synced = getSynced();
  if (remoteUpdated === state.bookmarksUpdated) return setSynced(remoteUpdated);
  if (synced !== null && state.bookmarksUpdated === synced && remoteUpdated > synced) {
    bible.applyBookmarks({ bookmarks: remote.bookmarks, tempBookmark: remote.tempBookmark, updated: remoteUpdated });
    return setSynced(remoteUpdated);
  }
  pushBookmarks(true);   // this device has changes the database doesn't (or the database went back to an older copy)
}

// What to send, given the database's copy: ours as it is if nothing changed there since we last synced,
// otherwise both sides combined.
function combine(remote, synced) {
  const remoteUpdated = remote.bookmarksUpdated ?? 0, localUpdated = state.bookmarksUpdated;
  if (remoteUpdated === synced || remoteUpdated === localUpdated) return mine();
  if (localUpdated === synced) {   // nothing new here: take theirs, unless theirs is an older copy written over ours
    return remoteUpdated < synced ? mine()
      : { bookmarks: remote.bookmarks ?? [], tempBookmark: remote.tempBookmark ?? null, bookmarksUpdated: remoteUpdated };
  }
  // A bookmark on one side only is new there, unless it was already around at the last sync,
  // in which case the other side deleted it.
  const local = new Map(state.bookmarks.map((b) => [b.id, b]));
  const others = new Map((remote.bookmarks ?? []).map((b) => [b.id, b]));
  const bookmarks = [];
  for (const id of new Set([...local.keys(), ...others.keys()])) {
    const a = local.get(id), b = others.get(id);
    if (a && b) bookmarks.push(localUpdated > remoteUpdated ? a : b);
    else if (synced === null || (a ?? b).created > synced) bookmarks.push(a ?? b);
  }
  // The temporary bookmark: if both sides have one, the newer. If only one side does, it stays only if it was
  // dropped after the last sync (or, never synced, after the other side's last change); otherwise it was named.
  const a = state.tempBookmark, b = remote.tempBookmark ?? null;
  const tempBookmark = a && b ? (a.created >= b.created ? a : b)
    : a?.created > (synced ?? remoteUpdated) ? a
    : b?.created > (synced ?? localUpdated) ? b : null;
  return {
    bookmarks: bookmarks.sort((x, y) => y.created - x.created), tempBookmark,
    bookmarksUpdated: Math.max(Date.now(), localUpdated + 1, remoteUpdated + 1),
  };
}

let bookmarkTimer = null, writing = false, writeAgain = false;
function pushBookmarks(now = false) {
  if (!profile) return;   // sent once the profile loads (syncBookmarks)
  clearTimeout(bookmarkTimer);
  bookmarkTimer = now ? null : setTimeout(writeBookmarks, 800);
  if (now) writeBookmarks();
}

// Read-then-write, so a device coming back online never writes over what others saved meanwhile.
// Offline it fails quietly: the bookmarks are kept here and sent when the app is next online.
async function writeBookmarks() {
  bookmarkTimer = null;
  if (writing) { writeAgain = true; return; }
  writing = true;
  const base = state.bookmarksUpdated, synced = getSynced();
  let sentOk = false;
  try {
    const sent = await runTransaction(db, async (tx) => {
      const next = combine((await tx.get(userRef())).data() ?? {}, synced);
      tx.set(userRef(), next, { merge: true });
      return next;
    });
    if (state.bookmarksUpdated === base) {   // nothing new here while sending
      if (sent.bookmarksUpdated !== base) bible.applyBookmarks({ ...sent, updated: sent.bookmarksUpdated });
      setSynced(sent.bookmarksUpdated);
    } else writeAgain = true;
    sentOk = true;
  } catch (error) {
    console.warn("Bookmarks not sent yet", error);
  } finally {
    writing = false;
    if (writeAgain) { writeAgain = false; pushBookmarks(true); }
    else if (sentOk && profile) syncBookmarks(profile);   // anything that arrived while sending
  }
}

// Reading progress (chronological): marks merge by keeping the newer one (app.js, Reading progress), so a
// write is just read, merge, write back. "progressUnsent" remembers changes made offline or not yet sent.
let progressTimer = null, progressChanges = 0, sendingProgress = false;
const progressUnsent = () => !!profile && store.get("progressUnsent", false);
function pushProgress(now = false) {
  clearTimeout(progressTimer);
  progressTimer = now ? null : setTimeout(writeProgress, 1500);
  if (now) writeProgress();
}
async function writeProgress() {
  progressTimer = null;
  if (!profile || sendingProgress) return;
  sendingProgress = true;
  const changes = progressChanges;
  try {
    await runTransaction(db, async (tx) => {
      const merged = bible.mergeProgress((await tx.get(userRef())).data()?.progress, state.progress);
      tx.update(userRef(), { progress: merged });
    });
    if (changes === progressChanges) store.set("progressUnsent", false);
  } catch (error) {
    console.warn("Reading progress not sent yet", error);
  } finally {
    sendingProgress = false;
    if (changes !== progressChanges) pushProgress();
  }
}
window.addEventListener("bible:progress", () => {
  progressChanges++;
  store.set("progressUnsent", true);
  pushProgress();
});
window.addEventListener("online", () => { if (progressUnsent()) pushProgress(true); });

const unsent = () => !!profile && state.bookmarksUpdated !== getSynced();
window.addEventListener("online", () => { if (unsent()) pushBookmarks(true); });

window.addEventListener("bible:position", () => {
  // A new chapter is worth telling the group about right away; scrolling within one can wait.
  const where = `${state.book}:${state.chapter}`;
  pushPosition(where !== lastShared);
});
window.addEventListener("bible:bookmarks", () => pushBookmarks());
window.addEventListener("bible:rendered", highlightVerses);

document.addEventListener("visibilitychange", () => {
  if (!profile) return;
  if (document.visibilityState === "hidden") {
    if (bookmarkTimer) pushBookmarks(true);   // don't leave a bookmark waiting while the app is put away
    if (progressTimer) pushProgress(true);
    return pushPosition(true);
  }
  // Coming back to the app: pick up a newer place from another device, and send bookmarks that couldn't go before.
  attempt(async () => applyPosition((await getDoc(userRef())).data()?.position));
  if (unsent()) pushBookmarks(true);
  if (progressUnsent()) pushProgress(true);
});

/* ---------- Groups ---------- */

async function createGroup(name) {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)]).join("");
  } while ((await getDoc(doc(db, "groups", code))).exists());
  await setDoc(doc(db, "groups", code), { name, created: Date.now(), createdBy: user.uid });
  await joinGroup(code);
  return code;
}

async function joinGroup(rawCode) {
  const code = rawCode.trim().toUpperCase();
  if (!(await getDoc(doc(db, "groups", code))).exists()) throw new Error(`There's no group with the code ${code}.`);
  await setDoc(memberRef(code), { nickname: profile.nickname, book: state.book, chapter: state.chapter, updated: Date.now() });
  await setDoc(userRef(), { groups: arrayUnion(code) }, { merge: true });
}

async function leaveGroup(code) {
  await deleteDoc(memberRef(code));
  await setDoc(userRef(), { groups: arrayRemove(code) }, { merge: true });
}

// The owner can put anyone who has signed up straight into a group, or take them out.
// Their own app sees the new code in their profile and starts following the group.
async function addToGroup(code, uid) {
  const person = people.find((p) => p.uid === uid);
  const at = person?.position ?? { book: 0, chapter: 0 };
  await setDoc(doc(db, "groups", code, "members", uid),
    { nickname: person?.nickname ?? "?", book: at.book, chapter: at.chapter, updated: at.updated ?? Date.now() });
  await setDoc(doc(db, "users", uid), { groups: arrayUnion(code) }, { merge: true });
  return true;
}

async function removeFromGroup(code, uid) {
  await deleteDoc(doc(db, "groups", code, "members", uid));
  await setDoc(doc(db, "users", uid), { groups: arrayRemove(code) }, { merge: true });
}

function renderManage(code, group) {
  const inGroup = new Set(group.members.map((m) => m.uid));
  const others = people.filter((p) => p.uid !== ownerUid && !inGroup.has(p.uid) && !p.blocked)
    .sort((a, b) => (a.nickname ?? "").localeCompare(b.nickname ?? ""));
  const row = (p, button) => `<div class="person"><div class="person-main"><b>${escapeHTML(p.nickname ?? "?")}</b>` +
    (p.email ? `<div class="person-sub">${escapeHTML(p.email)}</div>` : "") + `</div>` +
    `<div class="person-actions">${button}</div></div>`;
  return `<div class="manage"><div class="sub-label">Add people</div>` +
    (others.map((p) => row(p, `<button class="card-btn" data-add-person="${p.uid}" data-group="${code}">Add</button>`)).join("") ||
      `<p class="list-empty" style="padding:4px 14px 8px">Everyone who has signed up is already in this group.</p>`) +
    (group.members.some((m) => m.uid !== user.uid)
      ? `<div class="sub-label">In this group</div>` + group.members.filter((m) => m.uid !== user.uid).map((m) =>
        row(m, `<button class="link-btn" data-remove-person="${m.uid}" data-group="${code}">Remove</button>`)).join("")
      : "") +
    `</div>`;
}

async function invite(code) {
  const url = `${location.origin}${location.pathname}?join=${code}`;
  const text = `Join my Bible reading group "${groups.get(code)?.name ?? code}" (code ${code}): ${url}`;
  if (navigator.share) {
    try { await navigator.share({ text }); } catch {}
    return;
  }
  try { await navigator.clipboard.writeText(text); toast("Invite link copied"); }
  catch { prompt("Copy this invite:", text); }
}

// Opening an invite link (?join=CODE) remembers the code until you're signed in.
const joinParam = new URLSearchParams(location.search).get("join");
if (joinParam) {
  store.set("pendingJoin", joinParam.toUpperCase());
  history.replaceState(null, "", location.pathname);
  whenReady.then(() => bible.showTab("connectionView"));
}

async function handlePendingJoin() {
  const code = store.get("pendingJoin", null);
  if (!code || !profile || !isActive()) return;
  store.set("pendingJoin", null);
  if (profile.groups?.includes(code)) return;
  try { await joinGroup(code); toast(`Joined group ${code}`); }
  catch (error) { toast(error.message.startsWith("There's") ? error.message : "Couldn't join that group."); }
}

/* ---------- Owner: approving people and the shared ESV key ---------- */

function watchPeople() {
  unsubs.push(onSnapshot(collection(db, "users"), (snap) => {
    people = snap.docs.map((d) => ({ uid: d.id, ...d.data() }))
      .sort((a, b) => (b.created?.toMillis?.() ?? 0) - (a.created?.toMillis?.() ?? 0));
    renderView();
  }, (error) => console.error(error)));
}

const pending = () => people.filter((p) => !p.approved && !p.blocked && p.uid !== ownerUid);

function renderPeople() {
  const row = (p) => {
    const status = p.blocked ? "Blocked" : p.approved ? "Approved" : "Waiting for approval";
    const granted = hasNasbGrant(p);
    const nasb = p.approved && !p.blocked
      ? `<button class="${granted ? "card-btn" : "link-btn"}" data-nasb="${p.uid}" ` +
        `${!granted && nasbPeople() >= NASB_LIMIT ? "disabled" : ""}>${granted ? "NASB offline ✓" : "NASB offline"}</button>` : "";
    const actions = p.blocked ? `<button class="card-btn" data-person="${p.uid}" data-set="unblock">Unblock</button>`
      : nasb + `${p.approved ? "" : `<button class="card-btn" data-person="${p.uid}" data-set="approve">Approve</button>`}` +
        `<button class="link-btn" data-person="${p.uid}" data-set="block">Block</button>`;
    return `<div class="person"><div class="person-main"><b>${escapeHTML(p.nickname ?? "?")}</b>` +
      `<div class="person-sub">${escapeHTML(p.email ?? "")}</div>` +
      `<div class="person-sub">${status}${p.created ? ` · joined ${ago(p.created.toMillis())}` : ""}</div></div>` +
      `<div class="person-actions">${actions}</div></div>`;
  };
  const others = people.filter((p) => p.uid !== ownerUid);
  const waiting = pending();
  return `<div class="section-label">People${waiting.length ? ` · ${waiting.length} waiting` : ""}</div>` +
    `<div class="group">${others.length ? [...waiting, ...others.filter((p) => !waiting.includes(p))].map(row).join("")
      : `<p class="list-empty" style="padding:12px 14px 4px">Nobody else has signed up yet.</p>`}` +
    Object.entries(SHARED_KEYS).map(([name, label]) => {
      const set = name === "esv" ? state.sharedEsvKey : state.sharedNivKey;
      return `<form class="esv-form" data-key-form="${name}"><label for="shared-${name}">Shared ${label} key</label>` +
        `<div class="inline"><input class="field" id="shared-${name}" autocomplete="off" autocapitalize="off" spellcheck="false" ` +
        `placeholder="${set ? "Key is set. Paste a new one to replace it" : "Paste the key to share it with approved people"}">` +
        `<button class="card-btn">Save</button></div></form>`;
    }).join("") + `</div>` + renderNasbOwner();
}

/* ---------- Connection tab ---------- */

function renderView() {
  const waiting = isOwner() ? pending().length : 0;
  connectionTab.textContent = waiting ? `Connection (${waiting})` : "Connection";
  if (!db) {
    view.innerHTML = `<div class="empty"><h2>Connection</h2><p>Not set up yet.</p></div>`;
    return;
  }
  if (!authKnown) { view.innerHTML = `<p class="list-empty">Loading…</p>`; return; }
  if (!user) return renderSignIn();
  if (needsNickname) return renderNickname();
  if (!profile) { view.innerHTML = `<p class="list-empty">Loading…</p>`; return; }

  const header =
    `<div class="me"><span>Signed in as <b>${escapeHTML(profile.nickname)}</b></span>` +
    `<span><button class="link-btn" data-rename>Rename</button><button class="link-btn" data-signout>Sign out</button></span></div>`;

  let banner = "";
  if (!isOwner() && profile.blocked) {
    banner = `<div class="banner">Your account is paused. Ask the person who runs this app to unblock you.</div>`;
  } else if (!isOwner() && !profile.approved) {
    // Clamped because the server's clock can run slightly ahead of the phone's.
    const daysLeft = Math.min(TRIAL_DAYS, Math.ceil((trialEnds() - Date.now()) / 86400000));
    banner = daysLeft > 0
      ? `<div class="banner">Welcome! You have temporary access for ${daysLeft} more day${daysLeft === 1 ? "" : "s"} ` +
        `while the owner approves your account. The shared ESV unlocks once you're approved.</div>`
      : `<div class="banner">Your temporary access has ended. Groups will come back once the owner approves your account.</div>`;
  }
  if (!isActive()) {
    view.innerHTML = header + banner +
      `<p class="list-empty">Your place and bookmarks still sync across your devices.</p>`;
    return;
  }

  const cards = [...groups.entries()].map(([code, group]) => {
    const members = group.members.map((m) =>
      `<button class="member" data-go="${m.book},${m.chapter}">` +
      `<span><b>${escapeHTML(m.nickname)}</b>${m.uid === user.uid ? " (you)" : ""}</span>` +
      `<span><span class="where">${escapeHTML(reference({ ...m, verse: 1 }))}</span> <span class="when">· ${ago(m.updated)}</span></span></button>`
    ).join("");
    const notes = group.notes.slice(0, 5).map((n) => {
      const replies = group.replies.filter((r) => r.note === n.id).length;
      return `<button class="note" data-go="${n.book},${n.chapter},${n.verse},${lastVerse(n)}">` +
        `<div class="who"><b>${escapeHTML(n.nickname)}</b> on ${escapeHTML(bible.verseRef(n))} · ${ago(n.created)}` +
        `${replies ? ` · ${replies} repl${replies === 1 ? "y" : "ies"}` : ""}</div>` +
        `<div class="text">${escapeHTML(n.text)}</div></button>`;
    }).join("");
    return `<div class="group">` +
      `<div class="group-head"><h3>${escapeHTML(group.name)} <span class="code">${code}</span></h3>` +
      (isOwner() ? `<button class="card-btn" data-manage="${code}">${managing === code ? "Done" : "Add people"}</button>` : "") +
      `<button class="card-btn" data-invite="${code}">Invite</button></div>` +
      (isOwner() && managing === code ? renderManage(code, group) : "") +
      members +
      (notes ? `<div class="sub-label">Recent notes</div>${notes}` : "") +
      `<div class="group-foot"><button class="link-btn" data-leave="${code}">Leave group</button></div></div>`;
  }).join("");

  // Keep a half-pasted key if the list redraws while the owner is pasting.
  const drafts = Object.keys(SHARED_KEYS).map((name) => $(`shared-${name}`)?.value ?? "");
  const nasbNote = !isOwner() && hasNasbGrant(profile)
    ? `<p class="list-empty">${bible.offline.copied("NASB") ? "The NASB 2020 is saved on this device for offline reading."
      : nasbSyncing ? "Downloading the NASB 2020 for offline reading…" : "The NASB 2020 will download for offline reading once the owner has copied it."}</p>` : "";
  view.innerHTML = header + banner + nasbNote +
    `<div class="row-actions"><button class="secondary-btn" data-create>Create group</button>` +
    `<button class="secondary-btn" data-join>Join group</button></div>` +
    `<div class="section-label">Your groups</div>` +
    (cards || `<p class="list-empty">Create a group and invite people, or join one with its code. ` +
      `To share a note, hold a verse while reading and tap Note.</p>`) +
    (isOwner() ? renderPeople() : "");
  Object.keys(SHARED_KEYS).forEach((name, i) => { if (drafts[i] && $(`shared-${name}`)) $(`shared-${name}`).value = drafts[i]; });
}

function renderSignIn() {
  const invited = store.get("pendingJoin", null);
  const creating = signInMode === "create";
  view.innerHTML = `<div class="form-card">` +
    `<p>${invited ? `You've been invited to group <b>${escapeHTML(invited)}</b>. ` : ""}` +
    `Sign in to read along with a group. Your place and bookmarks come with you on any device.</p>` +
    `<button class="google-btn" data-google>` +
    `<svg viewBox="0 0 24 24" width="18" height="18"><path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.2-2.1 3.5-5.1 3.5-8.7z"/><path fill="#34A853" d="M12 24c3.2 0 6-1.1 7.9-2.9l-3.9-3c-1.1.7-2.4 1.2-4 1.2-3.1 0-5.7-2.1-6.6-4.9h-4v3.1A12 12 0 0 0 12 24z"/><path fill="#FBBC05" d="M5.4 14.4a7.2 7.2 0 0 1 0-4.7V6.6h-4a12 12 0 0 0 0 10.8l4-3z"/><path fill="#EA4335" d="M12 4.8c1.7 0 3.3.6 4.5 1.8l3.4-3.4A12 12 0 0 0 1.4 6.6l4 3.1c.9-2.8 3.5-4.9 6.6-4.9z"/></svg>` +
    `Continue with Google</button>` +
    `<div class="or">or</div>` +
    `<form id="signInForm">` +
    `<label for="signInEmail">Email</label>` +
    `<input class="field" id="signInEmail" type="email" autocomplete="email" autocapitalize="off" required>` +
    `<label for="signInPassword">Password</label>` +
    `<input class="field" id="signInPassword" type="password" autocomplete="${creating ? "new-password" : "current-password"}" required minlength="6">` +
    `<button class="primary-btn">${creating ? "Create account" : "Sign in"}</button></form>` +
    `<p class="error" id="signInError"></p>` +
    `<div class="form-links"><button class="link-btn" data-mode>${creating ? "I already have an account" : "New here? Create an account"}</button>` +
    (creating ? "" : `<button class="link-btn" data-reset>Forgot password?</button>`) + `</div></div>`;
}

function renderNickname() {
  const suggestion = user.displayName?.split(" ")[0] ?? "";
  view.innerHTML = `<form class="form-card" id="nicknameForm">` +
    `<p>One more thing: what should your group call you?</p>` +
    `<label for="nickname">Nickname</label>` +
    `<input class="field" id="nickname" autocomplete="nickname" required maxlength="40" value="${escapeHTML(suggestion)}" placeholder="e.g. Heather">` +
    `<button class="primary-btn">Continue</button><p class="error" id="signInError"></p></form>`;
}

const showError = (error) => {
  console.error(error);
  if (error.code === "auth/popup-closed-by-user" || error.code === "auth/cancelled-popup-request") return;
  const el = $("signInError");
  if (el) el.textContent = AUTH_ERRORS[error.code] ?? "Something went wrong. Try again.";
};

view.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector("button:not([type=button])") ?? form.querySelector("button");
  button.disabled = true;
  try {
    if (form.id === "signInForm") {
      const email = $("signInEmail").value.trim(), password = $("signInPassword").value;
      if (signInMode === "create") await createUserWithEmailAndPassword(auth, email, password);
      else await signInWithEmailAndPassword(auth, email, password);
    } else if (form.id === "nicknameForm") {
      await createProfile($("nickname").value.trim());
    } else if (form.dataset.keyForm) {
      const name = form.dataset.keyForm;
      const key = $(`shared-${name}`).value.trim();
      if (key) {
        await setDoc(doc(db, "config", name), { key });
        $(`shared-${name}`).value = "";
        bible.setSharedKey(name, key);
        toast(`${SHARED_KEYS[name]} key shared with approved people`);
        renderView();
      }
    }
  } catch (error) {
    if (form.dataset.keyForm) { console.error(error); toast("Couldn't save the key."); }
    else showError(error);
  }
  button.disabled = false;
});

view.addEventListener("click", async (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  const data = target.dataset;

  if (data.google !== undefined) {
    try { await signInWithPopup(auth, new GoogleAuthProvider()); } catch (error) { showError(error); }
  } else if (data.mode !== undefined) {
    signInMode = signInMode === "create" ? "signin" : "create";
    renderSignIn();
  } else if (data.reset !== undefined) {
    const email = $("signInEmail").value.trim();
    if (!email) { $("signInError").textContent = "Type your email first, then tap Forgot password."; return; }
    try { await sendPasswordResetEmail(auth, email); $("signInError").textContent = `If there's an account for ${email}, a reset link is on its way.`; }
    catch (error) { showError(error); }
  } else if (data.go) {
    const [book, chapter, verse = 1, verseEnd = verse] = data.go.split(",").map(Number);
    bible.jumpTo(book, chapter, verse, verseEnd);
  } else if (data.invite) invite(data.invite);
  else if (data.manage) {
    managing = managing === data.manage ? null : data.manage;
    renderView();
  } else if (data.addPerson) {
    target.disabled = true;
    const name = people.find((p) => p.uid === data.addPerson)?.nickname ?? "them";
    if (await attempt(() => addToGroup(data.group, data.addPerson))) toast(`Added ${name}`);
  } else if (data.removePerson) {
    const name = groups.get(data.group)?.members.find((m) => m.uid === data.removePerson)?.nickname ?? "this person";
    if (confirm(`Remove ${name} from ${groups.get(data.group)?.name ?? "this group"}?`))
      attempt(() => removeFromGroup(data.group, data.removePerson));
  } else if (data.leave !== undefined) {
    if (confirm(`Leave ${groups.get(data.leave)?.name ?? "this group"}?`)) attempt(() => leaveGroup(data.leave));
  } else if (data.create !== undefined) {
    const name = prompt("Name your group", "Reading group")?.trim();
    if (!name) return;
    const code = await attempt(() => createGroup(name));
    if (code) toast(`Created ${name} with code ${code}`);
  } else if (data.join !== undefined) {
    const code = prompt("Group code")?.trim();
    if (!code) return;
    try { await joinGroup(code); toast(`Joined group ${code.toUpperCase()}`); }
    catch (error) { toast(error.message.startsWith("There's") ? error.message : "Couldn't join. Check your connection."); }
  } else if (data.rename !== undefined) {
    const nickname = prompt("Your nickname", profile.nickname)?.trim();
    if (nickname && nickname !== profile.nickname) await attempt(() => rename(nickname));
  } else if (data.signout !== undefined) {
    if (confirm(`Sign out on this device? Your bookmarks stay here, and you can sign back in any time.` +
      `${bible.offline.copied("NASB") ? " The offline NASB will be removed from this device." : ""}`)) authSignOut(auth);
  } else if (data.copyNasb !== undefined) {
    if (!state.sharedNivKey) {
      toast("Paste your API.Bible key in “Shared API.Bible (NIV, NASB, NTV) key” above and tap Save first");
      $("shared-niv")?.focus();
      return;
    }
    if (confirm("Copy the whole NASB 2020 from API.Bible into your private database? It takes a few minutes; keep the app open.")) copyNasb();
  } else if (data.nasb) {
    const person = people.find((p) => p.uid === data.nasb);
    const granted = hasNasbGrant(person);
    if (!granted && nasbPeople() >= NASB_LIMIT) return toast(`Lockman's permission covers ${NASB_LIMIT} people`);
    attempt(() => setDoc(doc(db, "users", data.nasb), { offline: granted ? arrayRemove("nasb") : arrayUnion("nasb") }, { merge: true }));
    toast(granted ? `${person.nickname}'s devices will remove the offline NASB` : `${person.nickname} can now keep the NASB offline`);
  } else if (data.person) {
    // Blocking also takes away the offline NASB, so it frees up one of the 10 places.
    const change = { approve: { approved: true }, block: { blocked: true, offline: arrayRemove("nasb") }, unblock: { blocked: false } }[data.set];
    attempt(() => setDoc(doc(db, "users", data.person), change, { merge: true }));
  }
});

/* ---------- Verse notes ---------- */

// A note is on one verse or a few (verse to verseEnd), and either just for you (users/{uid}/notes)
// or shared with one group. Group notes can have replies. Pick verses and tap Note to see and write them.
const lastVerse = (n) => n.verseEnd ?? n.verse;
const notePath = (n) => n.code ? doc(db, "groups", n.code, "notes", n.id) : doc(db, "users", user.uid, "notes", n.id);
let noteRange = null;   // { book, chapter, verse, verseEnd? } the dialog is about
let composing = null;   // { kind: "new" } | { kind: "edit" | "reply", note }

function watchPrivateNotes() {
  unsubs.push(onSnapshot(query(collection(db, "users", user.uid, "notes"), orderBy("created", "desc"), limit(500)), (snap) => {
    privateNotes = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderPrivateNotes();
    highlightVerses();
    refreshNotes();
  }, (error) => console.error(error)));
}

// Notes touching verses start..end of a chapter: your own, then everyone's in your groups, oldest first.
function notesOn(book, chapter, start = 1, end = Infinity) {
  const on = (n) => n.book === book && n.chapter === chapter && n.verse <= end && lastVerse(n) >= start;
  const found = privateNotes.filter(on).map((n) => ({ ...n, code: null }));
  for (const [code, group] of groups) found.push(...group.notes.filter(on).map((n) => ({ ...n, code })));
  return found.sort((a, b) => a.created - b.created);
}
bible.noteCount = (s) => user ? notesOn(s.book, s.chapter, s.start, s.end).length : 0;

function highlightVerses() {
  document.querySelectorAll(".verse.noted").forEach((v) => v.classList.remove("noted"));
  for (const n of notesOn(state.book, state.chapter)) {
    for (let v = n.verse; v <= lastVerse(n); v++) document.getElementById(`v${v}`)?.classList.add("noted");
  }
}

// Keep an open dialog current as notes and replies come in.
function refreshNotes() { if (noteDialog.open) renderNoteList(); }

function renderNoteList() {
  const many = groups.size > 1;
  const { book, chapter, verse } = noteRange;
  $("noteList").innerHTML = notesOn(book, chapter, verse, lastVerse(noteRange)).map((n) => {
    const key = `${n.code ?? ""}/${n.id}`;
    const mine = !n.code || n.uid === user.uid;
    const who = n.code ? `<b>${escapeHTML(n.nickname)}</b>${many ? ` in ${escapeHTML(groups.get(n.code).name)}` : ""}` : `<b>Just me</b>`;
    // Its own verses, when they aren't exactly the ones picked
    const on = n.verse !== verse || lastVerse(n) !== lastVerse(noteRange) ? ` on ${escapeHTML(bible.verseRef(n))}` : "";
    const replies = n.code ? groups.get(n.code).replies.filter((r) => r.note === n.id).sort((a, b) => a.created - b.created) : [];
    return `<div class="note"><div class="who">${who}${on} · ${ago(n.created)}${n.edited ? " · edited" : ""}</div>` +
      `<div class="text">${escapeHTML(n.text)}</div>` +
      replies.map((r) => `<div class="reply"><div class="who"><b>${escapeHTML(r.nickname)}</b> · ${ago(r.created)}` +
        (r.uid === user.uid || isOwner() ? ` · <button type="button" class="link-btn" data-delete-reply="${n.code}/${r.id}">Delete</button>` : "") +
        `</div><div class="text">${escapeHTML(r.text)}</div></div>`).join("") +
      `<div class="note-actions">` +
      (n.code && isActive() ? `<button type="button" class="link-btn" data-reply="${key}">Reply</button>` : "") +
      (mine ? `<button type="button" class="link-btn" data-edit-note="${key}">Edit</button>` +
        `<button type="button" class="link-btn" data-note-verses="${key}">Change verses</button>` : "") +
      (mine || isOwner() ? `<button type="button" class="link-btn" data-delete="${key}">Delete</button>` : "") +
      `</div></div>`;
  }).join("");
}

const findNote = (key) => {
  const [code, id] = key.split("/");
  const n = code ? groups.get(code)?.notes.find((x) => x.id === id) : privateNotes.find((x) => x.id === id);
  return n && { ...n, code: code || null };
};

window.addEventListener("bible:notes", ({ detail }) => {
  if (!db) return;
  if (!user || !profile) return toast("Sign in on the Connection tab to write notes");
  noteRange = { book: detail.book, chapter: detail.chapter, verse: detail.verse,
    ...(detail.verseEnd > detail.verse ? { verseEnd: detail.verseEnd } : {}) };
  $("noteRef").textContent = bible.verseRef(noteRange);
  // Who sees it: just you, or one of your groups (the last choice is remembered).
  const active = isActive() ? [...groups.entries()] : [];
  $("noteGroup").innerHTML = `<option value="">Just me</option>` +
    active.map(([code, g]) => `<option value="${code}">${escapeHTML(g.name)}</option>`).join("");
  const last = store.get("noteAudience", null);
  $("noteGroup").value = last !== null && (last === "" || groups.has(last)) ? last : active[0]?.[0] ?? "";
  renderNoteList();
  compose({ kind: "new" });
  noteDialog.returnValue = "";
  noteDialog.showModal();
});

function compose(next) {
  composing = next;
  const { kind, note } = next;
  $("noteText").value = kind === "edit" ? note.text : "";
  $("noteTextLabel").textContent = kind === "edit" ? "Edit your note" : kind === "reply" ? `Reply to ${note.nickname}` : "Your note";
  $("noteGroup").hidden = $("noteGroupLabel").hidden = kind !== "new";
  updateSaveLabel();
  if (kind !== "new") $("noteText").focus();
}
const updateSaveLabel = () => {
  $("noteSave").textContent = composing.kind === "reply" ? "Reply"
    : composing.kind === "new" && $("noteGroup").value ? "Share" : "Save";
  $("noteText").placeholder = composing.kind === "new" && !$("noteGroup").value ? "A thought, just for you" : "Share a thought with your group";
};
$("noteGroup").addEventListener("change", updateSaveLabel);

$("noteList").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  const d = button.dataset;
  if (d.reply) return compose({ kind: "reply", note: findNote(d.reply) });
  if (d.editNote) return compose({ kind: "edit", note: findNote(d.editNote) });
  if (d.noteVerses) {
    const note = findNote(d.noteVerses);
    noteDialog.close();
    return bible.changeVerses(note, "Verses for your note", (start, end) =>
      attempt(() => updateDoc(notePath(note), { verse: start, verseEnd: end > start ? end : deleteField(), edited: Date.now() })));
  }
  if (d.deleteReply) {
    const [code, id] = d.deleteReply.split("/");
    if (confirm("Delete this reply?")) attempt(() => deleteDoc(doc(db, "groups", code, "replies", id)));
    return;
  }
  if (d.delete) {
    const note = findNote(d.delete);
    if (!note || !confirm(note.code ? "Delete this note (and its replies) for everyone?" : "Delete this note?")) return;
    attempt(async () => {
      // Replies first: the rules let a note's author remove them only while the note is there.
      const replies = note.code ? groups.get(note.code).replies.filter((r) => r.note === note.id) : [];
      await Promise.all(replies.map((r) => deleteDoc(doc(db, "groups", note.code, "replies", r.id))));
      await deleteDoc(notePath(note));
      if (composing?.note?.id === note.id) compose({ kind: "new" });
    });
  }
});

noteDialog.addEventListener("close", () => {
  const text = $("noteText").value.trim().slice(0, 2000);
  const { kind, note } = composing ?? {};
  composing = null;
  if (noteDialog.returnValue !== "share" || !text) return;
  if (kind === "edit") return attempt(() => updateDoc(notePath(note), { text, edited: Date.now() }));
  if (kind === "reply") {
    return attempt(() => addDoc(collection(db, "groups", note.code, "replies"),
      { note: note.id, uid: user.uid, nickname: profile.nickname, text, created: Date.now() }));
  }
  const code = $("noteGroup").value;
  store.set("noteAudience", code);
  const fields = { ...noteRange, text, created: Date.now() };
  if (!code) return attempt(() => addDoc(collection(db, "users", user.uid, "notes"), fields));
  attempt(() => addDoc(collection(db, "groups", code, "notes"), { uid: user.uid, nickname: profile.nickname, ...fields }));
});

// Your "Just me" notes, under your bookmarks.
function renderPrivateNotes() {
  $("myNotes").innerHTML = privateNotes.length ? `<div class="section-label">My notes · just me</div>` +
    privateNotes.map((n) => `<button class="card note-card" data-go="${n.book},${n.chapter},${n.verse},${lastVerse(n)}">` +
      `<div class="card-main"><div class="card-ref">${escapeHTML(bible.verseRef(n))}</div>` +
      `<div class="card-notes">${escapeHTML(n.text)}</div></div></button>`).join("") : "";
}
$("myNotes").addEventListener("click", (event) => {
  const go = event.target.closest("[data-go]");
  if (!go) return;
  const [book, chapter, verse, verseEnd] = go.dataset.go.split(",").map(Number);
  bible.jumpTo(book, chapter, verse, verseEnd);
});

/* ---------- Start ---------- */

renderView();
