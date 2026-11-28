// JimLogs app shell: state, screens, actions. Data is written to IndexedDB before the screen updates.
import * as db from "./db.js";
import { t, setLang, getLang } from "./i18n.js";
import { seedExercises, MUSCLES } from "./seed.js";
import { suggest, e1rm, volumeLoad, fmt, uid, clock, isWork, round2, fmtRange, OPEN_MARGIN } from "./domain.js";
import { setsCsv, fullText, mergeImport } from "./data.js";
import { parseAny, readXlsx, matchAll, buildProgramFromPlan, buildSessionsFromLog, parseExerciseLine, dayName } from "./importer.js";
import { CHANNEL, BUILD_VERSION } from "./channel.js";
import { pack, unpack, extractCode, toPayload, validPayload, fromPayload } from "./share.js";
import { matchExercise } from "./importer.js";
export const VERSION = BUILD_VERSION;
const isBeta = CHANNEL === "beta";
const standalone = () => (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const DAY = 86400000;
const A = {
    lib: new Map(), programs: [], sessions: [],
    settings: { lang: "en", theme: "system", lastBackupAt: null },
    nav: [{ v: "today", p: {} }],
    sheet: null, toast: null, cal: null, q: "", qm: "", persisted: null,
};
let toastTimer = null;
let wakeLock = null;
const app = document.getElementById("app");
/* ---------------- helpers ---------------- */
const now = () => Date.now();
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const L = () => getLang();
const nm = (n) => (n && (n[L()] || n.en)) || "";
const exById = (id) => A.lib.get(id);
const exName = (id) => nm(exById(id)?.name) || "?";
const route = () => A.nav[A.nav.length - 1];
const activeSession = () => A.sessions.find((s) => s.status === "in_progress");
const activeProgram = () => A.programs.find((p) => p.status === "active");
const completed = () => A.sessions.filter((s) => s.status === "completed").sort((a, b) => b.startedAt - a.startedAt);
const locale = () => (L() === "it" ? "it-IT" : "en-GB");
const dstr = (ms, o = { weekday: "short", day: "numeric", month: "short" }) => new Date(ms).toLocaleDateString(locale(), o);
const tstr = (ms) => new Date(ms).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
const sessionDate = (s) => (s.dateUnknown ? t("imported") : dstr(s.startedAt, { weekday: "short", day: "numeric", month: "short", year: "numeric" }));
const loadTxt = (ex, load) => (ex && (ex.loadType === "bodyweight" || ex.loadType === "bw_plus") ? (load ? "+" + fmt(load) : t("bw")) : fmt(load));
const numTitle = (f, ex) => f === "load" ? t("weight") : f === "mins" ? t("minutes") : f === "speed" || f === "incline" ? t("ex_" + f) : t("reps");
const numOpts = (f, ex) => f === "load" ? { step: ex?.inc || 2.5, decimal: true, unit: "kg" } : f === "mins" ? { step: 1, decimal: true, unit: "min" }
    : f === "speed" ? { step: 0.5, decimal: true, unit: "km/h" } : f === "incline" ? { step: 0.5, decimal: true, unit: "%" } : { step: 1 };
const trackOf = (exId) => exById(exId)?.track || "wr";
/** Extra per-set measures of a timed exercise: the treadmill has speed (km/h) and incline (%). */
const EXTRA_UNIT = { speed: "km/h", incline: "%" };
const extrasOf = (ex) => ((ex?.track === "time" && Array.isArray(ex.extras)) ? ex.extras : []);
const extraTxt = (ex, x) => extrasOf(ex).filter(k => x?.[k] != null).map(k => `${fmt(x[k])}${k === "incline" ? "" : " "}${EXTRA_UNIT[k]}`).join(" · ");
const timeTxt = (ex, x) => [`${fmt(x.mins)} min`, extraTxt(ex, x)].filter(Boolean).join(" · ");
/** One set as text, by the exercise's tracking type: 80×8@2 · ×100 · 12 min */
function setTxt(ex, x, withRir = false) {
    const tr = ex?.track || "wr";
    if (tr === "time")
        return timeTxt(ex, x);
    if (tr === "reps")
        return `×${x.reps}`;
    return `${loadTxt(ex, x.load)}×${x.reps}${withRir && x.rir != null ? "@" + x.rir : ""}`;
}
const elapsed = (s) => (s.pausedAt || s.endedAt || now()) - s.startedAt - (s.pausedMs || 0);
function go(v, p = {}) { A.nav.push({ v, p }); A.sheet = null; render(); scrollTop(); }
function back() { if (A.nav.length > 1)
    A.nav.pop(); A.sheet = null; render(); }
function tab(v) { A.nav = [{ v, p: {} }]; A.sheet = null; render(); scrollTop(); }
function scrollTop() { const s = app.querySelector(".scroll"); if (s)
    s.scrollTop = 0; }
function haptic() {
    try {
        if (navigator.vibrate && navigator.vibrate(10))
            return;
        const l = document.createElement("label");
        l.style.display = "none";
        const i = document.createElement("input");
        i.type = "checkbox";
        i.setAttribute("switch", "");
        l.appendChild(i);
        document.body.appendChild(l);
        l.click();
        l.remove();
    }
    catch { /* best effort */ }
}
/* ---------------- rest-over alert ----------------
   In the app: a haptic buzz (Android/Chrome vibrate; iPhone allows it only during a tap) and an optional beep (Web Audio).
   Locked phone / Apple Watch: iOS web apps stop running when the screen locks and cannot schedule notifications, so the app asks the free
   ntfy service (ntfy.sh) to deliver one at the right moment; the ntfy iPhone app shows it like any native notification, which also buzzes the Watch.
   No sound is played to keep the app alive, so music from other apps is never interrupted. */
let actx = null;
function audioSessionType(type) { try {
    const as = navigator.audioSession;
    if (as)
        as.type = type;
}
catch { } }
/** Call inside a tap: unlocks Web Audio for the beep (iOS only lets audio start from a user gesture). */
function armRestAudio() {
    if (!A.settings.restSound)
        return;
    try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC)
            return;
        audioSessionType("ambient"); // mix with music, never interrupt it
        actx = actx || new AC();
        if (actx.state !== "running")
            actx.resume();
        const b = actx.createBuffer(1, 1, 22050), src = actx.createBufferSource();
        src.buffer = b;
        src.connect(actx.destination);
        src.start(0);
    }
    catch { /* best effort */ }
}
function buzz() {
    const nav = navigator;
    if (nav.vibrate && nav.vibrate([220, 110, 220, 110, 420]))
        return;
    haptic();
    setTimeout(haptic, 160);
    setTimeout(haptic, 320);
}
function beep() {
    try {
        if (!actx)
            return;
        const c = actx;
        if (c.state !== "running")
            c.resume();
        const t0 = c.currentTime + 0.02;
        for (let i = 0; i < 3; i++) {
            const o = c.createOscillator(), g = c.createGain(), at = t0 + i * 0.28;
            o.type = "sine";
            o.frequency.value = 880;
            o.connect(g);
            g.connect(c.destination);
            g.gain.setValueAtTime(0.0001, at);
            g.gain.exponentialRampToValueAtTime(0.5, at + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0001, at + 0.2);
            o.start(at);
            o.stop(at + 0.22);
        }
    }
    catch { /* best effort */ }
}
const NTFY = "https://ntfy.sh";
const ntfyTopic = () => A.settings.ntfyTopic;
function newTopic() { const a = new Uint8Array(16); crypto.getRandomValues(a); return "jimlogs-" + Array.from(a, x => (x % 36).toString(36)).join(""); }
function ntfyPost(path, params, body) {
    const u = new URL(NTFY + path);
    for (const k in params)
        u.searchParams.set(k, params[k]);
    return fetch(u.toString(), { method: "POST", mode: "no-cors", body }).catch(() => { }); // fire and forget; a simple request needs no CORS handshake
}
const ntfyCancel = (topic) => fetch(`${NTFY}/${topic}/rest/delete`, { mode: "no-cors" }).catch(() => { });
let pushSig = "", pushEndsAt = 0;
/* JimLogs push server (Cloudflare Worker): real Web Push to this app, so the alert is a normal JimLogs notification (also on the Watch). */
const wpUrl = () => (A.settings.pushUrl || "").replace(/\/+$/, "");
const wpOn = () => !!(A.settings.restWPush && wpUrl() && A.settings.pushSub && A.settings.pushKey);
const b64uBytes = (s) => { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4)
    s += "="; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); };
async function wpCall(path, body) {
    try {
        const r = await fetch(wpUrl() + path, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ key: A.settings.pushKey, sub: A.settings.pushSub, ...body }) });
        return r.ok;
    }
    catch {
        return false;
    }
}
/** Must run inside a tap: asks for notification permission, subscribes this app to the server's push channel. */
async function wpEnable(rawUrl) {
    const url = rawUrl.trim().replace(/\/+$/, "");
    if (!/^https:\/\/[^\s/]+\.[^\s/]+/.test(url))
        return t("wpBadUrl");
    if (!("serviceWorker" in navigator) || !("PushManager" in window))
        return isIOS() && !standalone() ? t("wpInstall") : t("wpNoSupport");
    const perm = await Notification.requestPermission();
    if (perm !== "granted")
        return t("wpDenied");
    let pub;
    try {
        const r = await fetch(url + "/vapid");
        if (!r.ok)
            throw 0;
        pub = await r.text();
    }
    catch {
        return t("wpUnreachable");
    }
    try {
        const reg = await navigator.serviceWorker.ready;
        const old = await reg.pushManager.getSubscription();
        if (old)
            await old.unsubscribe();
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uBytes(pub) });
        A.settings.pushUrl = url;
        A.settings.pushSub = sub.toJSON();
        A.settings.restWPush = true;
        if (!A.settings.pushKey) {
            const r = new Uint8Array(32);
            crypto.getRandomValues(r);
            A.settings.pushKey = Array.from(r, x => x.toString(16).padStart(2, "0")).join("");
        }
        await saveSettings();
        return null;
    }
    catch {
        return t("wpFail");
    }
}
/** Keeps ONE scheduled alert in step with the running rest timer (start, +30 / −30, edit, skip). Server push first, ntfy as fallback. */
function syncRestPush(s) {
    const wp = wpOn(), topic = ntfyTopic();
    const nt = !wp && !!(A.settings.restPush && topic);
    const sig = (wp || nt) && s && s.rest && !s.rest.buzzed ? (wp ? "w" : "n") + s.rest.endsAt : "";
    if (sig === pushSig)
        return;
    const had = pushSig;
    pushSig = sig;
    const hadW = had.startsWith("w"), hadN = had.startsWith("n");
    const cancelOld = () => { if (hadW)
        wpCall("/cancel", {});
    else if (hadN && topic)
        ntfyCancel(topic); };
    if (!sig) {
        if (had && pushEndsAt - now() > 3000)
            cancelOld();
        return;
    } // cancel only if it has not been delivered yet
    if (had && (hadW !== wp))
        cancelOld();
    pushEndsAt = s.rest.endsAt;
    const secs = Math.round((s.rest.endsAt - now()) / 1000);
    const nu = nextUp(s), msg = nu ? `${t("nextUp")}: ${nu}` : t("restOverBody");
    if (wp) {
        if (secs < 1) {
            if (hadW)
                wpCall("/cancel", {});
            return;
        }
        wpCall("/schedule", { at: s.rest.endsAt, title: t("restOverTitle"), body: msg });
        return;
    }
    if (secs < 12) {
        if (hadN && topic)
            ntfyCancel(topic);
        return;
    } // ntfy's minimum delay is 10 s
    ntfyPost(`/${topic}/rest`, { delay: `${Math.max(10, secs - 4)}s`, title: t("restOverTitle"), priority: "4", tags: "muscle" }, msg);
}
async function ntfyTest() {
    const topic = ntfyTopic();
    if (!topic)
        return;
    await ntfyPost(`/${topic}`, { title: t("pushTestTitle"), priority: "4", tags: "white_check_mark" }, t("pushTestBody"));
    toast(t("pushTestSent"));
}
function restAlert(s) {
    if (!s.rest || now() - s.rest.endsAt > 10000)
        return; // opened the app long after the rest ended: stay quiet
    if (A.settings.restVibrate !== false)
        buzz();
    if (A.settings.restSound)
        beep();
}
function toast(msg, undo) {
    A.toast = { msg, undo };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { A.toast = null; render(); }, 5000);
}
/* ---------------- persistence ---------------- */
async function saveSession(s) { s.updatedAt = now(); await db.put("sessions", s); }
async function saveProgram(p) { p.updatedAt = now(); await db.put("programs", p); }
async function saveExercise(e) { e.updatedAt = now(); await db.put("exercises", e); A.lib.set(e.id, e); }
async function saveSettings() { await db.setMeta("settings", A.settings); }
async function boot() {
    try {
        let exs = await db.all("exercises");
        if (!exs.length) {
            const ex = seedExercises(now());
            await db.putMany("exercises", ex);
            exs = ex;
        }
        // library updates for existing installs: new seed exercises, new aliases, tracking type
        const have = new Map(exs.map((e) => [e.id, e]));
        const upd = [];
        for (const sd of seedExercises(now())) {
            const cur = have.get(sd.id);
            if (!cur) {
                upd.push(sd);
                exs.push(sd);
                continue;
            }
            let ch = false;
            const al = Array.from(new Set([...(cur.aliases || []), ...sd.aliases]));
            if (al.length !== (cur.aliases || []).length) {
                cur.aliases = al;
                ch = true;
            }
            if (!cur.track) {
                cur.track = sd.track;
                ch = true;
            }
            if (!cur.custom && cur.laterality !== sd.laterality) {
                cur.laterality = sd.laterality;
                ch = true;
            }
            if (sd.extras && !cur.extras) {
                cur.extras = sd.extras;
                ch = true;
            }
            if (ch)
                upd.push(cur);
        }
        // your own exercises named like a built-in cardio / timed one (e.g. "Rope jumping") take its tracking
        const key = (x) => (x || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
        const seedByName = new Map();
        for (const sd of seedExercises(0))
            if (sd.track !== "wr")
                for (const n of [sd.name.en, sd.name.it, ...sd.aliases])
                    seedByName.set(key(n), sd);
        for (const e of exs)
            if (e.custom && !e.track) {
                const sd = seedByName.get(key(e.name.en)) || seedByName.get(key(e.name.it));
                if (sd) {
                    e.track = sd.track;
                    e.loadType = "bodyweight";
                    e.inc = 0;
                    if (sd.mechanic === "cardio") {
                        e.mechanic = "cardio";
                        e.pattern = "cardio";
                        if (!e.muscles.length)
                            e.muscles = [{ m: "cardio", role: "primary" }];
                    }
                    upd.push(e);
                }
            }
        for (const e of exs)
            if (!e.track) {
                e.track = "wr";
                upd.push(e);
            }
        if (upd.length)
            await db.putMany("exercises", upd);
        exs.forEach((e) => A.lib.set(e.id, e));
        A.programs = await db.all("programs");
        A.sessions = await db.all("sessions");
        await migrateData();
        for (const ss of A.sessions)
            if (ss.status === "in_progress" && fillMissingLast(ss))
                await saveSession(ss);
        A.settings = { ...A.settings, ...(await db.getMeta("settings", {})) };
        if (!(await db.getMeta("settings", null))) {
            A.settings.lang = (navigator.language || "").toLowerCase().startsWith("it") ? "it" : "en";
            await saveSettings();
        }
        setLang(A.settings.lang);
        try {
            A.persisted = navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : null;
        }
        catch {
            A.persisted = null;
        }
        if (!A.settings.tourDone && !A.programs.some((p) => p.status !== "deleted") && !A.sessions.length)
            A.tour = { i: 0 };
        render();
        await openShareFromHash();
    }
    catch (err) {
        app.innerHTML = `<div class="scroll"><h1>Storage error</h1><p class="sub">${esc(err && err.message)}</p></div>`;
    }
}
/** v0.7 data fixes, idempotent: AMRAP "Max/8" → 8+ to failure; "Piramidale" note → pyramid scheme;
 *  OCR'd day names ("Ese 5abato …"); custom exercises that now exist in the library are merged into it. */
async function migrateData() {
    const touchedP = new Set(), touchedS = new Set(), touchedE = [];
    for (const p of A.programs)
        for (const d of p.days) {
            if (/(^|\s)[05][a-zà-ù]{3,}/i.test(d.name.en || "")) {
                const n = dayName(d.name.en);
                d.name = { en: n, it: n };
                touchedP.add(p);
            }
            for (const pe of d.exercises) {
                for (const st of pe.sets)
                    if (st.type === "amrap" && st.repsMax != null && st.repsMax === st.repsMin) {
                        st.repsMax = null;
                        if (st.rir === 2)
                            st.rir = 0;
                        touchedP.add(p);
                    }
                if (/Piramidale \/ pyramid/.test(pe.notes || "")) {
                    pe.scheme = "pyr_asc";
                    pe.notes = pe.notes.replace(/\s*·?\s*Piramidale \/ pyramid/, "").trim();
                    touchedP.add(p);
                }
            }
        }
    const key = (x) => (x || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
    const seeds = [...A.lib.values()].filter((e) => !e.custom && !e.archived);
    const byName = new Map();
    for (const sd of seeds)
        for (const n of [sd.name.en, sd.name.it, ...(sd.aliases || [])])
            if (!byName.has(key(n)))
                byName.set(key(n), sd);
    for (const c of [...A.lib.values()]) {
        if (!c.custom || c.archived)
            continue;
        const sd = byName.get(key(c.name.en)) || byName.get(key(c.name.it));
        if (!sd)
            continue;
        for (const p of A.programs)
            for (const d of p.days)
                for (const pe of d.exercises)
                    if (pe.exId === c.id) {
                        pe.exId = sd.id;
                        touchedP.add(p);
                    }
        for (const s of A.sessions)
            for (const e of s.exercises) {
                if (e.exId === c.id) {
                    e.exId = sd.id;
                    e.name = sd.name;
                    touchedS.add(s);
                }
                if (e.plannedExId === c.id) {
                    e.plannedExId = sd.id;
                    touchedS.add(s);
                }
            }
        c.archived = true;
        c.mergedInto = sd.id;
        c.updatedAt = now();
        touchedE.push(c);
    }
    for (const p of touchedP) {
        p.updatedAt = now();
        await db.put("programs", p);
    }
    for (const s of touchedS) {
        s.updatedAt = now();
        await db.put("sessions", s);
    }
    if (touchedE.length)
        await db.putMany("exercises", touchedE);
}
/* ---------------- previous performance & session building ---------------- */
function lastPerf(exId, excludeId) {
    for (const s of completed()) {
        if (s.id === excludeId)
            continue;
        const e = s.exercises.find((x) => x.exId === exId && !x.skipped && x.sets.some((y) => y.done));
        if (e) {
            const done = e.sets.filter((y) => y.done);
            return { session: s, warm: done.filter((y) => y.type === "warmup"), work: done.filter((y) => y.type !== "warmup") };
        }
    }
    return null;
}
function buildSets(tpls, exId) {
    const lp = lastPerf(exId);
    let wi = 0, ki = 0;
    return tpls.map((tp) => {
        const warm = tp.type === "warmup";
        const pool = lp ? (warm ? lp.warm : lp.work) : [];
        const pi = warm ? wi++ : ki++;
        const prev = pool[pi] ?? pool[pool.length - 1] ?? null; // extra sets reuse the previous final set instead of showing "—"
        const carry = !!prev && !pool[pi];
        const load = tp.load ?? prev?.load ?? 0;
        const reps = prev && prev.load === load ? Math.max(prev.reps, tp.repsMin) : tp.repsMin;
        const tr = trackOf(exId);
        const mins = tr === "time" ? (tp.mins ?? prev?.mins ?? 10) : null;
        const xs = {};
        if (tr === "time")
            for (const k of extrasOf(exById(exId)))
                xs[k] = tp[k] ?? prev?.[k] ?? null;
        return {
            id: uid(), type: tp.type, load: tr === "wr" ? load : 0, reps: tr === "time" ? 0 : reps, mins, ...xs, rir: warm || tr !== "wr" ? null : tp.rir, rpe: null, done: false, doneAt: null, edited: {},
            last: prev ? { load: prev.load, reps: prev.reps, rir: prev.rir, mins: prev.mins ?? null, speed: prev.speed ?? null, incline: prev.incline ?? null, ...(carry ? { carry: true } : {}) } : null,
            t: { repsMin: tp.repsMin, repsMax: tp.repsMax, rir: tr === "wr" ? tp.rir : null, load: tp.load, mins: tp.mins ?? null, speed: tp.speed ?? null, incline: tp.incline ?? null },
        };
    });
}
function sessionExercise(pe) {
    const ex = exById(pe.exId);
    return {
        id: uid(), peId: pe.id, exId: pe.exId, plannedExId: pe.exId, name: ex.name, group: pe.group || null, optional: !!pe.optional,
        rest: pe.rest ?? null, notes: pe.notes || "", scheme: pe.scheme || "straight", skipped: false, sets: buildSets(pe.sets, pe.exId),
    };
}
const defaultTemplates = (track = "wr") => [0, 1, 2].map(() => track === "time" ? { id: uid(), type: "working", load: null, repsMin: 0, repsMax: 0, rir: null, mins: 10 }
    : track === "reps" ? { id: uid(), type: "working", load: null, repsMin: 10, repsMax: 15, rir: null } : { id: uid(), type: "working", load: null, repsMin: 8, repsMax: 12, rir: 2 });
async function startWorkout(program, dayIdx) {
    if (activeSession()) {
        go("workout");
        return;
    }
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
function fillMissingLast(s) {
    let ch = false;
    for (const e of s.exercises) {
        const lp = lastPerf(e.exId, s.id);
        if (!lp)
            continue;
        e.sets.forEach((x) => {
            if (x.last || x.done)
                return;
            const pool = x.type === "warmup" ? lp.warm : lp.work;
            const prev = pool[pool.length - 1];
            if (!prev)
                return;
            x.last = { load: prev.load, reps: prev.reps, rir: prev.rir, mins: prev.mins ?? null, speed: prev.speed ?? null, incline: prev.incline ?? null, carry: true };
            ch = true;
        });
    }
    return ch;
}
/* ---------------- editing the plan from inside a workout ---------------- */
const planOf = (e) => { if (!e.peId)
    return null; for (const p of A.programs)
    for (const d of p.days) {
        const pe = d.exercises.find((q) => q.id === e.peId);
        if (pe)
            return { p, d, pe };
    } return null; };
const planDay = (s) => { const p = A.programs.find((q) => q.id === s.programId); const d = p?.days.find((q) => q.id === s.dayId); return p && d ? { p, d } : null; };
async function setGroup(s, members, g) {
    const touched = new Set();
    for (const m of members) {
        m.group = g;
        const r = planOf(m);
        if (r) {
            r.pe.group = g;
            touched.add(r.p);
        }
    }
    for (const p of touched)
        await saveProgram(p);
    await saveSession(s);
}
async function syncOrderToPlan(s) {
    const pd = planDay(s);
    if (!pd)
        return;
    const ids = s.exercises.map((x) => x.peId).filter(Boolean);
    const slots = pd.d.exercises.map((pe, i) => (ids.includes(pe.id) ? i : -1)).filter((i) => i >= 0);
    const ordered = ids.map((id) => pd.d.exercises.find((pe) => pe.id === id)).filter(Boolean);
    if (ordered.length !== slots.length)
        return;
    slots.forEach((slot, k) => { pd.d.exercises[slot] = ordered[k]; });
    await saveProgram(pd.p);
}
function templatesFromSets(e, old) {
    return e.sets.map((x, i) => old[i] ? { ...old[i], type: x.type } : {
        id: uid(), type: x.type, load: null, repsMin: x.t?.repsMin ?? x.reps ?? 8, repsMax: x.t?.repsMax ?? x.reps ?? 12, rir: x.t?.rir ?? null, ...(x.mins != null ? { mins: x.mins } : {}), ...(x.speed != null ? { speed: x.speed } : {}), ...(x.incline != null ? { incline: x.incline } : {})
    });
}
/** Take an exercise out of the running workout only; the plan is left alone. Undo puts it back. */
function removeFromWorkout(s, e) {
    const logged = e.sets.filter((x) => x.done).length;
    confirmSheet(t("rwTitle"), logged ? t("rwBodyLogged", { x: nm(e.name), n: logged }) : t("rwBody", { x: nm(e.name) }), t("delete"), true, async () => {
        const idx = s.exercises.indexOf(e);
        if (idx < 0)
            return;
        s.exercises.splice(idx, 1);
        const lone = e.group ? s.exercises.filter((x) => x.group === e.group) : [];
        const loneOld = lone.length === 1 ? lone[0].group : null;
        if (lone.length === 1)
            lone[0].group = null; // a superset of one is no superset (this workout only)
        const oldIdx = s.idx;
        s.idx = Math.max(0, Math.min(idx, s.exercises.length - 1));
        await saveSession(s);
        toast(t("rwDone"), async () => { s.exercises.splice(idx, 0, e); if (loneOld)
            lone[0].group = loneOld; s.idx = oldIdx; await saveSession(s); render(); });
    });
}
function planMenu(s) {
    const e = s.exercises[s.idx];
    const r = planOf(e);
    const nxt = s.exercises[s.idx + 1];
    const members = e.group ? s.exercises.filter((x) => x.group === e.group) : [];
    const items = [];
    if (e.group) {
        items.push({ label: t("pmUngroupAll", { g: e.group }), on: async () => { await setGroup(s, members, null); toast(t("pmDone")); } });
        if (members.length > 2)
            items.push({ label: t("pmLeave", { g: e.group }), on: async () => { await setGroup(s, [e], null); toast(t("pmDone")); } });
    }
    else if (nxt) {
        items.push({ label: t("pmMakeSuper", { x: nm(nxt.name) }), on: async () => {
                const used = new Set(s.exercises.map((x) => x.group).filter(Boolean));
                const g = nxt.group || "ABCDEFGH".split("").find(c => !used.has(c)) || "A";
                await setGroup(s, [e, nxt], g);
                toast(t("pmDone"));
            } });
    }
    items.push({ label: e.optional ? t("pmNotOptional") : t("pmOptional"), on: async () => { e.optional = !e.optional; if (r) {
            r.pe.optional = e.optional;
            await saveProgram(r.p);
        } await saveSession(s); toast(t("pmDone")); } });
    if (r)
        items.push({ label: t("pmSaveSets"), on: async () => { r.pe.sets = templatesFromSets(e, r.pe.sets); await saveProgram(r.p); toast(t("pmDone")); } });
    else if (planDay(s))
        items.push({ label: t("pmAddToPlan"), on: async () => {
                const pd = planDay(s);
                const pe = { id: uid(), exId: e.exId, group: e.group || null, optional: !!e.optional, rest: e.rest ?? null, notes: e.notes || "", scheme: e.scheme || "straight", sets: templatesFromSets(e, []) };
                pd.d.exercises.push(pe);
                await saveProgram(pd.p);
                e.peId = pe.id;
                await saveSession(s);
                toast(t("pmDone"));
            } });
    if (r) {
        items.push({ label: t("pmRemovePlan"), danger: true, on: () => confirmSheet(t("pmRemovePlan"), t("pmRemovePlanQ", { x: nm(e.name) }), t("delete"), true, async () => {
                r.d.exercises.splice(r.d.exercises.indexOf(r.pe), 1);
                await saveProgram(r.p);
                e.peId = null;
                await saveSession(s);
                toast(t("pmDone"));
            }) });
    }
    if (r && !e.sets.some((x) => x.done))
        items.push({ label: t("pmRemoveBoth"), danger: true, on: () => confirmSheet(t("pmRemoveBoth"), t("pmRemoveBothQ", { x: nm(e.name) }), t("delete"), true, async () => {
                if (r) {
                    r.d.exercises.splice(r.d.exercises.indexOf(r.pe), 1);
                    await saveProgram(r.p);
                }
                const idx = s.exercises.indexOf(e);
                s.exercises.splice(idx, 1);
                if (e.group) {
                    const left = s.exercises.filter((x) => x.group === e.group);
                    if (left.length === 1)
                        await setGroup(s, left, null);
                }
                s.idx = Math.min(s.idx, Math.max(0, s.exercises.length - 1));
                await saveSession(s);
                toast(t("pmDone"));
            }) });
    menu(t("pmTitle"), items);
}
/* ---------------- wake lock ---------------- */
async function requestWake() {
    try {
        if ("wakeLock" in navigator && activeSession() && route().v === "workout")
            wakeLock = await navigator.wakeLock.request("screen");
    }
    catch { /* unsupported */ }
}
function releaseWake() { try {
    wakeLock && wakeLock.release();
}
catch { } wakeLock = null; }
document.addEventListener("visibilitychange", () => { if (!document.hidden) {
    render();
    requestWake();
} });
/* ---------------- icons ---------------- */
const I = {
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
    grip: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" width="22" height="22"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>',
    list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true" width="20" height="20"><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true" width="20" height="20"><path d="M12 5v14M5 12h14"/></svg>',
};
/** Row you can swipe left for actions. One Delete action: a full swipe deletes. lp = long-press menu ("program:id"). */
function swipeRow(inner, acts, lp = "") {
    const list = typeof acts === "string" ? [{ label: t("delete"), attrs: acts, cls: "del swipe-del" }] : acts;
    const full = typeof acts === "string";
    return `<div class="swipe" data-w="${list.length * 84}" ${full ? 'data-full="1"' : ""}><div class="swipe-acts">${list.map(a => `<button class="swipe-act ${a.cls || ""}" ${a.attrs}>${a.label}</button>`).join("")}</div><div class="swipe-in" ${lp ? `data-lp="${lp}"` : ""}>${inner}</div></div>`;
}
const header = (title, right = "") => `<header class="hdr"><button class="iconbtn" data-a="back" aria-label="${t("back")}">${I.back}</button><div class="hdr-t">${esc(title)}</div><div class="hdr-r">${right}</div></header>`;
/* ---------------- theme ---------------- */
const ACCENTS = ["orange", "blue", "teal", "purple", "pink", "yellow", "mono"];
const darkMq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
function applyTheme() {
    const pref = A.settings.theme || "system";
    const resolved = pref === "system" ? (darkMq && darkMq.matches ? "dark" : "light") : pref;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.accent = A.settings.accent || "orange";
    document.documentElement.dataset.cb = A.settings.cbSafe ? "1" : "0";
    document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.setAttribute("content", resolved === "dark" ? "#0f1012" : "#f4f4f2"));
}
if (darkMq) {
    const onChange = () => { if ((A.settings.theme || "system") === "system")
        render(); };
    darkMq.addEventListener ? darkMq.addEventListener("change", onChange) : darkMq.addListener(onChange);
}
const backupDue = () => {
    const lb = A.settings.lastBackupAt;
    const real = completed().filter((x) => !x.imported);
    return real.length > 0 && (!lb || (now() - lb > 7 * DAY && real.some((x) => (x.endedAt || 0) > lb)));
};
/* ---------------- render ---------------- */
function render() {
    applyTheme();
    document.documentElement.lang = L();
    const r = route();
    let h = "";
    const s = activeSession();
    if (r.v === "workout" && s)
        h = vWorkout(s);
    else {
        const views = {
            today: vToday, history: vHistory, session: vSession, summary: vSummary, programs: vPrograms, program: vProgram, day: vDay, pe: vPe,
            library: vLibrary, exercise: vExercise, exform: vExForm, pick: vPick, more: vMore, import: vImport, feedback: vFeedback, shared: vShared,
        };
        const fn = views[r.v] || vToday;
        const top = ["today", "history", "programs", "library", "more"];
        const tabV = top.includes(A.nav[0].v) ? A.nav[0].v : "today";
        const mini = s ? `<button class="minibar num" data-a="openWorkout"><span>${esc(nm(s.dayName))} · <span data-clock>${clock(elapsed(s))}</span></span><span data-rest>${s.rest ? t("rest") + " " + restLeft(s) : "›"}</span></button>` : "";
        const due = backupDue();
        const tabs = top.map(k => `<button data-a="tab" data-v="${k}" ${k === tabV ? 'aria-current="page"' : ""}>${I[k]}<span>${t(k)}</span>${k === "more" && due ? `<i class="badge-dot" aria-label="${t("backupShort")}"></i>` : ""}</button>`).join("");
        h = `<div class="view">${fn(r.p)}</div>${mini}<nav class="tabbar">${tabs}</nav>`;
    }
    if (A.sheet)
        h += vSheet();
    if (A.tour)
        h += vTour();
    if (A.toast)
        h += `<div class="toast" role="status"><span>${esc(A.toast.msg)}</span>${A.toast.undo ? `<button data-a="undo">${t("undo")}</button>` : ""}</div>`;
    const scroll = app.querySelector(".scroll");
    const st = scroll ? scroll.scrollTop : 0;
    const sameView = app._view === r.v + JSON.stringify(r.p);
    app.innerHTML = h;
    app._view = r.v + JSON.stringify(r.p);
    if (sameView) {
        const n = app.querySelector(".scroll");
        if (n)
            n.scrollTop = st;
    }
    if (A.tour)
        requestAnimationFrame(placeTour);
}
/* ---------------- Today ---------------- */
function vToday() {
    const s = activeSession();
    const p = activeProgram();
    let h = `<div class="scroll">`;
    if (s) {
        h += `<div class="bar-card hot"><div class="flex1"><b>${t("inProgress")}</b><span class="sub small block">${esc(nm(s.dayName))} · ${t("startedAt", { t: tstr(s.startedAt) })} · <span data-clock>${clock(elapsed(s))}</span></span></div>
      <button class="btn primary small" data-a="openWorkout">${t("resume")}</button><button class="iconbtn" data-a="resumeMenu" aria-label="${t("more")}">${I.dots}</button></div>`;
    }
    const pend = completed().slice(0, 3).find((x) => (x.suggestions || []).some((g) => g.status === "pending"));
    if (pend) {
        const n = pend.suggestions.filter((g) => g.status === "pending").length;
        h += `<button class="card rowbtn" data-a="openSummary" data-id="${pend.id}"><span>${t("suggWaiting", { n })}</span><span class="accent">${t("review")} ${I.chev}</span></button>`;
    }
    if (!p)
        return h + `<h1>${t("welcome")}</h1><p class="sub">${t("welcomeBody")}</p>
    <label class="btn primary block mt16 filebtn">${t("importJson")}<input type="file" accept=".json,.csv,.tsv,.txt,.md,.xlsx,image/*,text/*,application/json" data-in="impFile" hidden></label>
    <button class="btn ghost block mt8" data-a="newProgram">+ ${t("newProgram")}</button>
    <button class="btn ghost block mt8" data-a="startEmpty">${t("emptyWorkout")}</button>
    <p class="sub mt16">${t("installHint")}</p></div>`;
    const di = Math.min(p.nextDay || 0, p.days.length - 1);
    const day = p.days[di];
    if (!day)
        return h + `<h1>${esc(p.name)}</h1><p class="sub">${t("noProgram")}</p></div>`;
    const nSets = day.exercises.reduce((a, e) => a + e.sets.filter(isWork).length, 0);
    h += `<div class="sub">${isBeta ? `<span class="pill betapill">BETA</span> ` : ""}${t("next")} · ${t("dayOf", { a: di + 1, b: p.days.length })}</div><h1>${esc(nm(day.name))}</h1>
    <div class="sub">${day.exercises.length} ${t("exercises")} · ${nSets} ${t("workSets").toLowerCase()}</div>`;
    if (!s)
        h += `<button class="btn primary block mt16" data-a="start" data-v="${di}">${t("start")}</button>
    <div class="row mt8"><button class="btn ghost flex1" data-a="changeDay">${t("changeDay")}</button><button class="btn ghost flex1" data-a="startEmpty">${t("emptyWorkout")}</button></div>`;
    h += `<h2>${t("lastTime")}</h2><div class="card">` + day.exercises.map((pe) => {
        const lp = lastPerf(pe.exId);
        const ex = exById(pe.exId);
        // no ticked sets in History yet → show the plan instead of a dash
        const plan = pe.sets.filter(isWork).map((tp) => (ex?.track || "wr") === "time" ? timeTxt(ex, { ...tp, mins: tp.mins ?? 0 })
            : `${tp.load != null && (ex?.track || "wr") === "wr" ? loadTxt(ex, tp.load) + "×" : "×"}${fmtRange(tp.repsMin, tp.repsMax)}`).join(" · ");
        const txt = lp ? lp.work.map((y) => setTxt(ex, y)).join(" · ") : plan ? `<span class="faint">${t("planLbl")}: ${plan}</span>` : "—";
        return `<div class="li"><span>${esc(exName(pe.exId))}${pe.optional ? ` <span class="faint">(${t("optional")})</span>` : ""}${pe.group ? ` <span class="pill">${esc(pe.group)}</span>` : ""}</span><span class="muted num small r">${txt}</span></div>`;
    }).join("") + `</div></div>`;
    return h;
}
/* ---------------- Workout ---------------- */
function restLeft(s) { const l = s.rest.endsAt - now(); return l > 0 ? clock(l) : "+" + clock(-l); }
function badge(e, i) {
    const s = e.sets[i];
    if (s.type === "warmup")
        return `<span class="badge w">W</span>`;
    const n = e.sets.slice(0, i + 1).filter(isWork).length;
    const tag = s.type === "top" ? "T" : s.type === "backoff" ? "B" : s.type === "amrap" ? "A" : s.type === "drop" ? "D" : String(n);
    return `<span class="badge ${s.type === "top" ? "acc" : ""}">${tag}</span>`;
}
/** What comes after the current rest: next unticked set here, else the next exercise's. */
function nextUp(s) {
    for (let k = s.idx; k < s.exercises.length; k++) {
        const e = s.exercises[k];
        if (e.skipped)
            continue;
        const i = e.sets.findIndex((x) => !x.done);
        if (i < 0)
            continue;
        const x = e.sets[i], ex = exById(e.exId);
        const no = x.type === "warmup" ? "W" : e.sets.slice(0, i + 1).filter(isWork).length;
        const what = (ex?.track || "wr") === "wr" ? `${loadTxt(ex, x.load)} kg × ${x.reps}` : setTxt(ex, x);
        return `${k === s.idx ? "" : esc(nm(e.name)) + " · "}${t("set")} ${no} · ${what}`;
    }
    return null;
}
function vWorkout(s) {
    if (s.idx >= s.exercises.length)
        s.idx = Math.max(0, s.exercises.length - 1);
    const e = s.exercises[s.idx];
    const strip = s.exercises.map((x, i) => {
        const fin = x.sets.length && x.sets.every((y) => y.done);
        const dn = x.sets.filter((y) => y.done).length;
        return `<button class="${i === s.idx ? "on" : ""} ${fin ? "fin" : ""} ${x.skipped ? "skip" : ""}" data-a="goto" data-v="${i}">${x.group ? esc(x.group) + " · " : ""}${esc(nm(x.name))} <span class="prog num">${dn}/${x.sets.length}</span></button>`;
    }).join("") + `<button data-a="addToWorkout" aria-label="${t("addExercise")}">+</button>`;
    const head = `<div class="wk-head"><div class="wk-top">
    <div class="row g6"><button class="btn ghost small" data-a="tab" data-v="today" aria-label="${t("minimise")}">${I.down}</button><button class="btn ghost small" data-a="wkList" aria-label="${t("reorder")}">${I.list}</button></div>
    <div class="c"><div class="wk-title">${esc(nm(s.dayName))}</div><div class="wk-clock num" data-clock>${s.pausedAt ? t("paused") + " · " : ""}${clock(elapsed(s))}</div></div>
    <div class="row g6"><button class="btn ghost small" data-a="pause">${s.pausedAt ? t("resumeBtn") : t("pause")}</button><button class="btn primary small" data-a="askFinish">${t("finish")}</button></div>
  </div><div class="strip" id="strip">${strip}</div></div>`;
    if (!e)
        return `<div class="wk">${head}<div class="wk-body"><button class="btn primary block" data-a="addToWorkout">${t("addExercise")}</button></div></div>`;
    const ex = exById(e.exId);
    const rest = e.rest ?? ex?.rest ?? 120;
    const sets = e.sets.map((x, i) => {
        const g = (f) => (!x.done && !x.edited?.[f] ? "ghost" : "");
        const tr = ex?.track || "wr";
        const last = x.last ? (x.last.carry ? '<span class="carry" title="' + esc(t("lastCarry")) + '">' : "<span>") + (tr === "wr" ? `<b>${loadTxt(ex, x.last.load)}×${x.last.reps}</b>${x.last.rir != null ? " @" + x.last.rir : ""}` : tr === "time" && extrasOf(ex).length ? `<b>${fmt(x.last.mins)} min</b><br><small>${esc(extraTxt(ex, x.last))}</small>` : `<b>${setTxt(ex, x.last)}</b>`) + "</span>" : "—";
        const xt = extrasOf(ex);
        const cells = tr === "time" && xt.length
            ? `<button class="cell num ${g("mins")}" data-a="wNum" data-f="mins" data-v="${i}" aria-label="${t("minutes")}">${fmt(x.mins)}</button>` + xt.map(k => `<button class="cell num ${g(k)}" data-a="wNum" data-f="${k}" data-v="${i}" aria-label="${t("ex_" + k)}">${x[k] == null ? "–" : fmt(x[k])}</button>`).join("") + (xt.length < 2 ? "<span></span>" : "")
            : tr === "time"
                ? `<button class="cell num span3 ${g("mins")}" data-a="wNum" data-f="mins" data-v="${i}" aria-label="${t("minutes")}">${fmt(x.mins)} <span class="unit">min</span></button>`
                : tr === "reps"
                    ? `<button class="cell num span3 ${g("reps")}" data-a="wNum" data-f="reps" data-v="${i}" aria-label="${t("reps")}">${x.reps} <span class="unit">${t("reps").toLowerCase()}</span></button>`
                    : `<button class="cell num ${g("load")}" data-a="wNum" data-f="load" data-v="${i}" aria-label="${t("weight")}">${loadTxt(ex, x.load)}</button>
      <button class="cell num ${g("reps")}" data-a="wNum" data-f="reps" data-v="${i}" aria-label="${t("reps")}">${x.reps}</button>
      <button class="cell num ${g("rir")}" data-a="wRir" data-v="${i}" aria-label="RIR">${x.rir == null ? "–" : x.rir}</button>`;
        const tgt = !isWork(x) || !x.t ? "" : tr === "time" ? (x.t.mins != null ? timeTxt(ex, x.t) : "")
            : `${fmtRange(x.t.repsMin, x.t.repsMax)}${tr === "wr" && x.t.rir != null ? " @ RIR " + x.t.rir : ""}`;
        return `<div class="set ${x.done ? "done" : ""}">
      <button data-a="setMenu" data-v="${i}" aria-label="${t("set")} ${i + 1}">${badge(e, i)}</button>
      <div class="last num">${last}</div>
      ${cells}
      <button class="check" data-a="check" data-v="${i}" aria-label="${t("done")}" aria-pressed="${!!x.done}">${I.check}</button>
      ${tgt ? `<div class="target num">${t("target")}: ${tgt}</div>` : ""}
    </div>`;
    }).join("");
    const partner = e.group ? s.exercises.filter((x) => x.group === e.group && x !== e).map((x) => esc(nm(x.name))).join(", ") : "";
    const body = `<div class="wk-body scroll" id="wkbody">
    <div class="row spread top"><h2 class="ex-name">${esc(nm(e.name))}</h2><button class="iconbtn" data-a="exMenu" aria-label="${t("edit")}">${I.dots}</button></div>
    <div class="ex-meta"><span class="pill">${t("eq_" + (ex?.equipment || "other"))}</span>${ex?.laterality === "unilateral" ? `<span class="pill">${t("unilateral")} · ${t("perSide")}</span>` : ""}<button class="pill num pillbtn" data-a="restEdit">${t("restOn")} ${rest}${t("sec")} ✎</button>${(ex?.track || "wr") === "wr" ? `<span class="pill num">+${fmt(ex?.inc)} kg</span>` : ""}
      ${e.scheme && e.scheme !== "straight" ? `<span class="pill accent">${t("sch_" + e.scheme + "_s")}</span>` : ""}${e.optional ? `<span class="pill">${t("optional")}</span>` : ""}${e.skipped ? `<span class="pill warn">${t("skip")}</span>` : ""}${partner ? `<span class="pill accent">${t("superset")} ${esc(e.group)}: ${partner}</span>` : ""}</div>
    ${e.exId !== e.plannedExId ? `<div class="note">↺ ${t("replaces", { x: esc(exName(e.plannedExId)) })}</div>` : ""}
    ${e.notes ? `<div class="note">${esc(e.notes)}</div>` : ""}
    <button class="notebtn" data-a="wNotes">✎ ${s.notes || e.notes ? t("wnEdit") : t("wnAdd")}${s.notes ? ` <i class="dotmark" aria-hidden="true"></i>` : ""}</button>
    <div class="sets-head"><span>${t("set")}</span><span>${t("last")}</span>${(ex?.track || "wr") === "wr" ? `<span class="c">${t("kg")}</span><span class="c">${t("reps")}</span><span class="c">${t("rir")}</span>` : (ex?.track) === "time" && extrasOf(ex).length ? `<span class="c">${t("min")}</span>${extrasOf(ex).map(k => `<span class="c">${t("ex_" + k + "_h")}</span>`).join("")}${extrasOf(ex).length < 2 ? "<span></span>" : ""}` : `<span class="c span3">${(ex?.track) === "time" ? t("minutes") : t("reps")}</span>`}<span></span></div>
    ${sets}
    <div class="row mt4"><button class="addset flex1" data-a="wAddSet">+ ${t("addSet")}</button><button class="addset" style="flex:0 0 auto;padding:0 14px" data-a="wAddWarm">+ W</button></div>
  </div>`;
    let restH = "";
    if (s.rest) {
        const l = s.rest.endsAt - now(), p = Math.max(0, Math.min(1, l / (s.rest.total * 1000)));
        restH = `<div class="rest ${l <= 0 ? "over" : ""}" data-restbar><button class="t num" data-a="restEdit" aria-live="polite" aria-label="${t("editRest")}">${l > 0 ? clock(l) : t("restDone")}</button><span class="bar"><i style="width:${p * 100}%"></i></span>
      <button class="btn ghost small num" data-a="restMinus">−30</button><button class="btn ghost small num" data-a="rest30">+30</button><button class="btn ghost small" data-a="restSkip">${t("skip")}</button></div>`;
        const nu = nextUp(s);
        if (nu)
            restH += `<div class="next-up small num">${t("nextUp")}: ${nu}</div>`;
    }
    const lastIdx = s.idx === s.exercises.length - 1;
    const curDone = e.skipped || (e.sets.length > 0 && e.sets.every((y) => y.done));
    const nxt = s.exercises[s.idx + 1];
    const foot = `<div class="wk-foot">${restH}<div class="row g8">
    <button class="btn ghost prevbtn" data-a="goto" data-v="${s.idx - 1}" ${s.idx === 0 ? "disabled" : ""} aria-label="${t("prev")}">‹</button>
    <button class="btn ${lastIdx || curDone ? "primary" : "ghost"} flex1 nextbtn" data-a="${lastIdx ? "askFinish" : "goto"}" data-v="${s.idx + 1}">${lastIdx ? t("finish") : `<span class="ell">${t("nextEx")}: ${esc(nm(nxt.name))}</span> ›`}</button></div></div>`;
    return `<div class="wk">${head}${body}${foot}</div>`;
}
async function toggleSet(s, i) {
    const e = s.exercises[s.idx];
    const x = e.sets[i];
    x.done = !x.done;
    x.doneAt = x.done ? now() : null;
    if (x.done) {
        haptic();
        const ex = exById(e.exId);
        const restSec = x.type === "warmup" ? 60 : (e.rest ?? ex?.rest ?? 120);
        // supersets: hop to the partner, rest after the last exercise of the group
        const grp = e.group ? s.exercises.map((y, j) => ({ y, j })).filter((o) => o.y.group === e.group && !o.y.skipped) : [];
        if (grp.length > 1) {
            const pos = grp.findIndex((o) => o.j === s.idx);
            const nxt = grp[pos + 1];
            if (nxt && nxt.y.sets.some((z) => !z.done)) {
                s.idx = nxt.j;
                s.rest = null;
            }
            else {
                s.rest = { startAt: now(), endsAt: now() + restSec * 1000, total: restSec, buzzed: false };
                const first = grp.find((o) => o.y.sets.some((z) => !z.done));
                if (first)
                    s.idx = first.j;
            }
        }
        else
            s.rest = { startAt: now(), endsAt: now() + restSec * 1000, total: restSec, buzzed: false };
    }
    await saveSession(s);
}
async function finishSession(s) {
    if (s.pausedAt) {
        s.pausedMs += now() - s.pausedAt;
        s.pausedAt = null;
    }
    s.status = "completed";
    s.endedAt = now();
    s.rest = null;
    s.suggestions = s.exercises.filter((e) => !e.skipped && e.peId && trackOf(e.exId) === "wr").map((e) => {
        const ex = exById(e.exId);
        const g = suggest(e.sets, ex?.inc ?? 2.5);
        return g ? { peId: e.peId, exId: e.exId, substituted: e.exId !== e.plannedExId, ...g, status: "pending" } : null;
    }).filter(Boolean);
    await saveSession(s);
    const p = A.programs.find((x) => x.id === s.programId);
    if (p) {
        const di = p.days.findIndex((d) => d.id === s.dayId);
        if (di >= 0) {
            p.nextDay = (di + 1) % p.days.length;
            await saveProgram(p);
        }
    }
    releaseWake();
    A.nav = [{ v: "today", p: {} }, { v: "summary", p: { id: s.id } }];
}
/* ---------------- Summary & suggestions ---------------- */
function why(g) {
    if (g.kind === "up") {
        let w = t("whyUp", { n: g.adj.length, adj: g.adj.map(fmt).join(", "), inc: fmt(g.inc) });
        if (g.predicted != null)
            w += t("whyPred", { w: fmt(Math.max(...g.loads)), p: Math.floor(g.predicted), r: g.predRir ?? 0 });
        if (g.unknownEffort)
            w += t("whyUnknown");
        if (g.openEnded)
            w += t("whyOpen", { n: OPEN_MARGIN });
        return w;
    }
    if (g.kind === "reps" && g.topNoLoad)
        return t("whyTopNoLoad");
    if (g.kind === "reps")
        return t("whyReps", { n: g.setNo, a: fmt(g.limitAdj), t: g.limitTarget }) + (g.unknownEffort ? t("whyUnknown") : "");
    return t("whyHold", { n: g.setNo, a: fmt(g.limitAdj), t: g.limitTarget, h: g.harder ? t("whyHarder") : "" }) + (g.unknownEffort ? t("whyUnknown") : "");
}
function suggCards(s) {
    return (s.suggestions || []).map((g, i) => {
        const title = g.kind === "up" ? t("sUp") : g.kind === "reps" ? t("sReps") : t("sHold");
        const st = g.status !== "pending" ? `<span class="status ${g.status === "rejected" ? "muted" : "ok"}">${t(g.status)}</span>` : "";
        const ex = exById(g.exId);
        return `<div class="card"><div class="faint small">${esc(exName(g.exId))}</div>
      <div class="row spread base"><span class="b17">${title}</span>${st}</div>
      <div class="num b mt4">${g.loads.map((l) => loadTxt(ex, l)).join(" / ")} kg</div>
      <div class="why">${esc(why(g))}${g.substituted ? " " + t("substituted") : ""}</div>
      ${g.status === "pending" ? `<div class="row g8"><button class="btn primary small flex1" data-a="sgAccept" data-id="${s.id}" data-v="${i}">${t("accept")}</button>
        ${g.kind === "up" ? `<button class="btn ghost small flex1" data-a="sgModify" data-id="${s.id}" data-v="${i}">${t("modify")}</button>` : ""}
        <button class="btn ghost small flex1" data-a="sgReject" data-id="${s.id}" data-v="${i}">${t("reject")}</button></div>` : ""}
    </div>`;
    }).join("");
}
function sessionStats(s) {
    let sets = 0, vol = 0, mins = 0, cReps = 0;
    s.exercises.forEach((e) => {
        if (e.skipped)
            return;
        const tr = trackOf(e.exId), done = e.sets.filter((x) => x.done && isWork(x));
        sets += done.length;
        if (tr === "wr")
            vol += volumeLoad(e.sets);
        else if (tr === "time")
            mins += done.reduce((a, x) => a + (x.mins || 0), 0);
        else if (exById(e.exId)?.mechanic === "cardio")
            cReps += done.reduce((a, x) => a + (x.reps || 0), 0);
    });
    return { sets, vol, mins, cReps };
}
const cardioLine = (st) => st.mins || st.cReps ? `<p class="sub small">${t("cardio")}: ${[st.mins ? fmt(st.mins) + " min" : "", st.cReps ? st.cReps + " " + t("reps").toLowerCase() : ""].filter(Boolean).join(" · ")}</p>` : "";
function vSummary(p) {
    const s = A.sessions.find((x) => x.id === p.id);
    if (!s)
        return "";
    const st = sessionStats(s);
    return `<div class="scroll"><h1>${t("summary")}</h1><div class="sub">${esc(nm(s.dayName))} · ${sessionDate(s)}</div>
    <div class="stats"><div class="stat"><b class="num">${clock(elapsed(s))}</b><span>${t("duration")}</span></div><div class="stat"><b class="num">${st.sets}</b><span>${t("workSets")}</span></div><div class="stat"><b class="num">${Math.round(st.vol).toLocaleString(locale())}</b><span>${t("volume")}</span></div></div>${cardioLine(st)}
    ${(s.suggestions || []).length ? `<h2>${t("forNext")}</h2>${suggCards(s)}` : ""}
    <button class="btn ghost block mt16" data-a="tab" data-v="today">${t("close")}</button></div>`;
}
async function applySuggestion(s, i, status) {
    const g = s.suggestions[i];
    g.status = status;
    if ((status === "accepted" || status === "modified") && g.kind === "up" && !g.substituted) {
        for (const p of A.programs)
            for (const d of p.days)
                for (const pe of d.exercises) {
                    if (pe.id !== g.peId)
                        continue;
                    const work = pe.sets.filter(isWork);
                    work.forEach((tp, k) => { if (g.loads[k] != null)
                        tp.load = g.loads[k]; });
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
    const first = new Date(c.y, c.m, 1);
    const startDow = (first.getDay() + 6) % 7;
    const nDays = new Date(c.y, c.m + 1, 0).getDate();
    const trained = new Set(list.filter((s) => !s.dateUnknown).map((s) => new Date(s.startedAt).toDateString()));
    const today = new Date().toDateString();
    let cells = "";
    const dows = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(locale(), { weekday: "narrow" }));
    cells += dows.map(d => `<span class="dow">${d}</span>`).join("");
    for (let i = 0; i < startDow; i++)
        cells += `<span></span>`;
    for (let d = 1; d <= nDays; d++) {
        const ds = new Date(c.y, c.m, d).toDateString();
        cells += `<span class="dd ${trained.has(ds) ? "on" : ""} ${ds === today ? "now" : ""}">${d}</span>`;
    }
    const monthName = first.toLocaleDateString(locale(), { month: "long", year: "numeric" });
    // progress chart: exercises with history, most logged first
    const counts = new Map();
    for (const s of list)
        for (const e of s.exercises)
            if (!e.skipped && e.sets.some((x) => x.done && isWork(x)))
                counts.set(e.exId, (counts.get(e.exId) || 0) + 1);
    const exs = [...counts.entries()].sort((a, b) => b[1] - a[1] || exName(a[0]).localeCompare(exName(b[0]))).map(x => x[0]);
    let prog = "";
    if (exs.length) {
        const pe = A.histEx && counts.has(A.histEx) ? A.histEx : exs[0];
        const tr = trackOf(pe), ms = metricsFor(tr), m = A.histM && ms.includes(A.histM) ? A.histM : ms[0];
        const sp = seriesFor(pe, m);
        prog = `<div class="card"><div class="row spread"><b>${t("progressT")}</b></div>
      <select class="inp mt8" data-in="histEx" aria-label="${t("exercises")}">${exs.map(id => `<option value="${id}" ${id === pe ? "selected" : ""}>${esc(exName(id))} (${counts.get(id)})</option>`).join("")}</select>
      ${ms.length > 1 ? `<div class="seg mt8">${ms.map(k => `<button class="${k === m ? "on" : ""}" data-a="histM" data-v="${k}">${t("m_" + k)}</button>`).join("")}</div>` : ""}
      <div class="mt8">${deltaLine(sp, m)}${lineChart(sp, m)}</div></div>`;
    }
    let h = `<div class="scroll"><h1>${t("history")}</h1>${prog}
    <div class="card"><div class="row spread"><button class="iconbtn" data-a="calPrev" aria-label="prev">${I.back}</button><b class="cap">${monthName}</b><button class="iconbtn flip" data-a="calNext" aria-label="next">${I.back}</button></div><div class="cal">${cells}</div></div>`;
    if (!list.length)
        h += `<p class="sub">${t("noSessions")}</p>`;
    h += list.map((s) => {
        const st = sessionStats(s);
        return swipeRow(`<button class="card rowbtn" data-a="openSession" data-id="${s.id}"><span><b>${esc(nm(s.dayName))}</b><span class="sub block">${sessionDate(s)}${s.dateUnknown ? "" : " · " + clock(elapsed(s))}</span></span><span class="muted num small r">${st.sets} ${t("sets").toLowerCase()}<br>${Math.round(st.vol).toLocaleString(locale())} kg</span></button>`, `data-a="swipeDelSession" data-id="${s.id}"`, `session:${s.id}`);
    }).join("");
    if (list.length)
        h += `<p class="faint small c">${t("swipeTip")}</p>`;
    return h + `</div>`;
}
function vSession(p) {
    const s = A.sessions.find((x) => x.id === p.id);
    if (!s)
        return header("");
    const st = sessionStats(s);
    const d = new Date(s.startedAt);
    const iso = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    let h = header(nm(s.dayName), `<button class="iconbtn" data-a="sessionMenu" data-id="${s.id}" aria-label="${t("edit")}">${I.dots}</button>`) + `<div class="scroll">
    <div class="row spread"><label class="sub" for="sdate">${t("date")}</label><input id="sdate" type="date" class="inp w-auto" value="${s.dateUnknown ? "" : iso}" data-in="sessionDate" data-id="${s.id}"></div>
    <div class="stats"><div class="stat"><b class="num">${s.dateUnknown ? "–" : clock(elapsed(s))}</b><span>${t("duration")}</span></div><div class="stat"><b class="num">${st.sets}</b><span>${t("workSets")}</span></div><div class="stat"><b class="num">${Math.round(st.vol).toLocaleString(locale())}</b><span>${t("volume")}</span></div></div>${cardioLine(st)}`;
    h += s.exercises.map((e, ei) => {
        const ex = exById(e.exId);
        return `<div class="card"><div class="row spread"><b>${esc(nm(e.name))}</b>${e.skipped ? `<span class="pill warn">${t("skip")}</span>` : ""}</div>
      ${e.exId !== e.plannedExId ? `<div class="faint small">↺ ${t("replaces", { x: esc(exName(e.plannedExId)) })}</div>` : ""}
      ${e.sets.map((x, si) => `<div class="hset ${x.done ? "" : "undone"}">
        <span class="faint num">${x.type === "warmup" ? "W" : e.sets.slice(0, si + 1).filter(isWork).length}</span>
        ${(ex?.track || "wr") === "time" ? (extrasOf(ex).length ? `<button class="cell sm num" data-a="hNum" data-id="${s.id}" data-e="${ei}" data-v="${si}" data-f="mins">${fmt(x.mins)}′</button>${extrasOf(ex).map(k => `<button class="cell sm num" data-a="hNum" data-id="${s.id}" data-e="${ei}" data-v="${si}" data-f="${k}">${x[k] == null ? "–" : fmt(x[k]) + (k === "incline" ? "%" : "")}</button>`).join("")}${extrasOf(ex).length < 2 ? "<span></span>" : ""}` : `<button class="cell sm num span3" data-a="hNum" data-id="${s.id}" data-e="${ei}" data-v="${si}" data-f="mins">${fmt(x.mins)} min</button>`)
            : (ex?.track || "wr") === "reps" ? `<button class="cell sm num span3" data-a="hNum" data-id="${s.id}" data-e="${ei}" data-v="${si}" data-f="reps">× ${x.reps}</button>`
                : `<button class="cell sm num" data-a="hNum" data-id="${s.id}" data-e="${ei}" data-v="${si}" data-f="load">${loadTxt(ex, x.load)} kg</button>
        <button class="cell sm num" data-a="hNum" data-id="${s.id}" data-e="${ei}" data-v="${si}" data-f="reps">× ${x.reps}</button>
        <button class="cell sm num" data-a="hRir" data-id="${s.id}" data-e="${ei}" data-v="${si}">RIR ${x.rir ?? "–"}</button>`}
        <button class="iconbtn" data-a="hDel" data-id="${s.id}" data-e="${ei}" data-v="${si}" aria-label="${t("deleteSet")}">${I.x}</button></div>`).join("")}
      </div>`;
    }).join("");
    h += `<label class="lbl" for="snotes">${t("sessionNotes")}</label><textarea id="snotes" class="inp" rows="3" data-in="sessionNotes" data-id="${s.id}">${esc(s.notes)}</textarea>`;
    if ((s.suggestions || []).length)
        h += `<h2>${t("forNext")}</h2>` + suggCards(s);
    return h + `</div>`;
}
/* ---------------- Programs ---------------- */
function vPrograms() {
    const act = A.programs.filter((p) => p.status !== "archived" && p.status !== "deleted").sort((a, b) => (b.status === "active" ? 1 : 0) - (a.status === "active" ? 1 : 0));
    const arc = A.programs.filter((p) => p.status === "archived");
    const acts = (p) => p.status === "archived"
        ? [{ label: t("unarchive"), attrs: `data-a="progRestore" data-id="${p.id}"`, cls: "main" }, { label: t("delete"), attrs: `data-a="progDelete" data-id="${p.id}"`, cls: "del" }]
        : [...(p.status !== "active" ? [{ label: t("activate"), attrs: `data-a="progActivate" data-id="${p.id}"`, cls: "main" }] : []),
            { label: t("archive"), attrs: `data-a="progArchive" data-id="${p.id}"`, cls: "mid" }, { label: t("delete"), attrs: `data-a="progDelete" data-id="${p.id}"`, cls: "del" }];
    const card = (p) => `<button class="card rowbtn" data-a="openProgram" data-id="${p.id}"><span><b>${esc(p.name)}</b><span class="sub block">${p.days.map((d) => esc(nm(d.name))).join(" · ") || "—"}</span></span><span>${p.status === "active" ? `<span class="pill accent">${t("active")}</span>` : ""}</span></button>`;
    const row = (p) => swipeRow(card(p), acts(p), `program:${p.id}`);
    return `<div class="scroll"><h1>${t("programs")}</h1>${act.map(row).join("")}
    <button class="btn ghost block mt8" data-a="newProgram">+ ${t("newProgram")}</button>
    ${arc.length ? `<h2>${t("archived")}</h2>${arc.map(row).join("")}` : ""}
    ${act.length + arc.length ? `<p class="faint small c mt12">${t("progTip")}</p>` : ""}</div>`;
}
const findProg = (id) => A.programs.find((p) => p.id === id);
function vProgram(p) {
    const pr = findProg(p.id);
    if (!pr)
        return header("");
    return header(t("program"), `<button class="iconbtn" data-a="programMenu" data-id="${pr.id}" aria-label="${t("edit")}">${I.dots}</button>`) + `<div class="scroll">
    <label class="lbl" for="pname">${t("name")}</label><input id="pname" class="inp" value="${esc(pr.name)}" data-in="progName" data-id="${pr.id}">
    <label class="lbl" for="pdesc">${t("description")}</label><input id="pdesc" class="inp" value="${esc(pr.description || "")}" data-in="progDesc" data-id="${pr.id}">
    <h2>${t("days")}</h2>
    <div class="sortable" data-sort="days" data-id="${pr.id}">${pr.days.map((d, i) => `<div class="card row sort-item">
      <button class="flex1 tl" data-a="openDay" data-id="${pr.id}" data-v="${i}"><b>${i + 1}. ${esc(nm(d.name))}</b>${pr.nextDay === i ? ` <span class="pill accent">${t("isNext")}</span>` : ""}<span class="sub block">${d.exercises.map((e) => esc(exName(e.exId))).join(" · ") || "—"}</span></button>
      <button class="handle" data-handle aria-label="${t("dragHint")}">${I.grip}</button></div>`).join("")}</div>
    <button class="btn ghost block mt8" data-a="addDay" data-id="${pr.id}">+ ${t("addDay")}</button></div>`;
}
function vDay(p) {
    const pr = findProg(p.id);
    const d = pr?.days[p.d];
    if (!d)
        return header("");
    return header(nm(d.name), `<button class="iconbtn" data-a="dayMenu" data-id="${pr.id}" data-v="${p.d}" aria-label="${t("edit")}">${I.dots}</button>`) + `<div class="scroll">
    <div class="sortable" data-sort="day" data-id="${pr.id}" data-d="${p.d}">${d.exercises.map((pe, i) => {
        const ex = exById(pe.exId);
        const tr = ex?.track || "wr";
        const sum = pe.sets.map((s) => tr === "time" ? timeTxt(ex, { ...s, mins: s.mins ?? 0 }) : tr === "reps" ? `×${fmtRange(s.repsMin, s.repsMax)}`
            : s.type === "warmup" ? `W ${loadTxt(ex, s.load ?? 0)}×${s.repsMin}` : `${s.load != null ? loadTxt(ex, s.load) + "×" : ""}${fmtRange(s.repsMin, s.repsMax)}${s.rir != null ? "@" + s.rir : ""}`).join(" · ");
        return `<div class="card row sort-item"><button class="flex1 tl" data-a="openPe" data-id="${pr.id}" data-d="${p.d}" data-v="${i}">
        <b>${esc(exName(pe.exId))}</b>${pe.group ? ` <span class="pill accent">${esc(pe.group)}</span>` : ""}${pe.scheme && pe.scheme !== "straight" ? ` <span class="pill">${t("sch_" + pe.scheme + "_s")}</span>` : ""}${pe.optional ? ` <span class="pill">${t("optional")}</span>` : ""}
        <span class="sub block num">${sum}</span></button>
        <button class="handle" data-handle aria-label="${t("dragHint")}">${I.grip}</button></div>`;
    }).join("")}</div>${d.exercises.length > 1 ? `<p class="faint small c">${t("dragTip")}</p>` : ""}
    <button class="btn ghost block mt8" data-a="pickFor" data-mode="addToDay" data-id="${pr.id}" data-d="${p.d}">+ ${t("addExercise")}</button></div>`;
}
function vPe(p) {
    const pr = findProg(p.id);
    const d = pr?.days[p.d];
    const pe = d?.exercises[p.e];
    if (!pe)
        return header("");
    const ex = exById(pe.exId);
    const groups = ["", "A", "B", "C", "D"];
    return header(exName(pe.exId), `<button class="iconbtn" data-a="peMenu" data-id="${pr.id}" data-d="${p.d}" data-v="${p.e}" aria-label="${t("edit")}">${I.dots}</button>`) + `<div class="scroll">
    <h2>${t("sets")}</h2>
    ${(ex?.track || "wr") === "wr" ? `<div class="tpl-head"><span></span><span>${t("kg")}</span><span>${t("repsMin")}</span><span>${t("repsMax")}</span><span>RIR</span><span></span></div>`
        : ex.track === "reps" ? `<div class="tpl-head"><span></span><span class="span2">${t("repsMin")}</span><span class="span2">${t("repsMax")}</span><span></span></div>`
            : `<div class="tpl-head"><span></span><span class="span4">${t("minutes")}</span><span></span></div>`}
    ${pe.sets.map((s, i) => `<div class="tpl">
      <button data-a="tplType" data-id="${pr.id}" data-d="${p.d}" data-e="${p.e}" data-v="${i}" class="badge ${s.type === "warmup" ? "w" : s.type === "top" ? "acc" : ""}">${s.type === "warmup" ? "W" : s.type === "top" ? "T" : s.type === "backoff" ? "B" : s.type === "amrap" ? "A" : s.type === "drop" ? "D" : pe.sets.slice(0, i + 1).filter(isWork).length}</button>
      ${(ex?.track || "wr") === "time" ? (extrasOf(ex).length ? `<button class="cell sm num" data-a="tplNum" data-f="mins" data-id="${pr.id}" data-d="${p.d}" data-e="${p.e}" data-v="${i}">${fmt(s.mins ?? 0)}′</button>${extrasOf(ex).map(k => `<button class="cell sm num" data-a="tplNum" data-f="${k}" data-id="${pr.id}" data-d="${p.d}" data-e="${p.e}" data-v="${i}">${s[k] == null ? "–" : fmt(s[k]) + (k === "incline" ? "%" : "")}</button>`).join("")}${extrasOf(ex).length < 2 ? "<span></span>" : ""}` : `<button class="cell sm num span4" data-a="tplNum" data-f="mins" data-id="${pr.id}" data-d="${p.d}" data-e="${p.e}" data-v="${i}">${fmt(s.mins ?? 0)} min</button>`)
        : ex.track === "reps" ? `<button class="cell sm num span2" data-a="tplNum" data-f="repsMin" data-id="${pr.id}" data-d="${p.d}" data-e="${p.e}" data-v="${i}">${s.repsMin}</button>
      <button class="cell sm num span2" data-a="tplNum" data-f="repsMax" data-id="${pr.id}" data-d="${p.d}" data-e="${p.e}" data-v="${i}">${s.repsMax == null ? "∞" : s.repsMax}</button>`
            : `<button class="cell sm num" data-a="tplNum" data-f="load" data-id="${pr.id}" data-d="${p.d}" data-e="${p.e}" data-v="${i}">${s.load == null ? "–" : loadTxt(ex, s.load)}</button>
      <button class="cell sm num" data-a="tplNum" data-f="repsMin" data-id="${pr.id}" data-d="${p.d}" data-e="${p.e}" data-v="${i}">${s.repsMin}</button>
      <button class="cell sm num" data-a="tplNum" data-f="repsMax" data-id="${pr.id}" data-d="${p.d}" data-e="${p.e}" data-v="${i}">${s.repsMax == null ? "∞" : s.repsMax}</button>
      <button class="cell sm num" data-a="tplRir" data-id="${pr.id}" data-d="${p.d}" data-e="${p.e}" data-v="${i}">${s.rir ?? "–"}</button>`}
      <button class="iconbtn" data-a="tplDel" data-id="${pr.id}" data-d="${p.d}" data-e="${p.e}" data-v="${i}" aria-label="${t("deleteSet")}">${I.x}</button></div>`).join("")}
    <div class="row g8 mt4"><button class="addset flex1" data-a="tplAdd" data-id="${pr.id}" data-d="${p.d}" data-e="${p.e}">+ ${t("addSet")}</button><button class="addset flex1" data-a="tplAddWarm" data-id="${pr.id}" data-d="${p.d}" data-e="${p.e}">+ ${t("addWarmup")}</button></div>
    <h2>${t("restSec")}</h2>
    <button class="cell num wide" data-a="peRest" data-id="${pr.id}" data-d="${p.d}" data-e="${p.e}">${pe.rest ?? ex?.rest ?? 120} ${t("sec")}${pe.rest == null ? ` <span class="faint small">(${t("default")})</span>` : ""}</button>
    <h2>${t("scheme")}</h2>
    <select class="inp" data-in="peScheme" data-id="${pr.id}" data-d="${p.d}" data-e="${p.e}" aria-label="${t("scheme")}">${["straight", "pyr_asc", "pyr_desc", "pyr_full", "topback", "drop"].map(k => `<option value="${k}" ${(pe.scheme || "straight") === k ? "selected" : ""}>${t("sch_" + k)}</option>`).join("")}</select>
    <p class="faint small mt4">${t("sch_" + (pe.scheme || "straight") + "_d")}</p>
    <h2>${t("superset")}</h2>
    <div class="seg">${groups.map(g => `<button class="${(pe.group || "") === g ? "on" : ""}" data-a="peGroup" data-id="${pr.id}" data-d="${p.d}" data-e="${p.e}" data-v="${g}">${g || t("none")}</button>`).join("")}</div>
    <label class="toggle mt16"><input type="checkbox" ${pe.optional ? "checked" : ""} data-in="peOptional" data-id="${pr.id}" data-d="${p.d}" data-e="${p.e}"> ${t("optional")}</label>
    <label class="lbl" for="penotes">${t("notes")}</label><textarea id="penotes" class="inp" rows="3" data-in="peNotes" data-id="${pr.id}" data-d="${p.d}" data-e="${p.e}">${esc(pe.notes || "")}</textarea>
  </div>`;
}
/* ---------------- Library ---------------- */
function libList(mode, ctx) {
    const q = A.q.trim().toLowerCase();
    const list = [...A.lib.values()].filter((e) => !e.archived)
        .filter((e) => !A.qm || (A.qm === "uni" ? e.laterality === "unilateral" : e.muscles.some((m) => m.m === A.qm && m.role === "primary")))
        .filter((e) => !q || [e.name.en, e.name.it, ...(e.aliases || [])].some((n) => n.toLowerCase().includes(q)))
        .sort((a, b) => nm(a.name).localeCompare(nm(b.name), locale()));
    const chips = `<div class="chips-row">${["", "uni", ...MUSCLES].map(m => `<button class="chipf ${A.qm === m ? "on" : ""}" data-a="libMuscle" data-v="${m}">${m === "uni" ? t("unilateral") : m ? t("m_" + m) : t("all")}</button>`).join("")}</div>`;
    const row = (e) => `<button class="li btnli" data-a="${mode}" data-id="${e.id}" ${ctx ? `data-ctx='${esc(JSON.stringify(ctx))}'` : ""}>
      <span><span class="b">${esc(nm(e.name))}</span>${e.custom ? ` <span class="pill">${t("custom")}</span>` : ""}<span class="sub block small">${t("eq_" + e.equipment)} · ${e.muscles.filter((m) => m.role === "primary").map((m) => t("m_" + m.m)).join(", ")}${e.laterality === "unilateral" ? " · " + t("unilateral") : ""}</span></span>${I.chev}</button>`;
    const items = list.map((e) => (mode === "openExercise" ? swipeRow(row(e), `data-a="swipeDelEx" data-id="${e.id}"`, `exercise:${e.id}`) : row(e))).join("");
    return `<input class="inp search" type="search" placeholder="${t("search")}" value="${esc(A.q)}" data-in="libQ" autocomplete="off">${chips}<div class="card libcard">${items || `<p class="sub">—</p>`}</div>${mode === "openExercise" && list.length ? `<p class="faint small c">${t("swipeTipEx")}</p>` : ""}`;
}
function vLibrary() {
    return `<div class="scroll"><div class="row spread"><h1>${t("library")}</h1><button class="btn ghost small" data-a="newExercise">+ ${t("newExercise")}</button></div>${libList("openExercise", null)}</div>`;
}
function vPick(p) {
    const keep = p.mode === "impItem" ? `<button class="btn ghost block mb8" data-a="impKeepNew" data-ctx='${esc(JSON.stringify(p))}'>${t("keepNew", { x: esc(impTarget(p)?.name || "") })}</button>` : "";
    return header(p.mode === "substitute" ? t("substitute") : p.mode === "replacePe" ? t("replaceEx") : p.mode === "impItem" ? t("matchEx") : t("addExercise")) + `<div class="scroll">${keep}${libList("picked", p)}</div>`;
}
const impTarget = (p) => (A.imp ? (p.kind === "log" ? A.imp.sessions[p.di]?.exercises[p.ii] : A.imp.days[p.di]?.items[p.ii]) : null);
/** Per-session values for an exercise, oldest first. */
function metricsFor(track) { return track === "time" ? ["mins"] : track === "reps" ? ["reps", "bestReps"] : ["e1rm", "top", "vol"]; }
function seriesFor(exId, m) {
    return exHistory(exId).slice().reverse().map((h) => {
        const w = h.work;
        let v = null;
        if (m === "e1rm")
            v = h.best ? h.best.v : null;
        else if (m === "top")
            v = Math.max(...w.map((x) => x.load || 0));
        else if (m === "vol")
            v = volumeLoad(w);
        else if (m === "reps")
            v = w.reduce((a, x) => a + (x.reps || 0), 0);
        else if (m === "bestReps")
            v = Math.max(...w.map((x) => x.reps || 0));
        else if (m === "mins")
            v = w.reduce((a, x) => a + (x.mins || 0), 0);
        return v == null ? null : { v, s: h.s };
    }).filter(Boolean);
}
const metricUnit = (m) => (m === "e1rm" || m === "top" || m === "vol" ? "kg" : m === "mins" ? "min" : t("reps").toLowerCase());
function lineChart(pts, m) {
    if (pts.length < 2)
        return `<p class="sub small">${t("needTwo")}</p>`;
    const W = 340, H = 150, L = 8, R = 46, T = 14, B = 26;
    const vals = pts.map(p => p.v), mn = Math.min(...vals), mx = Math.max(...vals), pad = (mx - mn) * 0.12 || Math.max(1, mx * 0.05);
    const lo = mn - pad, hi = mx + pad;
    const X = (i) => L + (i * (W - L - R)) / (pts.length - 1), Y = (v) => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
    const line = pts.map((p, i) => `${X(i).toFixed(1)},${Y(p.v).toFixed(1)}`).join(" ");
    const area = `${X(0).toFixed(1)},${H - B} ${line} ${X(pts.length - 1).toFixed(1)},${H - B}`;
    const u = metricUnit(m), r = (v) => (m === "e1rm" || m === "vol" ? Math.round(v) : fmt(v));
    const lbl = (p) => (p.s.dateUnknown ? "" : dstr(p.s.startedAt, { day: "numeric", month: "short" }));
    return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="${pts.map(p => r(p.v)).join(", ")} ${u}">
    <line x1="${L}" x2="${W - R}" y1="${Y(mx)}" y2="${Y(mx)}" class="grid"/><line x1="${L}" x2="${W - R}" y1="${Y(mn)}" y2="${Y(mn)}" class="grid"/>
    <polygon points="${area}" fill="var(--accent)" opacity=".12"/>
    <polyline fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" points="${line}"/>
    ${pts.map((p, i) => `<circle cx="${X(i).toFixed(1)}" cy="${Y(p.v).toFixed(1)}" r="${i === pts.length - 1 ? 4.5 : 3}" fill="var(--accent)"/>`).join("")}
    <text x="${W - R + 6}" y="${Y(mx) + 4}" class="ctext">${r(mx)} ${u}</text><text x="${W - R + 6}" y="${Y(mn) + 4}" class="ctext">${r(mn)} ${u}</text>
    <text x="${L}" y="${H - 6}" class="ctext">${lbl(pts[0])}</text><text x="${W - R}" y="${H - 6}" text-anchor="end" class="ctext">${lbl(pts[pts.length - 1])}</text></svg>`;
}
function deltaLine(pts, m) {
    if (pts.length < 2)
        return "";
    const a = pts[0].v, b = pts[pts.length - 1].v, d = b - a, pct = a ? (d / a) * 100 : 0;
    const u = metricUnit(m), sign = d > 0 ? "+" : d < 0 ? "−" : "±";
    const cls = d > 0 ? "up" : d < 0 ? "down" : "";
    const val = m === "e1rm" || m === "vol" ? Math.round(Math.abs(d)) : fmt(Math.abs(d));
    return `<div class="delta ${cls} num"><b>${sign}${val} ${u}</b> <span>(${sign}${Math.abs(pct).toFixed(1)}%)</span> <span class="faint">${t("sinceFirst", { n: pts.length })}</span></div>`;
}
function exHistory(exId) {
    return completed().map((s) => {
        const e = s.exercises.find((x) => x.exId === exId && !x.skipped);
        if (!e)
            return null;
        const work = e.sets.filter((x) => x.done && isWork(x));
        if (!work.length)
            return null;
        let best = null;
        if (trackOf(exId) === "wr")
            for (const x of work) {
                const v = e1rm(x.load, x.reps, x.rir);
                if (v != null && (!best || v > best.v))
                    best = { v, x };
            }
        return { s, work, best };
    }).filter(Boolean);
}
function vExercise(p) {
    const ex = exById(p.id);
    if (!ex)
        return header("");
    const hist = exHistory(ex.id);
    let heavy = null, bestE = null, bestV = null;
    hist.forEach((h) => h.work.forEach((x) => {
        if (!heavy || x.load > heavy.x.load)
            heavy = { x, s: h.s };
        const v = e1rm(x.load, x.reps, x.rir);
        if (v != null && (!bestE || v > bestE.v))
            bestE = { v, x, s: h.s };
        if (!bestV || x.load * x.reps > bestV.v)
            bestV = { v: x.load * x.reps, x, s: h.s };
    }));
    const tr = ex.track || "wr";
    const em = A.exMetric && metricsFor(tr).includes(A.exMetric) ? A.exMetric : metricsFor(tr)[0];
    const sp = seriesFor(ex.id, em);
    const chart = hist.length ? `<h2>${t("progressT")}</h2><div class="card">${metricsFor(tr).length > 1 ? `<div class="seg mb8">${metricsFor(tr).map(k => `<button class="${k === em ? "on" : ""}" data-a="exMetric" data-v="${k}">${t("m_" + k)}</button>`).join("")}</div>` : ""}${deltaLine(sp, em)}${lineChart(sp, em)}</div>` : "";
    const rec = (lbl, r, val) => `<div class="li"><span>${lbl}</span><span class="r num"><b>${val}</b><span class="sub block small">${r ? `${loadTxt(ex, r.x.load)}×${r.x.reps}${r.x.rir != null ? " @" + r.x.rir : ""} · ${sessionDate(r.s)}` : ""}</span></span></div>`;
    return header(nm(ex.name), `<button class="iconbtn" data-a="exEdit" data-id="${ex.id}" aria-label="${t("edit")}">${I.dots}</button>`) + `<div class="scroll">
    <div class="ex-meta"><span class="pill">${t("eq_" + ex.equipment)}</span>${ex.laterality === "unilateral" ? `<span class="pill">${t("unilateral")}</span>` : ""}${ex.muscles.map((m) => `<span class="pill ${m.role === "primary" ? "accent" : ""}">${t("m_" + m.m)}${m.role === "secondary" ? " ½" : ""}</span>`).join("")}</div>
    <div class="row g8">${tr === "wr" ? `<button class="cell num flex1" data-a="exInc" data-id="${ex.id}">+${fmt(ex.inc)} kg</button>` : ""}<button class="cell num flex1" data-a="exRest" data-id="${ex.id}">${ex.rest} ${t("sec")} ${t("restOn")}</button></div>
    ${hist.length && tr === "wr" ? `<h2>${t("records")}</h2><div class="card">${rec(t("heaviest"), heavy, loadTxt(ex, heavy.x.load) + " kg")}${bestE ? rec(t("bestE1rm"), bestE, "~" + Math.round(bestE.v) + " kg") : ""}${rec(t("bestSet"), bestV, Math.round(bestV.v) + " kg")}</div>` : ""}
    ${chart}
    <h2>${t("history")}</h2>${hist.length ? hist.map((h) => `<button class="card rowbtn" data-a="openSession" data-id="${h.s.id}"><span><b class="small">${sessionDate(h.s)}</b><span class="block num">${h.work.map((x) => setTxt(ex, x, true)).join(" · ")}</span></span>${h.best ? `<span class="faint small num">~${Math.round(h.best.v)}</span>` : ""}</button>`).join("") : `<p class="sub">${t("noHistory")}</p>`}
  </div>`;
}
function vExForm(p) {
    const ex = p.id ? exById(p.id) : null;
    const f = A.form || (A.form = ex ? JSON.parse(JSON.stringify(ex)) : { id: "", name: { en: "", it: "" }, aliases: [], equipment: "machine", pattern: "other", mechanic: "isolation", loadType: "external", inc: 5, rest: 90, muscles: [{ m: "chest", role: "primary" }], notes: "", custom: true, archived: false });
    const prim = f.muscles.find((m) => m.role === "primary")?.m || "chest";
    const sec = new Set(f.muscles.filter((m) => m.role === "secondary").map((m) => m.m));
    const eqs = ["barbell", "dumbbell", "machine", "cable", "smith", "bodyweight", "band", "kettlebell", "other"];
    const lts = ["external", "bodyweight", "bw_plus", "assisted"];
    return header(ex ? t("edit") : t("newExercise")) + `<div class="scroll">
    <label class="lbl" for="fen">${t("name")} (English)</label><input id="fen" class="inp" value="${esc(f.name.en)}" data-in="fName" data-v="en">
    <label class="lbl" for="fit">${t("name")} (Italiano)</label><input id="fit" class="inp" value="${esc(f.name.it)}" data-in="fName" data-v="it">
    <label class="lbl" for="feq">${t("equipment")}</label><select id="feq" class="inp" data-in="fEq">${eqs.map(e => `<option value="${e}" ${f.equipment === e ? "selected" : ""}>${t("eq_" + e)}</option>`).join("")}</select>
    <label class="lbl" for="ftr">${t("tracking")}</label><select id="ftr" class="inp" data-in="fTr">${["wr", "reps", "time"].map(e => `<option value="${e}" ${(f.track || "wr") === e ? "selected" : ""}>${t("tr_" + e)}</option>`).join("")}</select>
    ${(f.track || "wr") === "time" ? `<div class="lbl">${t("extrasT")}</div><label class="toggle"><input type="checkbox" ${(f.extras || []).includes("speed") ? "checked" : ""} data-in="fXSpeed"> ${t("ex_speed")} (km/h)</label><label class="toggle"><input type="checkbox" ${(f.extras || []).includes("incline") ? "checked" : ""} data-in="fXIncline"> ${t("ex_incline")} (%)</label>` : ""}
    <label class="lbl" for="flt">${t("loadType")}</label><select id="flt" class="inp" data-in="fLt">${lts.map(e => `<option value="${e}" ${f.loadType === e ? "selected" : ""}>${t("lt_" + e)}</option>`).join("")}</select>
    <label class="lbl" for="fpm">${t("primary")}</label><select id="fpm" class="inp" data-in="fPrim">${MUSCLES.map(m => `<option value="${m}" ${prim === m ? "selected" : ""}>${t("m_" + m)}</option>`).join("")}</select>
    <div class="lbl">${t("secondary")}</div><div class="chips-row wrap">${MUSCLES.filter(m => m !== prim).map(m => `<button class="chipf ${sec.has(m) ? "on" : ""}" data-a="fSec" data-v="${m}">${t("m_" + m)}</button>`).join("")}</div>
    <div class="row g8 mt12"><div class="flex1"><div class="lbl">${t("increment")}</div><input class="inp num" inputmode="decimal" value="${fmt(f.inc)}" data-in="fInc"></div><div class="flex1"><div class="lbl">${t("restSec")}</div><input class="inp num" inputmode="numeric" value="${f.rest}" data-in="fRest"></div></div>
    <button class="btn primary block mt16" data-a="fSave">${t("save")}</button>
    ${ex ? `<button class="btn ghost block mt8 danger" data-a="exArchive" data-id="${ex.id}">${t("deleteExercise")}</button>` : ""}
  </div>`;
}
/* ---------------- Import ---------------- */
function usedIds() { const u = new Set(); for (const s of A.sessions)
    for (const e of s.exercises)
        u.add(e.exId); for (const p of A.programs)
    for (const d of p.days)
        for (const e of d.exercises)
            u.add(e.exId); return u; }
function setsTxt(it) {
    const ss = it.sets;
    if (!ss.length)
        return "";
    if (ss[0].mins != null)
        return `${ss.length} × ${fmt(ss[0].mins)} min`;
    const same = ss.every(x => x.min === ss[0].min && x.max === ss[0].max);
    const one = (x) => `${x.type === "amrap" ? "AMRAP " : ""}${fmtRange(x.min, x.max)}`;
    return same ? `${ss.length} × ${one(ss[0])}` : `${ss.length} × ${ss.map(one).filter((x, i, a) => i === 0 || x !== a[i - 1]).join(", ")}`;
}
function vImport() {
    const im = A.imp;
    let h = header(t("importT")) + `<div class="scroll">`;
    if (!im || im.stage === "input") {
        return h + `<p class="sub">${t("importIntro")}</p>
      <label class="btn primary block mt12 filebtn">${t("chooseFile")}<input type="file" accept=".json,.csv,.tsv,.txt,.md,.xlsx,image/*,text/*,application/json" data-in="impFile" hidden></label>
      <p class="faint small mt8">${t("formats")}</p>
      <h2>${t("orPaste")}</h2><textarea class="inp" rows="8" data-in="impText" placeholder="${esc(t("pasteHint"))}">${esc(A.impText || "")}</textarea>
      <button class="btn ghost block mt8" data-a="impReadText">${t("readText")}</button>
      ${im?.error ? `<p class="errline mt12">${esc(im.error)}</p>` : ""}</div>`;
    }
    if (im.stage === "busy")
        return h + `<p class="b mt16">${esc(im.msg)}</p><div class="pbar mt8"><i style="width:${Math.round((im.pct || 0) * 100)}%"></i></div><p class="sub small mt8">${t("ocrNote")}</p></div>`;
    if (im.kind === "plan") {
        const nNew = im.days.reduce((a, d) => a + d.items.filter((i) => !i.exId).length, 0);
        h += `<p class="sub">${t("checkPlan", { d: im.days.length, e: im.days.reduce((a, d) => a + d.items.length, 0) })}${nNew ? " " + t("newCount", { n: nNew }) : ""}</p>
      <label class="lbl" for="impn">${t("name")}</label><input id="impn" class="inp" value="${esc(im.name)}" data-in="impName">
      <label class="toggle"><input type="checkbox" ${im.makeActive ? "checked" : ""} data-in="impActive"> ${t("makeActive")}</label>`;
        h += im.days.map((d, di) => `<div class="card"><div class="row g8"><input class="inp flex1 dayinp" value="${esc(d.name)}" data-in="impDay" data-v="${di}" aria-label="${t("renameDay")}"><button class="iconbtn" data-a="impDelDay" data-v="${di}" aria-label="${t("deleteDay")}">${I.x}</button></div>
      ${d.items.map((it, ii) => `<div class="improw">
        <button class="flex1 tl" data-a="impPick" data-v="${di}" data-i="${ii}"><b class="${it.exId ? "" : "accent"}">${it.exId ? esc(exName(it.exId)) : t("newEx") + ": " + esc(it.name)}</b>${it.exId && norm2(exName(it.exId)) !== norm2(it.name) ? `<span class="faint small block">“${esc(it.name)}”</span>` : ""}</button>
        <button class="cell sm num impsets" data-a="impEdit" data-v="${di}" data-i="${ii}">${setsTxt(it)}${it.rest ? ` · ${it.rest}${t("sec")}` : ""}${it.scheme ? `<span class="block small accent">${t("sch_" + it.scheme + "_s")}</span>` : ""}</button>
        <button class="iconbtn" data-a="impDel" data-v="${di}" data-i="${ii}" aria-label="${t("delete")}">${I.x}</button></div>`).join("")}</div>`).join("");
        return h + `<button class="btn primary block mt8" data-a="impCreate">${t("createProgram")}</button><button class="btn ghost block mt8" data-a="impReset">${t("startOver")}</button></div>`;
    }
    // workout log
    h += `<p class="sub">${t("checkLog", { n: im.sessions.length })}</p>`;
    h += im.sessions.map((s, si) => `<div class="card"><div class="row spread"><b>${esc(s.name)}</b><input type="date" class="inp w-auto" value="${s.date || ""}" data-in="impDate" data-v="${si}" aria-label="${t("date")}"></div>
    ${s.exercises.map((e, ei) => `<div class="improw"><button class="flex1 tl" data-a="impPick" data-kind="log" data-v="${si}" data-i="${ei}"><b class="${e.exId ? "" : "accent"}">${e.exId ? esc(exName(e.exId)) : t("newEx") + ": " + esc(e.name)}</b>${e.group ? ` <span class="pill">${e.group}</span>` : ""}<span class="faint small block num">${e.sets.map((x) => (x.type === "warmup" ? "W " : "") + (x.mins != null ? fmt(x.mins) + " min" : (x.load ? fmt(x.load) + "×" : "×") + x.reps + (x.rir != null ? "@" + x.rir : ""))).join(" · ")}</span></button></div>`).join("")}</div>`).join("");
    return h + `<p class="faint small">${t("noDateHint")}</p><button class="btn primary block mt8" data-a="impAddLog">${t("addWorkouts", { n: im.sessions.length })}</button><button class="btn ghost block mt8" data-a="impReset">${t("startOver")}</button></div>`;
}
const norm2 = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
function showParsed(r, source) {
    if (r.kind === "none") {
        A.imp = { stage: "input", error: t("nothingFound") };
        render();
        return;
    }
    matchAll(r.kind === "plan" ? r.days : null, r.kind === "log" ? r.sessions : null, [...A.lib.values()], usedIds());
    A.imp = { stage: "preview", kind: r.kind, days: r.days || [], sessions: r.sessions || [], name: source || t("importedPlan"), makeActive: true };
    if (route().v !== "import")
        go("import", {});
    else {
        render();
        scrollTop();
    }
}
async function handleImportFile(file) {
    const n = (file.name || "").toLowerCase();
    try {
        if (n.endsWith(".json") || file.type === "application/json") {
            const txt = await file.text();
            try {
                if (JSON.parse(txt)?.app === "logbook") {
                    await importFile(file);
                    return;
                }
            }
            catch { }
            showParsed(parseAny(txt), "");
            return;
        }
        if (route().v !== "import")
            go("import", {});
        const base = file.name.replace(/\.[^.]+$/, "");
        if (file.type.startsWith("image/") || /\.(png|jpe?g|heic|webp|gif)$/.test(n)) {
            A.imp = { stage: "busy", msg: t("ocrLoading"), pct: 0 };
            render();
            const text = await ocrImage(file, (msg, pct) => { A.imp = { stage: "busy", msg, pct }; render(); });
            showParsed(parseAny(text), base);
            return;
        }
        if (n.endsWith(".xlsx")) {
            const rows = await readXlsx(await file.arrayBuffer());
            showParsed(parseAny("", rows), base);
            return;
        }
        if (/\.(xls|numbers|ods|docx?|pdf)$/.test(n)) {
            A.imp = { stage: "input", error: t("unsupported") };
            render();
            return;
        }
        showParsed(parseAny(await file.text()), base);
    }
    catch (err) {
        console.error(err);
        A.imp = { stage: "input", error: err && err.message === "offline" ? t("ocrOffline") : t("importFailed") + (err && err.message ? " (" + err.message + ")" : "") };
        render();
    }
}
/* ---- image reading: Tesseract (runs on the phone; engine + language data download once) */
const TESS_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
function loadScript(src) {
    return new Promise((res, rej) => { if (window.Tesseract)
        return res(); const sc = document.createElement("script"); sc.src = src; sc.onload = () => res(); sc.onerror = () => rej(new Error("offline")); document.head.appendChild(sc); });
}
/** Spreadsheet screenshots: coloured header/day bands carry white text, which OCR misses.
 *  Per pixel row: if the row is mostly saturated colour, white → black and colour → white; else plain threshold. 2× upscale for small text. */
export function preprocess(img) {
    const W = img.width, H = img.height;
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const id = ctx.getImageData(0, 0, W, H), d = id.data;
    for (let y = 0; y < H; y++) {
        let colored = 0;
        for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4, r = d[i], g = d[i + 1], b = d[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b);
            if (mx > 60 && (mx - mn) / mx > 0.25)
                colored++;
        }
        const band = colored > 0.35 * W;
        for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4, r = d[i], g = d[i + 1], b = d[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b);
            const l = 0.299 * r + 0.587 * g + 0.114 * b, sat = mx ? (mx - mn) / mx : 0;
            const v = band ? (sat < 0.18 && l > 200 ? 0 : 255) : (l < 150 ? 0 : 255);
            d[i] = d[i + 1] = d[i + 2] = v;
            d[i + 3] = 255;
        }
    }
    ctx.putImageData(id, 0, 0);
    const k = W < 1600 ? 2 : 1;
    if (k === 1)
        return c;
    const o = document.createElement("canvas");
    o.width = W * k;
    o.height = H * k;
    const octx = o.getContext("2d");
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = "high";
    octx.drawImage(c, 0, 0, o.width, o.height);
    return o;
}
async function ocrImage(file, progress) {
    await loadScript(TESS_URL);
    const T = window.Tesseract;
    const bmp = await createImageBitmap(file);
    const canvas = preprocess(bmp);
    let last = 0;
    const worker = await T.createWorker(["ita", "eng"], 1, { logger: (m) => {
            const now2 = Date.now();
            if (now2 - last < 200 && m.progress < 1)
                return;
            last = now2;
            progress(m.status === "recognizing text" ? t("ocrReading") : t("ocrLoading"), m.status === "recognizing text" ? m.progress : (m.progress || 0) * 0.3);
        } });
    try {
        await worker.setParameters({ tessedit_pageseg_mode: "6", preserve_interword_spaces: "1" });
        const { data } = await worker.recognize(canvas);
        return data.text;
    }
    finally {
        await worker.terminate();
    }
}
const STEPS = [
    { k: "welcome" },
    { k: "install", when: () => isIOS() && !standalone() },
    { k: "today", tab: "today", target: '.tabbar [data-v="today"]' },
    { k: "programs", tab: "programs", target: '.tabbar [data-v="programs"]' },
    { k: "import", tab: "more", target: '[data-a="openImport"]' },
    { k: "training" },
    { k: "history", tab: "history", target: '.tabbar [data-v="history"]' },
    { k: "backup", tab: "more", target: '.duecard, [data-a="exportJson"]' },
    { k: "feedback", tab: "more", target: '[data-a="openFeedback"]' },
    { k: "ready", actions: true },
];
const tourSteps = () => STEPS.filter(st => !st.when || st.when());
function tourGo(d) {
    const steps = tourSteps();
    const i = Math.max(0, Math.min(steps.length - 1, A.tour.i + d));
    A.tour.i = i;
    const st = steps[i];
    if (st.tab)
        A.nav = [{ v: st.tab, p: {} }];
    render();
}
async function endTour() { A.tour = null; A.settings.tourDone = true; await saveSettings(); A.nav = [{ v: "today", p: {} }]; }
function vTour() {
    const steps = tourSteps(), i = Math.min(A.tour.i, steps.length - 1), st = steps[i];
    const dots = steps.map((_, j) => `<i class="${j === i ? "on" : ""}"></i>`).join("");
    const body = t("tour_" + st.k + "_b").split("\n").map(p => `<p>${p}</p>`).join("");
    const acts = st.actions
        ? `<div class="col g8 mt12"><button class="btn primary block" data-a="tourDo" data-v="import">${t("tourImport")}</button><button class="btn ghost block" data-a="tourDo" data-v="program">${t("tourCreate")}</button><button class="btn ghost block" data-a="tourEnd">${t("tourExplore")}</button></div>`
        : `<div class="row g8 mt12"><button class="btn ghost small" data-a="tourEnd">${t("tourSkip")}</button><span class="flex1"></span>${i > 0 ? `<button class="btn ghost small" data-a="tourBack">${t("back")}</button>` : ""}<button class="btn primary small" data-a="tourNext">${t("tourNextBtn")}</button></div>`;
    return `<div class="tour" role="dialog" aria-modal="true" aria-label="${t("showTutorial")}"><div class="tour-hole ${st.target ? "" : "none"}"></div>
    <div class="tour-card"><div class="tour-dots">${dots}</div><h3>${t("tour_" + st.k + "_t")}</h3><div class="tour-body">${body}</div>${acts}</div></div>`;
}
function placeTour() {
    if (!A.tour)
        return;
    const st = tourSteps()[Math.min(A.tour.i, tourSteps().length - 1)];
    const hole = app.querySelector(".tour-hole"), card = app.querySelector(".tour-card");
    if (!hole || !card)
        return;
    const el = st.target ? app.querySelector(st.target) : null;
    if (!el) {
        hole.classList.add("none");
        card.style.top = "";
        card.style.bottom = "";
        card.classList.add("mid");
        return;
    }
    el.scrollIntoView({ block: "nearest" });
    const r = el.getBoundingClientRect(), pad = 6;
    Object.assign(hole.style, { left: r.left - pad + "px", top: r.top - pad + "px", width: r.width + pad * 2 + "px", height: r.height + pad * 2 + "px" });
    hole.classList.remove("none");
    card.classList.remove("mid");
    if (r.top > window.innerHeight / 2) {
        card.style.top = "";
        card.style.bottom = window.innerHeight - r.top + 16 + "px";
    }
    else {
        card.style.bottom = "";
        card.style.top = r.bottom + 16 + "px";
    }
}
window.addEventListener("resize", () => { if (A.tour)
    placeTour(); });
/* ---------------- Feedback ---------------- */
function diagText() {
    const ua = navigator.userAgent;
    const dev = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : "Desktop";
    const os = (ua.match(/OS (\d+[_.]\d+)/) || ua.match(/Android (\d+(\.\d+)?)/) || [])[1]?.replace("_", ".") || "";
    return `JimLogs ${VERSION}${isBeta ? " beta" : ""} · ${dev}${os ? " " + os : ""} · ${standalone() ? "app" : "browser"} · ${L()} · ${window.innerWidth}×${window.innerHeight}`;
}
function vFeedback() {
    const f = A.fb || (A.fb = { kind: "idea", text: "", diag: true });
    return header(t("sendFeedback")) + `<div class="scroll"><p class="sub">${t("fbIntro")}</p>
    <div class="seg mt12">${["bug", "idea", "other"].map(k => `<button class="${f.kind === k ? "on" : ""}" data-a="fbKind" data-v="${k}">${t("fb_" + k)}</button>`).join("")}</div>
    <label class="lbl" for="fbt">${t("fbMessage")}</label><textarea id="fbt" class="inp" rows="7" data-in="fbText" placeholder="${esc(t("fbPh_" + f.kind))}">${esc(f.text)}</textarea>
    <label class="toggle mt8"><input type="checkbox" ${f.diag ? "checked" : ""} data-a="fbDiag"> ${t("fbDiag")}</label>
    ${f.diag ? `<p class="faint small">${esc(diagText())}</p>` : ""}
    <button class="btn primary block mt12" data-a="fbSend">${t("fbSend")}</button>
    <p class="faint small mt8">${t("fbHow")}</p></div>`;
}
async function sendFeedback() {
    const f = A.fb;
    const text = (f.text || "").trim();
    if (!text) {
        toast(t("fbEmpty"));
        render();
        return;
    }
    const msg = `[JimLogs ${t("fb_" + f.kind)}]\n${text}${f.diag ? "\n\n— " + diagText() : ""}`;
    const nav = navigator;
    try {
        if (nav.share) {
            await nav.share({ text: msg });
            A.fb = null;
            toast(t("fbThanks"));
            back();
            return;
        }
    }
    catch (e) {
        if (e && e.name === "AbortError")
            return;
    }
    try {
        await navigator.clipboard.writeText(msg);
        toast(t("fbCopied"));
    }
    catch {
        toast(t("copyFailed"));
    }
    render();
}
/* ---------------- Program sharing ---------------- */
const appBase = () => location.origin + location.pathname.replace(/[^/]*$/, "");
async function buildShareLink() {
    const p = findProg(A.share.id);
    const code = await pack(toPayload(p, A.lib, A.share.withLoads));
    A.share.link = appBase() + "#share=" + code;
    render();
}
async function shareProgram(p) {
    A.share = { id: p.id, withLoads: false, link: null };
    A.sheet = { kind: "share" };
    render();
    await buildShareLink();
}
async function sendShare() {
    const p = findProg(A.share.id), link = A.share.link;
    if (!link)
        return;
    const text = t("shareText", { x: p.name });
    const nav = navigator;
    try {
        if (nav.share) {
            await nav.share({ title: p.name, text, url: link });
            A.sheet = null;
            render();
            return;
        }
    }
    catch (e) {
        if (e && e.name === "AbortError")
            return;
    }
    try {
        await navigator.clipboard.writeText(text + "\n" + link);
        toast(t("linkCopied"));
    }
    catch {
        toast(t("copyFailed"));
    }
    A.sheet = null;
    render();
}
async function openShareFromHash() {
    const code = extractCode(location.hash);
    if (!code)
        return;
    history.replaceState(null, "", location.pathname + location.search); // don't re-import on reload
    await openShared(code, false);
}
window.addEventListener("hashchange", () => { openShareFromHash(); });
async function openShared(code, pasted) {
    try {
        const o = await unpack(code);
        if (!validPayload(o))
            throw new Error("bad");
        A.shared = { payload: o, code, makeActive: !activeProgram(), here: pasted || standalone() || !isIOS() };
        A.nav = [{ v: "today", p: {} }, { v: "shared", p: {} }];
        A.tour = null;
        render();
    }
    catch {
        toast(t("shareBad"));
        render();
    }
}
function vShared() {
    const sh = A.shared;
    if (!sh)
        return header("");
    const o = sh.payload, link = appBase() + "#share=" + sh.code;
    const name = (x, xn) => (A.lib.has(x) ? exName(x) : o.cx?.[x] ? nm(o.cx[x].n) : xn);
    let h = header(t("sharedT")) + `<div class="scroll"><p class="sub">${t("sharedIntro")}</p><h1 class="mt8">${esc(o.n)}</h1>`;
    if (!sh.here) {
        // opened in Safari: on iPhone the Home Screen app keeps separate data, so guide the user there
        return h + `<div class="card betacard mt12"><b>${t("openInApp")}</b>
      <ol class="sub small steps"><li>${t("openInApp1")}</li><li>${t("openInApp2")}</li><li>${t("openInApp3")}</li></ol>
      <button class="btn primary block mt8" data-a="copyLink" data-link="${esc(link)}">${t("copyLinkBtn")}</button>
      <button class="btn ghost block mt8" data-a="sharedHere">${t("importHere")}</button></div></div>`;
    }
    h += o.d.map((d) => `<div class="card"><b>${esc(d.n)}</b>${d.e.map((e) => `<div class="li"><span>${esc(name(e.x, e.xn))}</span><span class="muted num small r">${e.s.length} × ${e.s[0] && e.s[0][5] != null ? fmt(e.s[0][5]) + " min" : fmtRange(e.s[0]?.[2] ?? 0, e.s[0]?.[3] ?? null)}</span></div>`).join("")}</div>`).join("");
    h += `<p class="faint small">${o.w ? t("sharedWithLoads") : t("sharedNoLoads")}</p>
    <label class="toggle"><input type="checkbox" ${sh.makeActive ? "checked" : ""} data-in="sharedActive"> ${t("makeActive")}</label>
    <button class="btn primary block mt8" data-a="sharedAdd">${t("addProgram")}</button></div>`;
    return h;
}
async function addShared() {
    const sh = A.shared;
    const libArr = [...A.lib.values()];
    const { program, created } = fromPayload(sh.payload, A.lib, now(), n => { const m = matchExercise(n, libArr); return m.score >= 0.9 ? m.id : null; });
    for (const ex of created)
        await saveExercise(ex);
    if (sh.makeActive) {
        for (const q of A.programs)
            if (q.status === "active") {
                q.status = "inactive";
                await saveProgram(q);
            }
        program.status = "active";
    }
    await saveProgram(program);
    A.programs.push(program);
    A.shared = null;
    toast(t("sharedAdded", { x: program.name }));
    A.nav = [{ v: "programs", p: {} }, { v: "program", p: { id: program.id } }];
    render();
}
/* ---------------- Beta: copy the main app's data in (one way) ---------------- */
function noLive() { confirmSheet(t("betaCopy"), t("betaNoLive"), "OK", false, () => { }); }
async function copyLiveIntoBeta() {
    const dbs = indexedDB.databases ? await indexedDB.databases() : null;
    if (dbs && !dbs.some((d) => d.name === "logbook")) {
        return noLive();
    }
    const live = await new Promise((res, rej) => {
        const r = indexedDB.open("logbook");
        r.onupgradeneeded = () => { r.transaction.abort(); }; // never create the main database from here
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
    }).catch(() => null);
    if (!live) {
        return noLive();
    }
    const read = (st) => new Promise(res => { try {
        const q = live.transaction(st).objectStore(st).getAll();
        q.onsuccess = () => res(q.result);
        q.onerror = () => res([]);
    }
    catch {
        res([]);
    } });
    const [ex, pr, se] = [await read("exercises"), await read("programs"), await read("sessions")];
    live.close();
    if (!pr.length && !se.length)
        return noLive();
    await db.clearAll();
    await db.putMany("exercises", ex);
    await db.putMany("programs", pr);
    await db.putMany("sessions", se);
    A.lib = new Map(ex.map((e) => [e.id, e]));
    A.programs = pr;
    A.sessions = se;
    await migrateData();
    toast(t("betaCopied", { n: se.length }));
    A.nav = [{ v: "today", p: {} }];
    render();
}
/* ---------------- More ---------------- */
function vMore() {
    const disc = A.sessions.filter((s) => s.status === "discarded").sort((a, b) => b.startedAt - a.startedAt);
    const lb = A.settings.lastBackupAt, due = backupDue();
    const delP = A.programs.filter((p) => p.status === "deleted");
    const delEx = [...A.lib.values()].filter((e) => e.archived).sort((a, b) => nm(a.name).localeCompare(nm(b.name), locale()));
    return `<div class="scroll"><h1>${t("more")}${isBeta ? ` <span class="pill betapill">BETA</span>` : ""}</h1>
    ${isBeta ? `<div class="card betacard"><b>${t("betaTitle")}</b><p class="sub small mt4">${t("betaBody")}</p><button class="btn ghost small mt8" data-a="betaCopy">${t("betaCopy")}</button></div>` : ""}
    <div class="card ${due ? "duecard" : ""}"><div class="row g8"><span class="flex1"><b>${t("backupShort")}</b><span class="sub small block">${t("lastBackup", { d: lb ? dstr(lb) : t("never") })}${due ? " · " + t("backupDueShort") : ""}</span></span>
      <button class="btn ${due ? "primary" : "ghost"} small" data-a="exportJson">${t("backupNow")}</button></div><p class="sub small mt8">${t("backupHelp")}</p></div>
    <h2>${t("importT")}</h2>
    <button class="btn primary block" data-a="openImport">${t("importPlan")}</button>
    <h2>${t("helpT")}</h2>
    <button class="btn ghost block" data-a="openFeedback">${t("sendFeedback")}</button>
    <button class="btn ghost block mt8" data-a="tourStart">${t("showTutorial")}</button>
    <h2>${t("language")}</h2><div class="seg"><button class="${L() === "en" ? "on" : ""}" data-a="lang" data-v="en">English</button><button class="${L() === "it" ? "on" : ""}" data-a="lang" data-v="it">Italiano</button></div>
    <h2>${t("accentT")}</h2><div class="swatches" role="group" aria-label="${t("accentT")}">${ACCENTS.map(k => `<button class="sw sw-${k} ${(A.settings.accent || "orange") === k ? "on" : ""}" data-a="accent" data-v="${k}" aria-pressed="${(A.settings.accent || "orange") === k}" aria-label="${t("ac_" + k)}"><span>${(A.settings.accent || "orange") === k ? "✓" : ""}</span></button>`).join("")}</div>
    <p class="sub small mt4">${t("ac_" + (A.settings.accent || "orange"))}</p>
    <label class="toggle mt8"><input type="checkbox" ${A.settings.cbSafe ? "checked" : ""} data-a="cbSafe"> ${t("cbSafe")}</label><p class="faint small">${t("cbHelp")}</p>
    <h2>${t("restAlertT")}</h2>
    <label class="toggle"><input type="checkbox" ${A.settings.restVibrate !== false ? "checked" : ""} data-a="restVibrate"> ${t("restVibrate")}</label>
    <label class="toggle"><input type="checkbox" ${A.settings.restSound ? "checked" : ""} data-a="restSound"> ${t("restSound")}</label>
    <label class="toggle"><input type="checkbox" ${wpOn() ? "checked" : ""} data-a="restWPush"> ${t("restWPush")}</label>
    ${A.settings.pushUrl ? `<div class="row g8 mt8 wrap"><button class="btn ghost small" data-a="wpSetup">${t("pushHow")}</button><button class="btn ghost small" data-a="wpTest">${t("pushTest")}</button></div>` : ""}
    <label class="toggle"><input type="checkbox" ${A.settings.restPush ? "checked" : ""} data-a="restPush"> ${t("restPush")}</label>
    ${A.settings.restPush ? `<div class="card mt8"><div class="sub small">${t("pushTopic")}</div><div class="mono small wrapany">${esc(ntfyTopic() || "")}</div>
      <div class="row g8 mt8 wrap"><button class="btn ghost small" data-a="pushSetup">${t("pushHow")}</button><button class="btn ghost small" data-a="pushTest">${t("pushTest")}</button><button class="btn ghost small" data-a="pushCopy">${t("pushCopy")}</button></div></div>` : ""}
    <p class="faint small">${t("restAlertHelp")}</p>
    <h2>${t("theme")}</h2><div class="seg">${["system", "light", "dark"].map(k => `<button class="${(A.settings.theme || "system") === k ? "on" : ""}" data-a="theme" data-v="${k}">${t(k)}</button>`).join("")}</div>
    <h2>${t("data")}</h2>
    <button class="btn ghost block" data-a="exportAll">${t("exportAll")}</button><p class="faint small">${t("exportAllHelp")}</p>
    <button class="btn ghost block" data-a="exportCsv">${t("exportCsv")}</button>
    <label class="btn ghost block mt8 filebtn">${t("importJson")}<input type="file" accept=".json,.csv,.tsv,.txt,.md,.xlsx,image/*,text/*,application/json" data-in="impFile" hidden></label>
    ${disc.length ? `<h2>${t("discarded")}</h2><div class="card">${disc.map((s) => `<div class="li"><span class="flex1">${esc(nm(s.dayName))}<span class="sub block small">${sessionDate(s)} · ${sessionStats(s).sets} ${t("sets").toLowerCase()}</span></span><button class="btn ghost small" data-a="restoreSession" data-id="${s.id}">${t("restore")}</button><button class="iconbtn danger" data-a="purgeSession" data-id="${s.id}" aria-label="${t("deleteForever")}">${I.x}</button></div>`).join("")}</div>` : ""}
    ${delP.length ? `<h2>${t("deletedPrograms")}</h2><div class="card">${delP.map((p) => `<div class="li"><span class="flex1">${esc(p.name)}</span><button class="btn ghost small" data-a="progRestore" data-id="${p.id}">${t("restore")}</button><button class="iconbtn danger" data-a="progPurge" data-id="${p.id}" aria-label="${t("deleteForever")}">${I.x}</button></div>`).join("")}</div>` : ""}
    ${delEx.length ? `<h2>${t("deletedEx")}</h2><div class="card">${delEx.map((e) => `<div class="li"><span>${esc(nm(e.name))}</span><button class="btn ghost small" data-a="restoreEx" data-id="${e.id}">${t("restore")}</button></div>`).join("")}</div>` : ""}
    <h2>${t("storage")}</h2><div class="card"><div class="sub">${A.persisted ? t("persisted") : t("notPersisted")}</div><div class="sub mt8">${t("installHint")}</div></div>
    <p class="faint small c mt16">JimLogs ${VERSION}${isBeta ? " · beta" : ""}</p></div>`;
}
/* ---------------- Sheets ---------------- */
function vSheet() {
    const sh = A.sheet;
    let inner = "";
    const still = !!sh.shown;
    sh.shown = true; // animate only when a sheet first opens, not on every re-render
    if (sh.kind === "num") {
        inner = `<h3>${esc(sh.title)}</h3><div class="bigval num">${esc(sh.val === "" ? "0" : sh.val)}<small> ${sh.unit || ""}</small></div>
      ${sh.step ? `<div class="steppers">${[-2, -1, 1, 2].map(k => `<button class="key num" data-a="kStep" data-v="${k * sh.step}">${k < 0 ? "−" : "+"}${fmt(Math.abs(k * sh.step))}</button>`).join("")}</div>` : ""}
      <div class="keys">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button class="key num" data-a="kKey" data-v="${n}">${n}</button>`).join("")}
      <button class="key" data-a="kKey" data-v="${sh.decimal ? "." : "C"}">${sh.decimal ? (L() === "it" ? "," : ".") : "C"}</button><button class="key num" data-a="kKey" data-v="0">0</button><button class="key" data-a="kKey" data-v="del" aria-label="⌫">⌫</button></div>
      <button class="btn primary block mt8" data-a="kOk">${t("done")}</button>`;
    }
    else if (sh.kind === "rir") {
        inner = `<h3>${esc(sh.title)}</h3><div class="sub">${t("rpe")} ${sh.val == null ? "–" : 10 - Math.min(sh.val, 5)} (= 10 − RIR)</div>
      <div class="rirs">${[0, 1, 2, 3, 4, 5].map(n => `<button class="chip num ${sh.val === n ? "on" : ""}" data-a="rirPick" data-v="${n}">${n === 5 ? "5+" : n}</button>`).join("")}</div>
      <button class="btn ghost block" data-a="rirPick" data-v="null">– (${t("none").toLowerCase()})</button>`;
    }
    else if (sh.kind === "menu") {
        inner = `${sh.title ? `<h3>${esc(sh.title)}</h3>` : ""}<div class="menu">${sh.items.map((it, i) => `<button class="${it.danger ? "danger" : ""}" data-a="menuPick" data-v="${i}">${esc(it.label)}</button>`).join("")}</div>`;
    }
    else if (sh.kind === "confirm") {
        inner = `<h3>${esc(sh.title)}</h3><p class="sub">${esc(sh.body)}</p><div class="row g8"><button class="btn ghost flex1" data-a="closeSheet">${t("cancel")}</button>
      <button class="btn ${sh.danger ? "ghost danger" : "primary"} flex1" data-a="confirmOk">${esc(sh.okLabel)}</button></div>`;
    }
    else if (sh.kind === "wp") {
        inner = `<h3>${t("wpSetupT")}</h3>${isIOS() && !standalone() ? `<p class="sub small" style="color:var(--warn,#ffb02e)">${t("wpInstall")}</p>` : ""}<ol class="steps sub">
      <li>${t("wpStep1")}<input id="wpUrl" class="search mt4" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="https://jimlogs-push.….workers.dev" value="${esc(A.settings.pushUrl || "")}"></li>
      <li>${t("wpStep2")}</li><li>${t("wpStep3")}</li></ol>
      <div class="row g8 mt12 wrap"><button class="btn primary flex1" data-a="wpEnable">${t("wpEnable")}</button><button class="btn ghost flex1" data-a="wpTest">${t("pushTest")}</button></div>
      <p class="faint small mt8">${t("wpPrivacy")}</p><button class="btn ghost block mt8" data-a="closeSheet">${t("done")}</button>`;
    }
    else if (sh.kind === "ntfy") {
        inner = `<h3>${t("pushSetupT")}</h3><ol class="steps sub">
      <li>${t("pushStep1")} <a href="https://apps.apple.com/us/app/ntfy/id1625396347" target="_blank" rel="noopener" class="accent">ntfy ↗</a></li>
      <li>${t("pushStep2")}<div class="mono small wrapany mt4">${esc(ntfyTopic() || "")}</div></li>
      <li>${t("pushStep3")}</li></ol>
      <div class="row g8 mt12 wrap"><button class="btn ghost flex1" data-a="pushCopy">${t("pushCopy")}</button><button class="btn primary flex1" data-a="pushTest">${t("pushTest")}</button></div>
      <p class="faint small mt8">${t("pushPrivacy")}</p>
      <button class="btn ghost block mt8" data-a="pushNew">${t("pushNew")}</button><button class="btn ghost block mt8" data-a="closeSheet">${t("done")}</button>`;
    }
    else if (sh.kind === "wnotes") {
        const s = activeSession(), e = s.exercises[s.idx];
        inner = `<h3>${t("wnTitle")}</h3>
      ${e ? `<label class="lbl" for="wne">${t("wnExercise", { x: esc(nm(e.name)) })}</label><textarea id="wne" class="inp" rows="3" data-in="wExNote" placeholder="${esc(t("wnExPh"))}">${esc(e.notes || "")}</textarea>` : ""}
      <label class="lbl" for="wns">${t("wnWorkout")}</label><textarea id="wns" class="inp" rows="3" data-in="wSesNote" placeholder="${esc(t("wnWkPh"))}">${esc(s.notes || "")}</textarea>
      <p class="faint small mt8">${t("wnHint")}</p><button class="btn primary block mt8" data-a="closeSheet">${t("done")}</button>`;
    }
    else if (sh.kind === "share") {
        const p = findProg(A.share.id);
        inner = `<h3>${t("shareProgram")}</h3><p class="sub small">${t("shareIntro", { x: esc(p.name) })}</p>
      <label class="toggle mt8"><input type="checkbox" ${A.share.withLoads ? "checked" : ""} data-a="shareLoads"> ${t("shareWithLoads")}</label>
      <button class="btn primary block mt8" data-a="shareSend" ${A.share.link ? "" : "disabled"}>${A.share.link ? t("shareSendBtn") : t("preparing")}</button>
      ${A.share.link ? `<p class="faint small mt8">${t("shareLen", { n: A.share.link.length })}</p>` : ""}`;
    }
    else if (sh.kind === "rest") {
        const n = Math.max(0, Math.round(parseFloat(sh.val) || 0));
        inner = `<h3>${esc(sh.title)}</h3><div class="bigval num">${clock(n * 1000)}<small> (${n} ${t("sec")})</small></div>
      <div class="steppers">${[-30, -15, 15, 30].map(k => `<button class="key num" data-a="kStep" data-v="${k}">${k < 0 ? "−" : "+"}${Math.abs(k)}</button>`).join("")}</div>
      <div class="keys">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(k => `<button class="key num" data-a="kKey" data-v="${k}">${k}</button>`).join("")}
      <button class="key" data-a="kKey" data-v="C">C</button><button class="key num" data-a="kKey" data-v="0">0</button><button class="key" data-a="kKey" data-v="del" aria-label="⌫">⌫</button></div>
      <div class="row g8 mt8">${sh.running ? `<button class="btn ghost flex1" data-a="restOnce">${t("restOnce")}</button>` : ""}<button class="btn primary flex1" data-a="restAlways">${t("restAlways")}</button></div>`;
    }
    else if (sh.kind === "order") {
        const s = activeSession();
        inner = `<h3>${t("reorder")}</h3><p class="sub small">${t("dragTip")}</p><div class="sortable mt8" data-sort="wk">${s.exercises.map((x, i) => {
            const dn = x.sets.filter((y) => y.done).length;
            return `<div class="sort-item orow ${i === s.idx ? "cur" : ""}"><button class="flex1 tl" data-a="gotoClose" data-v="${i}"><b class="${x.skipped ? "strike" : ""}">${x.group ? esc(x.group) + " · " : ""}${esc(nm(x.name))}</b><span class="sub small block num">${dn}/${x.sets.length} ${t("sets").toLowerCase()}${x.skipped ? " · " + t("skip") : ""}</span></button><button class="handle" data-handle aria-label="${t("dragHint")}">${I.grip}</button></div>`;
        }).join("")}</div><button class="btn ghost block mt8" data-a="addToWorkout">+ ${t("addExercise")}</button>`;
    }
    else if (sh.kind === "text") {
        inner = `<h3>${esc(sh.title)}</h3><input class="inp" id="sheetText" value="${esc(sh.val)}" data-in="sheetText"><button class="btn primary block mt12" data-a="textOk">${t("save")}</button>`;
    }
    return `<div class="scrim ${still ? "still" : ""}" data-a="scrim"><div class="sheet ${still ? "still" : ""}" role="dialog" aria-modal="true"><div class="grab"></div>${inner}</div></div>`;
}
function numSheet(title, val, opts, onOk) {
    A.sheet = { kind: "num", title, val: val == null ? "" : fmt(val), fresh: true, ...opts, onOk };
    render();
}
function rirSheet(title, val, onOk) { A.sheet = { kind: "rir", title, val, onOk }; render(); }
function menu(title, items) { A.sheet = { kind: "menu", title, items }; render(); }
function confirmSheet(title, body, okLabel, danger, onOk) { A.sheet = { kind: "confirm", title, body, okLabel, danger, onOk }; render(); }
function textSheet(title, val, onOk) { A.sheet = { kind: "text", title, val, onOk }; render(); setTimeout(() => document.getElementById("sheetText")?.focus(), 50); }
/* ---------------- export / import ---------------- */
async function shareFile(name, mime, text) {
    const file = new File([text], name, { type: mime });
    const nav = navigator;
    if (nav.canShare && nav.canShare({ files: [file] })) {
        try {
            await nav.share({ files: [file], title: name });
            return true;
        }
        catch (e) {
            if (e && e.name === "AbortError")
                return false;
        }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(file);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    return true;
}
const stamp = () => new Date().toISOString().slice(0, 10);
async function exportJson() {
    const data = { app: "logbook", schema: 1, exportedAt: new Date().toISOString(), version: VERSION,
        exercises: await db.all("exercises"), programs: await db.all("programs"), sessions: await db.all("sessions"), settings: A.settings };
    const ok = await shareFile(`jimlogs-backup-${stamp()}.json`, "application/json", JSON.stringify(data, null, 1));
    if (ok) {
        A.settings.lastBackupAt = now();
        await saveSettings();
        toast(t("saved"));
        render();
    }
}
async function exportAll() { await shareFile(`jimlogs-everything-${stamp()}.txt`, "text/plain", fullText(A.sessions, A.programs, A.lib, L())); }
async function exportCsv() { await shareFile(`jimlogs-sets-${stamp()}.csv`, "text/csv", setsCsv(A.sessions, A.lib)); }
async function importFile(file) {
    try {
        const data = JSON.parse(await file.text());
        if (!data || data.app !== "logbook" || !Array.isArray(data.sessions))
            throw new Error("bad");
        const local = { exercises: await db.all("exercises"), programs: await db.all("programs"), sessions: await db.all("sessions") };
        const r = mergeImport(local, data);
        for (const st of ["exercises", "programs", "sessions"])
            await db.putMany(st, r.writes[st]);
        A.lib = new Map((await db.all("exercises")).map((e) => [e.id, e]));
        A.programs = await db.all("programs");
        A.sessions = await db.all("sessions");
        if (A.programs.filter((p) => p.status === "active").length > 1) {
            const keep = A.programs.filter((p) => p.status === "active").sort((a, b) => b.updatedAt - a.updatedAt)[0];
            for (const p of A.programs)
                if (p.status === "active" && p !== keep) {
                    p.status = "inactive";
                    await saveProgram(p);
                }
        }
        toast(t("importDone", { a: r.added, u: r.updated, k: r.kept }));
    }
    catch {
        toast(t("importBad"));
    }
    render();
}
/* ---------------- actions ---------------- */
function ds(el) { return el.dataset; }
app.addEventListener("click", async (ev) => {
    const el = ev.target.closest("[data-a]");
    if (!el || el.disabled)
        return;
    const a = el.dataset.a, d = ds(el), v = d.v ?? "";
    const s = activeSession();
    const sh = A.sheet;
    if (a === "scrim") {
        if (ev.target === el) {
            A.sheet = null;
            render();
        }
        return;
    }
    try {
        switch (a) {
            case "tab":
                tab(v);
                return;
            case "back":
                back();
                return;
            case "undo":
                if (A.toast?.undo)
                    await A.toast.undo();
                A.toast = null;
                break;
            case "lang":
                A.settings.lang = v;
                setLang(v);
                await saveSettings();
                break;
            case "theme":
                A.settings.theme = v;
                await saveSettings();
                break;
            case "accent":
                A.settings.accent = v;
                await saveSettings();
                break;
            case "restVibrate":
                A.settings.restVibrate = !(A.settings.restVibrate !== false);
                await saveSettings();
                if (A.settings.restVibrate)
                    buzz();
                break;
            case "restSound":
                A.settings.restSound = !A.settings.restSound;
                await saveSettings();
                if (A.settings.restSound) {
                    armRestAudio();
                    setTimeout(beep, 300);
                }
                break;
            case "restPush": {
                const on = !A.settings.restPush;
                A.settings.restPush = on;
                if (on && !A.settings.ntfyTopic)
                    A.settings.ntfyTopic = newTopic();
                await saveSettings();
                if (on)
                    A.sheet = { kind: "ntfy" };
                break;
            }
            case "pushSetup":
                A.sheet = { kind: "ntfy" };
                break;
            case "restWPush": {
                if (A.settings.restWPush) {
                    A.settings.restWPush = false;
                    await saveSettings();
                }
                else if (A.settings.pushSub && wpUrl()) {
                    A.settings.restWPush = true;
                    await saveSettings();
                }
                else
                    A.sheet = { kind: "wp" };
                break;
            }
            case "wpSetup":
                A.sheet = { kind: "wp" };
                break;
            case "wpEnable": {
                const v = document.getElementById("wpUrl")?.value || "";
                const err = await wpEnable(v);
                if (err) {
                    toast(err);
                    return;
                }
                toast(t("wpOn"));
                break;
            }
            case "wpTest": {
                if (!A.settings.pushSub || !wpUrl()) {
                    toast(t("wpNeedSetup"));
                    return;
                }
                const ok = await wpCall("/test", { title: t("pushTestTitle"), body: t("pushTestBody") });
                toast(ok ? t("pushTestSent") : t("wpUnreachable"));
                return;
            }
            case "pushTest":
                await ntfyTest();
                return;
            case "pushCopy": {
                try {
                    await navigator.clipboard.writeText(ntfyTopic() || "");
                    toast(t("pushCopied"));
                }
                catch {
                    toast(t("copyFailed"));
                }
                break;
            }
            case "pushNew":
                confirmSheet(t("pushNew"), t("pushNewQ"), t("pushNew"), false, async () => { A.settings.ntfyTopic = newTopic(); await saveSettings(); A.sheet = { kind: "ntfy" }; });
                return;
            case "cbSafe":
                A.settings.cbSafe = !A.settings.cbSafe;
                await saveSettings();
                break;
            case "closeSheet":
                A.sheet = null;
                break;
            // sheets
            case "kKey": {
                let x = sh.fresh ? "" : sh.val;
                sh.fresh = false;
                if (v === "del")
                    x = x.slice(0, -1);
                else if (v === "C")
                    x = "";
                else if (v === ".") {
                    if (!x.includes("."))
                        x = (x || "0") + ".";
                }
                else if (x.replace(".", "").length < 6)
                    x = (x === "0" ? "" : x) + v;
                sh.val = x;
                break;
            }
            case "kStep":
                sh.val = fmt(Math.max(0, round2((parseFloat(sh.val) || 0) + parseFloat(v))));
                sh.fresh = false;
                haptic();
                break;
            case "kOk": {
                const n = parseFloat(sh.val) || 0;
                A.sheet = null;
                await sh.onOk(sh.decimal ? round2(n) : Math.round(n));
                break;
            }
            case "rirPick": {
                A.sheet = null;
                haptic();
                await sh.onOk(v === "null" ? null : +v);
                break;
            }
            case "menuPick": {
                const it = sh.items[+v];
                A.sheet = null;
                await it.on();
                break;
            }
            case "confirmOk": {
                A.sheet = null;
                await sh.onOk();
                break;
            }
            case "textOk": {
                const val = document.getElementById("sheetText").value.trim();
                A.sheet = null;
                if (val)
                    await sh.onOk(val);
                break;
            }
            // today
            case "start": {
                const p = activeProgram();
                await startWorkout(p, +v);
                return;
            }
            case "startEmpty":
                await startWorkout(null, null);
                return;
            case "changeDay": {
                const p = activeProgram();
                if (!p)
                    return;
                menu(t("changeDay"), p.days.map((dd, i) => ({ label: `${i + 1}. ${nm(dd.name)}`, on: async () => { p.nextDay = i; await saveProgram(p); } })));
                return;
            }
            case "toggleBackup":
                A.settings.backupOpen = !A.settings.backupOpen;
                await saveSettings();
                break;
            case "resumeMenu":
                menu(t("inProgress"), [{ label: t("finishNow"), on: () => askFinish(s) }, { label: t("discard"), danger: true, on: () => askDiscard(s) }]);
                return;
            case "wkList":
                A.sheet = { kind: "order" };
                break;
            case "gotoClose":
                s.idx = +v;
                A.sheet = null;
                await saveSession(s);
                render();
                centerStrip();
                return;
            case "openWorkout":
                A.nav = [{ v: "today", p: {} }, { v: "workout", p: {} }];
                render();
                requestWake();
                return;
            case "openSummary":
                go("summary", { id: d.id });
                return;
            case "exportJson":
                await exportJson();
                return;
            case "exportCsv":
                await exportCsv();
                return;
            case "exportAll":
                await exportAll();
                return;
            // workout
            case "goto": {
                const i = +v;
                if (s && i >= 0 && i < s.exercises.length) {
                    s.idx = i;
                    await saveSession(s);
                    render();
                    const b = document.getElementById("wkbody");
                    if (b)
                        b.scrollTop = 0;
                    centerStrip();
                }
                return;
            }
            case "pause":
                if (s.pausedAt) {
                    s.pausedMs += now() - s.pausedAt;
                    s.pausedAt = null;
                }
                else
                    s.pausedAt = now();
                await saveSession(s);
                break;
            case "check":
                armRestAudio();
                await toggleSet(s, +v);
                render();
                centerStrip();
                return;
            case "wNum": {
                const e = s.exercises[s.idx], x = e.sets[+v], f = d.f, ex = exById(e.exId);
                numSheet(numTitle(f, ex), x[f], numOpts(f, ex), async (n) => {
                    const old = x[f];
                    x[f] = n;
                    x.edited = { ...(x.edited || {}), [f]: true };
                    if (f === "load" && x.type !== "warmup")
                        for (const y of e.sets.slice(+v + 1))
                            if (!y.done && !y.edited?.load && y.type !== "warmup" && y.load === old)
                                y.load = n;
                    if (f === "speed" || f === "incline")
                        for (const y of e.sets.slice(+v + 1))
                            if (!y.done && !y.edited?.[f] && (y[f] ?? null) === (old ?? null))
                                y[f] = n;
                    await saveSession(s);
                });
                return;
            }
            case "wRir": {
                const x = s.exercises[s.idx].sets[+v];
                rirSheet(`RIR · ${t("set")} ${+v + 1}`, x.rir, async (n) => { x.rir = n; x.edited = { ...(x.edited || {}), rir: true }; await saveSession(s); });
                return;
            }
            case "setMenu": {
                const e = s.exercises[s.idx], i = +v;
                menu(t("setType"), [
                    ...["warmup", "working", "top", "backoff", "amrap", "drop"].map(k => ({ label: t(k), on: async () => { const x = e.sets[i]; x.type = k; if (k === "amrap" && x.t) {
                            x.t.repsMax = null;
                            x.t.rir = 0;
                        } await saveSession(s); } })),
                    { label: t("deleteSet"), danger: true, on: async () => { const removed = e.sets.splice(i, 1)[0]; await saveSession(s); toast(t("setDeleted"), async () => { e.sets.splice(i, 0, removed); await saveSession(s); }); } },
                ]);
                return;
            }
            case "wAddSet":
            case "wAddWarm": {
                const e = s.exercises[s.idx];
                const warm = a === "wAddWarm";
                const src = warm ? e.sets.find((x) => x.type === "warmup") : [...e.sets].reverse().find((x) => isWork(x));
                const ns = { id: uid(), type: warm ? "warmup" : "working", load: src?.load ?? 0, reps: src?.reps ?? 8, mins: src?.mins ?? (trackOf(e.exId) === "time" ? 10 : null), ...(src?.speed != null ? { speed: src.speed } : extrasOf(exById(e.exId)).includes("speed") ? { speed: null } : {}), ...(src?.incline != null ? { incline: src.incline } : extrasOf(exById(e.exId)).includes("incline") ? { incline: null } : {}), rir: warm || trackOf(e.exId) !== "wr" ? null : (src?.rir ?? 2), rpe: null, done: false, doneAt: null, edited: {}, last: null,
                    t: src?.t ? { ...src.t } : { repsMin: 8, repsMax: 12, rir: warm ? null : 2, load: null } };
                if (warm)
                    e.sets.unshift(ns);
                else
                    e.sets.push(ns);
                await saveSession(s);
                break;
            }
            case "exMenu": {
                const e = s.exercises[s.idx];
                menu(nm(e.name), [
                    { label: t("substitute"), on: () => go("pick", { mode: "substitute" }) },
                    { label: e.skipped ? t("unskipEx") : t("skipEx"), on: async () => { e.skipped = !e.skipped; if (e.skipped && s.idx < s.exercises.length - 1)
                            s.idx++; await saveSession(s); if (e.skipped)
                            toast(t("exSkipped"), async () => { e.skipped = false; await saveSession(s); }); } },
                    ...(s.idx > 0 ? [{ label: t("moveUp"), on: async () => { const x = s.exercises.splice(s.idx, 1)[0]; s.exercises.splice(--s.idx, 0, x); await saveSession(s); await syncOrderToPlan(s); } }] : []),
                    ...(s.idx < s.exercises.length - 1 ? [{ label: t("moveDown"), on: async () => { const x = s.exercises.splice(s.idx, 1)[0]; s.exercises.splice(++s.idx, 0, x); await saveSession(s); await syncOrderToPlan(s); } }] : []),
                    { label: t("pmTitle") + "…", on: () => planMenu(s) },
                    { label: t("rwTitle"), danger: true, on: () => removeFromWorkout(s, e) },
                ]);
                return;
            }
            case "wNotes":
                A.sheet = { kind: "wnotes" };
                break;
            case "addToWorkout":
                go("pick", { mode: "addToWorkout" });
                return;
            case "rest30":
                s.rest.endsAt += 30000;
                s.rest.total += 30;
                s.rest.buzzed = false;
                await saveSession(s);
                break;
            case "restMinus": {
                s.rest.endsAt -= 30000;
                s.rest.total = Math.max(1, s.rest.total - 30);
                await saveSession(s);
                break;
            }
            case "restEdit": {
                const e = s.exercises[s.idx], ex = exById(e.exId);
                const cur = s.rest ? Math.round(s.rest.total) : (e.rest ?? ex?.rest ?? 120);
                A.sheet = { kind: "rest", title: `${t("rest")} · ${nm(e.name)}`, val: String(cur), fresh: true, running: !!s.rest,
                    apply: async (n, always) => {
                        if (s.rest) {
                            const st = s.rest.startAt ?? (s.rest.endsAt - s.rest.total * 1000);
                            s.rest.total = n;
                            s.rest.endsAt = st + n * 1000;
                            s.rest.buzzed = false;
                        }
                        if (always) {
                            e.rest = n;
                            for (const p of A.programs)
                                for (const d of p.days)
                                    for (const pe of d.exercises)
                                        if (pe.id === e.peId) {
                                            pe.rest = n;
                                            await saveProgram(p);
                                        }
                            toast(t("restSaved", { n, x: nm(e.name) }));
                        }
                        await saveSession(s);
                    } };
                break;
            }
            case "restOnce":
            case "restAlways": {
                const n = Math.max(0, Math.round(parseFloat(sh.val) || 0));
                A.sheet = null;
                await sh.apply(n, a === "restAlways");
                break;
            }
            case "restSkip":
                s.rest = null;
                await saveSession(s);
                break;
            case "askFinish":
                askFinish(s);
                return;
            case "askDiscard":
                askDiscard(s);
                return;
            // suggestions
            case "sgAccept":
            case "sgReject": {
                const ss = A.sessions.find((x) => x.id === d.id);
                await applySuggestion(ss, +v, a === "sgAccept" ? "accepted" : "rejected");
                break;
            }
            case "sgModify": {
                const ss = A.sessions.find((x) => x.id === d.id), g = ss.suggestions[+v];
                const top = Math.max(...g.loads);
                numSheet(t("weight"), top, { step: g.inc || 2.5, decimal: true, unit: "kg" }, async (n) => { const delta = n - top; g.loads = g.loads.map((l) => round2(l + delta)); await applySuggestion(ss, +v, "modified"); });
                return;
            }
            // history
            case "calPrev":
            case "calNext": {
                const c = A.cal;
                c.m += a === "calNext" ? 1 : -1;
                if (c.m < 0) {
                    c.m = 11;
                    c.y--;
                }
                if (c.m > 11) {
                    c.m = 0;
                    c.y++;
                }
                break;
            }
            case "openSession":
                go("session", { id: d.id });
                return;
            case "hNum": {
                const ss = A.sessions.find((x) => x.id === d.id), e = ss.exercises[+d.e], x = e.sets[+v], f = d.f, ex = exById(e.exId);
                numSheet(numTitle(f, ex), x[f], numOpts(f, ex), async (n) => { x[f] = n; await saveSession(ss); });
                return;
            }
            case "hRir": {
                const ss = A.sessions.find((x) => x.id === d.id), x = ss.exercises[+d.e].sets[+v];
                rirSheet("RIR", x.rir, async (n) => { x.rir = n; await saveSession(ss); });
                return;
            }
            case "hDel": {
                const ss = A.sessions.find((x) => x.id === d.id), e = ss.exercises[+d.e], i = +v;
                const removed = e.sets.splice(i, 1)[0];
                await saveSession(ss);
                toast(t("setDeleted"), async () => { e.sets.splice(i, 0, removed); await saveSession(ss); });
                break;
            }
            case "sessionMenu": {
                const ss = A.sessions.find((x) => x.id === d.id);
                menu("", [{ label: t("deleteWorkout"), danger: true, on: () => confirmSheet(t("confirmDiscard"), t("confirmDiscardBody"), t("discard"), true, async () => { ss.status = "discarded"; ss.discardedAt = now(); await saveSession(ss); back(); }) }]);
                return;
            }
            case "restoreSession": {
                const ss = A.sessions.find((x) => x.id === d.id);
                ss.status = "completed";
                ss.endedAt = ss.endedAt || ss.updatedAt;
                await saveSession(ss);
                break;
            }
            // programs
            case "openProgram":
                go("program", { id: d.id });
                return;
            case "newProgram": {
                const p = { id: uid(), name: t("newProgram"), description: "", status: activeProgram() ? "inactive" : "active", nextDay: 0, days: [{ id: uid(), name: { en: "Day 1", it: "Giorno 1" }, exercises: [] }], createdAt: now(), updatedAt: now() };
                await saveProgram(p);
                A.programs.push(p);
                go("program", { id: p.id });
                return;
            }
            case "programMenu":
                programActions(findProg(d.id), true);
                return;
            case "progActivate":
                closeSwipes();
                await activateProgram(findProg(d.id));
                break;
            case "progArchive":
                closeSwipes();
                {
                    const p = findProg(d.id);
                    p.status = "archived";
                    await saveProgram(p);
                    toast(t("progArchived"), async () => { p.status = "inactive"; await saveProgram(p); });
                }
                break;
            case "progRestore":
                closeSwipes();
                {
                    const p = findProg(d.id);
                    p.status = p.prevStatus === "active" && !activeProgram() ? "active" : "inactive";
                    delete p.prevStatus;
                    await saveProgram(p);
                }
                break;
            case "progDelete":
                closeSwipes();
                deleteProgram(findProg(d.id));
                return;
            case "progPurge": {
                const p = findProg(d.id);
                confirmSheet(t("deleteForever"), `${p.name}. ${t("cantUndo")}`, t("delete"), true, async () => { await db.del("programs", p.id); A.programs = A.programs.filter((x) => x !== p); });
                return;
            }
            case "openDay":
                go("day", { id: d.id, d: +v });
                return;
            case "addDay": {
                const p = findProg(d.id);
                const n = p.days.length + 1;
                p.days.push({ id: uid(), name: { en: `Day ${n}`, it: `Giorno ${n}` }, exercises: [] });
                await saveProgram(p);
                break;
            }
            case "dayMenu": {
                const p = findProg(d.id), i = +v, dd = p.days[i];
                menu(nm(dd.name), [
                    { label: t("renameDay"), on: () => textSheet(t("renameDay"), nm(dd.name), async (val) => { dd.name = { en: val, it: val }; await saveProgram(p); }) },
                    { label: t("setNext"), on: async () => { p.nextDay = i; await saveProgram(p); } },
                    ...(i > 0 ? [{ label: t("moveUp"), on: () => reorder({ sort: "days", id: p.id }, i, i - 1) }] : []),
                    ...(i < p.days.length - 1 ? [{ label: t("moveDown"), on: () => reorder({ sort: "days", id: p.id }, i, i + 1) }] : []),
                    { label: t("duplicate"), on: async () => { const c = JSON.parse(JSON.stringify(dd)); c.id = uid(); c.name = { en: nm(dd.name) + " (2)", it: nm(dd.name) + " (2)" }; c.exercises.forEach((pe) => { pe.id = uid(); pe.sets.forEach((x) => x.id = uid()); }); p.days.splice(i + 1, 0, c); await saveProgram(p); } },
                    { label: t("deleteDay"), danger: true, on: () => confirmSheet(t("deleteDay"), nm(dd.name), t("delete"), true, async () => { p.days.splice(i, 1); p.nextDay = Math.min(p.nextDay, Math.max(0, p.days.length - 1)); await saveProgram(p); back(); }) },
                ]);
                return;
            }
            case "openPe":
                go("pe", { id: d.id, d: +d.d, e: +v });
                return;
            case "pickFor":
                go("pick", { mode: d.mode, id: d.id, d: +d.d, e: d.e != null ? +d.e : null });
                return;
            case "peMenu": {
                const p = findProg(d.id), day = p.days[+d.d], i = +v, pe = day.exercises[i];
                menu(exName(pe.exId), [
                    { label: t("replaceEx"), on: () => go("pick", { mode: "replacePe", id: p.id, d: +d.d, e: i }) },
                    ...(i > 0 ? [{ label: t("moveUp"), on: async () => { await reorder({ sort: "day", id: p.id, d: d.d }, i, i - 1); A.nav[A.nav.length - 1].p.e = i - 1; } }] : []),
                    ...(i < day.exercises.length - 1 ? [{ label: t("moveDown"), on: async () => { await reorder({ sort: "day", id: p.id, d: d.d }, i, i + 1); A.nav[A.nav.length - 1].p.e = i + 1; } }] : []),
                    { label: t("duplicate"), on: async () => { const c = JSON.parse(JSON.stringify(pe)); c.id = uid(); c.sets.forEach((x) => x.id = uid()); day.exercises.splice(i + 1, 0, c); await saveProgram(p); } },
                    ...p.days.map((dd, k) => k === +d.d ? null : { label: `${t("moveTo")}: ${nm(dd.name)}`, on: async () => { day.exercises.splice(i, 1); dd.exercises.push(pe); await saveProgram(p); back(); } }).filter(Boolean),
                    { label: t("deleteEx"), danger: true, on: () => confirmSheet(t("deleteEx"), exName(pe.exId), t("delete"), true, async () => { day.exercises.splice(i, 1); await saveProgram(p); back(); }) },
                ]);
                return;
            }
            case "tplType": {
                const p = findProg(d.id), pe = p.days[+d.d].exercises[+d.e], x = pe.sets[+v];
                menu(t("setType"), ["warmup", "working", "top", "backoff", "amrap", "drop"].map(k => ({ label: t(k), on: async () => {
                        const was = x.type;
                        x.type = k;
                        if (k === "warmup")
                            x.rir = null;
                        else if (k === "amrap") {
                            if (x.repsMax === x.repsMin)
                                x.repsMax = null;
                            x.rir = 0;
                        }
                        else if (x.rir == null)
                            x.rir = 2;
                        if (was === "amrap" && k !== "amrap" && x.repsMax == null)
                            x.repsMax = x.repsMin + 2;
                        await saveProgram(p);
                    } })));
                return;
            }
            case "tplNum": {
                const p = findProg(d.id), pe = p.days[+d.d].exercises[+d.e], x = pe.sets[+v], f = d.f, ex = exById(pe.exId);
                numSheet(f === "repsMin" ? t("repsMin") : f === "repsMax" ? t("repsMaxHint") : numTitle(f, ex), x[f], numOpts(f, ex), async (n) => {
                    if (f === "repsMax" && n === 0)
                        x.repsMax = null; // no upper limit (AMRAP 8+)
                    else {
                        x[f] = n;
                        if (f === "repsMin" && x.repsMax != null && x.repsMax < n)
                            x.repsMax = n;
                        if (f === "repsMax" && x.repsMin > n)
                            x.repsMin = n;
                    }
                    await saveProgram(p);
                });
                return;
            }
            case "tplRir": {
                const p = findProg(d.id), x = p.days[+d.d].exercises[+d.e].sets[+v];
                rirSheet("RIR", x.rir, async (n) => { x.rir = n; await saveProgram(p); });
                return;
            }
            case "tplDel": {
                const p = findProg(d.id), pe = p.days[+d.d].exercises[+d.e], i = +v;
                const removed = pe.sets.splice(i, 1)[0];
                await saveProgram(p);
                toast(t("setDeleted"), async () => { pe.sets.splice(i, 0, removed); await saveProgram(p); });
                break;
            }
            case "tplAdd":
            case "tplAddWarm": {
                const p = findProg(d.id), pe = p.days[+d.d].exercises[+d.e];
                const warm = a === "tplAddWarm";
                const src = warm ? null : [...pe.sets].reverse().find(isWork);
                const ns = warm ? { id: uid(), type: "warmup", load: null, repsMin: 8, repsMax: 8, rir: null } : { ...(src || defaultTemplates(trackOf(pe.exId))[0]), id: uid(), type: "working" };
                if (warm)
                    pe.sets.unshift(ns);
                else
                    pe.sets.push(ns);
                await saveProgram(p);
                break;
            }
            case "peRest": {
                const p = findProg(d.id), pe = p.days[+d.d].exercises[+d.e], ex = exById(pe.exId);
                numSheet(t("restSec"), pe.rest ?? ex?.rest ?? 120, { step: 15, unit: t("sec") }, async (n) => { pe.rest = n; await saveProgram(p); });
                return;
            }
            case "peGroup": {
                const p = findProg(d.id), pe = p.days[+d.d].exercises[+d.e];
                pe.group = v || null;
                await saveProgram(p);
                break;
            }
            // library
            case "libMuscle":
                A.qm = v;
                break;
            case "exMetric":
                A.exMetric = v;
                break;
            case "histM":
                A.histM = v;
                break;
            case "openImport":
                A.imp = null;
                go("import", {});
                return;
            case "openFeedback":
                A.fb = { kind: "idea", text: "", diag: true };
                go("feedback", {});
                return;
            case "fbKind":
                A.fb.kind = v;
                break;
            case "fbDiag":
                A.fb.diag = !A.fb.diag;
                break;
            case "fbSend":
                await sendFeedback();
                return;
            case "tourStart":
                A.tour = { i: 0 };
                A.nav = [{ v: "today", p: {} }];
                break;
            case "tourNext":
                tourGo(1);
                return;
            case "tourBack":
                tourGo(-1);
                return;
            case "tourEnd":
                await endTour();
                break;
            case "tourDo": {
                await endTour();
                if (v === "import") {
                    A.imp = null;
                    A.nav = [{ v: "more", p: {} }, { v: "import", p: {} }];
                }
                else if (v === "program") {
                    A.nav = [{ v: "programs", p: {} }];
                }
                break;
            }
            case "betaCopy":
                confirmSheet(t("betaCopyQ"), t("betaCopyBody"), t("betaCopyOk"), true, copyLiveIntoBeta);
                return;
            case "shareSend":
                await sendShare();
                return;
            case "shareLoads":
                A.share.withLoads = !A.share.withLoads;
                A.share.link = null;
                await buildShareLink();
                return;
            case "sharedAdd":
                await addShared();
                return;
            case "sharedHere":
                A.shared.here = true;
                break;
            case "copyLink": {
                try {
                    await navigator.clipboard.writeText(el.dataset.link || "");
                    toast(t("linkCopied"));
                }
                catch {
                    toast(t("copyFailed"));
                }
                break;
            }
            case "impReadText": {
                const txt = A.impText || "";
                if (!txt.trim())
                    break;
                const code = extractCode(txt);
                if (code) {
                    A.impText = "";
                    await openShared(code, true);
                    return;
                }
                try {
                    if (JSON.parse(txt)?.app === "logbook") {
                        await importFile(new File([txt], "backup.json"));
                        return;
                    }
                }
                catch { }
                showParsed(parseAny(txt), "");
                return;
            }
            case "impReset":
                A.imp = { stage: "input" };
                break;
            case "impDel":
                A.imp.days[+v].items.splice(+d.i, 1);
                break;
            case "impDelDay":
                A.imp.days.splice(+v, 1);
                break;
            case "impPick":
                go("pick", { mode: "impItem", kind: d.kind || "plan", di: +v, ii: +d.i });
                return;
            case "impKeepNew": {
                const ctx = JSON.parse(el.dataset.ctx || "{}");
                const it = impTarget(ctx);
                if (it) {
                    it.exId = null;
                    it.isNew = true;
                }
                back();
                return;
            }
            case "impEdit": {
                const it = A.imp.days[+v].items[+d.i];
                const cur = `${it.sets.length} x ${it.sets[0]?.mins != null ? fmt(it.sets[0].mins) + " min" : it.sets.map((x) => (x.type === "amrap" ? "max/" : "") + x.min + (x.max != null && x.max !== x.min ? "-" + x.max : "")).filter((x, i, a) => a.indexOf(x) === i).join(", ")}${it.rest ? " " + it.rest + "s" : ""}`;
                textSheet(t("setsReps"), cur, async (val) => { const p = parseExerciseLine("Item " + val); if (p) {
                    it.sets = p.sets;
                    if (p.rest != null)
                        it.rest = p.rest;
                }
                else
                    toast(t("cantRead")); });
                return;
            }
            case "impCreate": {
                const im = A.imp;
                const days = im.days.filter((x) => x.items.length);
                if (!days.length)
                    break;
                const { program, created } = buildProgramFromPlan(days, (im.name || t("importedPlan")).trim(), now(), A.lib);
                for (const ex of created)
                    await saveExercise(ex);
                if (im.makeActive) {
                    for (const q of A.programs)
                        if (q.status === "active") {
                            q.status = "inactive";
                            await saveProgram(q);
                        }
                    program.status = "active";
                }
                await saveProgram(program);
                A.programs.push(program);
                A.imp = null;
                toast(t("planCreated", { d: program.days.length, n: created.length }));
                A.nav = [{ v: "programs", p: {} }, { v: "program", p: { id: program.id } }];
                break;
            }
            case "impAddLog": {
                const im = A.imp;
                const { sessions, created } = buildSessionsFromLog(im.sessions, now(), A.lib);
                for (const ex of created)
                    await saveExercise(ex);
                await db.putMany("sessions", sessions);
                A.sessions.push(...sessions);
                A.imp = null;
                toast(t("logsAdded", { n: sessions.length }));
                A.nav = [{ v: "history", p: {} }];
                break;
            }
            case "openExercise":
                go("exercise", { id: d.id });
                return;
            case "newExercise":
                A.form = null;
                go("exform", {});
                return;
            case "exEdit": {
                const ex = exById(d.id);
                menu(nm(ex.name), [{ label: t("edit"), on: () => { A.form = null; go("exform", { id: ex.id }); } }, { label: t("deleteExercise"), danger: true, on: () => deleteExercise(ex, true) }]);
                return;
            }
            case "swipeDelEx": {
                closeSwipes();
                await deleteExercise(exById(d.id), false);
                break;
            }
            case "swipeDelSession": {
                closeSwipes();
                const ss = A.sessions.find((x) => x.id === d.id);
                if (!ss)
                    break;
                ss.status = "discarded";
                ss.discardedAt = now();
                await saveSession(ss);
                toast(t("workoutDeleted"), async () => { ss.status = "completed"; await saveSession(ss); });
                break;
            }
            case "purgeSession": {
                const ss = A.sessions.find((x) => x.id === d.id);
                confirmSheet(t("deleteForever"), `${nm(ss.dayName)} · ${sessionDate(ss)}. ${t("cantUndo")}`, t("delete"), true, async () => { await db.del("sessions", ss.id); A.sessions = A.sessions.filter((x) => x !== ss); });
                return;
            }
            case "restoreEx": {
                const ex = exById(d.id);
                ex.archived = false;
                delete ex.deletedAt;
                await saveExercise(ex);
                toast(t("exRestored"));
                break;
            }
            case "exInc": {
                const ex = exById(d.id);
                numSheet(t("increment"), ex.inc, { step: 0.5, decimal: true, unit: "kg" }, async (n) => { ex.inc = n; await saveExercise(ex); });
                return;
            }
            case "exRest": {
                const ex = exById(d.id);
                numSheet(t("restSec"), ex.rest, { step: 15, unit: t("sec") }, async (n) => { ex.rest = n; await saveExercise(ex); });
                return;
            }
            case "exArchive": {
                await deleteExercise(exById(d.id), true);
                return;
            }
            case "fSec": {
                const f = A.form;
                const has = f.muscles.some((m) => m.m === v && m.role === "secondary");
                f.muscles = has ? f.muscles.filter((m) => !(m.m === v && m.role === "secondary")) : [...f.muscles, { m: v, role: "secondary" }];
                break;
            }
            case "fSave": {
                const f = A.form;
                if (!f.name.en && !f.name.it) {
                    toast(t("name") + "?");
                    break;
                }
                f.name.en = f.name.en || f.name.it;
                f.name.it = f.name.it || f.name.en;
                if (!f.id) {
                    f.id = "ex_c_" + uid();
                    f.createdAt = now();
                }
                await saveExercise(f);
                A.form = null;
                back();
                return;
            }
            case "picked": {
                const ctx = JSON.parse(el.dataset.ctx || "{}");
                A.q = "";
                await picked(ctx, d.id);
                return;
            }
        }
    }
    catch (err) {
        console.error(err);
        toast("Error: " + (err && err.message));
    }
    render();
});
function askFinish(s) {
    const n = s.exercises.reduce((acc, e) => acc + e.sets.filter((x) => x.done && isWork(x)).length, 0);
    if (n === 0) {
        confirmSheet(t("nothingLogged"), t("nothingLoggedBody"), t("discard"), true, async () => { s.status = "discarded"; s.discardedAt = now(); await saveSession(s); releaseWake(); A.nav = [{ v: "today", p: {} }]; });
        return;
    }
    confirmSheet(t("confirmFinish"), t("confirmFinishBody", { n }), t("finish"), false, async () => { await finishSession(s); });
}
function askDiscard(s) {
    confirmSheet(t("confirmDiscard"), t("confirmDiscardBody"), t("discard"), true, async () => { s.status = "discarded"; s.discardedAt = now(); await saveSession(s); releaseWake(); A.nav = [{ v: "today", p: {} }]; });
}
/* ---- program actions (menu, swipe, long-press) */
async function activateProgram(p) {
    for (const q of A.programs)
        if (q.status === "active" && q !== p) {
            q.status = "inactive";
            await saveProgram(q);
        }
    p.status = "active";
    await saveProgram(p);
    toast(t("progActive", { x: p.name }));
}
async function duplicateProgram(p) {
    const c = JSON.parse(JSON.stringify(p));
    c.id = uid();
    c.name = p.name + " (2)";
    c.status = "inactive";
    c.createdAt = now();
    c.days.forEach((dd) => { dd.id = uid(); dd.exercises.forEach((pe) => { pe.id = uid(); pe.sets.forEach((x) => x.id = uid()); }); });
    await saveProgram(c);
    A.programs.push(c);
    return c;
}
function deleteProgram(p) {
    confirmSheet(t("deleteProgramQ", { x: p.name }), t("deleteProgramBody"), t("delete"), true, async () => {
        p.prevStatus = p.status;
        p.status = "deleted";
        p.deletedAt = now();
        await saveProgram(p);
        if (route().v === "program" || route().v === "day" || route().v === "pe")
            A.nav = [{ v: "programs", p: {} }];
        toast(t("progDeleted"), async () => { p.status = p.prevStatus; delete p.prevStatus; delete p.deletedAt; await saveProgram(p); });
    });
}
function programActions(p, inDetail) {
    menu(p.name, [
        ...(p.status !== "active" && p.status !== "archived" ? [{ label: t("makeActive"), on: () => activateProgram(p) }] : []),
        ...(!inDetail ? [{ label: t("edit"), on: () => go("program", { id: p.id }) }] : []),
        { label: t("shareProgram"), on: () => shareProgram(p) },
        { label: t("duplicate"), on: async () => { const c = await duplicateProgram(p); go("program", { id: c.id }); } },
        p.status === "archived" ? { label: t("unarchive"), on: async () => { p.status = "inactive"; await saveProgram(p); } }
            : { label: t("archive"), on: async () => { p.status = "archived"; await saveProgram(p); if (inDetail)
                    back(); } },
        { label: t("deleteProgram"), danger: true, on: () => deleteProgram(p) },
    ]);
}
/** Long-press menus for list rows. */
function longPress(spec) {
    const [kind, id] = spec.split(":");
    if (kind === "program") {
        const p = findProg(id);
        if (p)
            programActions(p, false);
    }
    if (kind === "session") {
        const ss = A.sessions.find((x) => x.id === id);
        if (ss)
            menu(`${nm(ss.dayName)} · ${sessionDate(ss)}`, [
                { label: t("open"), on: () => go("session", { id }) },
                { label: t("deleteWorkout"), danger: true, on: async () => { ss.status = "discarded"; ss.discardedAt = now(); await saveSession(ss); toast(t("workoutDeleted"), async () => { ss.status = "completed"; await saveSession(ss); }); } }
            ]);
    }
    if (kind === "exercise") {
        const ex = exById(id);
        if (ex)
            menu(nm(ex.name), [
                { label: t("open"), on: () => go("exercise", { id }) },
                { label: t("edit"), on: () => { A.form = null; go("exform", { id }); } },
                { label: t("deleteExercise"), danger: true, on: () => deleteExercise(ex, false) }
            ]);
    }
}
/** Delete from the library: hidden everywhere and removed from programs; past workouts keep it. Undo / restore in More. */
async function deleteExercise(ex, fromDetail) {
    if (!ex)
        return;
    const uses = [];
    for (const p of A.programs)
        for (const d of p.days)
            d.exercises.forEach((pe, i) => { if (pe.exId === ex.id)
                uses.push({ p, d, i, pe }); });
    const doIt = async () => {
        ex.archived = true;
        ex.deletedAt = now();
        await saveExercise(ex);
        const touched = new Set();
        for (const u of [...uses].reverse()) {
            u.d.exercises.splice(u.i, 1);
            touched.add(u.p);
        }
        for (const p of touched)
            await saveProgram(p);
        if (fromDetail)
            A.nav = [{ v: "library", p: {} }];
        toast(t("exDeleted", { x: nm(ex.name) }), async () => {
            ex.archived = false;
            delete ex.deletedAt;
            await saveExercise(ex);
            for (const u of uses)
                u.d.exercises.splice(u.i, 0, u.pe);
            for (const p of touched)
                await saveProgram(p);
        });
    };
    if (uses.length)
        confirmSheet(t("deleteExQ", { x: nm(ex.name) }), t("deleteExUsed", { n: uses.length }), t("delete"), true, doIt);
    else {
        await doIt();
        render();
    }
}
const moveItem = (arr, from, to) => { const [x] = arr.splice(from, 1); arr.splice(to, 0, x); };
/** Apply a drag (or menu) reorder to the list a .sortable element describes. */
async function reorder(ds, from, to) {
    if (from === to)
        return;
    if (ds.sort === "days") {
        const p = findProg(ds.id);
        const nextId = p.days[p.nextDay]?.id;
        moveItem(p.days, from, to);
        p.nextDay = Math.max(0, p.days.findIndex((x) => x.id === nextId));
        await saveProgram(p);
    }
    if (ds.sort === "day") {
        const p = findProg(ds.id);
        moveItem(p.days[+ds.d].exercises, from, to);
        await saveProgram(p);
    }
    if (ds.sort === "wk") {
        const s = activeSession();
        const cur = s.exercises[s.idx];
        moveItem(s.exercises, from, to);
        s.idx = s.exercises.indexOf(cur);
        await saveSession(s);
        await syncOrderToPlan(s);
    }
}
async function picked(ctx, exId) {
    const s = activeSession();
    if (ctx.mode === "impItem") {
        const it = impTarget(ctx);
        if (it) {
            it.exId = exId;
            it.isNew = false;
            it.score = 1;
        }
        back();
        return;
    }
    if (ctx.mode === "addToDay") {
        const p = findProg(ctx.id);
        p.days[ctx.d].exercises.push({ id: uid(), exId, group: null, optional: false, rest: null, notes: "", sets: defaultTemplates(trackOf(exId)) });
        await saveProgram(p);
        back();
        return;
    }
    if (ctx.mode === "replacePe") {
        const p = findProg(ctx.id);
        p.days[ctx.d].exercises[ctx.e].exId = exId;
        await saveProgram(p);
        back();
        return;
    }
    if (ctx.mode === "addToWorkout" && s) {
        const pe = { id: null, exId, group: null, optional: false, rest: null, notes: "", sets: defaultTemplates(trackOf(exId)) };
        const se = sessionExercise(pe);
        se.peId = null;
        s.exercises.push(se);
        s.idx = s.exercises.length - 1;
        await saveSession(s);
        back();
        return;
    }
    if (ctx.mode === "substitute" && s) {
        const e = s.exercises[s.idx];
        const ex = exById(exId);
        const lp = lastPerf(exId);
        e.exId = exId;
        e.name = ex.name;
        let wi = 0, ki = 0;
        e.sets.forEach((x) => { const prev = lp ? (x.type === "warmup" ? lp.warm[wi++] : lp.work[ki++]) : null; x.last = prev ? { load: prev.load, reps: prev.reps, rir: prev.rir, mins: prev.mins ?? null } : null; if (!x.done) {
            x.load = prev ? prev.load : x.load;
            x.edited = {};
            if (ex.track === "time" && x.mins == null)
                x.mins = prev?.mins ?? 10;
            if (ex.track !== "wr")
                x.rir = null;
        } });
        await saveSession(s);
        back();
        return;
    }
    back();
}
function centerStrip() { const st = document.getElementById("strip"); const on = st && st.querySelector(".on"); if (on)
    on.scrollIntoView({ inline: "center", block: "nearest" }); }
/* inputs */
// iPhone shows "Undo Typing" when the phone is shaken/set down and any text field still has edit history.
// Resetting the field's value on blur clears that history (the text itself is unchanged).
document.addEventListener("focusout", ev => {
    const el = ev.target;
    if (el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && /^(text|search|)$/.test(el.type)))) {
        const v = el.value;
        el.value = "";
        el.value = v;
    }
}, true);
let inputTimer = null;
app.addEventListener("input", ev => {
    const el = ev.target;
    const k = el.dataset?.in;
    if (!k)
        return;
    const d = el.dataset;
    if (k === "impText") {
        A.impText = el.value;
        return;
    }
    if (k === "fbText") {
        A.fb.text = el.value;
        return;
    }
    if (k === "libQ") {
        A.q = el.value;
        const pos = el.selectionStart;
        render();
        const n = app.querySelector(".search");
        if (n) {
            n.focus();
            n.setSelectionRange(pos, pos);
        }
        return;
    }
    if (k === "fName") {
        A.form.name[d.v] = el.value;
        return;
    }
    if (k === "fInc") {
        A.form.inc = parseFloat(el.value.replace(",", ".")) || 0;
        return;
    }
    if (k === "fRest") {
        A.form.rest = parseInt(el.value) || 0;
        return;
    }
    if (k === "wExNote" || k === "wSesNote") { // keep memory current at once; only the disk write is debounced
        const ss = activeSession();
        if (ss) {
            if (k === "wSesNote")
                ss.notes = el.value;
            else if (ss.exercises[ss.idx])
                ss.exercises[ss.idx].notes = el.value;
        }
    }
    clearTimeout(inputTimer);
    inputTimer = setTimeout(async () => {
        if (k === "progName" || k === "progDesc") {
            const p = findProg(d.id);
            p[k === "progName" ? "name" : "description"] = el.value;
            await saveProgram(p);
        }
        if (k === "wExNote" || k === "wSesNote") {
            const ss = activeSession();
            if (ss)
                await saveSession(ss);
        }
        if (k === "sessionNotes") {
            const ss = A.sessions.find((x) => x.id === d.id);
            ss.notes = el.value;
            await saveSession(ss);
        }
        if (k === "peNotes") {
            const p = findProg(d.id);
            p.days[+d.d].exercises[+d.e].notes = el.value;
            await saveProgram(p);
        }
    }, 400);
});
app.addEventListener("change", async (ev) => {
    const el = ev.target;
    const k = el.dataset?.in;
    if (!k)
        return;
    const d = el.dataset;
    if (k === "impFile" && el.files && el.files[0]) {
        const f = el.files[0];
        el.value = "";
        await handleImportFile(f);
        return;
    }
    if (k === "impName") {
        A.imp.name = el.value;
        return;
    }
    if (k === "impActive") {
        A.imp.makeActive = el.checked;
        return;
    }
    if (k === "sharedActive") {
        A.shared.makeActive = el.checked;
        return;
    }
    if (k === "impDay") {
        A.imp.days[+d.v].name = el.value;
        return;
    }
    if (k === "impDate") {
        A.imp.sessions[+d.v].date = el.value || null;
        return;
    }
    if (k === "fEq") {
        A.form.equipment = el.value;
        return;
    }
    if (k === "fLt") {
        A.form.loadType = el.value;
        return;
    }
    if (k === "fTr") {
        A.form.track = el.value;
        render();
        return;
    }
    if (k === "fXSpeed" || k === "fXIncline") {
        const key = k === "fXSpeed" ? "speed" : "incline";
        const set = new Set(A.form.extras || []);
        el.checked ? set.add(key) : set.delete(key);
        A.form.extras = ["speed", "incline"].filter(q => set.has(q));
        return;
    }
    if (k === "histEx") {
        A.histEx = el.value;
        render();
        return;
    }
    if (k === "fPrim") {
        A.form.muscles = [{ m: el.value, role: "primary" }, ...A.form.muscles.filter((m) => m.role === "secondary" && m.m !== el.value)];
        render();
        return;
    }
    if (k === "peScheme") {
        const p = findProg(d.id);
        p.days[+d.d].exercises[+d.e].scheme = el.value;
        await saveProgram(p);
        render();
        return;
    }
    if (k === "peOptional") {
        const p = findProg(d.id);
        p.days[+d.d].exercises[+d.e].optional = el.checked;
        await saveProgram(p);
        return;
    }
    if (k === "sessionDate" && el.value) {
        const ss = A.sessions.find((x) => x.id === d.id);
        const [y, m, dd] = el.value.split("-").map(Number);
        const old = new Date(ss.startedAt);
        const nd = new Date(y, m - 1, dd, ss.dateUnknown ? 8 : old.getHours(), ss.dateUnknown ? 0 : old.getMinutes());
        const dur = (ss.endedAt || ss.startedAt) - ss.startedAt;
        ss.startedAt = nd.getTime();
        ss.endedAt = ss.startedAt + dur;
        ss.dateUnknown = false;
        await saveSession(ss);
        render();
    }
});
/* swipe-to-delete rows (pointer events; vertical scrolling stays native via touch-action: pan-y) */
let sw = null, swipeBlockUntil = 0, lpBlockUntil = 0, lpPending = false;
const SW_OPEN = 92;
let lpTimer = null;
const clearLp = () => { if (lpTimer) {
    clearTimeout(lpTimer);
    lpTimer = null;
} };
app.addEventListener("contextmenu", e => { if (e.target.closest("[data-lp]"))
    e.preventDefault(); });
function closeSwipes(except) { app.querySelectorAll(".swipe.open").forEach(r => { if (r !== except) {
    r.classList.remove("open");
    r.querySelector(".swipe-in").style.transform = "";
} }); }
app.addEventListener("pointerdown", ev => {
    const inn = ev.target.closest(".swipe-in");
    if (!inn) {
        if (!ev.target.closest(".swipe-act") && app.querySelector(".swipe.open")) {
            closeSwipes();
            swipeBlockUntil = Date.now() + 350;
        }
        return;
    }
    const row = inn.parentElement;
    if (row.classList.contains("open") || app.querySelector(".swipe.open")) {
        // like iOS: a touch on any row while one is open just closes it
        closeSwipes();
        swipeBlockUntil = Date.now() + 350;
        if (row.classList.contains("open")) {
            row.classList.remove("open");
            inn.style.transform = "";
            return;
        }
    }
    const openW = parseInt(row.dataset.w || "") || SW_OPEN;
    sw = { inn, row, x0: ev.clientX, y0: ev.clientY, base: row.classList.contains("open") ? -openW : 0, dir: "", x: 0, pid: ev.pointerId, w: row.getBoundingClientRect().width, openW, full: !!row.dataset.full };
    clearLp();
    if (inn.dataset.lp && !row.classList.contains("open")) {
        const spec = inn.dataset.lp;
        lpTimer = setTimeout(() => { lpTimer = null; if (sw && !sw.dir) {
            sw = null;
            lpPending = true;
            haptic();
            longPress(spec);
        } }, 480);
    }
});
app.addEventListener("pointermove", ev => {
    if (!sw || ev.pointerId !== sw.pid)
        return;
    const dx = ev.clientX - sw.x0, dy = ev.clientY - sw.y0;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8)
        clearLp();
    if (!sw.dir) {
        if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * 1.2) {
            sw.dir = "h";
            try {
                sw.inn.setPointerCapture(sw.pid);
            }
            catch { }
            sw.row.classList.add("swiping");
        }
        else if (Math.abs(dy) > 8) {
            sw = null;
            return;
        }
        else
            return;
    }
    sw.x = Math.max(sw.full ? -sw.w * 0.95 : -(sw.openW + 40), Math.min(0, sw.base + dx));
    sw.inn.style.transform = `translateX(${sw.x}px)`;
    sw.row.classList.toggle("full", sw.full && sw.x < -sw.w * 0.6);
});
const endSwipe = (ev) => {
    clearLp();
    if (!sw || ev.pointerId !== sw.pid)
        return;
    const g = sw;
    sw = null;
    if (g.dir !== "h")
        return;
    swipeBlockUntil = Date.now() + 350;
    g.row.classList.remove("swiping");
    if (g.full && g.x < -g.w * 0.6) {
        haptic();
        g.row.querySelector(".swipe-act.del").click();
        return;
    } // full swipe = delete
    const open = g.x < -g.openW / 2;
    g.row.classList.toggle("open", open);
    g.row.classList.remove("full");
    g.inn.style.transform = open ? `translateX(${-g.openW}px)` : "";
    if (open) {
        closeSwipes(g.row);
        haptic();
    }
};
app.addEventListener("pointerup", endSwipe);
app.addEventListener("pointerup", () => { if (lpPending) {
    lpPending = false;
    lpBlockUntil = Date.now() + 150;
} }, true);
document.addEventListener("pointerup", () => { if (lpPending) {
    lpPending = false;
    lpBlockUntil = Date.now() + 150;
} }, true);
app.addEventListener("pointercancel", endSwipe);
// a click right after a swipe (or tapping away from an open row) must not open the row
app.addEventListener("click", ev => {
    const tg = ev.target;
    // after a long-press, only the row's own release-click is swallowed (the menu that opened stays tappable)
    // the finger lifting after a long-press sends one click to whatever is under it now (often the menu backdrop): drop exactly that one
    if (Date.now() < lpBlockUntil) {
        lpBlockUntil = 0;
        ev.stopPropagation();
        ev.preventDefault();
        return;
    }
    if (Date.now() < swipeBlockUntil && !tg.closest(".swipe-act")) {
        ev.stopPropagation();
        ev.preventDefault();
    }
}, true);
// behave like an app: no double-tap or pinch zoom
document.addEventListener("gesturestart", e => e.preventDefault());
document.addEventListener("dblclick", e => e.preventDefault(), { passive: false });
/* drag to reorder: grab the handle, move, release */
let drag = null;
app.addEventListener("pointerdown", ev => {
    const hd = ev.target.closest("[data-handle]");
    if (!hd)
        return;
    const item = hd.closest(".sort-item");
    const list = item?.parentElement;
    if (!item || !list?.classList.contains("sortable"))
        return;
    ev.preventDefault();
    const items = Array.from(list.children).filter(c => c.classList.contains("sort-item"));
    const rects = items.map(x => x.getBoundingClientRect());
    const from = items.indexOf(item);
    const gap = items.length > 1 ? Math.max(0, rects[1].top - rects[0].bottom) : 0;
    const scroller = list.closest(".scroll, .sheet");
    drag = { list, items, rects, from, to: from, item, scroller, startY: ev.clientY, lastY: ev.clientY, startScroll: scroller ? scroller.scrollTop : 0, step: rects[from].height + gap, pid: ev.pointerId, raf: 0 };
    try {
        hd.setPointerCapture(ev.pointerId);
    }
    catch { }
    item.classList.add("dragging");
    list.classList.add("sorting");
    haptic();
    const loop = () => { if (!drag)
        return; const sc = drag.scroller; if (sc) {
        const r = sc.getBoundingClientRect();
        if (drag.lastY < r.top + 70)
            sc.scrollTop -= 8;
        else if (drag.lastY > r.bottom - 70)
            sc.scrollTop += 8;
    } layoutDrag(); drag.raf = requestAnimationFrame(loop); };
    drag.raf = requestAnimationFrame(loop);
});
function layoutDrag() {
    const g = drag;
    const ds = (g.scroller ? g.scroller.scrollTop : 0) - g.startScroll;
    const dy = g.lastY - g.startY + ds;
    g.item.style.transform = `translateY(${dy}px)`;
    const c = g.rects[g.from].top + g.rects[g.from].height / 2 + dy;
    const to = g.rects.filter((r, i) => i !== g.from && r.top + r.height / 2 < c).length;
    g.items.forEach((el, i) => {
        if (i === g.from)
            return;
        const sh = g.from < to && i > g.from && i <= to ? -g.step : g.from > to && i < g.from && i >= to ? g.step : 0;
        el.style.transform = sh ? `translateY(${sh}px)` : "";
    });
    if (to !== g.to) {
        g.to = to;
        haptic();
    }
}
app.addEventListener("pointermove", ev => { if (drag && ev.pointerId === drag.pid) {
    drag.lastY = ev.clientY;
    ev.preventDefault();
} });
const endDrag = async (ev) => {
    if (!drag || ev.pointerId !== drag.pid)
        return;
    const g = drag;
    drag = null;
    cancelAnimationFrame(g.raf);
    g.items.forEach((el) => { el.style.transform = ""; });
    g.item.classList.remove("dragging");
    g.list.classList.remove("sorting");
    if (g.to !== g.from) {
        await reorder(g.list.dataset, g.from, g.to);
    }
    render();
};
app.addEventListener("pointerup", endDrag);
app.addEventListener("pointercancel", endDrag);
/* swipe between exercises */
let sx = null, sy = 0;
app.addEventListener("touchstart", e => { if (!e.target.closest("#wkbody") || A.sheet)
    return; sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
app.addEventListener("touchend", async (e) => {
    const s = activeSession();
    if (sx == null || !s)
        return;
    const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    sx = null;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        const j = s.idx + (dx < 0 ? 1 : -1);
        if (j >= 0 && j < s.exercises.length) {
            s.idx = j;
            await saveSession(s);
            render();
            centerStrip();
        }
    }
}, { passive: true });
/* ticking: clock + rest timer, without re-rendering the whole screen */
setInterval(() => {
    const s = activeSession();
    syncRestPush(s);
    if (!s)
        return;
    if (s.rest && !s.rest.buzzed && s.rest.endsAt <= now()) {
        s.rest.buzzed = true;
        restAlert(s);
        saveSession(s);
    }
    if (A.sheet || drag)
        return;
    app.querySelectorAll("[data-clock]").forEach(n => n.textContent = (route().v === "workout" && s.pausedAt ? t("paused") + " · " : "") + clock(elapsed(s)));
    const rb = app.querySelector("[data-restbar]");
    if (s.rest && rb) {
        const l = s.rest.endsAt - now();
        rb.querySelector(".t").textContent = l > 0 ? clock(l) : t("restDone");
        rb.classList.toggle("over", l <= 0);
        rb.querySelector(".bar i").style.width = Math.max(0, Math.min(1, l / (s.rest.total * 1000))) * 100 + "%";
    }
    else if (route().v === "workout" && !!s.rest !== !!rb)
        render();
    const mr = app.querySelector("[data-rest]");
    if (mr)
        mr.textContent = s.rest ? t("rest") + " " + restLeft(s) : "›";
}, 250);
/* service worker */
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    navigator.serviceWorker.register("./sw.js").catch(() => { });
}
boot();
window.__logbook = { preprocess }; // test hook: image clean-up used before OCR
