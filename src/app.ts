// Logbook app shell: state, screens, actions. Data is written to IndexedDB before the screen updates.
import * as db from "./db.js";
import { t, setLang, getLang, Lang } from "./i18n.js";
import { seedExercises, MUSCLES } from "./seed.js";
import { suggest, e1rm, volumeLoad, fmt, uid, clock, isWork, round2 } from "./domain.js";
import { setsCsv, mergeImport } from "./data.js";

export const VERSION = "0.3.0";
const DAY = 86_400_000;

type Any = any;
const A: Any = {
  lib: new Map<string, Any>(), programs: [] as Any[], sessions: [] as Any[],
  settings: { lang: "en", theme: "dark", lastBackupAt: null as number | null },
  nav: [{ v: "today", p: {} }] as { v: string; p: Any }[],
  sheet: null as Any, toast: null as Any, cal: null as Any, q: "", qm: "", persisted: null as boolean | null,
};
let toastTimer: any = null;
let wakeLock: any = null;
const app = document.getElementById("app")!;

/* ---------------- helpers ---------------- */
const now = () => Date.now();
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const L = () => getLang();
const nm = (n: Any) => (n && (n[L()] || n.en)) || "";
const exById = (id: string) => A.lib.get(id);
const exName = (id: string) => nm(exById(id)?.name) || "?";
const route = () => A.nav[A.nav.length - 1];
const activeSession = () => A.sessions.find((s: Any) => s.status === "in_progress");
const activeProgram = () => A.programs.find((p: Any) => p.status === "active");
const completed = () => A.sessions.filter((s: Any) => s.status === "completed").sort((a: Any, b: Any) => b.startedAt - a.startedAt);
const locale = () => (L() === "it" ? "it-IT" : "en-GB");
const dstr = (ms: number, o: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short" }) => new Date(ms).toLocaleDateString(locale(), o);
const tstr = (ms: number) => new Date(ms).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
const sessionDate = (s: Any) => (s.dateUnknown ? t("imported") : dstr(s.startedAt, { weekday: "short", day: "numeric", month: "short", year: "numeric" }));
const loadTxt = (ex: Any, load: number) => (ex && (ex.loadType === "bodyweight" || ex.loadType === "bw_plus") ? (load ? "+" + fmt(load) : t("bw")) : fmt(load));
const elapsed = (s: Any) => (s.pausedAt || s.endedAt || now()) - s.startedAt - (s.pausedMs || 0);

function go(v: string, p: Any = {}) { A.nav.push({ v, p }); A.sheet = null; render(); scrollTop(); }
function back() { if (A.nav.length > 1) A.nav.pop(); A.sheet = null; render(); }
function tab(v: string) { A.nav = [{ v, p: {} }]; A.sheet = null; render(); scrollTop(); }
function scrollTop() { const s = app.querySelector(".scroll"); if (s) s.scrollTop = 0; }

function haptic() {
  try {
    if ((navigator as Any).vibrate && (navigator as Any).vibrate(10)) return;
    const l = document.createElement("label"); l.style.display = "none";
    const i = document.createElement("input"); i.type = "checkbox"; i.setAttribute("switch", "");
    l.appendChild(i); document.body.appendChild(l); l.click(); l.remove();
  } catch { /* best effort */ }
}
function toast(msg: string, undo?: () => void) {
  A.toast = { msg, undo }; clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { A.toast = null; render(); }, 5000);
}

/* ---------------- persistence ---------------- */
async function saveSession(s: Any) { s.updatedAt = now(); await db.put("sessions", s); }
async function saveProgram(p: Any) { p.updatedAt = now(); await db.put("programs", p); }
async function saveExercise(e: Any) { e.updatedAt = now(); await db.put("exercises", e); A.lib.set(e.id, e); }
async function saveSettings() { await db.setMeta("settings", A.settings); }

async function boot() {
  try {
    let exs = await db.all("exercises");
    if (!exs.length) {
      const ex = seedExercises(now());
      await db.putMany("exercises", ex);
      exs = ex;
    }
    exs.forEach((e: Any) => A.lib.set(e.id, e));
    A.programs = await db.all("programs");
    A.sessions = await db.all("sessions");
    A.settings = { ...A.settings, ...(await db.getMeta("settings", {})) };
    if (!(await db.getMeta("settings", null))) {
      A.settings.lang = (navigator.language || "").toLowerCase().startsWith("it") ? "it" : "en";
      await saveSettings();
    }
    setLang(A.settings.lang as Lang);
    try { A.persisted = navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : null; } catch { A.persisted = null; }
    if (activeSession()) { /* resume banner shown on Today */ }
    render();
  } catch (err: Any) {
    app.innerHTML = `<div class="scroll"><h1>Storage error</h1><p class="sub">${esc(err && err.message)}</p></div>`;
  }
}

/* ---------------- previous performance & session building ---------------- */
function lastPerf(exId: string, excludeId?: string) {
  for (const s of completed()) {
    if (s.id === excludeId) continue;
    const e = s.exercises.find((x: Any) => x.exId === exId && !x.skipped && x.sets.some((y: Any) => y.done));
    if (e) {
      const done = e.sets.filter((y: Any) => y.done);
      return { session: s, warm: done.filter((y: Any) => y.type === "warmup"), work: done.filter((y: Any) => y.type !== "warmup") };
    }
  }
  return null;
}

function buildSets(tpls: Any[], exId: string) {
  const lp = lastPerf(exId);
  let wi = 0, ki = 0;
  return tpls.map((tp: Any) => {
    const warm = tp.type === "warmup";
    const prev = lp ? (warm ? lp.warm[wi++] : lp.work[ki++]) : null;
    const load = tp.load ?? prev?.load ?? 0;
    const reps = prev && prev.load === load ? Math.max(prev.reps, tp.repsMin) : tp.repsMin;
    return {
      id: uid(), type: tp.type, load, reps, rir: warm ? null : tp.rir, rpe: null, done: false, doneAt: null, edited: {},
      last: prev ? { load: prev.load, reps: prev.reps, rir: prev.rir } : null,
      t: { repsMin: tp.repsMin, repsMax: tp.repsMax, rir: tp.rir, load: tp.load },
    };
  });
}

function sessionExercise(pe: Any) {
  const ex = exById(pe.exId);
  return {
    id: uid(), peId: pe.id, exId: pe.exId, plannedExId: pe.exId, name: ex.name, group: pe.group || null, optional: !!pe.optional,
    rest: pe.rest ?? null, notes: pe.notes || "", skipped: false, sets: buildSets(pe.sets, pe.exId),
  };
}

const defaultTemplates = () => [0, 1, 2].map(() => ({ id: uid(), type: "working", load: null, repsMin: 8, repsMax: 12, rir: 2 }));

async function startWorkout(program: Any | null, dayIdx: number | null) {
  if (activeSession()) { go("workout"); return; }
  const day = program && dayIdx != null ? program.days[dayIdx] : null;
  const s = {
    id: uid(), programId: program?.id || null, dayId: day?.id || null, dayName: day ? day.name : { en: "Workout", it: "Allenamento" },
    status: "in_progress", startedAt: now(), endedAt: null, pausedAt: null, pausedMs: 0, idx: 0, rest: null,
    notes: "", sessionRpe: null, suggestions: [], createdAt: now(), updatedAt: now(),
    exercises: day ? day.exercises.map(sessionExercise) : [],
  };
  await saveSession(s);
  A.sessions.push(s);
  A.nav = [{ v: "today", p: {} }, { v: "workout", p: {} }];
  render();
  requestWake();
}

/* ---------------- wake lock ---------------- */
async function requestWake() {
  try { if ("wakeLock" in navigator && activeSession() && route().v === "workout") wakeLock = await (navigator as Any).wakeLock.request("screen"); } catch { /* unsupported */ }
}
function releaseWake() { try { wakeLock && wakeLock.release(); } catch { } wakeLock = null; }
document.addEventListener("visibilitychange", () => { if (!document.hidden) { render(); requestWake(); } });

/* ---------------- icons ---------------- */
const I: Record<string, string> = {
  today: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6.5 6.5v11M17.5 6.5v11M3 9.5v5M21 9.5v5M6.5 12h11"/></svg>',
  history: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
  programs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg>',
  library: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  dots: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" width="22" height="22"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true" width="22" height="22"><path d="M15 5l-7 7 7 7"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" width="18" height="18"><path d="M9 5l7 7-7 7"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true" width="20" height="20"><path d="M6 15l6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true" width="20" height="20"><path d="M6 9l6 6 6-6"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true" width="20" height="20"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true" width="20" height="20"><path d="M12 5v14M5 12h14"/></svg>',
};
const header = (title: string, right = "") =>
  `<header class="hdr"><button class="iconbtn" data-a="back" aria-label="${t("back")}">${I.back}</button><div class="hdr-t">${esc(title)}</div><div class="hdr-r">${right}</div></header>`;

/* ---------------- render ---------------- */
function render() {
  document.documentElement.dataset.theme = A.settings.theme;
  document.documentElement.lang = L();
  const r = route();
  let h = "";
  const s = activeSession();
  if (r.v === "workout" && s) h = vWorkout(s);
  else {
    const views: Record<string, (p: Any) => string> = {
      today: vToday, history: vHistory, session: vSession, summary: vSummary, programs: vPrograms, program: vProgram, day: vDay, pe: vPe,
      library: vLibrary, exercise: vExercise, exform: vExForm, pick: vPick, more: vMore,
    };
    const fn = views[r.v] || vToday;
    const top = ["today", "history", "programs", "library", "more"];
    const tabV = top.includes(A.nav[0].v) ? A.nav[0].v : "today";
    const mini = s ? `<button class="minibar num" data-a="openWorkout"><span>${esc(nm(s.dayName))} · <span data-clock>${clock(elapsed(s))}</span></span><span data-rest>${s.rest ? t("rest") + " " + restLeft(s) : "›"}</span></button>` : "";
    const tabs = top.map(k => `<button data-a="tab" data-v="${k}" ${k === tabV ? 'aria-current="page"' : ""}>${I[k]}<span>${t(k)}</span></button>`).join("");
    h = `<div class="view">${fn(r.p)}</div>${mini}<nav class="tabbar">${tabs}</nav>`;
  }
  if (A.sheet) h += vSheet();
  if (A.toast) h += `<div class="toast" role="status"><span>${esc(A.toast.msg)}</span>${A.toast.undo ? `<button data-a="undo">${t("undo")}</button>` : ""}</div>`;
  const scroll = app.querySelector(".scroll") as HTMLElement | null;
  const st = scroll ? scroll.scrollTop : 0;
  const sameView = (app as Any)._view === r.v + JSON.stringify(r.p);
  app.innerHTML = h;
  (app as Any)._view = r.v + JSON.stringify(r.p);
  if (sameView) { const n = app.querySelector(".scroll") as HTMLElement | null; if (n) n.scrollTop = st; }
}

/* ---------------- Today ---------------- */
function vToday() {
  const s = activeSession();
  const p = activeProgram();
  let h = `<div class="scroll">`;
  if (s) {
    h += `<div class="banner"><b>${t("resumeTitle")}</b><div class="sub mt4">${t("resumeBody", { t: tstr(s.startedAt) })}</div>
      <div class="row wrap mt12"><button class="btn primary" data-a="openWorkout">${t("resume")}</button><button class="btn ghost" data-a="askFinish">${t("finishNow")}</button><button class="btn ghost" data-a="askDiscard">${t("discard")}</button></div></div>`;
  }
  const real = completed().filter((x: Any) => !x.imported);
  const lb = A.settings.lastBackupAt;
  if (real.length && (!lb || (now() - lb > 7 * DAY && real.some((x: Any) => (x.endedAt || 0) > lb)))) {
    h += `<div class="banner soft"><b>${t("backupTitle")}</b><div class="sub mt4">${t("backupBody", { d: lb ? dstr(lb) : t("never") })}</div><button class="btn primary small mt12" data-a="exportJson">${t("backupNow")}</button></div>`;
  }
  const pend = completed().slice(0, 3).find((x: Any) => (x.suggestions || []).some((g: Any) => g.status === "pending"));
  if (pend) {
    const n = pend.suggestions.filter((g: Any) => g.status === "pending").length;
    h += `<button class="card rowbtn" data-a="openSummary" data-id="${pend.id}"><span>${t("suggWaiting", { n })}</span><span class="accent">${t("review")} ${I.chev}</span></button>`;
  }
  if (!p) return h + `<h1>${t("welcome")}</h1><p class="sub">${t("welcomeBody")}</p>
    <label class="btn primary block mt16 filebtn">${t("importJson")}<input type="file" accept="application/json,.json" data-in="importFile" hidden></label>
    <button class="btn ghost block mt8" data-a="newProgram">+ ${t("newProgram")}</button>
    <button class="btn ghost block mt8" data-a="startEmpty">${t("emptyWorkout")}</button>
    <p class="sub mt16">${t("installHint")}</p></div>`;
  const di = Math.min(p.nextDay || 0, p.days.length - 1);
  const day = p.days[di];
  if (!day) return h + `<h1>${esc(p.name)}</h1><p class="sub">${t("noProgram")}</p></div>`;
  const nSets = day.exercises.reduce((a: number, e: Any) => a + e.sets.filter(isWork).length, 0);
  h += `<div class="sub">${t("next")} · ${t("dayOf", { a: di + 1, b: p.days.length })}</div><h1>${esc(nm(day.name))}</h1>
    <div class="sub">${day.exercises.length} ${t("exercises")} · ${nSets} ${t("workSets").toLowerCase()}</div>`;
  if (!s) h += `<button class="btn primary block mt16" data-a="start" data-v="${di}">${t("start")}</button>
    <div class="row mt8"><button class="btn ghost flex1" data-a="changeDay">${t("changeDay")}</button><button class="btn ghost flex1" data-a="startEmpty">${t("emptyWorkout")}</button></div>`;
  h += `<h2>${t("lastTime")}</h2><div class="card">` + day.exercises.map((pe: Any) => {
    const lp = lastPerf(pe.exId); const ex = exById(pe.exId);
    const txt = lp ? lp.work.map((y: Any) => `${loadTxt(ex, y.load)}×${y.reps}`).join(" · ") : "—";
    return `<div class="li"><span>${esc(exName(pe.exId))}${pe.optional ? ` <span class="faint">(${t("optional")})</span>` : ""}${pe.group ? ` <span class="pill">${esc(pe.group)}</span>` : ""}</span><span class="muted num small r">${txt}</span></div>`;
  }).join("") + `</div></div>`;
  return h;
}

/* ---------------- Workout ---------------- */
function restLeft(s: Any) { const l = s.rest.endsAt - now(); return l > 0 ? clock(l) : "+" + clock(-l); }
function badge(e: Any, i: number) {
  const s = e.sets[i];
  if (s.type === "warmup") return `<span class="badge w">W</span>`;
  const n = e.sets.slice(0, i + 1).filter(isWork).length;
  const tag = s.type === "top" ? "T" : s.type === "backoff" ? "B" : s.type === "amrap" ? "A" : s.type === "drop" ? "D" : String(n);
  return `<span class="badge ${s.type === "top" ? "acc" : ""}">${tag}</span>`;
}
function vWorkout(s: Any) {
  if (s.idx >= s.exercises.length) s.idx = Math.max(0, s.exercises.length - 1);
  const e = s.exercises[s.idx];
  const strip = s.exercises.map((x: Any, i: number) => {
    const fin = x.sets.length && x.sets.every((y: Any) => y.done);
    return `<button class="${i === s.idx ? "on" : ""} ${fin ? "fin" : ""} ${x.skipped ? "skip" : ""}" data-a="goto" data-v="${i}">${x.group ? esc(x.group) + " · " : ""}${esc(nm(x.name))}</button>`;
  }).join("") + `<button data-a="addToWorkout" aria-label="${t("addExercise")}">+</button>`;
  const head = `<div class="wk-head"><div class="wk-top">
    <button class="btn ghost small" data-a="tab" data-v="today" aria-label="${t("minimise")}">${I.down}</button>
    <div class="c"><div class="wk-title">${esc(nm(s.dayName))}</div><div class="wk-clock num" data-clock>${s.pausedAt ? t("paused") + " · " : ""}${clock(elapsed(s))}</div></div>
    <div class="row g6"><button class="btn ghost small" data-a="pause">${s.pausedAt ? t("resumeBtn") : t("pause")}</button><button class="btn primary small" data-a="askFinish">${t("finish")}</button></div>
  </div><div class="strip" id="strip">${strip}</div></div>`;
  if (!e) return `<div class="wk">${head}<div class="wk-body"><button class="btn primary block" data-a="addToWorkout">${t("addExercise")}</button></div></div>`;
  const ex = exById(e.exId);
  const rest = e.rest ?? ex?.rest ?? 120;
  const sets = e.sets.map((x: Any, i: number) => {
    const g = (f: string) => (!x.done && !x.edited?.[f] ? "ghost" : "");
    const last = x.last ? `<b>${loadTxt(ex, x.last.load)}×${x.last.reps}</b>${x.last.rir != null ? " @" + x.last.rir : ""}` : "—";
    return `<div class="set ${x.done ? "done" : ""}">
      <button data-a="setMenu" data-v="${i}" aria-label="${t("set")} ${i + 1}">${badge(e, i)}</button>
      <div class="last num">${last}</div>
      <button class="cell num ${g("load")}" data-a="wNum" data-f="load" data-v="${i}" aria-label="${t("weight")}">${loadTxt(ex, x.load)}</button>
      <button class="cell num ${g("reps")}" data-a="wNum" data-f="reps" data-v="${i}" aria-label="${t("reps")}">${x.reps}</button>
      <button class="cell num ${g("rir")}" data-a="wRir" data-v="${i}" aria-label="RIR">${x.rir == null ? "–" : x.rir}</button>
      <button class="check" data-a="check" data-v="${i}" aria-label="${t("done")}" aria-pressed="${!!x.done}">${I.check}</button>
      ${isWork(x) && x.t ? `<div class="target num">${t("target")}: ${x.t.repsMin}${x.t.repsMax !== x.t.repsMin ? "–" + x.t.repsMax : ""}${x.t.rir != null ? " @ RIR " + x.t.rir : ""}</div>` : ""}
    </div>`;
  }).join("");
  const partner = e.group ? s.exercises.filter((x: Any) => x.group === e.group && x !== e).map((x: Any) => esc(nm(x.name))).join(", ") : "";
  const body = `<div class="wk-body scroll" id="wkbody">
    <div class="row spread top"><h2 class="ex-name">${esc(nm(e.name))}</h2><button class="iconbtn" data-a="exMenu" aria-label="${t("edit")}">${I.dots}</button></div>
    <div class="ex-meta"><span class="pill">${t("eq_" + (ex?.equipment || "other"))}</span><span class="pill num">${t("restOn")} ${rest}${t("sec")}</span><span class="pill num">+${fmt(ex?.inc)} kg</span>
      ${e.optional ? `<span class="pill">${t("optional")}</span>` : ""}${e.skipped ? `<span class="pill warn">${t("skip")}</span>` : ""}${partner ? `<span class="pill accent">${t("superset")} ${esc(e.group)}: ${partner}</span>` : ""}</div>
    ${e.exId !== e.plannedExId ? `<div class="note">↺ ${t("replaces", { x: esc(exName(e.plannedExId)) })}</div>` : ""}
    ${e.notes ? `<div class="note">${esc(e.notes)}</div>` : ""}
    <div class="sets-head"><span>${t("set")}</span><span>${t("last")}</span><span class="c">${t("kg")}</span><span class="c">${t("reps")}</span><span class="c">${t("rir")}</span><span></span></div>
    ${sets}
    <div class="row mt4"><button class="addset flex1" data-a="wAddSet">+ ${t("addSet")}</button><button class="addset" style="flex:0 0 auto;padding:0 14px" data-a="wAddWarm">+ W</button></div>
  </div>`;
  let restH = "";
  if (s.rest) {
    const l = s.rest.endsAt - now(), p = Math.max(0, Math.min(1, l / (s.rest.total * 1000)));
    restH = `<div class="rest ${l <= 0 ? "over" : ""}" data-restbar><span class="t num" aria-live="polite">${l > 0 ? clock(l) : t("restDone")}</span><span class="bar"><i style="width:${p * 100}%"></i></span>
      <button class="btn ghost small num" data-a="rest30">+30${t("sec")}</button><button class="btn ghost small" data-a="restSkip">${t("skip")}</button></div>`;
  }
  const lastIdx = s.idx === s.exercises.length - 1;
  const foot = `<div class="wk-foot">${restH}<div class="row g8">
    <button class="btn ghost flex1" data-a="goto" data-v="${s.idx - 1}" ${s.idx === 0 ? "disabled" : ""}>‹ ${t("prev")}</button>
    <button class="btn ${lastIdx ? "primary" : "ghost"} flex1" data-a="${lastIdx ? "askFinish" : "goto"}" data-v="${s.idx + 1}">${lastIdx ? t("finish") : t("nextEx") + " ›"}</button></div></div>`;
  return `<div class="wk">${head}${body}${foot}</div>`;
}

async function toggleSet(s: Any, i: number) {
  const e = s.exercises[s.idx]; const x = e.sets[i];
  x.done = !x.done; x.doneAt = x.done ? now() : null;
  if (x.done) {
    haptic();
    const ex = exById(e.exId);
    const restSec = x.type === "warmup" ? 60 : (e.rest ?? ex?.rest ?? 120);
    // supersets: hop to the partner, rest after the last exercise of the group
    const grp = e.group ? s.exercises.map((y: Any, j: number) => ({ y, j })).filter((o: Any) => o.y.group === e.group && !o.y.skipped) : [];
    if (grp.length > 1) {
      const pos = grp.findIndex((o: Any) => o.j === s.idx);
      const nxt = grp[pos + 1];
      if (nxt && nxt.y.sets.some((z: Any) => !z.done)) { s.idx = nxt.j; s.rest = null; }
      else { s.rest = { endsAt: now() + restSec * 1000, total: restSec, buzzed: false }; const first = grp.find((o: Any) => o.y.sets.some((z: Any) => !z.done)); if (first) s.idx = first.j; }
    } else s.rest = { endsAt: now() + restSec * 1000, total: restSec, buzzed: false };
  }
  await saveSession(s);
}

async function finishSession(s: Any) {
  if (s.pausedAt) { s.pausedMs += now() - s.pausedAt; s.pausedAt = null; }
  s.status = "completed"; s.endedAt = now(); s.rest = null;
  s.suggestions = s.exercises.filter((e: Any) => !e.skipped && e.peId).map((e: Any) => {
    const ex = exById(e.exId);
    const g = suggest(e.sets, ex?.inc ?? 2.5);
    return g ? { peId: e.peId, exId: e.exId, substituted: e.exId !== e.plannedExId, ...g, status: "pending" } : null;
  }).filter(Boolean);
  await saveSession(s);
  const p = A.programs.find((x: Any) => x.id === s.programId);
  if (p) { const di = p.days.findIndex((d: Any) => d.id === s.dayId); if (di >= 0) { p.nextDay = (di + 1) % p.days.length; await saveProgram(p); } }
  releaseWake();
  A.nav = [{ v: "today", p: {} }, { v: "summary", p: { id: s.id } }];
}

/* ---------------- Summary & suggestions ---------------- */
function why(g: Any) {
  if (g.kind === "up") {
    let w = t("whyUp", { n: g.adj.length, adj: g.adj.map(fmt).join(", "), inc: fmt(g.inc) });
    if (g.predicted != null) w += t("whyPred", { w: fmt(Math.max(...g.loads)), p: Math.floor(g.predicted), r: g.predRir ?? 0 });
    if (g.unknownEffort) w += t("whyUnknown");
    return w;
  }
  if (g.kind === "reps") return t("whyReps", { n: g.setNo, a: fmt(g.limitAdj), t: g.limitTarget }) + (g.unknownEffort ? t("whyUnknown") : "");
  return t("whyHold", { n: g.setNo, a: fmt(g.limitAdj), t: g.limitTarget, h: g.harder ? t("whyHarder") : "" }) + (g.unknownEffort ? t("whyUnknown") : "");
}
function suggCards(s: Any) {
  return (s.suggestions || []).map((g: Any, i: number) => {
    const title = g.kind === "up" ? t("sUp") : g.kind === "reps" ? t("sReps") : t("sHold");
    const st = g.status !== "pending" ? `<span class="status ${g.status === "rejected" ? "muted" : "ok"}">${t(g.status)}</span>` : "";
    const ex = exById(g.exId);
    return `<div class="card"><div class="faint small">${esc(exName(g.exId))}</div>
      <div class="row spread base"><span class="b17">${title}</span>${st}</div>
      <div class="num b mt4">${g.loads.map((l: number) => loadTxt(ex, l)).join(" / ")} kg</div>
      <div class="why">${esc(why(g))}${g.substituted ? " " + t("substituted") : ""}</div>
      ${g.status === "pending" ? `<div class="row g8"><button class="btn primary small flex1" data-a="sgAccept" data-id="${s.id}" data-v="${i}">${t("accept")}</button>
        ${g.kind === "up" ? `<button class="btn ghost small flex1" data-a="sgModify" data-id="${s.id}" data-v="${i}">${t("modify")}</button>` : ""}
        <button class="btn ghost small flex1" data-a="sgReject" data-id="${s.id}" data-v="${i}">${t("reject")}</button></div>` : ""}
    </div>`;
  }).join("");
}
function sessionStats(s: Any) {
  let sets = 0, vol = 0;
  s.exercises.forEach((e: Any) => { if (e.skipped) return; sets += e.sets.filter((x: Any) => x.done && isWork(x)).length; vol += volumeLoad(e.sets); });
  return { sets, vol };
}
function vSummary(p: Any) {
  const s = A.sessions.find((x: Any) => x.id === p.id); if (!s) return "";
  const st = sessionStats(s);
  return `<div class="scroll"><h1>${t("summary")}</h1><div class="sub">${esc(nm(s.dayName))} · ${sessionDate(s)}</div>
    <div class="stats"><div class="stat"><b class="num">${clock(elapsed(s))}</b><span>${t("duration")}</span></div><div class="stat"><b class="num">${st.sets}</b><span>${t("workSets")}</span></div><div class="stat"><b class="num">${Math.round(st.vol).toLocaleString(locale())}</b><span>${t("volume")}</span></div></div>
    ${(s.suggestions || []).length ? `<h2>${t("forNext")}</h2>${suggCards(s)}` : ""}
    <button class="btn ghost block mt16" data-a="tab" data-v="today">${t("close")}</button></div>`;
}
async function applySuggestion(s: Any, i: number, status: string) {
  const g = s.suggestions[i];
  g.status = status;
  if ((status === "accepted" || status === "modified") && g.kind === "up" && !g.substituted) {
    for (const p of A.programs) for (const d of p.days) for (const pe of d.exercises) {
      if (pe.id !== g.peId) continue;
      const work = pe.sets.filter(isWork);
      work.forEach((tp: Any, k: number) => { if (g.loads[k] != null) tp.load = g.loads[k]; });
      await saveProgram(p);
      toast(t("appliedTo", { d: nm(d.name) }));
    }
  }
  await saveSession(s);
}

/* ---------------- History ---------------- */
function vHistory() {
  const list = completed();
  const c = A.cal || (A.cal = { y: new Date().getFullYear(), m: new Date().getMonth() });
  const first = new Date(c.y, c.m, 1); const startDow = (first.getDay() + 6) % 7; const nDays = new Date(c.y, c.m + 1, 0).getDate();
  const trained = new Set(list.filter((s: Any) => !s.dateUnknown).map((s: Any) => new Date(s.startedAt).toDateString()));
  const today = new Date().toDateString();
  let cells = "";
  const dows = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(locale(), { weekday: "narrow" }));
  cells += dows.map(d => `<span class="dow">${d}</span>`).join("");
  for (let i = 0; i < startDow; i++) cells += `<span></span>`;
  for (let d = 1; d <= nDays; d++) { const ds = new Date(c.y, c.m, d).toDateString(); cells += `<span class="dd ${trained.has(ds) ? "on" : ""} ${ds === today ? "now" : ""}">${d}</span>`; }
  const monthName = first.toLocaleDateString(locale(), { month: "long", year: "numeric" });
  let h = `<div class="scroll"><h1>${t("history")}</h1>
    <div class="card"><div class="row spread"><button class="iconbtn" data-a="calPrev" aria-label="prev">${I.back}</button><b class="cap">${monthName}</b><button class="iconbtn flip" data-a="calNext" aria-label="next">${I.back}</button></div><div class="cal">${cells}</div></div>`;
  if (!list.length) h += `<p class="sub">${t("noSessions")}</p>`;
  h += list.map((s: Any) => {
    const st = sessionStats(s);
    return `<button class="card rowbtn" data-a="openSession" data-id="${s.id}"><span><b>${esc(nm(s.dayName))}</b><span class="sub block">${sessionDate(s)}${s.dateUnknown ? "" : " · " + clock(elapsed(s))}</span></span><span class="muted num small r">${st.sets} ${t("sets").toLowerCase()}<br>${Math.round(st.vol).toLocaleString(locale())} kg</span></button>`;
  }).join("");
  return h + `</div>`;
}
function vSession(p: Any) {
  const s = A.sessions.find((x: Any) => x.id === p.id); if (!s) return header("");
  const st = sessionStats(s);
  const d = new Date(s.startedAt); const iso = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  let h = header(nm(s.dayName), `<button class="iconbtn" data-a="sessionMenu" data-id="${s.id}" aria-label="${t("edit")}">${I.dots}</button>`) + `<div class="scroll">
    <div class="row spread"><label class="sub" for="sdate">${t("date")}</label><input id="sdate" type="date" class="inp w-auto" value="${s.dateUnknown ? "" : iso}" data-in="sessionDate" data-id="${s.id}"></div>
    <div class="stats"><div class="stat"><b class="num">${s.dateUnknown ? "–" : clock(elapsed(s))}</b><span>${t("duration")}</span></div><div class="stat"><b class="num">${st.sets}</b><span>${t("workSets")}</span></div><div class="stat"><b class="num">${Math.round(st.vol).toLocaleString(locale())}</b><span>${t("volume")}</span></div></div>`;
  h += s.exercises.map((e: Any, ei: number) => {
    const ex = exById(e.exId);
    return `<div class="card"><div class="row spread"><b>${esc(nm(e.name))}</b>${e.skipped ? `<span class="pill warn">${t("skip")}</span>` : ""}</div>
      ${e.exId !== e.plannedExId ? `<div class="faint small">↺ ${t("replaces", { x: esc(exName(e.plannedExId)) })}</div>` : ""}
      ${e.sets.map((x: Any, si: number) => `<div class="hset ${x.done ? "" : "undone"}">
        <span class="faint num">${x.type === "warmup" ? "W" : e.sets.slice(0, si + 1).filter(isWork).length}</span>
        <button class="cell sm num" data-a="hNum" data-id="${s.id}" data-e="${ei}" data-v="${si}" data-f="load">${loadTxt(ex, x.load)} kg</button>
        <button class="cell sm num" data-a="hNum" data-id="${s.id}" data-e="${ei}" data-v="${si}" data-f="reps">× ${x.reps}</button>
        <button class="cell sm num" data-a="hRir" data-id="${s.id}" data-e="${ei}" data-v="${si}">RIR ${x.rir ?? "–"}</button>
        <button class="iconbtn" data-a="hDel" data-id="${s.id}" data-e="${ei}" data-v="${si}" aria-label="${t("deleteSet")}">${I.x}</button></div>`).join("")}
      </div>`;
  }).join("");
  h += `<label class="lbl" for="snotes">${t("sessionNotes")}</label><textarea id="snotes" class="inp" rows="3" data-in="sessionNotes" data-id="${s.id}">${esc(s.notes)}</textarea>`;
  if ((s.suggestions || []).length) h += `<h2>${t("forNext")}</h2>` + suggCards(s);
  return h + `</div>`;
}

/* ---------------- Programs ---------------- */
function vPrograms() {
  const act = A.programs.filter((p: Any) => p.status !== "archived");
  const arc = A.programs.filter((p: Any) => p.status === "archived");
  const card = (p: Any) => `<button class="card rowbtn" data-a="openProgram" data-id="${p.id}"><span><b>${esc(p.name)}</b><span class="sub block">${p.days.map((d: Any) => esc(nm(d.name))).join(" · ") || "—"}</span></span><span>${p.status === "active" ? `<span class="pill accent">${t("active")}</span>` : ""}</span></button>`;
  return `<div class="scroll"><h1>${t("programs")}</h1>${act.map(card).join("")}
    <button class="btn ghost block mt8" data-a="newProgram">+ ${t("newProgram")}</button>
    ${arc.length ? `<h2>${t("archived")}</h2>${arc.map(card).join("")}` : ""}</div>`;
}
const findProg = (id: string) => A.programs.find((p: Any) => p.id === id);
function vProgram(p: Any) {
  const pr = findProg(p.id); if (!pr) return header("");
  return header(t("program"), `<button class="iconbtn" data-a="programMenu" data-id="${pr.id}" aria-label="${t("edit")}">${I.dots}</button>`) + `<div class="scroll">
    <label class="lbl" for="pname">${t("name")}</label><input id="pname" class="inp" value="${esc(pr.name)}" data-in="progName" data-id="${pr.id}">
    <label class="lbl" for="pdesc">${t("description")}</label><input id="pdesc" class="inp" value="${esc(pr.description || "")}" data-in="progDesc" data-id="${pr.id}">
    <h2>${t("days")}</h2>
    ${pr.days.map((d: Any, i: number) => `<div class="card row">
      <button class="flex1 tl" data-a="openDay" data-id="${pr.id}" data-v="${i}"><b>${i + 1}. ${esc(nm(d.name))}</b>${pr.nextDay === i ? ` <span class="pill accent">${t("isNext")}</span>` : ""}<span class="sub block">${d.exercises.map((e: Any) => esc(exName(e.exId))).join(" · ") || "—"}</span></button>
      <div class="col"><button class="iconbtn" data-a="dayUp" data-id="${pr.id}" data-v="${i}" aria-label="${t("moveUp")}" ${i === 0 ? "disabled" : ""}>${I.up}</button><button class="iconbtn" data-a="dayDown" data-id="${pr.id}" data-v="${i}" aria-label="${t("moveDown")}" ${i === pr.days.length - 1 ? "disabled" : ""}>${I.down}</button></div></div>`).join("")}
    <button class="btn ghost block mt8" data-a="addDay" data-id="${pr.id}">+ ${t("addDay")}</button></div>`;
}
function vDay(p: Any) {
  const pr = findProg(p.id); const d = pr?.days[p.d]; if (!d) return header("");
  return header(nm(d.name), `<button class="iconbtn" data-a="dayMenu" data-id="${pr.id}" data-v="${p.d}" aria-label="${t("edit")}">${I.dots}</button>`) + `<div class="scroll">
    ${d.exercises.map((pe: Any, i: number) => {
      const ex = exById(pe.exId);
      const sum = pe.sets.map((s: Any) => s.type === "warmup" ? `W ${loadTxt(ex, s.load ?? 0)}×${s.repsMin}` : `${s.load != null ? loadTxt(ex, s.load) + "×" : ""}${s.repsMin}${s.repsMax !== s.repsMin ? "–" + s.repsMax : ""}${s.rir != null ? "@" + s.rir : ""}`).join(" · ");
      return `<div class="card row"><button class="flex1 tl" data-a="openPe" data-id="${pr.id}" data-d="${p.d}" data-v="${i}">
        <b>${esc(exName(pe.exId))}</b>${pe.group ? ` <span class="pill accent">${esc(pe.group)}</span>` : ""}${pe.optional ? ` <span class="pill">${t("optional")}</span>` : ""}
        <span class="sub block num">${sum}</span></button>
        <div class="col"><button class="iconbtn" data-a="peUp" data-id="${pr.id}" data-d="${p.d}" data-v="${i}" ${i === 0 ? "disabled" : ""} aria-label="${t("moveUp")}">${I.up}</button><button class="iconbtn" data-a="peDown" data-id="${pr.id}" data-d="${p.d}" data-v="${i}" ${i === d.exercises.length - 1 ? "disabled" : ""} aria-label="${t("moveDown")}">${I.down}</button></div></div>`;
    }).join("")}
    <button class="btn ghost block mt8" data-a="pickFor" data-mode="addToDay" data-id="${pr.id}" data-d="${p.d}">+ ${t("addExercise")}</button></div>`;
}
function vPe(p: Any) {
  const pr = findProg(p.id); const d = pr?.days[p.d]; const pe = d?.exercises[p.e]; if (!pe) return header("");
  const ex = exById(pe.exId);
  const groups = ["", "A", "B", "C", "D"];
  return header(exName(pe.exId), `<button class="iconbtn" data-a="peMenu" data-id="${pr.id}" data-d="${p.d}" data-v="${p.e}" aria-label="${t("edit")}">${I.dots}</button>`) + `<div class="scroll">
    <h2>${t("sets")}</h2>
    <div class="tpl-head"><span></span><span>${t("kg")}</span><span>${t("repsMin")}</span><span>${t("repsMax")}</span><span>RIR</span><span></span></div>
    ${pe.sets.map((s: Any, i: number) => `<div class="tpl">
      <button data-a="tplType" data-id="${pr.id}" data-d="${p.d}" data-e="${p.e}" data-v="${i}" class="badge ${s.type === "warmup" ? "w" : s.type === "top" ? "acc" : ""}">${s.type === "warmup" ? "W" : s.type === "top" ? "T" : s.type === "backoff" ? "B" : s.type === "amrap" ? "A" : s.type === "drop" ? "D" : pe.sets.slice(0, i + 1).filter(isWork).length}</button>
      <button class="cell sm num" data-a="tplNum" data-f="load" data-id="${pr.id}" data-d="${p.d}" data-e="${p.e}" data-v="${i}">${s.load == null ? "–" : loadTxt(ex, s.load)}</button>
      <button class="cell sm num" data-a="tplNum" data-f="repsMin" data-id="${pr.id}" data-d="${p.d}" data-e="${p.e}" data-v="${i}">${s.repsMin}</button>
      <button class="cell sm num" data-a="tplNum" data-f="repsMax" data-id="${pr.id}" data-d="${p.d}" data-e="${p.e}" data-v="${i}">${s.repsMax}</button>
      <button class="cell sm num" data-a="tplRir" data-id="${pr.id}" data-d="${p.d}" data-e="${p.e}" data-v="${i}">${s.rir ?? "–"}</button>
      <button class="iconbtn" data-a="tplDel" data-id="${pr.id}" data-d="${p.d}" data-e="${p.e}" data-v="${i}" aria-label="${t("deleteSet")}">${I.x}</button></div>`).join("")}
    <div class="row g8 mt4"><button class="addset flex1" data-a="tplAdd" data-id="${pr.id}" data-d="${p.d}" data-e="${p.e}">+ ${t("addSet")}</button><button class="addset flex1" data-a="tplAddWarm" data-id="${pr.id}" data-d="${p.d}" data-e="${p.e}">+ ${t("addWarmup")}</button></div>
    <h2>${t("restSec")}</h2>
    <button class="cell num wide" data-a="peRest" data-id="${pr.id}" data-d="${p.d}" data-e="${p.e}">${pe.rest ?? ex?.rest ?? 120} ${t("sec")}${pe.rest == null ? ` <span class="faint small">(${t("default")})</span>` : ""}</button>
    <h2>${t("superset")}</h2>
    <div class="seg">${groups.map(g => `<button class="${(pe.group || "") === g ? "on" : ""}" data-a="peGroup" data-id="${pr.id}" data-d="${p.d}" data-e="${p.e}" data-v="${g}">${g || t("none")}</button>`).join("")}</div>
    <label class="toggle mt16"><input type="checkbox" ${pe.optional ? "checked" : ""} data-in="peOptional" data-id="${pr.id}" data-d="${p.d}" data-e="${p.e}"> ${t("optional")}</label>
    <label class="lbl" for="penotes">${t("notes")}</label><textarea id="penotes" class="inp" rows="3" data-in="peNotes" data-id="${pr.id}" data-d="${p.d}" data-e="${p.e}">${esc(pe.notes || "")}</textarea>
  </div>`;
}

/* ---------------- Library ---------------- */
function libList(mode: string, ctx: Any) {
  const q = A.q.trim().toLowerCase();
  const list = [...A.lib.values()].filter((e: Any) => !e.archived)
    .filter((e: Any) => !A.qm || e.muscles.some((m: Any) => m.m === A.qm && m.role === "primary"))
    .filter((e: Any) => !q || [e.name.en, e.name.it, ...(e.aliases || [])].some((n: string) => n.toLowerCase().includes(q)))
    .sort((a: Any, b: Any) => nm(a.name).localeCompare(nm(b.name), locale()));
  const chips = `<div class="chips-row">${["", ...MUSCLES].map(m => `<button class="chipf ${A.qm === m ? "on" : ""}" data-a="libMuscle" data-v="${m}">${m ? t("m_" + m) : t("all")}</button>`).join("")}</div>`;
  const items = list.map((e: Any) => `<button class="li btnli" data-a="${mode}" data-id="${e.id}" ${ctx ? `data-ctx='${esc(JSON.stringify(ctx))}'` : ""}>
      <span><span class="b">${esc(nm(e.name))}</span>${e.custom ? ` <span class="pill">${t("custom")}</span>` : ""}<span class="sub block small">${t("eq_" + e.equipment)} · ${e.muscles.filter((m: Any) => m.role === "primary").map((m: Any) => t("m_" + m.m)).join(", ")}</span></span>${I.chev}</button>`).join("");
  return `<input class="inp search" type="search" placeholder="${t("search")}" value="${esc(A.q)}" data-in="libQ" autocomplete="off">${chips}<div class="card">${items || `<p class="sub">—</p>`}</div>`;
}
function vLibrary() {
  return `<div class="scroll"><div class="row spread"><h1>${t("library")}</h1><button class="btn ghost small" data-a="newExercise">+ ${t("newExercise")}</button></div>${libList("openExercise", null)}</div>`;
}
function vPick(p: Any) { return header(p.mode === "substitute" ? t("substitute") : p.mode === "replacePe" ? t("replaceEx") : t("addExercise")) + `<div class="scroll">${libList("picked", p)}</div>`; }

function exHistory(exId: string) {
  return completed().map((s: Any) => {
    const e = s.exercises.find((x: Any) => x.exId === exId && !x.skipped);
    if (!e) return null;
    const work = e.sets.filter((x: Any) => x.done && isWork(x));
    if (!work.length) return null;
    let best: Any = null;
    for (const x of work) { const v = e1rm(x.load, x.reps, x.rir); if (v != null && (!best || v > best.v)) best = { v, x }; }
    return { s, work, best };
  }).filter(Boolean);
}
function vExercise(p: Any) {
  const ex = exById(p.id); if (!ex) return header("");
  const hist = exHistory(ex.id) as Any[];
  let heavy: Any = null, bestE: Any = null, bestV: Any = null;
  hist.forEach((h: Any) => h.work.forEach((x: Any) => {
    if (!heavy || x.load > heavy.x.load) heavy = { x, s: h.s };
    const v = e1rm(x.load, x.reps, x.rir); if (v != null && (!bestE || v > bestE.v)) bestE = { v, x, s: h.s };
    if (!bestV || x.load * x.reps > bestV.v) bestV = { v: x.load * x.reps, x, s: h.s };
  }));
  const pts = hist.filter((h: Any) => h.best).slice().reverse().map((h: Any) => h.best.v);
  let chart = "";
  if (pts.length >= 2) {
    const W = 320, H = 110, mn = Math.min(...pts), mx = Math.max(...pts), span = mx - mn || 1;
    const xy = pts.map((v: number, i: number) => [12 + (i * (W - 24)) / (pts.length - 1), 10 + (H - 20) * (1 - (v - mn) / span)]);
    chart = `<h2>${t("e1rmChart")}</h2><div class="card"><svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="${t("e1rmChart")}: ${pts.map((v: number) => Math.round(v)).join(", ")} kg">
      <polyline fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" points="${xy.map(a => a.join(",")).join(" ")}"/>
      ${xy.map(a => `<circle cx="${a[0]}" cy="${a[1]}" r="3.5" fill="var(--accent)"/>`).join("")}
      <text x="${W - 4}" y="12" text-anchor="end" class="ctext">${Math.round(mx)} kg</text><text x="${W - 4}" y="${H - 2}" text-anchor="end" class="ctext">${Math.round(mn)} kg</text></svg></div>`;
  }
  const rec = (lbl: string, r: Any, val: string) => `<div class="li"><span>${lbl}</span><span class="r num"><b>${val}</b><span class="sub block small">${r ? `${loadTxt(ex, r.x.load)}×${r.x.reps}${r.x.rir != null ? " @" + r.x.rir : ""} · ${sessionDate(r.s)}` : ""}</span></span></div>`;
  return header(nm(ex.name), `<button class="iconbtn" data-a="exEdit" data-id="${ex.id}" aria-label="${t("edit")}">${I.dots}</button>`) + `<div class="scroll">
    <div class="ex-meta"><span class="pill">${t("eq_" + ex.equipment)}</span>${ex.muscles.map((m: Any) => `<span class="pill ${m.role === "primary" ? "accent" : ""}">${t("m_" + m.m)}${m.role === "secondary" ? " ½" : ""}</span>`).join("")}</div>
    <div class="row g8"><button class="cell num flex1" data-a="exInc" data-id="${ex.id}">+${fmt(ex.inc)} kg</button><button class="cell num flex1" data-a="exRest" data-id="${ex.id}">${ex.rest} ${t("sec")} ${t("restOn")}</button></div>
    ${hist.length ? `<h2>${t("records")}</h2><div class="card">${rec(t("heaviest"), heavy, loadTxt(ex, heavy.x.load) + " kg")}${bestE ? rec(t("bestE1rm"), bestE, "~" + Math.round(bestE.v) + " kg") : ""}${rec(t("bestSet"), bestV, Math.round(bestV.v) + " kg")}</div>` : ""}
    ${chart}
    <h2>${t("history")}</h2>${hist.length ? hist.map((h: Any) => `<button class="card rowbtn" data-a="openSession" data-id="${h.s.id}"><span><b class="small">${sessionDate(h.s)}</b><span class="block num">${h.work.map((x: Any) => `${loadTxt(ex, x.load)}×${x.reps}${x.rir != null ? "@" + x.rir : ""}`).join(" · ")}</span></span>${h.best ? `<span class="faint small num">~${Math.round(h.best.v)}</span>` : ""}</button>`).join("") : `<p class="sub">${t("noHistory")}</p>`}
  </div>`;
}
function vExForm(p: Any) {
  const ex = p.id ? exById(p.id) : null;
  const f = A.form || (A.form = ex ? JSON.parse(JSON.stringify(ex)) : { id: "", name: { en: "", it: "" }, aliases: [], equipment: "machine", pattern: "other", mechanic: "isolation", loadType: "external", inc: 5, rest: 90, muscles: [{ m: "chest", role: "primary" }], notes: "", custom: true, archived: false });
  const prim = f.muscles.find((m: Any) => m.role === "primary")?.m || "chest";
  const sec = new Set(f.muscles.filter((m: Any) => m.role === "secondary").map((m: Any) => m.m));
  const eqs = ["barbell", "dumbbell", "machine", "cable", "smith", "bodyweight", "band", "kettlebell", "other"];
  const lts = ["external", "bodyweight", "bw_plus", "assisted"];
  return header(ex ? t("edit") : t("newExercise")) + `<div class="scroll">
    <label class="lbl" for="fen">${t("name")} (English)</label><input id="fen" class="inp" value="${esc(f.name.en)}" data-in="fName" data-v="en">
    <label class="lbl" for="fit">${t("name")} (Italiano)</label><input id="fit" class="inp" value="${esc(f.name.it)}" data-in="fName" data-v="it">
    <label class="lbl" for="feq">${t("equipment")}</label><select id="feq" class="inp" data-in="fEq">${eqs.map(e => `<option value="${e}" ${f.equipment === e ? "selected" : ""}>${t("eq_" + e)}</option>`).join("")}</select>
    <label class="lbl" for="flt">${t("loadType")}</label><select id="flt" class="inp" data-in="fLt">${lts.map(e => `<option value="${e}" ${f.loadType === e ? "selected" : ""}>${t("lt_" + e)}</option>`).join("")}</select>
    <label class="lbl" for="fpm">${t("primary")}</label><select id="fpm" class="inp" data-in="fPrim">${MUSCLES.map(m => `<option value="${m}" ${prim === m ? "selected" : ""}>${t("m_" + m)}</option>`).join("")}</select>
    <div class="lbl">${t("secondary")}</div><div class="chips-row wrap">${MUSCLES.filter(m => m !== prim).map(m => `<button class="chipf ${sec.has(m) ? "on" : ""}" data-a="fSec" data-v="${m}">${t("m_" + m)}</button>`).join("")}</div>
    <div class="row g8 mt12"><div class="flex1"><div class="lbl">${t("increment")}</div><input class="inp num" inputmode="decimal" value="${fmt(f.inc)}" data-in="fInc"></div><div class="flex1"><div class="lbl">${t("restSec")}</div><input class="inp num" inputmode="numeric" value="${f.rest}" data-in="fRest"></div></div>
    <button class="btn primary block mt16" data-a="fSave">${t("save")}</button>
    ${ex ? `<button class="btn ghost block mt8 danger" data-a="exArchive" data-id="${ex.id}">${t("archiveEx")}</button>` : ""}
  </div>`;
}

/* ---------------- More ---------------- */
function vMore() {
  const disc = A.sessions.filter((s: Any) => s.status === "discarded").sort((a: Any, b: Any) => b.startedAt - a.startedAt);
  return `<div class="scroll"><h1>${t("more")}</h1>
    <h2>${t("language")}</h2><div class="seg"><button class="${L() === "en" ? "on" : ""}" data-a="lang" data-v="en">English</button><button class="${L() === "it" ? "on" : ""}" data-a="lang" data-v="it">Italiano</button></div>
    <h2>${t("theme")}</h2><div class="seg"><button class="${A.settings.theme === "dark" ? "on" : ""}" data-a="theme" data-v="dark">${t("dark")}</button><button class="${A.settings.theme === "light" ? "on" : ""}" data-a="theme" data-v="light">${t("light")}</button></div>
    <h2>${t("data")}</h2>
    <div class="sub mb8">${t("lastBackup", { d: A.settings.lastBackupAt ? dstr(A.settings.lastBackupAt) : t("never") })}</div>
    <button class="btn primary block" data-a="exportJson">${t("exportJson")}</button>
    <button class="btn ghost block mt8" data-a="exportCsv">${t("exportCsv")}</button>
    <label class="btn ghost block mt8 filebtn">${t("importJson")}<input type="file" accept="application/json,.json" data-in="importFile" hidden></label>
    ${disc.length ? `<h2>${t("discarded")}</h2><div class="card">${disc.map((s: Any) => `<div class="li"><span>${esc(nm(s.dayName))}<span class="sub block small">${sessionDate(s)}</span></span><button class="btn ghost small" data-a="restoreSession" data-id="${s.id}">${t("restore")}</button></div>`).join("")}</div>` : ""}
    <h2>${t("storage")}</h2><div class="card"><div class="sub">${A.persisted ? t("persisted") : t("notPersisted")}</div><div class="sub mt8">${t("installHint")}</div></div>
    <p class="faint small c mt16">Logbook ${VERSION}</p></div>`;
}

/* ---------------- Sheets ---------------- */
function vSheet() {
  const sh = A.sheet; let inner = "";
  if (sh.kind === "num") {
    inner = `<h3>${esc(sh.title)}</h3><div class="bigval num">${esc(sh.val === "" ? "0" : sh.val)}<small> ${sh.unit || ""}</small></div>
      ${sh.step ? `<div class="steppers">${[-2, -1, 1, 2].map(k => `<button class="key num" data-a="kStep" data-v="${k * sh.step}">${k < 0 ? "−" : "+"}${fmt(Math.abs(k * sh.step))}</button>`).join("")}</div>` : ""}
      <div class="keys">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button class="key num" data-a="kKey" data-v="${n}">${n}</button>`).join("")}
      <button class="key" data-a="kKey" data-v="${sh.decimal ? "." : "C"}">${sh.decimal ? (L() === "it" ? "," : ".") : "C"}</button><button class="key num" data-a="kKey" data-v="0">0</button><button class="key" data-a="kKey" data-v="del" aria-label="⌫">⌫</button></div>
      <button class="btn primary block mt8" data-a="kOk">${t("done")}</button>`;
  } else if (sh.kind === "rir") {
    inner = `<h3>${esc(sh.title)}</h3><div class="sub">${t("rpe")} ${sh.val == null ? "–" : 10 - Math.min(sh.val, 5)} (= 10 − RIR)</div>
      <div class="rirs">${[0, 1, 2, 3, 4, 5].map(n => `<button class="chip num ${sh.val === n ? "on" : ""}" data-a="rirPick" data-v="${n}">${n === 5 ? "5+" : n}</button>`).join("")}</div>
      <button class="btn ghost block" data-a="rirPick" data-v="null">– (${t("none").toLowerCase()})</button>`;
  } else if (sh.kind === "menu") {
    inner = `${sh.title ? `<h3>${esc(sh.title)}</h3>` : ""}<div class="menu">${sh.items.map((it: Any, i: number) => `<button class="${it.danger ? "danger" : ""}" data-a="menuPick" data-v="${i}">${esc(it.label)}</button>`).join("")}</div>`;
  } else if (sh.kind === "confirm") {
    inner = `<h3>${esc(sh.title)}</h3><p class="sub">${esc(sh.body)}</p><div class="row g8"><button class="btn ghost flex1" data-a="closeSheet">${t("cancel")}</button>
      <button class="btn ${sh.danger ? "ghost danger" : "primary"} flex1" data-a="confirmOk">${esc(sh.okLabel)}</button></div>`;
  } else if (sh.kind === "text") {
    inner = `<h3>${esc(sh.title)}</h3><input class="inp" id="sheetText" value="${esc(sh.val)}" data-in="sheetText"><button class="btn primary block mt12" data-a="textOk">${t("save")}</button>`;
  }
  return `<div class="scrim" data-a="scrim"><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${inner}</div></div>`;
}
function numSheet(title: string, val: number | null, opts: { step?: number; decimal?: boolean; unit?: string }, onOk: (n: number) => any) {
  A.sheet = { kind: "num", title, val: val == null ? "" : fmt(val), fresh: true, ...opts, onOk }; render();
}
function rirSheet(title: string, val: number | null, onOk: (n: number | null) => any) { A.sheet = { kind: "rir", title, val, onOk }; render(); }
function menu(title: string, items: { label: string; danger?: boolean; on: () => any }[]) { A.sheet = { kind: "menu", title, items }; render(); }
function confirmSheet(title: string, body: string, okLabel: string, danger: boolean, onOk: () => any) { A.sheet = { kind: "confirm", title, body, okLabel, danger, onOk }; render(); }
function textSheet(title: string, val: string, onOk: (v: string) => any) { A.sheet = { kind: "text", title, val, onOk }; render(); setTimeout(() => (document.getElementById("sheetText") as HTMLInputElement)?.focus(), 50); }

/* ---------------- export / import ---------------- */
async function shareFile(name: string, mime: string, text: string): Promise<boolean> {
  const file = new File([text], name, { type: mime });
  const nav: Any = navigator;
  if (nav.canShare && nav.canShare({ files: [file] })) {
    try { await nav.share({ files: [file], title: name }); return true; } catch (e: Any) { if (e && e.name === "AbortError") return false; }
  }
  const a = document.createElement("a"); a.href = URL.createObjectURL(file); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return true;
}
const stamp = () => new Date().toISOString().slice(0, 10);
async function exportJson() {
  const data = { app: "logbook", schema: 1, exportedAt: new Date().toISOString(), version: VERSION,
    exercises: await db.all("exercises"), programs: await db.all("programs"), sessions: await db.all("sessions"), settings: A.settings };
  const ok = await shareFile(`logbook-backup-${stamp()}.json`, "application/json", JSON.stringify(data, null, 1));
  if (ok) { A.settings.lastBackupAt = now(); await saveSettings(); toast(t("saved")); render(); }
}
async function exportCsv() { await shareFile(`logbook-sets-${stamp()}.csv`, "text/csv", setsCsv(A.sessions, A.lib)); }
async function importFile(file: File) {
  try {
    const data = JSON.parse(await file.text());
    if (!data || data.app !== "logbook" || !Array.isArray(data.sessions)) throw new Error("bad");
    const local = { exercises: await db.all("exercises"), programs: await db.all("programs"), sessions: await db.all("sessions") };
    const r = mergeImport(local, data);
    for (const st of ["exercises", "programs", "sessions"] as const) await db.putMany(st, r.writes[st]);
    A.lib = new Map((await db.all("exercises")).map((e: Any) => [e.id, e]));
    A.programs = await db.all("programs"); A.sessions = await db.all("sessions");
    if (A.programs.filter((p: Any) => p.status === "active").length > 1) {
      const keep = A.programs.filter((p: Any) => p.status === "active").sort((a: Any, b: Any) => b.updatedAt - a.updatedAt)[0];
      for (const p of A.programs) if (p.status === "active" && p !== keep) { p.status = "inactive"; await saveProgram(p); }
    }
    toast(t("importDone", { a: r.added, u: r.updated, k: r.kept }));
  } catch { toast(t("importBad")); }
  render();
}

/* ---------------- actions ---------------- */
function ds(el: HTMLElement) { return el.dataset; }
app.addEventListener("click", async ev => {
  const el = (ev.target as HTMLElement).closest("[data-a]") as HTMLElement | null;
  if (!el || (el as HTMLButtonElement).disabled) return;
  const a = el.dataset.a!, d = ds(el), v = d.v ?? "";
  const s = activeSession();
  const sh = A.sheet;
  if (a === "scrim") { if (ev.target === el) { A.sheet = null; render(); } return; }
  try {
    switch (a) {
      case "tab": tab(v); return;
      case "back": back(); return;
      case "undo": if (A.toast?.undo) await A.toast.undo(); A.toast = null; break;
      case "lang": A.settings.lang = v; setLang(v as Lang); await saveSettings(); break;
      case "theme": A.settings.theme = v; await saveSettings(); break;
      case "closeSheet": A.sheet = null; break;
      // sheets
      case "kKey": { let x = sh.fresh ? "" : sh.val; sh.fresh = false;
        if (v === "del") x = x.slice(0, -1); else if (v === "C") x = ""; else if (v === ".") { if (!x.includes(".")) x = (x || "0") + "."; } else if (x.replace(".", "").length < 6) x = (x === "0" ? "" : x) + v;
        sh.val = x; break; }
      case "kStep": sh.val = fmt(Math.max(0, round2((parseFloat(sh.val) || 0) + parseFloat(v)))); sh.fresh = false; haptic(); break;
      case "kOk": { const n = parseFloat(sh.val) || 0; A.sheet = null; await sh.onOk(sh.decimal ? round2(n) : Math.round(n)); break; }
      case "rirPick": { A.sheet = null; haptic(); await sh.onOk(v === "null" ? null : +v); break; }
      case "menuPick": { const it = sh.items[+v]; A.sheet = null; await it.on(); break; }
      case "confirmOk": { A.sheet = null; await sh.onOk(); break; }
      case "textOk": { const val = (document.getElementById("sheetText") as HTMLInputElement).value.trim(); A.sheet = null; if (val) await sh.onOk(val); break; }
      // today
      case "start": { const p = activeProgram(); await startWorkout(p, +v); return; }
      case "startEmpty": await startWorkout(null, null); return;
      case "changeDay": { const p = activeProgram(); if (!p) return;
        menu(t("changeDay"), p.days.map((dd: Any, i: number) => ({ label: `${i + 1}. ${nm(dd.name)}`, on: async () => { p.nextDay = i; await saveProgram(p); } }))); return; }
      case "openWorkout": A.nav = [{ v: "today", p: {} }, { v: "workout", p: {} }]; render(); requestWake(); return;
      case "openSummary": go("summary", { id: d.id }); return;
      case "exportJson": await exportJson(); return;
      case "exportCsv": await exportCsv(); return;
      // workout
      case "goto": { const i = +v; if (s && i >= 0 && i < s.exercises.length) { s.idx = i; await saveSession(s); render(); const b = document.getElementById("wkbody"); if (b) b.scrollTop = 0; centerStrip(); } return; }
      case "pause": if (s.pausedAt) { s.pausedMs += now() - s.pausedAt; s.pausedAt = null; } else s.pausedAt = now(); await saveSession(s); break;
      case "check": await toggleSet(s, +v); render(); centerStrip(); return;
      case "wNum": { const e = s.exercises[s.idx], x = e.sets[+v], f = d.f!, ex = exById(e.exId);
        numSheet(f === "load" ? t("weight") : t("reps"), x[f], f === "load" ? { step: ex?.inc || 2.5, decimal: true, unit: "kg" } : { step: 1 }, async n => { x[f] = n; x.edited = { ...(x.edited || {}), [f]: true }; await saveSession(s); }); return; }
      case "wRir": { const x = s.exercises[s.idx].sets[+v]; rirSheet(`RIR · ${t("set")} ${+v + 1}`, x.rir, async n => { x.rir = n; x.edited = { ...(x.edited || {}), rir: true }; await saveSession(s); }); return; }
      case "setMenu": { const e = s.exercises[s.idx], i = +v;
        menu(t("setType"), [
          ...["warmup", "working", "top", "backoff", "amrap", "drop"].map(k => ({ label: t(k), on: async () => { e.sets[i].type = k; await saveSession(s); } })),
          { label: t("deleteSet"), danger: true, on: async () => { const removed = e.sets.splice(i, 1)[0]; await saveSession(s); toast(t("setDeleted"), async () => { e.sets.splice(i, 0, removed); await saveSession(s); }); } },
        ]); return; }
      case "wAddSet": case "wAddWarm": { const e = s.exercises[s.idx]; const warm = a === "wAddWarm";
        const src = warm ? e.sets.find((x: Any) => x.type === "warmup") : [...e.sets].reverse().find((x: Any) => isWork(x));
        const ns = { id: uid(), type: warm ? "warmup" : "working", load: src?.load ?? 0, reps: src?.reps ?? 8, rir: warm ? null : (src?.rir ?? 2), rpe: null, done: false, doneAt: null, edited: {}, last: null,
          t: src?.t ? { ...src.t } : { repsMin: 8, repsMax: 12, rir: warm ? null : 2, load: null } };
        if (warm) e.sets.unshift(ns); else e.sets.push(ns); await saveSession(s); break; }
      case "exMenu": { const e = s.exercises[s.idx];
        menu(nm(e.name), [
          { label: t("substitute"), on: () => go("pick", { mode: "substitute" }) },
          { label: e.skipped ? t("unskipEx") : t("skipEx"), on: async () => { e.skipped = !e.skipped; if (e.skipped && s.idx < s.exercises.length - 1) s.idx++; await saveSession(s); if (e.skipped) toast(t("exSkipped"), async () => { e.skipped = false; await saveSession(s); }); } },
          ...(s.idx > 0 ? [{ label: t("moveUp"), on: async () => { const x = s.exercises.splice(s.idx, 1)[0]; s.exercises.splice(--s.idx, 0, x); await saveSession(s); } }] : []),
          ...(s.idx < s.exercises.length - 1 ? [{ label: t("moveDown"), on: async () => { const x = s.exercises.splice(s.idx, 1)[0]; s.exercises.splice(++s.idx, 0, x); await saveSession(s); } }] : []),
        ]); return; }
      case "addToWorkout": go("pick", { mode: "addToWorkout" }); return;
      case "rest30": s.rest.endsAt += 30000; s.rest.total += 30; s.rest.buzzed = false; await saveSession(s); break;
      case "restSkip": s.rest = null; await saveSession(s); break;
      case "askFinish": { const n = s.exercises.reduce((acc: number, e: Any) => acc + e.sets.filter((x: Any) => x.done && isWork(x)).length, 0);
        confirmSheet(t("confirmFinish"), t("confirmFinishBody", { n }), t("finish"), false, async () => { await finishSession(s); }); return; }
      case "askDiscard": confirmSheet(t("confirmDiscard"), t("confirmDiscardBody"), t("discard"), true, async () => { s.status = "discarded"; s.discardedAt = now(); await saveSession(s); releaseWake(); A.nav = [{ v: "today", p: {} }]; }); return;
      // suggestions
      case "sgAccept": case "sgReject": { const ss = A.sessions.find((x: Any) => x.id === d.id); await applySuggestion(ss, +v, a === "sgAccept" ? "accepted" : "rejected"); break; }
      case "sgModify": { const ss = A.sessions.find((x: Any) => x.id === d.id), g = ss.suggestions[+v]; const top = Math.max(...g.loads);
        numSheet(t("weight"), top, { step: g.inc || 2.5, decimal: true, unit: "kg" }, async n => { const delta = n - top; g.loads = g.loads.map((l: number) => round2(l + delta)); await applySuggestion(ss, +v, "modified"); }); return; }
      // history
      case "calPrev": case "calNext": { const c = A.cal; c.m += a === "calNext" ? 1 : -1; if (c.m < 0) { c.m = 11; c.y--; } if (c.m > 11) { c.m = 0; c.y++; } break; }
      case "openSession": go("session", { id: d.id }); return;
      case "hNum": { const ss = A.sessions.find((x: Any) => x.id === d.id), e = ss.exercises[+d.e!], x = e.sets[+v], f = d.f!, ex = exById(e.exId);
        numSheet(f === "load" ? t("weight") : t("reps"), x[f], f === "load" ? { step: ex?.inc || 2.5, decimal: true, unit: "kg" } : { step: 1 }, async n => { x[f] = n; await saveSession(ss); }); return; }
      case "hRir": { const ss = A.sessions.find((x: Any) => x.id === d.id), x = ss.exercises[+d.e!].sets[+v]; rirSheet("RIR", x.rir, async n => { x.rir = n; await saveSession(ss); }); return; }
      case "hDel": { const ss = A.sessions.find((x: Any) => x.id === d.id), e = ss.exercises[+d.e!], i = +v; const removed = e.sets.splice(i, 1)[0]; await saveSession(ss);
        toast(t("setDeleted"), async () => { e.sets.splice(i, 0, removed); await saveSession(ss); }); break; }
      case "sessionMenu": { const ss = A.sessions.find((x: Any) => x.id === d.id);
        menu("", [{ label: t("deleteWorkout"), danger: true, on: () => confirmSheet(t("confirmDiscard"), t("confirmDiscardBody"), t("discard"), true, async () => { ss.status = "discarded"; ss.discardedAt = now(); await saveSession(ss); back(); }) }]); return; }
      case "restoreSession": { const ss = A.sessions.find((x: Any) => x.id === d.id); ss.status = "completed"; ss.endedAt = ss.endedAt || ss.updatedAt; await saveSession(ss); break; }
      // programs
      case "openProgram": go("program", { id: d.id }); return;
      case "newProgram": { const p = { id: uid(), name: t("newProgram"), description: "", status: activeProgram() ? "inactive" : "active", nextDay: 0, days: [{ id: uid(), name: { en: "Day 1", it: "Giorno 1" }, exercises: [] }], createdAt: now(), updatedAt: now() };
        await saveProgram(p); A.programs.push(p); go("program", { id: p.id }); return; }
      case "programMenu": { const p = findProg(d.id!);
        menu(p.name, [
          ...(p.status !== "active" ? [{ label: t("makeActive"), on: async () => { for (const q of A.programs) if (q.status === "active") { q.status = "inactive"; await saveProgram(q); } p.status = "active"; await saveProgram(p); } }] : []),
          { label: t("duplicate"), on: async () => { const c = JSON.parse(JSON.stringify(p)); c.id = uid(); c.name = p.name + " (2)"; c.status = "inactive"; c.createdAt = now();
              c.days.forEach((dd: Any) => { dd.id = uid(); dd.exercises.forEach((pe: Any) => { pe.id = uid(); pe.sets.forEach((x: Any) => x.id = uid()); }); });
              await saveProgram(c); A.programs.push(c); A.nav[A.nav.length - 1] = { v: "program", p: { id: c.id } }; } },
          p.status === "archived" ? { label: t("unarchive"), on: async () => { p.status = "inactive"; await saveProgram(p); } }
            : { label: t("archive"), on: async () => { p.status = "archived"; await saveProgram(p); back(); } },
        ]); return; }
      case "openDay": go("day", { id: d.id, d: +v }); return;
      case "dayUp": case "dayDown": { const p = findProg(d.id!), i = +v, j = a === "dayUp" ? i - 1 : i + 1; const nextId = p.days[p.nextDay]?.id;
        [p.days[i], p.days[j]] = [p.days[j], p.days[i]]; p.nextDay = Math.max(0, p.days.findIndex((x: Any) => x.id === nextId)); await saveProgram(p); break; }
      case "addDay": { const p = findProg(d.id!); const n = p.days.length + 1; p.days.push({ id: uid(), name: { en: `Day ${n}`, it: `Giorno ${n}` }, exercises: [] }); await saveProgram(p); break; }
      case "dayMenu": { const p = findProg(d.id!), i = +v, dd = p.days[i];
        menu(nm(dd.name), [
          { label: t("renameDay"), on: () => textSheet(t("renameDay"), nm(dd.name), async val => { dd.name = { en: val, it: val }; await saveProgram(p); }) },
          { label: t("setNext"), on: async () => { p.nextDay = i; await saveProgram(p); } },
          { label: t("duplicate"), on: async () => { const c = JSON.parse(JSON.stringify(dd)); c.id = uid(); c.name = { en: nm(dd.name) + " (2)", it: nm(dd.name) + " (2)" }; c.exercises.forEach((pe: Any) => { pe.id = uid(); pe.sets.forEach((x: Any) => x.id = uid()); }); p.days.splice(i + 1, 0, c); await saveProgram(p); } },
          { label: t("deleteDay"), danger: true, on: () => confirmSheet(t("deleteDay"), nm(dd.name), t("delete"), true, async () => { p.days.splice(i, 1); p.nextDay = Math.min(p.nextDay, Math.max(0, p.days.length - 1)); await saveProgram(p); back(); }) },
        ]); return; }
      case "openPe": go("pe", { id: d.id, d: +d.d!, e: +v }); return;
      case "peUp": case "peDown": { const p = findProg(d.id!), ex = p.days[+d.d!].exercises, i = +v, j = a === "peUp" ? i - 1 : i + 1; [ex[i], ex[j]] = [ex[j], ex[i]]; await saveProgram(p); break; }
      case "pickFor": go("pick", { mode: d.mode, id: d.id, d: +d.d!, e: d.e != null ? +d.e : null }); return;
      case "peMenu": { const p = findProg(d.id!), day = p.days[+d.d!], i = +v, pe = day.exercises[i];
        menu(exName(pe.exId), [
          { label: t("replaceEx"), on: () => go("pick", { mode: "replacePe", id: p.id, d: +d.d!, e: i }) },
          { label: t("duplicate"), on: async () => { const c = JSON.parse(JSON.stringify(pe)); c.id = uid(); c.sets.forEach((x: Any) => x.id = uid()); day.exercises.splice(i + 1, 0, c); await saveProgram(p); } },
          ...p.days.map((dd: Any, k: number) => k === +d.d! ? null : { label: `${t("moveTo")}: ${nm(dd.name)}`, on: async () => { day.exercises.splice(i, 1); dd.exercises.push(pe); await saveProgram(p); back(); } }).filter(Boolean),
          { label: t("deleteEx"), danger: true, on: () => confirmSheet(t("deleteEx"), exName(pe.exId), t("delete"), true, async () => { day.exercises.splice(i, 1); await saveProgram(p); back(); }) },
        ]); return; }
      case "tplType": { const p = findProg(d.id!), pe = p.days[+d.d!].exercises[+d.e!], x = pe.sets[+v];
        menu(t("setType"), ["warmup", "working", "top", "backoff", "amrap", "drop"].map(k => ({ label: t(k), on: async () => { x.type = k; if (k === "warmup") x.rir = null; else if (x.rir == null) x.rir = 2; await saveProgram(p); } }))); return; }
      case "tplNum": { const p = findProg(d.id!), pe = p.days[+d.d!].exercises[+d.e!], x = pe.sets[+v], f = d.f!, ex = exById(pe.exId);
        numSheet(f === "load" ? t("weight") : f === "repsMin" ? t("repsMin") : t("repsMax"), x[f], f === "load" ? { step: ex?.inc || 2.5, decimal: true, unit: "kg" } : { step: 1 },
          async n => { x[f] = n; if (f === "repsMin" && x.repsMax < n) x.repsMax = n; if (f === "repsMax" && x.repsMin > n) x.repsMin = n; await saveProgram(p); }); return; }
      case "tplRir": { const p = findProg(d.id!), x = p.days[+d.d!].exercises[+d.e!].sets[+v]; rirSheet("RIR", x.rir, async n => { x.rir = n; await saveProgram(p); }); return; }
      case "tplDel": { const p = findProg(d.id!), pe = p.days[+d.d!].exercises[+d.e!], i = +v; const removed = pe.sets.splice(i, 1)[0]; await saveProgram(p);
        toast(t("setDeleted"), async () => { pe.sets.splice(i, 0, removed); await saveProgram(p); }); break; }
      case "tplAdd": case "tplAddWarm": { const p = findProg(d.id!), pe = p.days[+d.d!].exercises[+d.e!]; const warm = a === "tplAddWarm";
        const src = warm ? null : [...pe.sets].reverse().find(isWork);
        const ns = warm ? { id: uid(), type: "warmup", load: null, repsMin: 8, repsMax: 8, rir: null } : { ...(src || defaultTemplates()[0]), id: uid(), type: "working" };
        if (warm) pe.sets.unshift(ns); else pe.sets.push(ns); await saveProgram(p); break; }
      case "peRest": { const p = findProg(d.id!), pe = p.days[+d.d!].exercises[+d.e!], ex = exById(pe.exId);
        numSheet(t("restSec"), pe.rest ?? ex?.rest ?? 120, { step: 15, unit: t("sec") }, async n => { pe.rest = n; await saveProgram(p); }); return; }
      case "peGroup": { const p = findProg(d.id!), pe = p.days[+d.d!].exercises[+d.e!]; pe.group = v || null; await saveProgram(p); break; }
      // library
      case "libMuscle": A.qm = v; break;
      case "openExercise": go("exercise", { id: d.id }); return;
      case "newExercise": A.form = null; go("exform", {}); return;
      case "exEdit": A.form = null; go("exform", { id: d.id }); return;
      case "exInc": { const ex = exById(d.id!); numSheet(t("increment"), ex.inc, { step: 0.5, decimal: true, unit: "kg" }, async n => { ex.inc = n; await saveExercise(ex); }); return; }
      case "exRest": { const ex = exById(d.id!); numSheet(t("restSec"), ex.rest, { step: 15, unit: t("sec") }, async n => { ex.rest = n; await saveExercise(ex); }); return; }
      case "exArchive": { const ex = exById(d.id!); ex.archived = true; await saveExercise(ex); A.nav = [{ v: "library", p: {} }]; break; }
      case "fSec": { const f = A.form; const has = f.muscles.some((m: Any) => m.m === v && m.role === "secondary");
        f.muscles = has ? f.muscles.filter((m: Any) => !(m.m === v && m.role === "secondary")) : [...f.muscles, { m: v, role: "secondary" }]; break; }
      case "fSave": { const f = A.form; if (!f.name.en && !f.name.it) { toast(t("name") + "?"); break; }
        f.name.en = f.name.en || f.name.it; f.name.it = f.name.it || f.name.en;
        if (!f.id) { f.id = "ex_c_" + uid(); f.createdAt = now(); }
        await saveExercise(f); A.form = null; back(); return; }
      case "picked": { const ctx = JSON.parse(el.dataset.ctx || "{}"); A.q = ""; await picked(ctx, d.id!); return; }
    }
  } catch (err: Any) { console.error(err); toast("Error: " + (err && err.message)); }
  render();
});

async function picked(ctx: Any, exId: string) {
  const s = activeSession();
  if (ctx.mode === "addToDay") {
    const p = findProg(ctx.id); p.days[ctx.d].exercises.push({ id: uid(), exId, group: null, optional: false, rest: null, notes: "", sets: defaultTemplates() }); await saveProgram(p); back(); return;
  }
  if (ctx.mode === "replacePe") { const p = findProg(ctx.id); p.days[ctx.d].exercises[ctx.e].exId = exId; await saveProgram(p); back(); return; }
  if (ctx.mode === "addToWorkout" && s) {
    const pe = { id: null, exId, group: null, optional: false, rest: null, notes: "", sets: defaultTemplates() };
    const se: Any = sessionExercise(pe); se.peId = null; s.exercises.push(se); s.idx = s.exercises.length - 1; await saveSession(s); back(); return;
  }
  if (ctx.mode === "substitute" && s) {
    const e = s.exercises[s.idx]; const ex = exById(exId); const lp = lastPerf(exId);
    e.exId = exId; e.name = ex.name;
    let wi = 0, ki = 0;
    e.sets.forEach((x: Any) => { const prev = lp ? (x.type === "warmup" ? lp.warm[wi++] : lp.work[ki++]) : null; x.last = prev ? { load: prev.load, reps: prev.reps, rir: prev.rir } : null; if (!x.done) { x.load = prev ? prev.load : x.load; x.edited = {}; } });
    await saveSession(s); back(); return;
  }
  back();
}

function centerStrip() { const st = document.getElementById("strip"); const on = st && st.querySelector(".on") as HTMLElement | null; if (on) on.scrollIntoView({ inline: "center", block: "nearest" }); }

/* inputs */
let inputTimer: any = null;
app.addEventListener("input", ev => {
  const el = ev.target as HTMLInputElement; const k = el.dataset?.in; if (!k) return;
  const d = el.dataset;
  if (k === "libQ") { A.q = el.value; const pos = el.selectionStart; render(); const n = app.querySelector(".search") as HTMLInputElement; if (n) { n.focus(); n.setSelectionRange(pos, pos); } return; }
  if (k === "fName") { A.form.name[d.v!] = el.value; return; }
  if (k === "fInc") { A.form.inc = parseFloat(el.value.replace(",", ".")) || 0; return; }
  if (k === "fRest") { A.form.rest = parseInt(el.value) || 0; return; }
  clearTimeout(inputTimer);
  inputTimer = setTimeout(async () => {
    if (k === "progName" || k === "progDesc") { const p = findProg(d.id!); p[k === "progName" ? "name" : "description"] = el.value; await saveProgram(p); }
    if (k === "sessionNotes") { const ss = A.sessions.find((x: Any) => x.id === d.id); ss.notes = el.value; await saveSession(ss); }
    if (k === "peNotes") { const p = findProg(d.id!); p.days[+d.d!].exercises[+d.e!].notes = el.value; await saveProgram(p); }
  }, 400);
});
app.addEventListener("change", async ev => {
  const el = ev.target as HTMLInputElement; const k = el.dataset?.in; if (!k) return; const d = el.dataset;
  if (k === "importFile" && el.files && el.files[0]) { await importFile(el.files[0]); return; }
  if (k === "fEq") { A.form.equipment = el.value; return; }
  if (k === "fLt") { A.form.loadType = el.value; return; }
  if (k === "fPrim") { A.form.muscles = [{ m: el.value, role: "primary" }, ...A.form.muscles.filter((m: Any) => m.role === "secondary" && m.m !== el.value)]; render(); return; }
  if (k === "peOptional") { const p = findProg(d.id!); p.days[+d.d!].exercises[+d.e!].optional = el.checked; await saveProgram(p); return; }
  if (k === "sessionDate" && el.value) { const ss = A.sessions.find((x: Any) => x.id === d.id); const [y, m, dd] = el.value.split("-").map(Number);
    const old = new Date(ss.startedAt); const nd = new Date(y, m - 1, dd, ss.dateUnknown ? 8 : old.getHours(), ss.dateUnknown ? 0 : old.getMinutes());
    const dur = (ss.endedAt || ss.startedAt) - ss.startedAt; ss.startedAt = nd.getTime(); ss.endedAt = ss.startedAt + dur; ss.dateUnknown = false; await saveSession(ss); render(); }
});

/* swipe between exercises */
let sx: number | null = null, sy = 0;
app.addEventListener("touchstart", e => { if (!(e.target as HTMLElement).closest("#wkbody") || A.sheet) return; sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
app.addEventListener("touchend", async e => {
  const s = activeSession(); if (sx == null || !s) return;
  const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy; sx = null;
  if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) { const j = s.idx + (dx < 0 ? 1 : -1); if (j >= 0 && j < s.exercises.length) { s.idx = j; await saveSession(s); render(); centerStrip(); } }
}, { passive: true });

/* ticking: clock + rest timer, without re-rendering the whole screen */
setInterval(() => {
  const s = activeSession(); if (!s) return;
  if (s.rest && !s.rest.buzzed && s.rest.endsAt <= now()) { s.rest.buzzed = true; haptic(); saveSession(s); }
  if (A.sheet) return;
  app.querySelectorAll("[data-clock]").forEach(n => n.textContent = (route().v === "workout" && s.pausedAt ? t("paused") + " · " : "") + clock(elapsed(s)));
  const rb = app.querySelector("[data-restbar]") as HTMLElement | null;
  if (s.rest && rb) { const l = s.rest.endsAt - now(); rb.querySelector(".t")!.textContent = l > 0 ? clock(l) : t("restDone"); rb.classList.toggle("over", l <= 0); (rb.querySelector(".bar i") as HTMLElement).style.width = Math.max(0, Math.min(1, l / (s.rest.total * 1000))) * 100 + "%"; }
  else if (route().v === "workout" && !!s.rest !== !!rb) render();
  const mr = app.querySelector("[data-rest]"); if (mr) mr.textContent = s.rest ? t("rest") + " " + restLeft(s) : "›";
}, 250);

/* service worker */
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  navigator.serviceWorker.register("./sw.js").catch(() => { /* offline support unavailable */ });
}

boot();
