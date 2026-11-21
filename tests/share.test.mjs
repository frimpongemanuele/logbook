import test from "node:test"; import assert from "node:assert/strict";
import { pack, unpack, extractCode, toPayload, validPayload, fromPayload } from "../beta/js/share.js";
import { seedExercises, emptyProgram } from "../beta/js/seed.js";
import { matchExercise } from "../beta/js/importer.js";

const libArr = seedExercises(1); const lib = new Map(libArr.map(e => [e.id, e]));
const M = n => { const m = matchExercise(n, libArr); return m.score >= 0.9 ? m.id : null; };
function sampleProgram() {
  const p = emptyProgram(1); p.name = "Push Pull Legs";
  const bench = lib.get("ex_bench"), cardio = libArr.find(e => e.track === "time");
  p.days = [{ id: "d1", name: { en: "Push", it: "Push" }, exercises: [
    { id: "pe1", exId: bench.id, scheme: "pyr_asc", rest: 120, notes: "slow", sets: [
      { type: "warmup", load: 40, repsMin: 10, repsMax: 10, rir: null }, { type: "amrap", load: 80, repsMin: 8, repsMax: null, rir: 0 }] },
    { id: "pe2", exId: "ex_c_custom1", rest: 60, sets: [{ type: "working", load: 12, repsMin: 10, repsMax: 12, rir: 2 }] },
    { id: "pe3", exId: cardio.id, rest: 0, sets: [{ type: "working", load: null, repsMin: 0, repsMax: null, rir: null, mins: 20 }] },
  ] }];
  return { p, bench, cardio };
}
const lib2 = new Map(lib); lib2.set("ex_c_custom1", { id: "ex_c_custom1", name: { en: "Cable Wizard Fly", it: "Croci mago" }, muscles: [], track: "wr", custom: true });

test("share link round-trips without loads", async () => {
  const { p, bench } = sampleProgram();
  const code = await pack(toPayload(p, lib2, false));
  assert.match(code, /^[A-Za-z0-9_-]+$/);
  assert.equal(extractCode("hey https://x.io/logbook/#share=" + code + " bye"), code);
  const o = await unpack(code); assert.ok(validPayload(o));
  const { program, created } = fromPayload(o, lib, 5, M);
  assert.equal(program.name, "Push Pull Legs"); assert.equal(program.days[0].exercises.length, 3);
  const [e1, e2, e3] = program.days[0].exercises;
  assert.equal(e1.exId, bench.id); assert.equal(e1.scheme, "pyr_asc");
  assert.equal(e1.sets[1].load, null, "weights stripped"); assert.equal(e1.sets[1].repsMax, null); assert.equal(e1.sets[1].rir, 0); assert.equal(e1.sets[1].type, "amrap"); assert.equal(e1.rest, 120);
  assert.equal(program.days[0].name.en, "Push");
  assert.equal(created.length, 1); assert.equal(created[0].name.en, "Cable Wizard Fly"); assert.equal(e2.exId, created[0].id);
  assert.equal(e3.sets[0].mins, 20);
  assert.notEqual(program.id, p.id); assert.notEqual(program.status, "active");
});
test("share link keeps loads when asked", async () => {
  const { p } = sampleProgram();
  const o = await unpack(await pack(toPayload(p, lib2, true)));
  const { program } = fromPayload(o, lib, 5, M);
  assert.equal(program.days[0].exercises[0].sets[1].load, 80);
});
test("garbage codes are rejected", async () => {
  assert.equal(extractCode("no link here"), null);
  await assert.rejects(unpack("AAAAAAAAAAAAAAAAAAAAAAAAAA"));
  assert.equal(validPayload({ v: 1, app: "other" }), false);
});
test("a friend's built-in exercise that I deleted is matched back by name", async () => {
  const { p } = sampleProgram();
  const mine = new Map(lib); mine.delete("ex_bench");
  const o = await unpack(await pack(toPayload(p, lib2, false)));
  const { program, created } = fromPayload(o, mine, 5, n => { const m = matchExercise(n, [...mine.values()]); return m.score >= 0.9 ? m.id : null; });
  assert.equal(created.filter(c => c.name.en === "Bench Press").length, 1, "recreated as custom, not merged into a different exercise");
  assert.equal(program.days[0].exercises.length, 3);
});

test("treadmill speed and incline survive sharing and CSV", async () => {
  const tm = lib.get("ex_treadmill"); assert.deepEqual(tm.extras, ["speed", "incline"]);
  const p = emptyProgram(1); p.days[0].exercises = [{ id: "pe9", exId: "ex_treadmill", rest: 0, sets: [{ type: "working", load: null, repsMin: 0, repsMax: 0, rir: null, mins: 20, speed: 6.5, incline: 2 }] }];
  const o = await unpack(await pack(toPayload(p, lib, false)));
  const { program } = fromPayload(o, lib, 5, M);
  assert.deepEqual([program.days[0].exercises[0].sets[0].mins, program.days[0].exercises[0].sets[0].speed, program.days[0].exercises[0].sets[0].incline], [20, 6.5, 2]);
});
