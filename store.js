/* Authoritative store for the CP marking app.
   Every mutation goes through this module: it validates roles, clamps scores,
   enforces the one-CP-event-per-hand-raise constraint, stamps timestamps, and
   commits.

   SHARED BACKEND: state lives in a single Firebase Firestore document so every
   TA and student — on their own phone or laptop — reads and writes the same
   live state. Changes stream back to every device in real time.

   How it stays snappy AND shared:
     • The whole app reads state synchronously via getState(). We keep an
       in-memory copy (`cache`) that getState() returns instantly.
     • A mutation applies to `cache` immediately (so the screen updates with no
       lag) and, in the background, runs a Firestore transaction that re-applies
       the same change to the authoritative document.
     • A realtime listener (onSnapshot) overwrites `cache` with the authoritative
       state whenever anyone, anywhere, makes a change — then re-renders.

   If Firebase is not configured yet (see firebase-config.js), the app still
   runs on a single device using an in-memory copy, and shows a warning. */

/* Firebase settings are read defensively at startup (see loadConfig) rather than
   with a static import, so a malformed firebase-config.js — e.g. one pasted from
   the Firebase console without the leading "export" — degrades to a clear
   "backend not connected" notice instead of freezing the whole app. */
let firebaseConfig = null;

/* The Firebase SDK is loaded on demand (only when real keys are present) so the
   app opens instantly — and still works locally — even with no network or no
   backend configured. Pinned to a specific version for stability. */
const FB_VERSION = "10.14.1";
let FS = null;   // the loaded firestore module namespace (doc, getDoc, onSnapshot, …)

const COURSE = "Topics Course";

/* Where the shared state document lives in Firestore. */
const COLLECTION = "cp_marking";
const DOC_ID = "state";

export const CONTRIBUTIONS = [
  { key: "CURRENT_PAPER", label: "Relevant point from current paper", points: 1 },
  { key: "OTHER_PAPER", label: "Relevant point from a different paper", points: 2 },
  { key: "EXPERIENCE", label: "Relevant personal experience", points: 0.5 },
  { key: "VIDEO", label: "Relevant point from a recent video", points: 2 },
  { key: "IRRELEVANT", label: "Irrelevant contribution", points: 0 },
];

export const PENALTIES = [
  { key: "LATE", label: "Late", points: -0.5 },
  { key: "DIGITAL", label: "Digital use", points: -0.5 },
  { key: "NEIGHBOURS", label: "Talking to neighbours", points: -0.5 },
];

const FALLBACK_TAS = [
  { id: "ta001", name: "Abdul Ali Bangash", username: "abdul.ali" },
  { id: "ta002", name: "Hassan Tayyab", username: "hassan.tayyab" },
  { id: "ta003", name: "Imran Haider", username: "imran.haider" },
];

/* Passwords are NOT in the roster config files. These are shared credentials
   per role — every TA uses the TA password, every student the student one.
   Change them here before your first real class (see SETUP-GUIDE.md, under
   "Managing the app" → "Change the passwords").
   Note: because the app is fully client-side, these are visible to anyone who
   inspects the page source. They keep casual outsiders out, not determined
   ones — fine for classroom participation, not for secrets. */
const TA_PASSWORD = "@AHIta2026";
const STUDENT_PASSWORD = "cp2026";

let config = { tas: [], students: [], warnings: [] };
let listeners = new Set();

/* ---------- backend state ---------- */
let db = null;
let stateDocRef = null;
let fbReady = false;      // true once Firestore is connected and authed
let fbError = null;       // human-readable reason the backend is unavailable
let cache = null;         // the current parsed state object (synchronous source of truth for reads)

const clampScore = (n) => Math.max(0, Math.min(3, Math.round(n * 100) / 100));
const now = () => new Date().toISOString();
const todayKey = (d = new Date()) => d.toISOString().slice(0, 10);
const uid = (p) => p + Math.random().toString(36).slice(2, 8).toUpperCase();
const clone = (o) => JSON.parse(JSON.stringify(o));

/* Every mutator runs TWICE: once against the local cache (instant UI) and once
   against the authoritative Firestore document inside persist(). Both runs must
   produce byte-identical records — if a mutator minted its own random ids or
   read the clock itself, the two copies would disagree and any follow-up call
   that refers to a just-created id (e.g. raiseHand → markCp) would fail to find
   it server-side and silently write nothing.

   So all non-determinism is hoisted here: tx() builds one ctx and hands the
   SAME ctx to both runs. reset() rewinds the id counter so the second run
   re-issues the very same sequence. */
function makeCtx() {
  const ts = now();
  const seed = Math.random().toString(36).slice(2, 8).toUpperCase();
  let n = 0;
  return { ts, reset: () => { n = 0; }, uid: (p) => `${p}${seed}${n++}` };
}

export function fmtDate(iso) {
  const d = new Date(iso.length <= 10 ? iso + "T00:00:00" : iso);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
export function fmtTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/* ---------- config load + validation ---------- */

async function fetchJson(path) {
  try {
    const r = await fetch(path, { cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    return await r.json();
  } catch (e) {
    return null;
  }
}

function validate(tas, students) {
  const warnings = [];
  const seen = (arr, field, label) => {
    const m = new Map();
    arr.forEach((x) => {
      const v = x[field];
      if (!v) warnings.push(`${label} missing ${field}`);
      if (m.has(v)) warnings.push(`Duplicate ${label} ${field}: ${v}`);
      m.set(v, true);
    });
  };
  seen(tas, "id", "TA");
  seen(tas, "username", "TA");
  seen(students, "id", "student");
  seen(students, "username", "student");
  const names = new Set();
  students.forEach((s) => {
    if (names.has(s.name)) warnings.push(`Duplicate student name: ${s.name}`);
    names.add(s.name);
    if (!(s.group === null || s.group === undefined || (Number.isInteger(s.group) && s.group > 0)))
      warnings.push(`Invalid group for ${s.name}: ${s.group}`);
  });
  return warnings;
}

export async function loadConfig() {
  const t = await fetchJson("./config/tas.json");
  const s = await fetchJson("./config/students.json");
  const tas = (t && t.tas) || FALLBACK_TAS;
  const students = (s && s.students) || [];
  const warnings = validate(tas, students).concat(
    s ? [] : ["config/students.json could not be loaded — open the app over http(s), not as a local file."]
  );
  config = {
    tas,
    students: students.map((x) => ({ ...x, group: x.group ?? null })),
    warnings,
  };
  /* Read the Firebase settings defensively — a missing file or a config without
     the leading `export` leaves firebaseConfig null (→ local-only + a notice),
     never a crash that freezes the app. */
  try {
    const mod = await import("./firebase-config.js");
    firebaseConfig = (mod && (mod.firebaseConfig || mod.default)) ||
      (typeof window !== "undefined" ? window.firebaseConfig : null) || null;
  } catch (e) {
    firebaseConfig = null;
    console.error("[cp] could not load firebase-config.js", e);
  }

  /* Connect to the shared backend (or fall back to local-only) before we hand
     control back to the app. `cache` is guaranteed non-null after this. */
  await initBackend();
  if (fbError) config.warnings = [fbError].concat(config.warnings);
  return config;
}

export const getConfig = () => config;
export const studentById = (id) => config.students.find((s) => s.id === id);
export const taById = (id) => config.tas.find((t) => t.id === id);
export const studentName = (id) => (studentById(id) || {}).name || id;
export const taName = (id) => (taById(id) || {}).name || id;

/* ---------- state seed ---------- */

function defaultSeating() {
  const ids = config.students.map((s) => s.id);
  const rows = [];
  const perRow = 7;
  for (let r = 0; r < 6; r++) rows.push(ids.slice(r * perRow, r * perRow + perRow).concat(Array(perRow).fill(null)).slice(0, perRow));
  return rows;
}

/* seedState(withDemo):
     withDemo = true  → includes two earlier closed sessions so participation
                        history and the fairness model have something to show on
                        first run (nice for trying the app out).
     withDemo = false → a clean slate for real class use. */
function seedState(withDemo = true) {
  const st = {
    rev: 1,
    sessions: [],
    handRaises: [],
    cpEvents: [],
    scores: {},
    audit: [],
    seating: defaultSeating(),
  };
  if (!withDemo) return st;
  const past = [
    { date: "2026-09-07", picks: ["s003", "s011", "s021", "s030", "s006", "s014"] },
    { date: "2026-09-10", picks: ["s003", "s019", "s021", "s033", "s002"] },
  ];
  past.forEach(({ date, picks }, si) => {
    const sid = `SES-${date}`;
    st.sessions.push({
      id: sid, course: COURSE, date, startedAt: `${date}T10:02:00.000Z`,
      endedAt: `${date}T11:20:00.000Z`, status: "CLOSED", taIds: ["ta001", "ta002"],
    });
    st.scores[sid] = {};
    picks.forEach((studentId, i) => {
      const c = CONTRIBUTIONS[i % 3];
      const hr = {
        id: uid("HR-"), sessionId: sid, studentId, status: "MARKED",
        raisedAt: `${date}T10:${String(10 + i * 6).padStart(2, "0")}:00.000Z`,
        selectedAt: `${date}T10:${String(11 + i * 6).padStart(2, "0")}:00.000Z`,
        markedAt: `${date}T10:${String(12 + i * 6).padStart(2, "0")}:00.000Z`,
        selectedBy: "ta001", markedBy: si === 0 ? "ta001" : "ta002",
      };
      st.handRaises.push(hr);
      const prev = st.scores[sid][studentId] || 0;
      const next = clampScore(prev + c.points);
      st.scores[sid][studentId] = next;
      st.cpEvents.push({
        id: uid("CP-"), sessionId: sid, studentId, handRaiseId: hr.id, kind: "CONTRIBUTION",
        typeKey: c.key, typeLabel: c.label, points: c.points, prevScore: prev, newScore: next,
        taId: hr.markedBy, ts: hr.markedAt,
      });
    });
  });
  return st;
}

/* ---------- backend connect ---------- */

function configLooksReal(c) {
  return c && typeof c.apiKey === "string" && c.apiKey && !c.apiKey.startsWith("PASTE_") &&
    typeof c.projectId === "string" && c.projectId && !c.projectId.startsWith("PASTE_");
}

async function initBackend() {
  if (!configLooksReal(firebaseConfig)) {
    fbReady = false;
    fbError = "⚠ Shared backend not connected — data is local to this device only. Check firebase-config.js: your keys must be present AND the first line must start with \"export const firebaseConfig\". See SETUP-GUIDE.md, Part 3.";
    cache = seedState(true);
    return;
  }
  try {
    const base = "https://www.gstatic.com/firebasejs/" + FB_VERSION + "/";
    const [appMod, authMod, fsMod] = await Promise.all([
      import(base + "firebase-app.js"),
      import(base + "firebase-auth.js"),
      import(base + "firebase-firestore.js"),
    ]);
    FS = fsMod;

    const app = appMod.initializeApp(firebaseConfig);
    const auth = authMod.getAuth(app);
    await authMod.signInAnonymously(auth);
    db = FS.getFirestore(app);
    stateDocRef = FS.doc(db, COLLECTION, DOC_ID);

    const snap = await FS.getDoc(stateDocRef);
    if (snap.exists() && snap.data() && typeof snap.data().json === "string") {
      cache = JSON.parse(snap.data().json);
    } else {
      const seeded = seedState(true);
      await FS.setDoc(stateDocRef, { json: JSON.stringify(seeded), rev: seeded.rev, updatedAt: Date.now() });
      cache = seeded;
    }

    /* Realtime: whenever anyone changes the document, refresh our copy and
       re-render. This is what makes it live across every device. */
    FS.onSnapshot(stateDocRef, (s) => {
      if (!s.exists()) return;
      const d = s.data();
      if (!d || typeof d.json !== "string") return;
      try {
        cache = JSON.parse(d.json);
        notify();
      } catch (e) { /* ignore malformed snapshot */ }
    }, (err) => {
      console.error("[cp] realtime listener error", err);
    });

    fbReady = true;
    fbError = null;
  } catch (e) {
    console.error("[cp] backend init failed", e);
    fbReady = false;
    fbError = "⚠ Could not connect to the shared backend (" +
      (e && e.message ? e.message : String(e)) +
      "). Data is local to this device only. Check firebase-config.js and your Firebase project settings.";
    cache = cache || seedState(true);
  }
}

export function backendConnected() { return fbReady; }
export function backendMessage() { return fbError; }

/* ---------- read / notify ---------- */

function read() {
  if (!cache) cache = seedState(true);
  return cache;
}
export const getState = () => read();

function notify() {
  listeners.forEach((f) => { try { f(); } catch (e) { console.error(e); } });
}

/* A mutation runs through `tx`: the mutator either returns an error (nothing is
   written) or applies changes to a draft. We commit the draft to the local
   cache immediately (instant UI + a synchronous return value), then persist the
   same change to the shared document in the background. The realtime listener
   reconciles every device — including this one — with the authoritative result. */
function tx(mutator) {
  const ctx = makeCtx();                     // one set of ids/timestamps for BOTH runs
  const draft = clone(read());
  const out = mutator(draft, ctx) || {};
  if (out.error) return out;                 // validation failed — persist nothing
  draft.rev = (read().rev || 0) + 1;
  cache = draft;
  notify();                                  // optimistic local update
  persist(mutator, ctx);                     // background, reconciled by onSnapshot
  return { ok: true, ...out };
}

/* Re-apply the mutator to the AUTHORITATIVE document inside a Firestore
   transaction, so concurrent edits from multiple TAs merge correctly instead of
   overwriting each other. Fire-and-forget: results reach every device via the
   realtime listener. */
async function persist(mutator, ctx) {
  if (!fbReady || !stateDocRef || !FS) return;   // local-only fallback
  try {
    await FS.runTransaction(db, async (t) => {
      const snap = await t.get(stateDocRef);
      let st;
      if (snap.exists() && snap.data() && typeof snap.data().json === "string") {
        st = JSON.parse(snap.data().json);
      } else {
        st = seedState(true);
      }
      /* Firestore retries this callback on contention, so rewind the id counter
         here — not outside — or a retry would mint a fresh sequence. */
      ctx.reset();
      const out = mutator(st, ctx) || {};
      if (out.error) return reportPersistError(out.error);
      st.rev = (st.rev || 0) + 1;
      t.set(stateDocRef, { json: JSON.stringify(st), rev: st.rev, updatedAt: Date.now() });
    });
  } catch (e) {
    console.error("[cp] persist failed", e);
    reportPersistError(e && e.message ? e.message : String(e));
  }
}

/* A write that never reached Firestore looks identical on screen to one that
   did — until the next snapshot quietly rolls it back. Surface it instead. */
let persistErrorHandlers = new Set();
export function onPersistError(fn) {
  persistErrorHandlers.add(fn);
  return () => { persistErrorHandlers.delete(fn); };
}
function reportPersistError(msg) {
  persistErrorHandlers.forEach((f) => { try { f(msg); } catch (e) { console.error(e); } });
}

function log(st, ctx, actorName, action, detail) {
  st.audit.unshift({ id: ctx.uid("A-"), ts: ctx.ts, actor: actorName, action, detail: detail || "" });
  if (st.audit.length > 400) st.audit.length = 400;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/* ---------- auth ---------- */

export function login(role, username, password) {
  const u = String(username || "").trim().toLowerCase();
  if (role === "ta") {
    const ta = config.tas.find((t) => t.username.toLowerCase() === u);
    if (!ta) return { error: "No TA with that username." };
    if (password !== TA_PASSWORD) return { error: "Incorrect password." };
    tx((st, c) => log(st, c, ta.name, "Login", "Role: TA"));
    return { ok: true, user: { role: "ta", id: ta.id, name: ta.name, username: ta.username } };
  }
  const s = config.students.find((x) => x.username.toLowerCase() === u);
  if (!s) return { error: "No student with that username." };
  if (password !== STUDENT_PASSWORD) return { error: "Incorrect password." };
  tx((st, c) => log(st, c, s.name, "Login", "Role: Student"));
  return { ok: true, user: { role: "student", id: s.id, name: s.name, username: s.username } };
}

export const demoCredentials = () => ({ ta: TA_PASSWORD, student: STUDENT_PASSWORD });

/* ---------- sessions ---------- */

export function todaySession(st = read()) {
  return st.sessions.find((s) => s.date === todayKey()) || null;
}

export function startOrJoinSession(taId) {
  return tx((st, c) => {
    const date = todayKey();
    let s = st.sessions.find((x) => x.date === date);
    if (s) {
      if (!s.taIds.includes(taId)) {
        s.taIds.push(taId);
        log(st, c, taName(taId), "Joined class", `${s.course} — ${fmtDate(s.date)}`);
      }
      return { sessionId: s.id, joined: true };
    }
    s = { id: `SES-${date}`, course: COURSE, date, startedAt: c.ts, endedAt: null, status: "OPEN", taIds: [taId] };
    st.sessions.push(s);
    st.scores[s.id] = st.scores[s.id] || {};
    log(st, c, taName(taId), "Class started", `${s.course} — ${fmtDate(s.date)}`);
    return { sessionId: s.id, joined: false };
  });
}

export function endClass(taId) {
  return tx((st, c) => {
    const s = todaySession(st);
    if (!s) return { error: "No session today." };
    if (s.status === "CLOSED") return { error: "Class is already closed." };
    s.status = "CLOSED";
    s.endedAt = c.ts;
    st.handRaises.filter((h) => h.sessionId === s.id && (h.status === "ACTIVE" || h.status === "SELECTED"))
      .forEach((h) => { h.status = "CANCELLED"; h.cancelledAt = c.ts; });
    log(st, c, taName(taId), "Class ended", `${s.course} — ${fmtDate(s.date)}`);
  });
}

export function reopenClass(taId) {
  return tx((st, c) => {
    const s = todaySession(st);
    if (!s) return { error: "No session today." };
    s.status = "OPEN";
    s.endedAt = null;
    log(st, c, taName(taId), "Class reopened", `${s.course} — ${fmtDate(s.date)}`);
  });
}

/* ---------- hand raises ---------- */

export function raiseHand(studentId) {
  return tx((st, c) => {
    const s = todaySession(st);
    if (!s) return { error: "Class has not started yet." };
    if (s.status === "CLOSED") return { error: "Today's class is closed." };
    const open = st.handRaises.find(
      (h) => h.sessionId === s.id && h.studentId === studentId && (h.status === "ACTIVE" || h.status === "SELECTED")
    );
    if (open) return { error: "Your hand is already raised." };
    /* The id MUST come from ctx: award() hands this id straight to markCp(), so
       the local and authoritative copies have to agree on it. */
    const hr = {
      id: c.uid("HR-"), sessionId: s.id, studentId,
      status: "ACTIVE", raisedAt: c.ts, selectedAt: null, markedAt: null, selectedBy: null, markedBy: null,
    };
    st.handRaises.push(hr);
    log(st, c, studentName(studentId), "Raised hand", hr.id);
    return { handRaiseId: hr.id };
  });
}

export function cancelHand(studentId) {
  return tx((st, c) => {
    const s = todaySession(st);
    const hr = st.handRaises.find((h) => s && h.sessionId === s.id && h.studentId === studentId && h.status === "ACTIVE");
    if (!hr) return { error: "Nothing to lower — you may already have been selected." };
    hr.status = "CANCELLED";
    hr.cancelledAt = c.ts;
    log(st, c, studentName(studentId), "Cancelled hand", hr.id);
  });
}

export function selectHand(handRaiseId, taId) {
  return tx((st, c) => {
    const hr = st.handRaises.find((h) => h.id === handRaiseId);
    if (!hr) return { error: "Hand raise not found." };
    if (hr.status === "MARKED") return { error: `Already marked by ${taName(hr.markedBy)}.` };
    if (hr.status === "CANCELLED") return { error: "That hand was lowered." };
    hr.status = "SELECTED";
    hr.selectedAt = hr.selectedAt || c.ts;
    hr.selectedBy = taId;
    log(st, c, taName(taId), "Student selected", `${studentName(hr.studentId)} — ${hr.id}`);
  });
}

/* ---------- CP ---------- */

export function markCp(handRaiseId, contributionKey, taId) {
  const c = CONTRIBUTIONS.find((x) => x.key === contributionKey);
  if (!c) return { error: "Unknown contribution type." };
  return tx((st, ctx) => {
    const hr = st.handRaises.find((h) => h.id === handRaiseId);
    if (!hr) return { error: "Hand raise not found." };
    const s = st.sessions.find((x) => x.id === hr.sessionId);
    if (!s || s.status === "CLOSED") return { error: "Class is closed — no new participation events." };
    /* unique constraint: one CP event per hand raise */
    if (hr.status === "MARKED" || st.cpEvents.some((e) => e.handRaiseId === hr.id))
      return { error: `Already marked by ${taName(hr.markedBy)}.` };
    if (hr.status === "CANCELLED") return { error: "That hand was lowered — cannot mark it." };
    st.scores[s.id] = st.scores[s.id] || {};
    const prev = st.scores[s.id][hr.studentId] || 0;
    const next = clampScore(prev + c.points);
    st.scores[s.id][hr.studentId] = next;
    hr.status = "MARKED";
    hr.markedAt = ctx.ts;
    hr.markedBy = taId;
    hr.selectedAt = hr.selectedAt || hr.markedAt;
    hr.selectedBy = hr.selectedBy || taId;
    const ev = {
      id: ctx.uid("CP-"), sessionId: s.id, studentId: hr.studentId, handRaiseId: hr.id, kind: "CONTRIBUTION",
      typeKey: c.key, typeLabel: c.label, points: c.points, prevScore: prev, newScore: next, taId, ts: hr.markedAt,
    };
    st.cpEvents.push(ev);
    log(st, ctx, taName(taId), `Awarded ${c.points >= 0 ? "+" : ""}${c.points} to ${studentName(hr.studentId)}`,
      `Reason: ${c.label} · Previous CP: ${prev} · New CP: ${next} · Hand Raise: ${hr.id}`);
    return { prev, points: c.points, next, studentId: hr.studentId };
  });
}

export function applyPenalty(studentId, penaltyKey, taId) {
  const p = PENALTIES.find((x) => x.key === penaltyKey);
  if (!p) return { error: "Unknown penalty." };
  return tx((st, c) => {
    const s = todaySession(st);
    if (!s) return { error: "Class has not started yet." };
    if (s.status === "CLOSED") return { error: "Class is closed — no new CP changes." };
    st.scores[s.id] = st.scores[s.id] || {};
    const prev = st.scores[s.id][studentId] || 0;
    const next = clampScore(prev + p.points);
    st.scores[s.id][studentId] = next;
    st.cpEvents.push({
      id: c.uid("CP-"), sessionId: s.id, studentId, handRaiseId: null, kind: "PENALTY",
      typeKey: p.key, typeLabel: p.label, points: p.points, prevScore: prev, newScore: next, taId, ts: c.ts,
    });
    log(st, c, taName(taId), `Applied ${p.points} to ${studentName(studentId)}`,
      `Penalty: ${p.label} · Previous CP: ${prev} · New CP: ${next}`);
    return { prev, points: p.points, next, studentId };
  });
}

/* ---------- seating ---------- */

export function saveSeating(rows, taId) {
  return tx((st, c) => {
    st.seating = rows.map((r) => r.slice());
    log(st, c, taName(taId), "Seating plan saved", `${rows.length} rows`);
  });
}

export function logExport(taId, sessionId) {
  return tx((st, c) => log(st, c, taName(taId), "Export generated", sessionId));
}

/* ---------- derived reads ---------- */

export function sessionScores(sessionId, st = read()) {
  return st.scores[sessionId] || {};
}

export function activeHands(sessionId, st = read()) {
  return st.handRaises
    .filter((h) => h.sessionId === sessionId && (h.status === "ACTIVE" || h.status === "SELECTED"))
    .sort((a, b) => a.raisedAt.localeCompare(b.raisedAt));
}

export function participationCount(studentId, sessionId, st = read()) {
  return st.cpEvents.filter((e) => e.studentId === studentId && e.kind === "CONTRIBUTION" && (!sessionId || e.sessionId === sessionId)).length;
}

/* Student-facing projection: deliberately carries no scores or points. */
export function studentView(studentId, st = read()) {
  const s = todaySession(st);
  const mine = s
    ? st.handRaises.find((h) => h.sessionId === s.id && h.studentId === studentId && (h.status === "ACTIVE" || h.status === "SELECTED"))
    : null;
  const lastMarked = s
    ? st.handRaises.filter((h) => h.sessionId === s.id && h.studentId === studentId && h.status === "MARKED")
        .sort((a, b) => b.markedAt.localeCompare(a.markedAt))[0]
    : null;
  const history = st.handRaises
    .filter((h) => h.studentId === studentId && h.status === "MARKED")
    .sort((a, b) => b.markedAt.localeCompare(a.markedAt))
    .map((h) => ({ id: h.id, date: fmtDate(h.markedAt), time: fmtTime(h.markedAt) }));
  return {
    sessionStatus: s ? s.status : "NONE",
    course: COURSE,
    handStatus: mine ? mine.status : null,
    raisedAt: mine ? mine.raisedAt : null,
    justMarkedAt: lastMarked ? lastMarked.markedAt : null,
    history,
  };
}

/* ---------- fairness ---------- */

const QUAL = (score) => (score < 1 ? "Needs more participation" : score < 2.25 ? "Moderate participation" : "Already well represented");

export function fairnessQueue(sessionId, st = read(), nowMs = Date.now()) {
  const scores = sessionScores(sessionId, st);
  const hands = activeHands(sessionId, st);
  const lastSelected = {};
  st.handRaises
    .filter((h) => h.sessionId === sessionId && h.markedAt)
    .forEach((h) => { lastSelected[h.studentId] = Math.max(lastSelected[h.studentId] || 0, new Date(h.markedAt).getTime()); });

  const rows = hands.map((h) => {
    const score = scores[h.studentId] || 0;
    const countSession = participationCount(h.studentId, sessionId, st);
    const countAll = participationCount(h.studentId, null, st);
    const waitSec = Math.max(0, Math.round((nowMs - new Date(h.raisedAt).getTime()) / 1000));

    const scoreNeed = 1 - score / 3;                        // 0..1
    const countNeed = 1 / (1 + countAll);                   // 1, .5, .33 …
    const wait = Math.min(1, waitSec / 180);                // saturates at 3 min
    const freshRound = countSession === 0 ? 1 : 0;
    const since = lastSelected[h.studentId] ? (nowMs - lastSelected[h.studentId]) / 60000 : 999;
    const recentPenalty = since < 10 ? (10 - since) / 10 : 0;
    const capPenalty = score >= 3 ? 1 : 0;

    const priority =
      1.6 * scoreNeed + 1.2 * countNeed + 1.0 * wait + 0.4 * freshRound - 0.9 * recentPenalty - 1.4 * capPenalty;

    let reason = "Balanced across waiting time and participation.";
    if (capPenalty) reason = "Already at 3 / 3 — lowest priority.";
    else if (recentPenalty > 0.4) reason = "Participated very recently — deprioritised.";
    else if (wait > 0.75) reason = "Has been waiting longer than everyone else.";
    else if (scoreNeed > 0.6 && countNeed > 0.45) reason = "Lower participation than other students currently waiting.";
    else if (scoreNeed > 0.6) reason = "CP score below the rest of the queue.";
    else if (countNeed > 0.45) reason = "Has contributed fewer times this term.";

    return {
      handRaiseId: h.id, studentId: h.studentId, name: studentName(h.studentId), status: h.status,
      score, countSession, countAll, waitSec,
      waitLabel: `${Math.floor(waitSec / 60)}:${String(waitSec % 60).padStart(2, "0")}`,
      qualitative: QUAL(score), priority: Math.round(priority * 1000) / 1000, reason,
    };
  });

  rows.sort((a, b) => b.priority - a.priority || a.waitSec - b.waitSec || a.name.localeCompare(b.name));
  return rows;
}

/* ---------- export rows ---------- */

export function exportTables(sessionId, st = read()) {
  const scores = sessionScores(sessionId, st);
  const s = st.sessions.find((x) => x.id === sessionId);
  const date = s ? fmtDate(s.date) : "";
  const g = (id) => { const x = studentById(id); return x && x.group != null ? x.group : ""; };
  const u = (id) => { const x = studentById(id); return x ? x.username : ""; };

  const finalScores = config.students.map((stu) => ({
    Student: stu.name, Username: stu.username, Group: stu.group ?? "",
    "CP Score": scores[stu.id] || 0,
    "Participation Count": st.cpEvents.filter((e) => e.sessionId === sessionId && e.studentId === stu.id && e.kind === "CONTRIBUTION").length,
  }));

  const events = st.cpEvents.filter((e) => e.sessionId === sessionId && e.kind === "CONTRIBUTION").map((e) => ({
    Date: date, Student: studentName(e.studentId), Username: u(e.studentId), Group: g(e.studentId),
    "Event Type": e.typeLabel, Points: e.points, TA: taName(e.taId), Timestamp: e.ts, "Hand Raise ID": e.handRaiseId || "",
  }));

  const penalties = st.cpEvents.filter((e) => e.sessionId === sessionId && e.kind === "PENALTY").map((e) => ({
    Date: date, Student: studentName(e.studentId), "Penalty Type": e.typeLabel, Points: e.points,
    TA: taName(e.taId), Timestamp: e.ts,
  }));

  const raises = st.handRaises.filter((h) => h.sessionId === sessionId).map((h) => ({
    Date: date, Student: studentName(h.studentId), "Raised At": h.raisedAt, "Selected At": h.selectedAt || "",
    "Marked At": h.markedAt || "", Status: h.status,
    "Selected/Marked By": h.markedBy ? taName(h.markedBy) : h.selectedBy ? taName(h.selectedBy) : "",
    "Hand Raise ID": h.id,
  }));

  return [
    { name: "Final Scores", rows: finalScores },
    { name: "Participation Events", rows: events },
    { name: "Penalties", rows: penalties },
    { name: "Hand Raises", rows: raises },
  ];
}

/* ---------- admin: reset the shared data ---------- */

/* Wipe the shared document and start over. Runs from the browser console:
     import("./store.js").then(S => S.resetDemo())        → reset WITH demo history
     import("./store.js").then(S => S.resetDemo(false))   → clean slate for real use
   See SETUP-GUIDE.md, under "Managing the app" → "Clear the demo data". */
export async function resetDemo(withDemo = true) {
  const fresh = seedState(withDemo);
  cache = fresh;
  notify();
  if (fbReady && stateDocRef && FS) {
    try {
      await FS.setDoc(stateDocRef, { json: JSON.stringify(fresh), rev: fresh.rev, updatedAt: Date.now() });
    } catch (e) { console.error("[cp] reset failed", e); }
  }
  return { ok: true };
}
