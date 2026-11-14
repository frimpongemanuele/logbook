// Seed data: the exercise library (EN + IT names) and an empty starter program. No personal data lives in this repo.
import { uid, SetType } from "./domain.js";

// key, English, Italian, aliases, equipment, pattern, mechanic, loadType, increment kg, rest s, primary, secondary
type Row = [string, string, string, string, string, string, string, string, number, number, string, string];
const ROWS: Row[] = [
  ["bench", "Bench Press", "Panca piana", "Panca|Flat bench", "barbell", "horizontal_push", "compound", "external", 2.5, 180, "chest", "triceps,shoulders"],
  ["incbench", "Incline Bench Press", "Panca inclinata", "Incline barbell press", "barbell", "horizontal_push", "compound", "external", 2.5, 180, "chest", "shoulders,triceps"],
  ["dbbench", "Dumbbell Bench Press", "Panca piana manubri", "DB bench", "dumbbell", "horizontal_push", "compound", "external", 2, 150, "chest", "triceps,shoulders"],
  ["dbinc", "Incline Dumbbell Press", "Spinte inclinate manubri", "Incline DB press", "dumbbell", "horizontal_push", "compound", "external", 2, 150, "chest", "shoulders,triceps"],
  ["smithinc", "Incline Smith Press", "Spinte inclinate smith machine", "Smith incline", "smith", "horizontal_push", "compound", "external", 2.5, 150, "chest", "shoulders,triceps"],
  ["smithbench", "Smith Bench Press", "Panca al multipower", "Smith bench", "smith", "horizontal_push", "compound", "external", 2.5, 150, "chest", "triceps,shoulders"],
  ["mchest", "Machine Chest Press", "Chest press", "Chest press", "machine", "horizontal_push", "compound", "external", 5, 150, "chest", "triceps,shoulders"],
  ["pecdeck", "Pec Deck", "Pectoral machine", "Butterfly|Croci macchina", "machine", "chest_fly", "isolation", "external", 5, 90, "chest", ""],
  ["cablefly", "Cable Fly", "Croci ai cavi", "Cable crossover", "cable", "chest_fly", "isolation", "external", 2.5, 90, "chest", ""],
  ["dbfly", "Dumbbell Fly", "Croci con manubri", "DB fly", "dumbbell", "chest_fly", "isolation", "external", 2, 90, "chest", ""],
  ["dips", "Dips", "Dip alle parallele", "Parallel bar dips", "bodyweight", "vertical_push", "compound", "bw_plus", 2.5, 150, "chest", "triceps,shoulders"],
  ["pushup", "Push-up", "Piegamenti", "Flessioni", "bodyweight", "horizontal_push", "compound", "bodyweight", 0, 90, "chest", "triceps,shoulders"],
  ["pullup", "Pull-up", "Trazioni", "Weighted pull-up|Trazioni zavorrate", "bodyweight", "vertical_pull", "compound", "bw_plus", 2.5, 180, "back", "biceps"],
  ["chinup", "Chin-up", "Trazioni presa supina", "Chin up", "bodyweight", "vertical_pull", "compound", "bw_plus", 2.5, 180, "back", "biceps"],
  ["latpd", "Lat Pulldown", "Lat machine", "Lat pulldown|Lat machine avanti", "cable", "vertical_pull", "compound", "external", 5, 120, "back", "biceps"],
  ["bbrow", "Barbell Row", "Rematore bilanciere", "Rematore|Bent-over row", "barbell", "horizontal_pull", "compound", "external", 2.5, 150, "back", "biceps,shoulders"],
  ["dbrow", "One-Arm Dumbbell Row", "Rematore con manubrio", "DB row", "dumbbell", "horizontal_pull", "compound", "external", 2, 120, "back", "biceps"],
  ["cablerow", "Seated Cable Row", "Pulley", "Pulley basso|Seated row", "cable", "horizontal_pull", "compound", "external", 5, 120, "back", "biceps"],
  ["mrow", "Machine Row", "Row machine", "Chest-supported row", "machine", "horizontal_pull", "compound", "external", 5, 120, "back", "biceps"],
  ["tbar", "T-Bar Row", "Rematore T-bar", "T bar", "barbell", "horizontal_pull", "compound", "external", 2.5, 150, "back", "biceps"],
  ["pullover", "Cable Pullover", "Pullover ai cavi", "Straight-arm pulldown", "cable", "shoulder_extension", "isolation", "external", 2.5, 90, "back", ""],
  ["deadlift", "Deadlift", "Stacco da terra", "Stacco", "barbell", "hinge", "compound", "external", 2.5, 180, "hamstrings,glutes,back", "forearms"],
  ["ohp", "Overhead Press", "Military press", "Lento avanti", "barbell", "vertical_push", "compound", "external", 2.5, 150, "shoulders", "triceps"],
  ["dbsp", "Dumbbell Shoulder Press", "Shoulder press manubri", "DB shoulder press", "dumbbell", "vertical_push", "compound", "external", 2, 150, "shoulders", "triceps"],
  ["msp", "Machine Shoulder Press", "Shoulder press macchina", "Shoulder press", "machine", "vertical_push", "compound", "external", 5, 150, "shoulders", "triceps"],
  ["lat", "Dumbbell Lateral Raise", "Alzate laterali", "Lateral raise", "dumbbell", "lateral_raise", "isolation", "external", 2, 90, "shoulders", ""],
  ["clat", "Cable Lateral Raise", "Alzate laterali ai cavi", "Cable lateral", "cable", "lateral_raise", "isolation", "external", 2.5, 90, "shoulders", ""],
  ["rdelt", "Reverse Pec Deck", "Pectoral inversa", "Rear delt fly", "machine", "rear_delt", "isolation", "external", 5, 90, "shoulders", "back"],
  ["facepull", "Face Pull", "Face pull", "Facepull", "cable", "rear_delt", "isolation", "external", 2.5, 90, "shoulders", "back"],
  ["bbcurl", "Barbell Curl", "Curl bilanciere", "Curl", "barbell", "elbow_flexion", "isolation", "external", 2.5, 90, "biceps", "forearms"],
  ["dbcurl", "Alternating Dumbbell Curl", "Curl manubrio alternato", "DB curl", "dumbbell", "elbow_flexion", "isolation", "external", 2, 90, "biceps", "forearms"],
  ["hammer", "Hammer Curl", "Hammer curl", "Curl a martello", "dumbbell", "elbow_flexion", "isolation", "external", 2, 90, "biceps", "forearms"],
  ["cablecurl", "Cable Curl", "Curl ai cavi", "", "cable", "elbow_flexion", "isolation", "external", 2.5, 90, "biceps", ""],
  ["preacher", "Preacher Curl", "Curl alla panca Scott", "Scott curl", "machine", "elbow_flexion", "isolation", "external", 2.5, 90, "biceps", ""],
  ["pd", "Triceps Pushdown", "Push down", "Pushdown", "cable", "elbow_extension", "isolation", "external", 2.5, 90, "triceps", ""],
  ["ropepd", "Rope Pushdown", "Pushdown corda", "Pushdown with rope", "cable", "elbow_extension", "isolation", "external", 2.5, 90, "triceps", ""],
  ["ohext", "Overhead Cable Extension", "French press ai cavi", "Overhead triceps extension", "cable", "elbow_extension", "isolation", "external", 2.5, 90, "triceps", ""],
  ["skull", "Skull Crusher", "French press", "EZ bar extension", "barbell", "elbow_extension", "isolation", "external", 2.5, 90, "triceps", ""],
  ["cgbench", "Close-Grip Bench Press", "Panca presa stretta", "CGBP", "barbell", "horizontal_push", "compound", "external", 2.5, 150, "triceps", "chest"],
  ["wristcurl", "Wrist Curl", "Curl per avambracci", "", "dumbbell", "wrist_flexion", "isolation", "external", 2, 60, "forearms", ""],
  ["squat", "Back Squat", "Squat", "Squat bilanciere", "barbell", "squat", "compound", "external", 2.5, 180, "quads,glutes", "hamstrings"],
  ["hacksquat", "Hack Squat", "Hack squat", "", "machine", "squat", "compound", "external", 5, 150, "quads", "glutes"],
  ["legpress", "Leg Press", "Leg press", "Pressa", "machine", "squat", "compound", "external", 5, 150, "quads", "glutes"],
  ["lunge", "Walking Lunge", "Affondi", "Lunges", "dumbbell", "lunge", "compound", "external", 2, 120, "quads,glutes", "hamstrings"],
  ["bss", "Bulgarian Split Squat", "Squat bulgaro", "Split squat", "dumbbell", "lunge", "compound", "external", 2, 120, "quads,glutes", ""],
  ["legext", "Leg Extension", "Leg extension", "Quadricipiti macchina", "machine", "knee_extension", "isolation", "external", 5, 90, "quads", ""],
  ["rdl", "Romanian Deadlift", "Stacco rumeno", "RDL", "barbell", "hinge", "compound", "external", 2.5, 150, "hamstrings,glutes", "back"],
  ["dbrdl", "Dumbbell Romanian Deadlift", "Stacco rumeno manubri", "Romanian deadlift|RDL", "dumbbell", "hinge", "compound", "external", 2, 150, "hamstrings,glutes", "back"],
  ["legcurl", "Leg Curl", "Leg curl", "Lying leg curl|Seated leg curl", "machine", "knee_flexion", "isolation", "external", 5, 90, "hamstrings", ""],
  ["hipthrust", "Hip Thrust", "Hip thrust", "Ponte glutei", "barbell", "hinge", "compound", "external", 2.5, 120, "glutes", "hamstrings"],
  ["abductor", "Hip Abduction", "Abductor machine", "Abduttori", "machine", "hip_abduction", "isolation", "external", 5, 60, "glutes", ""],
  ["adductor", "Hip Adduction", "Adductor machine", "Adduttori", "machine", "hip_adduction", "isolation", "external", 5, 60, "quads", ""],
  ["calf", "Calf Raise", "Calf raise", "Calf raises|Polpacci", "machine", "calf_raise", "isolation", "external", 5, 60, "calves", ""],
  ["seatedcalf", "Seated Calf Raise", "Calf da seduto", "", "machine", "calf_raise", "isolation", "external", 5, 60, "calves", ""],
  ["cablecrunch", "Cable Crunch", "Crunch ai cavi", "Cable crunches", "cable", "trunk_flexion", "isolation", "external", 5, 60, "abs", ""],
  ["hangleg", "Hanging Leg Raise", "Leg raise alla sbarra", "", "bodyweight", "trunk_flexion", "isolation", "bodyweight", 0, 60, "abs", ""],
];

export const MUSCLES = ["chest", "back", "shoulders", "biceps", "triceps", "forearms", "quads", "hamstrings", "glutes", "calves", "abs"];

export function seedExercises(now: number) {
  return ROWS.map(r => ({
    id: "ex_" + r[0], name: { en: r[1], it: r[2] }, aliases: r[3] ? r[3].split("|") : [],
    equipment: r[4], pattern: r[5], mechanic: r[6], loadType: r[7], inc: r[8], rest: r[9],
    muscles: [
      ...r[10].split(",").filter(Boolean).map(m => ({ m, role: "primary" as const })),
      ...r[11].split(",").filter(Boolean).map(m => ({ m, role: "secondary" as const })),
    ],
    notes: "", custom: false, archived: false, createdAt: now, updatedAt: now,
  }));
}

export function emptyProgram(now: number) {
  return {
    id: uid(), name: "My program", description: "", status: "active", nextDay: 0,
    days: [{ id: uid(), name: { en: "Day 1", it: "Giorno 1" }, exercises: [] }], createdAt: now, updatedAt: now,
  };
}

// ---- Builders: turn a written log into a program + history. Personal logs are NOT stored in this repo:
// a private script feeds them in and produces a backup file that is imported on the phone.
export type L = [number, number, number | null, ("w")?];
export interface DayLog { en: string; it: string; ex: { k: string; sets: L[]; group?: string; optional?: boolean }[] }

function setType(sets: L[], i: number): SetType {
  if (sets[i][3] === "w") return "warmup";
  const work = sets.filter(s => s[3] !== "w");
  const wi = work.indexOf(sets[i]);
  const ascending = work.length >= 3 && work[work.length - 1][0] > work[0][0];
  return ascending && wi === work.length - 1 ? "top" : "working";
}

/** Targets from a log: logged reps = bottom of range, +2 = top; logged RIR, else 1. */
function template(sets: L[]) {
  return sets.map((s, i) => {
    const type = setType(sets, i);
    const w = type === "warmup";
    return { id: uid(), type, load: s[0], repsMin: s[1], repsMax: w ? s[1] : s[1] + 2, rir: w ? null : (s[2] ?? 1) };
  });
}

export function buildProgram(log: DayLog[], now: number, name: string, description = "") {
  const days = log.map(d => ({
    id: uid(), name: { en: d.en, it: d.it },
    exercises: d.ex.map(e => ({ id: uid(), exId: "ex_" + e.k, group: e.group || null, optional: !!e.optional, rest: null as number | null, notes: "", sets: template(e.sets) })),
  }));
  return { id: uid(), name, description, status: "active", nextDay: 0, days, createdAt: now, updatedAt: now };
}

/** Logged sessions as completed history, in order. Real dates unknown: flagged dateUnknown. */
export function buildHistory(log: DayLog[], now: number, program: any, lib: Map<string, any>) {
  return log.map((d, di) => {
    const day = program.days[di];
    const started = now - (log.length - di) * 60_000;
    return {
      id: uid(), programId: program.id, dayId: day.id, dayName: day.name,
      status: "completed", imported: true, dateUnknown: true,
      startedAt: started, endedAt: started, pausedMs: 0, pausedAt: null, idx: 0, rest: null,
      notes: "", sessionRpe: null, suggestions: [], createdAt: now, updatedAt: now,
      exercises: d.ex.map((e, ei) => {
        const pe = day.exercises[ei];
        const ex = lib.get("ex_" + e.k);
        return {
          id: uid(), peId: pe.id, exId: ex.id, plannedExId: ex.id, name: ex.name, group: pe.group, optional: pe.optional, skipped: false, notes: "",
          sets: e.sets.map((s, si) => ({
            id: uid(), type: pe.sets[si].type, load: s[0], reps: s[1], rir: s[2], rpe: null, done: true, doneAt: started,
            t: { repsMin: pe.sets[si].repsMin, repsMax: pe.sets[si].repsMax, rir: pe.sets[si].rir, load: pe.sets[si].load },
          })),
        };
      }),
    };
  });
}
