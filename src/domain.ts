// Pure training calculations. No DOM, no storage: unit-tested in tests/domain.test.mjs.

export type SetType = "warmup" | "working" | "top" | "backoff" | "amrap" | "drop";

export interface LoggedSet {
  type: SetType;
  load: number;
  reps: number;
  rir: number | null;
  done: boolean;
  t?: { repsMin: number; repsMax: number; rir: number | null };
}

export const isWork = (s: { type: SetType }) => s.type !== "warmup";

export const round2 = (n: number) => Math.round(n * 100) / 100;

export function fmt(n: number | null | undefined): string {
  if (n == null || isNaN(n as number)) return "–";
  return String(round2(n as number));
}

/** Effort-adjusted reps: the set re-expressed as if stopped at the target RIR. */
export function adjReps(reps: number, rir: number | null, targetRir: number | null): number {
  if (rir == null || targetRir == null) return reps;
  return reps + (rir - targetRir);
}

/** Epley e1RM, counting RIR as reps still in the tank. null when unreliable (reps + RIR > 15) or no load. */
export function e1rm(load: number, reps: number, rir: number | null): number | null {
  if (!(load > 0) || !(reps > 0)) return null;
  const r = reps + (rir ?? 0);
  if (r > 15) return null;
  return load * (1 + r / 30);
}

/** Uncapped Epley, used only for progression predictions (always shown as approximate). */
export function e1rmRaw(load: number, reps: number, rir: number | null): number | null {
  if (!(load > 0) || !(reps > 0)) return null;
  return load * (1 + (reps + (rir ?? 0)) / 30);
}

/** Reps predicted at a new load for a given e1RM, at the target RIR. */
export function predictReps(e1: number, load: number, targetRir: number): number {
  return 30 * (e1 / load - 1) - targetRir;
}

export function volumeLoad(sets: LoggedSet[]): number {
  return sets.filter(s => s.done && isWork(s)).reduce((a, s) => a + (s.load || 0) * (s.reps || 0), 0);
}

export interface Suggestion {
  kind: "up" | "reps" | "hold";
  loads: number[];          // proposed load per working set, in order
  adj: number[];            // effort-adjusted reps per working set
  setNo: number | null;     // 1-based working-set number that limited the decision
  limitAdj: number | null;
  limitTarget: number | null;
  harder: boolean;          // limiting set was harder (lower RIR) than planned
  unknownEffort: boolean;   // some sets had no RIR logged
  inc: number;
  predicted: number | null; // predicted reps at the new top-set load (kind "up")
  predRir: number | null;
}

/**
 * Effort-aware double progression.
 * up   : every working set reached the top of its range at (or easier than) target effort
 * reps : every set within range, at least one short of the top
 * hold : at least one set below range
 */
export function suggest(sets: LoggedSet[], inc: number): Suggestion | null {
  const ws = sets.filter(s => s.done && isWork(s) && s.t);
  if (!ws.length) return null;
  let unknownEffort = false;
  const adj = ws.map(s => {
    if (s.rir == null || s.t!.rir == null) unknownEffort = true;
    return adjReps(s.reps, s.rir, s.t!.rir);
  });
  const loads = ws.map(s => s.load);
  const base: Suggestion = { kind: "hold", loads, adj, setNo: null, limitAdj: null, limitTarget: null, harder: false, unknownEffort, inc, predicted: null, predRir: null };
  const allTop = ws.every((s, i) => adj[i] >= s.t!.repsMax);
  if (allTop) {
    const twoSteps = ws.every((s, i) => adj[i] >= s.t!.repsMax + 2);
    let step = inc;
    // two increments only if predicted reps at the heavier top-set load stay in range
    const topIdx = loads.indexOf(Math.max(...loads));
    const top = ws[topIdx];
    const e = e1rmRaw(top.load, top.reps, top.rir);
    if (twoSteps && e && inc > 0) {
      const p2 = predictReps(e, top.load + 2 * inc, top.t!.rir ?? 0);
      if (p2 >= top.t!.repsMin) step = 2 * inc;
    }
    const pred = e && inc > 0 ? predictReps(e, top.load + step, top.t!.rir ?? 0) : null;
    return { ...base, kind: "up", loads: loads.map(l => round2(l + step)), inc: step, predicted: pred == null ? null : Math.floor(pred * 10) / 10, predRir: top.t!.rir ?? 0 };
  }
  const allMin = ws.every((s, i) => adj[i] >= s.t!.repsMin);
  const pick = (pred: (i: number) => boolean) => {
    const i = ws.findIndex((_, j) => pred(j));
    return i;
  };
  if (allMin) {
    const i = pick(j => adj[j] < ws[j].t!.repsMax);
    return { ...base, kind: "reps", setNo: i + 1, limitAdj: adj[i], limitTarget: ws[i].t!.repsMax };
  }
  const i = pick(j => adj[j] < ws[j].t!.repsMin);
  const s = ws[i];
  return { ...base, kind: "hold", setNo: i + 1, limitAdj: adj[i], limitTarget: s.t!.repsMin, harder: s.rir != null && s.t!.rir != null && s.rir < s.t!.rir };
}

/** Weekly-style set counting for a muscle. method: fractional (secondary 0.5), direct (0), total (1). */
export function muscleSets(
  entries: { muscles: { m: string; role: "primary" | "secondary" }[]; hardSets: number }[],
  muscle: string,
  method: "fractional" | "direct" | "total" = "fractional"
): number {
  const sw = method === "fractional" ? 0.5 : method === "direct" ? 0 : 1;
  let n = 0;
  for (const e of entries) {
    const r = e.muscles.find(x => x.m === muscle);
    if (!r) continue;
    n += e.hardSets * (r.role === "primary" ? 1 : sw);
  }
  return n;
}

export function uid(): string {
  // UUIDv7-like: time-ordered, random tail
  const t = Date.now().toString(16).padStart(12, "0");
  const r = Array.from({ length: 20 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `${t.slice(0, 8)}-${t.slice(8, 12)}-7${r.slice(0, 3)}-${r.slice(3, 7)}-${r.slice(7, 19)}`;
}

export function clock(ms: number): string {
  ms = Math.max(0, ms);
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : String(m)) + ":" + String(x).padStart(2, "0");
}

export function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
