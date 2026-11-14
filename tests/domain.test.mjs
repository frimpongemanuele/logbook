import { test } from "node:test";
import assert from "node:assert/strict";
import { suggest, e1rm, predictReps, adjReps, volumeLoad, muscleSets } from "../public/js/domain.js";
import { setsCsv, mergeImport } from "../public/js/data.js";
import { seedExercises, buildProgram, buildHistory, emptyProgram } from "../public/js/seed.js";

const T = { repsMin: 8, repsMax: 12, rir: 2 };
const three = (reps, rir, load = 80) => reps.map((r, i) => ({ type: "working", load, reps: r, rir: Array.isArray(rir) ? rir[i] : rir, done: true, t: T }));
const close = (a, b, eps = 0.05) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test("e1RM: 80 kg × 12 @ RIR 2 = 117.3 kg (plan, section 8)", () => close(e1rm(80, 12, 2), 117.33));
test("e1RM unreliable above 15 reps-to-failure", () => assert.equal(e1rm(50, 14, 2), null));
test("predicted reps at 82.5 kg after 80×12@2 ≈ 10.7", () => close(predictReps(e1rm(80, 12, 2), 82.5, 2), 10.67));
test("effort-adjusted reps", () => { assert.equal(adjReps(12, 0, 2), 10); assert.equal(adjReps(12, 4, 2), 14); assert.equal(adjReps(12, null, 2), 12); });

test("case A: 12,12,12 @2 → +2.5 kg", () => {
  const g = suggest(three([12, 12, 12], 2), 2.5);
  assert.equal(g.kind, "up"); assert.deepEqual(g.loads, [82.5, 82.5, 82.5]); assert.equal(Math.floor(g.predicted), 10);
});
test("case B: 12,12,12 @0 → hold (reps hit by grinding)", () => {
  const g = suggest(three([12, 12, 12], 0), 2.5);
  assert.notEqual(g.kind, "up"); assert.deepEqual(g.loads, [80, 80, 80]); assert.equal(g.limitAdj, 10);
});
test("case C: 12,12,12 @4 → two increments (85 kg), predicted ~11", () => {
  const g = suggest(three([12, 12, 12], 4), 2.5);
  assert.equal(g.kind, "up"); assert.deepEqual(g.loads, [85, 85, 85]); assert.equal(Math.floor(g.predicted), 11);
});
test("case D: 12,11,10 @2 → same load, add reps; set 2 limits", () => {
  const g = suggest(three([12, 11, 10], 2), 2.5);
  assert.equal(g.kind, "reps"); assert.equal(g.setNo, 2);
});
test("case E: no RIR logged → up, flagged effort unknown", () => {
  const g = suggest(three([12, 12, 12], null), 2.5);
  assert.equal(g.kind, "up"); assert.equal(g.unknownEffort, true);
});
test("below range and harder than planned → hold", () => {
  const g = suggest(three([7, 12, 12], [0, 2, 2]), 2.5);
  assert.equal(g.kind, "hold"); assert.equal(g.setNo, 1); assert.equal(g.harder, true);
});
test("warm-ups and unticked sets are ignored", () => {
  const sets = [{ type: "warmup", load: 40, reps: 5, rir: null, done: true, t: T }, ...three([12, 12], 2), { type: "working", load: 80, reps: 3, rir: 0, done: false, t: T }];
  assert.equal(suggest(sets, 2.5).kind, "up");
  assert.equal(volumeLoad(sets), 80 * 12 * 2);
});
test("volume load: 80×12, 80×11, 80×10 = 2,640 kg", () => assert.equal(volumeLoad(three([12, 11, 10], 2)), 2640));
test("fractional sets: 4 bench + 3 pushdowns → triceps 5 / 3 / 7", () => {
  const e = [{ muscles: [{ m: "chest", role: "primary" }, { m: "triceps", role: "secondary" }], hardSets: 4 }, { muscles: [{ m: "triceps", role: "primary" }], hardSets: 3 }];
  assert.equal(muscleSets(e, "triceps", "fractional"), 5); assert.equal(muscleSets(e, "triceps", "direct"), 3); assert.equal(muscleSets(e, "triceps", "total"), 7);
});

// seed builders, on a synthetic log (no personal data in this repo)
const now = Date.UTC(2026, 0, 1);
const ex = seedExercises(now); const lib = new Map(ex.map(e => [e.id, e]));
const LOG = [
  { en: "Push", it: "Push", ex: [{ k: "bench", sets: [[60, 10, 2], [65, 8, 1], [70, 6, null]] }, { k: "pd", sets: [[20, 12, 2], [20, 12, null]] }] },
  { en: "Pull", it: "Pull", ex: [{ k: "latpd", group: "A", sets: [[50, 10, null]] }, { k: "facepull", group: "A", sets: [[15, 12, null]] }, { k: "hammer", optional: true, sets: [[10, 10, null]] }] },
  { en: "Legs", it: "Gambe", ex: [{ k: "squat", sets: [[40, 5, null, "w"], [60, 8, 2], [70, 8, null]] }, { k: "pullup", sets: [[0, 8, null]] }] },
];
const prog = buildProgram(LOG, now, "Test"); const hist = buildHistory(LOG, now, prog, lib);
test("library: 56 exercises, all ids unique, EN + IT names", () => {
  assert.equal(ex.length, 56); assert.equal(new Set(ex.map(e => e.id)).size, 56);
  assert.ok(ex.every(e => e.name.en && e.name.it && e.muscles.some(m => m.role === "primary")));
});
test("builder: days, exercises exist in library", () => {
  assert.deepEqual(prog.days.map(d => d.name.en), ["Push", "Pull", "Legs"]);
  for (const d of prog.days) for (const pe of d.exercises) assert.ok(lib.has(pe.exId), pe.exId);
});
test("builder: ascending top set, warm-up, superset, optional, targets", () => {
  const b = prog.days[0].exercises[0];
  assert.deepEqual(b.sets.map(s => s.type), ["working", "working", "top"]);
  assert.deepEqual(b.sets.map(s => [s.repsMin, s.repsMax, s.rir]), [[10, 12, 2], [8, 10, 1], [6, 8, 1]]);
  assert.equal(prog.days[2].exercises[0].sets[0].type, "warmup");
  assert.deepEqual(prog.days[1].exercises.filter(e => e.group === "A").map(e => e.exId), ["ex_latpd", "ex_facepull"]);
  assert.equal(prog.days[1].exercises[2].optional, true);
});
test("builder history keeps blank RIR as null, flagged date unknown", () => {
  assert.deepEqual(hist[0].exercises[0].sets.map(s => [s.load, s.reps, s.rir]), [[60, 10, 2], [65, 8, 1], [70, 6, null]]);
  assert.ok(hist.every(h => h.dateUnknown && h.status === "completed"));
});
test("empty program has one empty day", () => { const p = emptyProgram(now); assert.equal(p.days.length, 1); assert.equal(p.days[0].exercises.length, 0); });
test("CSV export: one row per set plus header, Italian names kept", () => {
  const csv = setsCsv(hist, lib).split("\n");
  const n = hist.reduce((a, s) => a + s.exercises.reduce((b, e) => b + e.sets.length, 0), 0);
  assert.equal(csv.length, n + 1);
  assert.ok(csv[1].includes("Bench Press") && csv[1].includes("Panca piana"));
});
test("import merge: no duplicates, newer wins, second active session becomes completed", () => {
  const local = { exercises: ex, programs: [prog], sessions: [...hist, { id: "live", status: "in_progress", updatedAt: 5 }] };
  const inc = { exercises: ex, programs: [{ ...prog, updatedAt: now + 1, name: "renamed" }], sessions: [...hist, { id: "other", status: "in_progress", startedAt: 1, updatedAt: 2 }] };
  const r = mergeImport(local, inc);
  assert.equal(r.added, 1); assert.equal(r.updated, 1); assert.equal(r.kept, ex.length + hist.length);
  assert.equal(r.writes.sessions[0].status, "completed");
  assert.equal(mergeImport(local, local).added, 0);
});
