// Upgrade check: data imported with v0.5/0.6 (AMRAP 8/8 @2, "Piramidale / pyramid" note, OCR day name,
// custom exercises that now exist in the library) is repaired on first launch of v0.7.
import { createRequire } from "module"; import { execSync, spawn } from "child_process";
const require = createRequire(import.meta.url);
const { chromium } = require(execSync("npm root -g").toString().trim() + "/playwright");
const srv = spawn("python3", ["-m", "http.server", "8771", "-d", "public"], { stdio: "ignore" });
await new Promise(r => setTimeout(r, 700));
const b = await chromium.launch(); const page = await (await b.newContext()).newPage();
await page.goto("http://localhost:8771/manifest.webmanifest");
await page.evaluate(() => new Promise(res => {
  const r = indexedDB.open("logbook", 1);
  r.onupgradeneeded = () => { const d = r.result; for (const n of ["exercises", "programs", "meta"]) d.createObjectStore(n, { keyPath: n === "meta" ? "key" : "id" }); const s = d.createObjectStore("sessions", { keyPath: "id" }); s.createIndex("startedAt", "startedAt"); s.createIndex("status", "status"); };
  r.onsuccess = () => {
    const tx = r.result.transaction(["exercises", "programs", "sessions"], "readwrite");
    const ex = tx.objectStore("exercises");
    ex.put({ id: "ex_c_row", name: { en: "Row presa singola", it: "Row presa singola" }, aliases: [], equipment: "machine", loadType: "external", inc: 5, rest: 90, muscles: [{ m: "back", role: "primary" }], custom: true, archived: false, track: "wr" });
    ex.put({ id: "ex_c_rope", name: { en: "Rope jumping", it: "Rope jumping" }, aliases: [], equipment: "bodyweight", loadType: "bodyweight", inc: 0, rest: 60, muscles: [], custom: true, archived: false, track: "reps" });
    tx.objectStore("programs").put({ id: "p1", name: "Scheda", status: "active", nextDay: 0, createdAt: 1, updatedAt: 1, days: [{ id: "d1", name: { en: "Ese 5abato (Pull B - Spessore)", it: "Ese 5abato (Pull B - Spessore)" }, exercises: [
      { id: "pe1", exId: "ex_latpd", sets: [{ id: "s1", type: "amrap", load: null, repsMin: 8, repsMax: 8, rir: 2 }], notes: "", group: null },
      { id: "pe2", exId: "ex_bench", sets: [{ id: "s2", type: "working", load: null, repsMin: 7, repsMax: 7, rir: 2 }], notes: "Piramidale / pyramid", group: null },
      { id: "pe3", exId: "ex_c_row", sets: [{ id: "s3", type: "working", load: null, repsMin: 10, repsMax: 10, rir: 2 }], notes: "", group: null } ] }] });
    tx.objectStore("sessions").put({ id: "w1", status: "completed", startedAt: 5, endedAt: 6, pausedMs: 0, dayName: { en: "Pull", it: "Pull" }, suggestions: [], exercises: [
      { id: "e1", exId: "ex_c_rope", plannedExId: "ex_c_rope", name: { en: "Rope jumping", it: "Rope jumping" }, sets: [{ type: "working", load: 0, reps: 100, rir: null, done: true }] },
      { id: "e2", exId: "ex_c_row", plannedExId: "ex_c_row", name: { en: "Row presa singola", it: "Row presa singola" }, sets: [{ type: "working", load: 40, reps: 10, rir: 2, done: true }] }] });
    tx.oncomplete = () => { r.result.close(); res(); };
  };
}));
await page.goto("http://localhost:8771/"); await page.waitForTimeout(900);
const db = await page.evaluate(() => new Promise(res => { const r = indexedDB.open("logbook"); r.onsuccess = () => { const out = {}; const tx = r.result.transaction(["exercises", "programs", "sessions"]); let n = 0;
  for (const st of ["exercises", "programs", "sessions"]) { const q = tx.objectStore(st).getAll(); q.onsuccess = () => { out[st] = q.result; if (++n === 3) res(out); }; } }; }));
const p = db.programs[0], [lat, bench, row] = p.days[0].exercises, w = db.sessions[0];
const check = (name, cond) => console.log((cond ? "PASS  " : "FAIL  ") + name);
check("AMRAP 8/8 @2 → 8+ (no ceiling) @0", lat.sets[0].repsMax === null && lat.sets[0].rir === 0);
check("'Piramidale / pyramid' note → Ascending pyramid scheme", bench.scheme === "pyr_asc" && bench.notes === "");
check("Day name 'Ese 5abato (…)' → 'Sabato (Pull B - Spessore)'", p.days[0].name.en === "Sabato (Pull B - Spessore)");
check("Custom 'Row presa singola' merged into Single-Arm Cable Row (program + history)", row.exId === "ex_sarow" && w.exercises[1].exId === "ex_sarow" && db.exercises.find(e => e.id === "ex_c_row").archived);
check("Custom 'Rope jumping' merged into Jump Rope with its history", w.exercises[0].exId === "ex_rope" && db.exercises.find(e => e.id === "ex_c_rope").mergedInto === "ex_rope");
await page.reload(); await page.waitForTimeout(700);
const p2 = await page.evaluate(() => new Promise(res => { const r = indexedDB.open("logbook"); r.onsuccess = () => { const q = r.result.transaction("programs").objectStore("programs").getAll(); q.onsuccess = () => res(q.result[0]); }; }));
check("Second launch changes nothing more (idempotent)", JSON.stringify(p2.days) === JSON.stringify(p.days));
await b.close(); srv.kill();
