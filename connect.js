// Connection: groups that see each other's reading place and share verse notes,
// plus syncing your own place and bookmarks across devices.
//
// Sign-in is Firebase Auth (email + password, or Google). New people get 7 days of
// temporary access, then need the owner's approval. The database rules in
// ../firebase/firestore.rules enforce all of this; the checks here only shape the UI.
//
// Firestore layout:
//   users/{uid}                    { nickname, email, approved, blocked, created, groups: [code],
//                                    position, bookmarks, tempBookmark, bookmarksUpdated }
//   config/esv                     { key }   shared ESV key, readable once approved
//   groups/{code}                  { name, created, createdBy }
//   groups/{code}/members/{uid}    { nickname, book, chapter, updated }
//   groups/{code}/notes/{id}       { uid, nickname, book, chapter, verse, text, created }

import { initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signInWithPopup, GoogleAuthProvider, sendPasswordResetEmail, signOut as authSignOut,
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, collection, addDoc, onSnapshot,
  query, orderBy, limit, arrayUnion, arrayRemove, serverTimestamp,
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
const groups = new Map(); // code -> { name, members: [], notes: [], unsubs: [] }
let people = [];          // owner only: everyone's profile
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
    renderView();
    highlightVerses();
    return;
  }
  const snap = await attempt(() => getDoc(userRef()));
  if (!snap) return;
  if (snap.exists()) listen();
  else { needsNickname = true; renderView(); }
});

// First sign-in: create the profile, keeping any bookmarks already on this device.
async function createProfile(nickname) {
  await setDoc(userRef(), {
    nickname, email: user.email ?? "", approved: false, blocked: false,
    created: serverTimestamp(), groups: [],
    bookmarks: state.bookmarks, tempBookmark: state.tempBookmark, bookmarksUpdated: state.bookmarksUpdated,
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

    if (firstLoad) {
      // Bookmarks: on a new device, keep both sides so nothing is lost.
      // (Always combine, whichever side looks newer: this device may hold an old, emptier list.)
      const remote = profile.bookmarks ?? [];
      const localIds = new Set(state.bookmarks.map((b) => b.id));
      const remoteIds = new Set(remote.map((b) => b.id));
      const fromRemote = remote.filter((b) => !localIds.has(b.id));
      const fromLocal = state.bookmarks.filter((b) => !remoteIds.has(b.id));
      const newerTemp = (profile.tempBookmark?.created ?? 0) > (state.tempBookmark?.created ?? 0);
      const tempBookmark = newerTemp ? profile.tempBookmark : state.tempBookmark;
      if (fromRemote.length || fromLocal.length || tempBookmark !== state.tempBookmark ||
          (tempBookmark && !profile.tempBookmark)) {
        bible.applyBookmarks({
          bookmarks: [...state.bookmarks, ...fromRemote].sort((a, b) => b.created - a.created),
          tempBookmark,
          updated: Date.now(),
        });
        pushBookmarks();
      }
      if (isOwner()) watchPeople();
    }
    if (!positionChecked) {
      positionChecked = true;
      await whenReady;
      applyPosition(profile.position);
      pushPosition(true);
      handlePendingJoin();
    }
    if ((profile.bookmarksUpdated ?? 0) > state.bookmarksUpdated) {
      bible.applyBookmarks({ bookmarks: profile.bookmarks, tempBookmark: profile.tempBookmark, updated: profile.bookmarksUpdated });
    }
    loadSharedKeys();

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
}

function watchGroup(code) {
  const group = { name: code, members: [], notes: [], unsubs: [] };
  groups.set(code, group);
  const refresh = () => { renderView(); highlightVerses(); };
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
  );
}

// Translation keys the owner shares with approved people (config/esv, config/niv).
const SHARED_KEYS = { esv: "ESV", niv: "NIV" };
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

let bookmarkTimer;
function pushBookmarks() {
  if (!profile) return;
  clearTimeout(bookmarkTimer);
  bookmarkTimer = setTimeout(() => attempt(() => setDoc(userRef(), {
    bookmarks: state.bookmarks, tempBookmark: state.tempBookmark, bookmarksUpdated: state.bookmarksUpdated,
  }, { merge: true })), 800);
}

window.addEventListener("bible:position", () => {
  // A new chapter is worth telling the group about right away; scrolling within one can wait.
  const where = `${state.book}:${state.chapter}`;
  pushPosition(where !== lastShared);
});
window.addEventListener("bible:bookmarks", pushBookmarks);
window.addEventListener("bible:rendered", highlightVerses);

document.addEventListener("visibilitychange", () => {
  if (!profile) return;
  if (document.visibilityState === "hidden") return pushPosition(true);
  // Coming back to the app: pick up a newer place from another device.
  attempt(async () => applyPosition((await getDoc(userRef())).data()?.position));
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
    const actions = p.blocked ? `<button class="card-btn" data-person="${p.uid}" data-set="unblock">Unblock</button>`
      : `${p.approved ? "" : `<button class="card-btn" data-person="${p.uid}" data-set="approve">Approve</button>`}` +
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
    }).join("") + `</div>`;
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
    const notes = group.notes.slice(0, 5).map((n) =>
      `<button class="note" data-go="${n.book},${n.chapter},${n.verse}">` +
      `<div class="who"><b>${escapeHTML(n.nickname)}</b> on ${escapeHTML(reference(n))} · ${ago(n.created)}</div>` +
      `<div class="text">${escapeHTML(n.text)}</div></button>`
    ).join("");
    return `<div class="group">` +
      `<div class="group-head"><h3>${escapeHTML(group.name)} <span class="code">${code}</span></h3>` +
      `<button class="card-btn" data-invite="${code}">Invite</button></div>` +
      members +
      (notes ? `<div class="sub-label">Recent notes</div>${notes}` : "") +
      `<div class="group-foot"><button class="link-btn" data-leave="${code}">Leave group</button></div></div>`;
  }).join("");

  // Keep a half-pasted key if the list redraws while the owner is pasting.
  const drafts = Object.keys(SHARED_KEYS).map((name) => $(`shared-${name}`)?.value ?? "");
  view.innerHTML = header + banner +
    `<div class="row-actions"><button class="secondary-btn" data-create>Create group</button>` +
    `<button class="secondary-btn" data-join>Join group</button></div>` +
    `<div class="section-label">Your groups</div>` +
    (cards || `<p class="list-empty">Create a group and invite people, or join one with its code. ` +
      `Tap any verse while reading to share a note with your group.</p>`) +
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
    const [book, chapter, verse = 1] = data.go.split(",").map(Number);
    bible.goTo(book, chapter, verse);
    bible.showTab("bibleView");
  } else if (data.invite) invite(data.invite);
  else if (data.leave !== undefined) {
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
    if (confirm("Sign out on this device? Your bookmarks stay here, and you can sign back in any time.")) authSignOut(auth);
  } else if (data.person) {
    const change = { approve: { approved: true }, block: { blocked: true }, unblock: { blocked: false } }[data.set];
    attempt(() => setDoc(doc(db, "users", data.person), change, { merge: true }));
  }
});

/* ---------- Verse notes ---------- */

function notesHere(verse) {
  const found = [];
  for (const [code, group] of groups) {
    for (const n of group.notes) {
      if (n.book === state.book && n.chapter === state.chapter && (verse === undefined || n.verse === verse)) {
        found.push({ ...n, code });
      }
    }
  }
  return found.sort((a, b) => a.created - b.created);
}

function highlightVerses() {
  document.querySelectorAll(".verse.noted").forEach((v) => v.classList.remove("noted"));
  for (const n of notesHere()) document.getElementById(`v${n.verse}`)?.classList.add("noted");
}

let noteVerse = null;
let editingNote = null;   // { code, id } while changing one of your own notes

function renderNoteList() {
  const many = groups.size > 1;
  $("noteList").innerHTML = notesHere(noteVerse).map((n) =>
    `<div class="note"><div class="who"><b>${escapeHTML(n.nickname)}</b>` +
    `${many ? ` in ${escapeHTML(groups.get(n.code).name)}` : ""} · ${ago(n.created)}${n.edited ? " · edited" : ""}` +
    (n.uid === user.uid ? ` · <button type="button" class="link-btn" data-edit-note="${n.code}/${n.id}">Edit</button>` : "") +
    (n.uid === user.uid || isOwner() ? ` · <button type="button" class="link-btn" data-delete="${n.code}/${n.id}">Delete</button>` : "") +
    `</div><div class="text">${escapeHTML(n.text)}</div></div>`
  ).join("");
}

window.addEventListener("bible:versetap", ({ detail }) => {
  if (!db) return;
  if (!profile || !isActive() || !groups.size) {
    toast("Join a group on the Connection tab to share notes on verses");
    return;
  }
  noteVerse = detail.verse;
  $("noteRef").textContent = reference({ book: state.book, chapter: state.chapter, verse: noteVerse });
  renderNoteList();
  const select = $("noteGroup");
  select.innerHTML = [...groups.entries()].map(([code, g]) => `<option value="${code}">${escapeHTML(g.name)}</option>`).join("");
  select.hidden = $("noteGroupLabel").hidden = groups.size < 2;
  startNewNote();
  noteDialog.returnValue = "";
  noteDialog.showModal();
});

function startNewNote() {
  editingNote = null;
  $("noteText").value = "";
  $("noteTextLabel").textContent = "Your note";
  $("noteSave").textContent = "Share";
  $("noteGroup").hidden = $("noteGroupLabel").hidden = groups.size < 2;
}

function startEditing(code, id) {
  const note = groups.get(code)?.notes.find((n) => n.id === id);
  if (!note) return;
  editingNote = { code, id };
  $("noteText").value = note.text;
  $("noteTextLabel").textContent = "Edit your note";
  $("noteSave").textContent = "Save";
  $("noteGroup").hidden = $("noteGroupLabel").hidden = true;
  $("noteText").focus();
}

$("noteList").addEventListener("click", (event) => {
  const edit = event.target.closest("[data-edit-note]");
  if (edit) return startEditing(...edit.dataset.editNote.split("/"));
  const button = event.target.closest("[data-delete]");
  if (!button || !confirm("Delete this note for everyone?")) return;
  const [code, id] = button.dataset.delete.split("/");
  attempt(async () => {
    await deleteDoc(doc(db, "groups", code, "notes", id));
    if (editingNote?.id === id) startNewNote();
    renderNoteList();
  });
});

noteDialog.addEventListener("close", () => {
  const text = $("noteText").value.trim().slice(0, 2000);
  if (noteDialog.returnValue !== "share" || !text) return;
  if (editingNote) {
    const { code, id } = editingNote;
    editingNote = null;
    return attempt(() => updateDoc(doc(db, "groups", code, "notes", id), { text, edited: Date.now() }));
  }
  const code = $("noteGroup").value;
  const { book, chapter } = state;
  attempt(() => addDoc(collection(db, "groups", code, "notes"), {
    uid: user.uid, nickname: profile.nickname, book, chapter, verse: noteVerse, text, created: Date.now(),
  }));
});

/* ---------- Start ---------- */

renderView();
