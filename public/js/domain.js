// Pure training calculations. No DOM, no storage: unit-tested in tests/domain.test.mjs.
export const isWork = (s) => s.type !== "warmup";
/** No upper rep limit (AMRAP "8+"): load goes up once every set beats the minimum by this many reps. */
export const OPEN_MARGIN = 4;
export const effMax = (t) => (t.repsMax == null ? t.repsMin + OPEN_MARGIN : t.repsMax);
/** 8–10 · 8 · 8+ */
export const fmtRange = (min, max) => (max == null ? `${min}+` : max === min ? `${min}` : `${min}–${max}`);
export const round2 = (n) => Math.round(n * 100) / 100;
export function fmt(n) {
    if (n == null || isNaN(n))
        return "–";
    return String(round2(n));
}
/** Effort-adjusted reps: the set re-expressed as if stopped at the target RIR. */
export function adjReps(reps, rir, targetRir) {
    if (rir == null || targetRir == null)
        return reps;
    return reps + (rir - targetRir);
}
/** Epley e1RM, counting RIR as reps still in the tank. null when unreliable (reps + RIR > 15) or no load. */
export function e1rm(load, reps, rir) {
    if (!(load > 0) || !(reps > 0))
        return null;
    const r = reps + (rir ?? 0);
    if (r > 15)
        return null;
    return load * (1 + r / 30);
}
/** Uncapped Epley, used only for progression predictions (always shown as approximate). */
export function e1rmRaw(load, reps, rir) {
    if (!(load > 0) || !(reps > 0))
        return null;
    return load * (1 + (reps + (rir ?? 0)) / 30);
}
/** Reps predicted at a new load for a given e1RM, at the target RIR. */
export function predictReps(e1, load, targetRir) {
    return 30 * (e1 / load - 1) - targetRir;
}
export function volumeLoad(sets) {
    return sets.filter(s => s.done && isWork(s)).reduce((a, s) => a + (s.load || 0) * (s.reps || 0), 0);
}
/**
 * Effort-aware double progression.
 * up   : every working set reached the top of its range at (or easier than) target effort
 * reps : every set within range, at least one short of the top
 * hold : at least one set below range
 */
export function suggest(sets, inc) {
    const ws = sets.filter(s => s.done && isWork(s) && s.t);
    if (!ws.length)
        return null;
    let unknownEffort = false;
    const adj = ws.map(s => {
        if (s.rir == null || s.t.rir == null)
            unknownEffort = true;
        return adjReps(s.reps, s.rir, s.t.rir);
    });
    const loads = ws.map(s => s.load);
    const openEnded = ws.some(s => s.t.repsMax == null);
    const base = { kind: "hold", loads, adj, setNo: null, limitAdj: null, limitTarget: null, harder: false, unknownEffort, inc, predicted: null, predRir: null, openEnded };
    const allTop = ws.every((s, i) => adj[i] >= effMax(s.t));
    if (allTop && !(inc > 0)) {
        // nothing to add load with (bodyweight / no step): progress by raising the rep target instead
        return { ...base, kind: "reps", setNo: null, limitAdj: null, limitTarget: null, topNoLoad: true };
    }
    if (allTop) {
        const twoSteps = ws.every((s, i) => adj[i] >= effMax(s.t) + 2);
        let step = inc;
        // two increments only if predicted reps at the heavier top-set load stay in range
        const topIdx = loads.indexOf(Math.max(...loads));
        const top = ws[topIdx];
        const e = e1rmRaw(top.load, top.reps, top.rir);
        if (twoSteps && e && inc > 0) {
            const p2 = predictReps(e, top.load + 2 * inc, top.t.rir ?? 0);
            if (p2 >= top.t.repsMin)
                step = 2 * inc;
        }
        const pred = e && inc > 0 ? predictReps(e, top.load + step, top.t.rir ?? 0) : null;
        return { ...base, kind: "up", loads: loads.map(l => round2(l + step)), inc: step, predicted: pred == null ? null : Math.floor(pred * 10) / 10, predRir: top.t.rir ?? 0 };
    }
    const allMin = ws.every((s, i) => adj[i] >= s.t.repsMin);
    const pick = (pred) => {
        const i = ws.findIndex((_, j) => pred(j));
        return i;
    };
    if (allMin) {
        const i = pick(j => adj[j] < effMax(ws[j].t));
        return { ...base, kind: "reps", setNo: i + 1, limitAdj: adj[i], limitTarget: effMax(ws[i].t) };
    }
    const i = pick(j => adj[j] < ws[j].t.repsMin);
    const s = ws[i];
    return { ...base, kind: "hold", setNo: i + 1, limitAdj: adj[i], limitTarget: s.t.repsMin, harder: s.rir != null && s.t.rir != null && s.rir < s.t.rir };
}
/** Weekly-style set counting for a muscle. method: fractional (secondary 0.5), direct (0), total (1). */
export function muscleSets(entries, muscle, method = "fractional") {
    const sw = method === "fractional" ? 0.5 : method === "direct" ? 0 : 1;
    let n = 0;
    for (const e of entries) {
        const r = e.muscles.find(x => x.m === muscle);
        if (!r)
            continue;
        n += e.hardSets * (r.role === "primary" ? 1 : sw);
    }
    return n;
}
export function uid() {
    // UUIDv7-like: time-ordered, random tail
    const t = Date.now().toString(16).padStart(12, "0");
    const r = Array.from({ length: 20 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
    return `${t.slice(0, 8)}-${t.slice(8, 12)}-7${r.slice(0, 3)}-${r.slice(3, 7)}-${r.slice(7, 19)}`;
}
export function clock(ms) {
    ms = Math.max(0, ms);
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : String(m)) + ":" + String(x).padStart(2, "0");
}
export function csvEscape(v) {
    const s = v == null ? "" : String(v);
    return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
