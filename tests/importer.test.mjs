import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReps, parseRest, parseExerciseLine, parseAny, parseLog, readXlsx, matchExercise, matchAll, buildProgramFromPlan, buildSessionsFromLog, dayName, cleanLine } from "../public/js/importer.js";
import { seedExercises } from "../public/js/seed.js";
import { suggest } from "../public/js/domain.js";

const lib = seedExercises(0); const libMap = new Map(lib.map(e => [e.id, e]));
const nm = id => libMap.get(id)?.name.en ?? null;

test("reps: ranges, lists, pyramids, AMRAP, time", () => {
  assert.deepEqual(parseReps("8-10", 2).map(s => [s.min, s.max]), [[8, 10], [8, 10]]);
  assert.deepEqual(parseReps("7, 8-10", 3).map(s => [s.min, s.max]), [[7, 7], [8, 10], [8, 10]]);
  assert.deepEqual(parseReps("Max/8", 2).map(s => [s.type, s.min]), [["amrap", 8], ["amrap", 8]]);
  assert.equal(parseReps("1 min", 3)[0].mins, 1);
  assert.equal(parseReps("45 sec", 1)[0].mins, 0.75);
});
test("rest: 120\" · 90s · 1'30 · 2 min · 1:30", () => {
  assert.equal(parseRest('120"'), 120); assert.equal(parseRest("90s"), 90); assert.equal(parseRest("1'30"), 90);
  assert.equal(parseRest("2 min"), 120); assert.equal(parseRest("1:30"), 90); assert.equal(parseRest("60"), 60);
});
test("OCR-style table line with row number, muscle column and noise", () => {
  const it = parseExerciseLine('3 Petto Panca piana bilanciere 3-7, 8-10 (Piramidale 120"');
  assert.equal(it.name, "Panca piana bilanciere"); assert.equal(it.muscle, "chest");
  assert.deepEqual(it.sets.map(s => s.min), [7, 8, 8]); assert.equal(it.rest, 120); assert.match(it.notes, /Piramidale/);
  const b = parseExerciseLine('& Tricipiti French Press EZ 3 10-12 60"');
  assert.equal(b.name, "French Press EZ"); assert.equal(b.muscle, "triceps");
  assert.equal(parseExerciseLine("Squat 4x6-8 3'").rest, 180);
  assert.equal(parseExerciseLine("Muscolo Esercizio Set Ripetizioni Recupero"), null);
});
test("day headers, with OCR misreads", () => {
  assert.equal(dayName("di LUNEDÌ {PUSH A)"), "Lunedì (Push A)");
  assert.equal(dayName("BREE SABATO (PULL 8 - SPESSORE)"), "Sabato (Pull B - Spessore)");
  assert.equal(cleanLine("12. Dorso | Rematore"), "Dorso Rematore");
});
test("free-text plan with days → matched exercises", () => {
  const r = parseAny("GIORNO 1 (PUSH)\nPetto Panca piana 3 8-10 90\"\nSpalle Alzate laterali ai cavi 4 12-15 60\"\nGIORNO 2 (GAMBE)\nGambe Leg press 4 10 120\"\nCore Plank 3 1 min 60\"");
  assert.equal(r.kind, "plan"); matchAll(r.days, null, lib, new Set());
  assert.deepEqual(r.days.map(d => d.name), ["Giorno 1 (Push)", "Giorno 2 (Gambe)"]);
  assert.deepEqual(r.days[0].items.map(i => nm(i.exId)), ["Bench Press", "Cable Lateral Raise"]);
  assert.deepEqual(r.days[1].items.map(i => nm(i.exId)), ["Leg Press", "Plank"]);
});
test("matching: Italian names, OCR typos, glued words, no false friends", () => {
  const m = n => nm(matchExercise(n, lib).id);
  assert.equal(m("Pushdewn cavo"), "Triceps Pushdown");
  assert.equal(m("Pancapianabilanciere"), "Bench Press");
  assert.equal(m("Lento avanti seduto al Multipower"), "Smith Shoulder Press");
  assert.equal(m("Dips (Parallele)"), "Dips");
  assert.equal(m("Facepull"), "Face Pull");
  assert.equal(matchExercise("Row presa singola", lib).id, null);   // "presa" must not match "Pressa"
  assert.equal(nm(matchExercise("Romanian deadlift", lib, new Set(["ex_dbrdl"])).id), "Dumbbell Romanian Deadlift"); // tie → the one you use
});
test("CSV / TSV paste with header and day column", () => {
  const r = parseAny("Day\tExercise\tSets\tReps\tRest\nA\tSquat\t4\t6-8\t3 min\nA\tTreadmill\t1\t20 min\t\nB\tBench press\t3\t8-10\t120");
  matchAll(r.days, null, lib, new Set());
  assert.deepEqual(r.days.map(d => d.name), ["A", "B"]);
  assert.equal(r.days[0].items[1].sets[0].mins, 20); assert.equal(r.days[0].items[0].rest, 180);
  assert.equal(nm(r.days[1].items[0].exId), "Bench Press");
});
test("notebook log: warm-up, RIR, superset, optional, separators", () => {
  const txt = "Squat\n0’ 5 - 40 KG (riscaldamento)\n1’ 8 - 60 KG 2 RIR\n2’ 8 - 65 KG\n\nLat pulldown / face pulls\n1’ 10 - 50 / 12 - 15\n\n(Hammer curl\n1’ 10 - 12 KG)\n————\nJump rope\n1’ 100\n2’ 120";
  const s = parseLog(txt);
  assert.equal(s.length, 2);
  const [sq, lp, fp, hc] = s[0].exercises;
  assert.deepEqual(sq.sets.map(x => [x.type, x.load, x.reps, x.rir]), [["warmup", 40, 5, null], ["working", 60, 8, 2], ["working", 65, 8, null]]);
  assert.equal(lp.group, "A"); assert.equal(fp.group, "A"); assert.deepEqual([lp.sets[0].load, fp.sets[0].load, fp.sets[0].reps], [50, 15, 12]);
  assert.equal(hc.optional, true);
  assert.deepEqual(s[1].exercises[0].sets.map(x => x.reps), [100, 120]);
  matchAll(null, s, lib, new Set()); assert.equal(nm(s[1].exercises[0].exId), "Jump Rope");
});
test("Logbook CSV export round-trips into sessions", () => {
  const csv = "date,session_id,day,exercise,exercise_it,set,type,load_kg,reps,rir,rpe,done,target_reps_min,target_reps_max,target_rir,date_unknown,minutes\n2026-11-10T08:00:00.000Z,s1,Push,Bench Press,Panca piana,1,working,80,8,2,8,1,8,10,2,0,\n2026-11-10T08:00:00.000Z,s1,Push,Bench Press,Panca piana,2,working,85,6,1,9,1,8,10,1,0,\n2026-11-10T08:00:00.000Z,s1,Push,Treadmill,Tapis roulant,1,working,0,0,,,1,,,,0,15";
  const r = parseAny(csv); assert.equal(r.kind, "log");
  assert.equal(r.sessions[0].date, "2026-11-10");
  assert.deepEqual(r.sessions[0].exercises[0].sets.map(x => [x.load, x.reps]), [[80, 8], [85, 6]]);
  assert.equal(r.sessions[0].exercises[1].sets[0].mins, 15);
});

// a minimal .xlsx (stored zip, shared strings, merged-looking day rows)
function zip(files) {
  const enc = new TextEncoder(); const parts = []; const central = []; let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const nb = enc.encode(name), data = enc.encode(text);
    const lh = new DataView(new ArrayBuffer(30)); lh.setUint32(0, 0x04034b50, true); lh.setUint16(8, 0, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, nb.length, true);
    parts.push(new Uint8Array(lh.buffer), nb, data);
    const ch = new DataView(new ArrayBuffer(46)); ch.setUint32(0, 0x02014b50, true); ch.setUint16(10, 0, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, nb.length, true); ch.setUint32(42, off, true);
    central.push(new Uint8Array(ch.buffer), nb); off += 30 + nb.length + data.length;
  }
  const csize = central.reduce((a, p) => a + p.length, 0);
  const e = new DataView(new ArrayBuffer(22)); e.setUint32(0, 0x06054b50, true); e.setUint16(8, Object.keys(files).length, true); e.setUint16(10, Object.keys(files).length, true); e.setUint32(12, csize, true); e.setUint32(16, off, true);
  const all = [...parts, ...central, new Uint8Array(e.buffer)]; const out = new Uint8Array(all.reduce((a, p) => a + p.length, 0)); let k = 0; for (const p of all) { out.set(p, k); k += p.length; } return out.buffer;
}
test("Excel .xlsx: shared strings, inline strings, numbers, day rows", async () => {
  const ss = ["Esercizio", "Set", "Ripetizioni", "Recupero", "LUNEDÌ (PUSH A)", "Panca piana", "8-10", "90\"", "Plank", "1 min"];
  const sst = `<sst>${ss.map(x => `<si><t>${x.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}</t></si>`).join("")}</sst>`;
  const c = (r, s) => `<c r="${r}" t="s"><v>${s}</v></c>`;
  const sheet = `<worksheet><sheetData><row r="1">${c("A1", 0)}${c("B1", 1)}${c("C1", 2)}${c("D1", 3)}</row><row r="2">${c("A2", 4)}</row>
    <row r="3">${c("A3", 5)}<c r="B3"><v>3</v></c>${c("C3", 6)}${c("D3", 7)}</row><row r="4">${c("A4", 8)}<c r="B4"><v>3</v></c>${c("C4", 9)}<c r="D4" t="inlineStr"><is><t>60"</t></is></c></row></sheetData></worksheet>`;
  const rows = await readXlsx(zip({ "xl/sharedStrings.xml": sst, "xl/worksheets/sheet1.xml": sheet }));
  assert.deepEqual(rows[2], ["Panca piana", "3", "8-10", '90"']);
  const r = parseAny("", rows); matchAll(r.days, null, lib, new Set());
  assert.equal(r.days[0].name, "Lunedì (Push A)");
  assert.deepEqual(r.days[0].items.map(i => [nm(i.exId), i.sets.length, i.rest]), [["Bench Press", 3, 90], ["Plank", 3, 60]]);
  assert.equal(r.days[0].items[1].sets[0].mins, 1);
});
test("build program: new exercises created once, cardio/time templates", () => {
  const r = parseAny("DAY A\nRow presa singola 3 10 90\"\nTapis roulant 1 20 min\nRow presa singola 2 12 60\"");
  matchAll(r.days, null, lib, new Set());
  const { program, created } = buildProgramFromPlan(r.days, "Test", 1, libMap);
  assert.equal(created.length, 1); assert.equal(created[0].name.it, "Row presa singola");
  const ex = program.days[0].exercises;
  assert.equal(ex[0].exId, ex[2].exId); assert.equal(ex[0].rest, 90);
  assert.equal(nm(ex[1].exId), "Treadmill"); assert.equal(ex[1].sets[0].mins, 20); assert.equal(ex[1].sets[0].rir, null);
});
test("build sessions from log keep date or flag unknown", () => {
  const s = parseLog("Panca\n1' 8 - 80 KG\n————\n12/11/2026\nSquat\n1' 5 - 100 KG");
  matchAll(null, s, lib, new Set());
  const { sessions } = buildSessionsFromLog(s, Date.UTC(2026, 10, 17), libMap);
  assert.equal(sessions[0].dateUnknown, true); assert.equal(sessions[1].dateUnknown, false);
  assert.equal(new Date(sessions[1].startedAt).getDate(), 12);
});
test("no '+0 kg' suggestions: bodyweight at top of range → raise reps instead", () => {
  const T = { repsMin: 80, repsMax: 100, rir: null };
  const g = suggest([{ type: "working", load: 0, reps: 100, rir: null, done: true, t: T }], 0);
  assert.equal(g.kind, "reps"); assert.equal(g.topNoLoad, true); assert.deepEqual(g.loads, [0]);
});
test("library: cardio + time/reps tracking seeded", () => {
  assert.equal(libMap.get("ex_treadmill").track, "time"); assert.equal(libMap.get("ex_rope").track, "reps");
  assert.equal(libMap.get("ex_plank").track, "time"); assert.equal(libMap.get("ex_bench").track, "wr");
});
