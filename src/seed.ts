// Seed data: the exercise library (EN + IT names) and an empty starter program. No personal data lives in this repo.
import { uid, SetType } from "./domain.js";

// key, English, Italian, aliases, equipment, pattern, mechanic, loadType, increment kg, rest s, primary, secondary, track?
// track: "wr" weight × reps (default) · "reps" reps only · "time" minutes
type Row = [string, string, string, string, string, string, string, string, number, number, string, string, string?];
const ROWS: Row[] = [
  ["bench", "Bench Press", "Panca piana", "Panca|Flat bench", "barbell", "horizontal_push", "compound", "external", 2.5, 180, "chest", "triceps,shoulders"],
  ["incbench", "Incline Bench Press", "Panca inclinata", "Incline barbell press", "barbell", "horizontal_push", "compound", "external", 2.5, 180, "chest", "shoulders,triceps"],
  ["dbbench", "Dumbbell Bench Press", "Panca piana manubri", "DB bench", "dumbbell", "horizontal_push", "compound", "external", 2, 150, "chest", "triceps,shoulders"],
  ["dbinc", "Incline Dumbbell Press", "Spinte inclinate manubri", "Incline DB press|Panca inclinata manubri", "dumbbell", "horizontal_push", "compound", "external", 2, 150, "chest", "shoulders,triceps"],
  ["smithinc", "Incline Smith Press", "Spinte inclinate smith machine", "Smith incline|Panca inclinata multipower|Panca inclinata smith", "smith", "horizontal_push", "compound", "external", 2.5, 150, "chest", "shoulders,triceps"],
  ["smithbench", "Smith Bench Press", "Panca al multipower", "Smith bench", "smith", "horizontal_push", "compound", "external", 2.5, 150, "chest", "triceps,shoulders"],
  ["mchest", "Machine Chest Press", "Chest press", "Chest press", "machine", "horizontal_push", "compound", "external", 5, 150, "chest", "triceps,shoulders"],
  ["pecdeck", "Pec Deck", "Pectoral machine", "Butterfly|Croci macchina|Fly pectoral|Pectoral fly", "machine", "chest_fly", "isolation", "external", 5, 90, "chest", ""],
  ["cablefly", "Cable Fly", "Croci ai cavi", "Cable crossover", "cable", "chest_fly", "isolation", "external", 2.5, 90, "chest", ""],
  ["dbfly", "Dumbbell Fly", "Croci con manubri", "DB fly", "dumbbell", "chest_fly", "isolation", "external", 2, 90, "chest", ""],
  ["dips", "Dips", "Dip alle parallele", "Parallel bar dips", "bodyweight", "vertical_push", "compound", "bw_plus", 2.5, 150, "chest", "triceps,shoulders"],
  ["pushup", "Push-up", "Piegamenti", "Flessioni", "bodyweight", "horizontal_push", "compound", "bodyweight", 0, 90, "chest", "triceps,shoulders"],
  ["pullup", "Pull-up", "Trazioni", "Weighted pull-up|Trazioni zavorrate", "bodyweight", "vertical_pull", "compound", "bw_plus", 2.5, 180, "back", "biceps"],
  ["chinup", "Chin-up", "Trazioni presa supina", "Chin up", "bodyweight", "vertical_pull", "compound", "bw_plus", 2.5, 180, "back", "biceps"],
  ["latpd", "Lat Pulldown", "Lat machine", "Lat pulldown|Lat machine avanti", "cable", "vertical_pull", "compound", "external", 5, 120, "back", "biceps"],
  ["bbrow", "Barbell Row", "Rematore bilanciere", "Rematore|Bent-over row", "barbell", "horizontal_pull", "compound", "external", 2.5, 150, "back", "biceps,shoulders"],
  ["dbrow", "One-Arm Dumbbell Row", "Rematore con manubrio", "DB row|Rematore manubrio", "dumbbell", "horizontal_pull", "compound", "external", 2, 120, "back", "biceps"],
  ["cablerow", "Seated Cable Row", "Pulley", "Pulley basso|Seated row|Pulley basso presa larga", "cable", "horizontal_pull", "compound", "external", 5, 120, "back", "biceps"],
  ["mrow", "Machine Row", "Row machine", "Chest-supported row", "machine", "horizontal_pull", "compound", "external", 5, 120, "back", "biceps"],
  ["tbar", "T-Bar Row", "Rematore T-bar", "T bar", "barbell", "horizontal_pull", "compound", "external", 2.5, 150, "back", "biceps"],
  ["pullover", "Cable Pullover", "Pullover ai cavi", "Straight-arm pulldown|Pulldown braccia tese", "cable", "shoulder_extension", "isolation", "external", 2.5, 90, "back", ""],
  ["deadlift", "Deadlift", "Stacco da terra", "Stacco", "barbell", "hinge", "compound", "external", 2.5, 180, "hamstrings,glutes,back", "forearms"],
  ["ohp", "Overhead Press", "Military press", "Lento avanti", "barbell", "vertical_push", "compound", "external", 2.5, 150, "shoulders", "triceps"],
  ["dbsp", "Dumbbell Shoulder Press", "Shoulder press manubri", "DB shoulder press|Lento avanti manubri", "dumbbell", "vertical_push", "compound", "external", 2, 150, "shoulders", "triceps"],
  ["msp", "Machine Shoulder Press", "Shoulder press macchina", "Shoulder press", "machine", "vertical_push", "compound", "external", 5, 150, "shoulders", "triceps"],
  ["lat", "Dumbbell Lateral Raise", "Alzate laterali", "Lateral raise", "dumbbell", "lateral_raise", "isolation", "external", 2, 90, "shoulders", ""],
  ["clat", "Cable Lateral Raise", "Alzate laterali ai cavi", "Cable lateral", "cable", "lateral_raise", "isolation", "external", 2.5, 90, "shoulders", ""],
  ["rdelt", "Reverse Pec Deck", "Pectoral inversa", "Rear delt fly", "machine", "rear_delt", "isolation", "external", 5, 90, "shoulders", "back"],
  ["facepull", "Face Pull", "Face pull", "Facepull", "cable", "rear_delt", "isolation", "external", 2.5, 90, "shoulders", "back"],
  ["bbcurl", "Barbell Curl", "Curl bilanciere", "Curl|Curl bilanciere EZ|EZ bar curl", "barbell", "elbow_flexion", "isolation", "external", 2.5, 90, "biceps", "forearms"],
  ["dbcurl", "Alternating Dumbbell Curl", "Curl manubrio alternato", "DB curl", "dumbbell", "elbow_flexion", "isolation", "external", 2, 90, "biceps", "forearms"],
  ["hammer", "Hammer Curl", "Hammer curl", "Curl a martello", "dumbbell", "elbow_flexion", "isolation", "external", 2, 90, "biceps", "forearms"],
  ["cablecurl", "Cable Curl", "Curl ai cavi", "", "cable", "elbow_flexion", "isolation", "external", 2.5, 90, "biceps", ""],
  ["preacher", "Preacher Curl", "Curl alla panca Scott", "Scott curl", "machine", "elbow_flexion", "isolation", "external", 2.5, 90, "biceps", ""],
  ["pd", "Triceps Pushdown", "Push down", "Pushdown|Pushdown cavo", "cable", "elbow_extension", "isolation", "external", 2.5, 90, "triceps", ""],
  ["ropepd", "Rope Pushdown", "Pushdown corda", "Pushdown with rope", "cable", "elbow_extension", "isolation", "external", 2.5, 90, "triceps", ""],
  ["ohext", "Overhead Cable Extension", "French press ai cavi", "Overhead triceps extension", "cable", "elbow_extension", "isolation", "external", 2.5, 90, "triceps", ""],
  ["skull", "Skull Crusher", "French press", "EZ bar extension|French press EZ", "barbell", "elbow_extension", "isolation", "external", 2.5, 90, "triceps", ""],
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
  ["seatedcalf", "Seated Calf Raise", "Calf da seduto", "Calf raise seduto", "machine", "calf_raise", "isolation", "external", 5, 60, "calves", ""],
  ["cablecrunch", "Cable Crunch", "Crunch ai cavi", "Cable crunches", "cable", "trunk_flexion", "isolation", "external", 5, 60, "abs", ""],
  ["hangleg", "Hanging Leg Raise", "Leg raise alla sbarra", "", "bodyweight", "trunk_flexion", "isolation", "bodyweight", 0, 60, "abs", "", "reps"],
  // v0.5 additions
  ["smithsp", "Smith Shoulder Press", "Lento avanti al multipower", "Lento avanti seduto al multipower|Smith overhead press", "smith", "vertical_push", "compound", "external", 2.5, 120, "shoulders", "triceps"],
  ["cglatpd", "Close-Grip Lat Pulldown", "Lat machine presa stretta", "Close grip pulldown", "cable", "vertical_pull", "compound", "external", 5, 120, "back", "biceps"],
  ["revlatpd", "Reverse-Grip Lat Pulldown", "Lat machine inversa", "Lat inversa e stretta|Supinated pulldown", "cable", "vertical_pull", "compound", "external", 5, 120, "back", "biceps"],
  ["kickback", "Cable Triceps Kickback", "Kickback ai cavi", "Kickback cavo basso", "cable", "elbow_extension", "isolation", "external", 2.5, 60, "triceps", ""],
  ["inccurl", "Incline Dumbbell Curl", "Curl manubri su panca inclinata", "Curl manubri su inclinata", "dumbbell", "elbow_flexion", "isolation", "external", 2, 60, "biceps", ""],
  ["cablehammer", "Cable Hammer Curl", "Hammer al cavo", "Rope hammer curl", "cable", "elbow_flexion", "isolation", "external", 2.5, 60, "biceps", "forearms"],
  ["bayesian", "Bayesian Cable Curl", "Bayesian curl al cavo", "Bayesian curl cavo singolo|Bayesian curl", "cable", "elbow_flexion", "isolation", "external", 2.5, 60, "biceps", ""],
  ["crunch", "Crunch", "Crunch addominali", "Sit-up crunch", "bodyweight", "trunk_flexion", "isolation", "bodyweight", 0, 60, "abs", "", "reps"],
  ["plank", "Plank", "Plank", "Front plank", "bodyweight", "core_hold", "isolation", "bodyweight", 0, 60, "abs", "", "time"],
  ["rope", "Jump Rope", "Salto della corda", "Rope jumping|Corda|Skipping", "other", "cardio", "cardio", "bodyweight", 0, 60, "cardio", "calves", "reps"],
  ["treadmill", "Treadmill", "Tapis roulant", "Running machine", "machine", "cardio", "cardio", "bodyweight", 0, 60, "cardio", "", "time"],
  ["bike", "Stationary Bike", "Cyclette", "Bike|Spin bike", "machine", "cardio", "cardio", "bodyweight", 0, 60, "cardio", "", "time"],
  ["elliptical", "Elliptical", "Ellittica", "Cross trainer", "machine", "cardio", "cardio", "bodyweight", 0, 60, "cardio", "", "time"],
  ["rower", "Rowing Machine", "Vogatore", "Rower|Rowing", "machine", "cardio", "cardio", "bodyweight", 0, 60, "cardio", "", "time"],
  ["stairs", "Stair Climber", "Stepper", "Stairmaster|Scale", "machine", "cardio", "cardio", "bodyweight", 0, 60, "cardio", "", "time"],
  ["walk", "Walking", "Camminata", "Incline walk|Camminata in salita", "other", "cardio", "cardio", "bodyweight", 0, 60, "cardio", "", "time"],
  ["run", "Running", "Corsa", "Run|Jogging", "other", "cardio", "cardio", "bodyweight", 0, 60, "cardio", "", "time"],
  ["sarow", "Single-Arm Cable Row", "Rematore monolaterale ai cavi", "Row presa singola|Rematore presa singola|Single arm row|One arm cable row|Rematore a un braccio|Row monolaterale", "cable", "horizontal_pull", "compound", "external", 2.5, 90, "back", "biceps"],
  // unilateral (single-arm) and single-leg (monopodalici)
  ["samrow", "Single-Arm Machine Row", "Rematore monolaterale alla macchina", "Row machine monolaterale|Single arm machine row|Iso-lateral row", "machine", "horizontal_pull", "compound", "external", 5, 90, "back", "biceps"],
  ["salatpd", "Single-Arm Lat Pulldown", "Lat machine monolaterale", "Lat machine a un braccio|Single arm pulldown|One arm lat pulldown", "cable", "vertical_pull", "compound", "external", 2.5, 90, "back", "biceps"],
  ["sadbpress", "Single-Arm Dumbbell Press", "Distensioni monolaterali con manubrio", "Panca monolaterale manubrio|One arm dumbbell bench", "dumbbell", "horizontal_push", "compound", "external", 2, 90, "chest", "triceps,shoulders"],
  ["sacablepress", "Single-Arm Cable Chest Press", "Chest press monolaterale al cavo", "Spinta monolaterale al cavo|One arm cable press", "cable", "horizontal_push", "compound", "external", 2.5, 90, "chest", "triceps,shoulders"],
  ["sacablefly", "Single-Arm Cable Fly", "Croci monolaterali al cavo", "Croce monolaterale|One arm cable fly", "cable", "chest_fly", "isolation", "external", 2.5, 60, "chest", ""],
  ["sadbsp", "Single-Arm Dumbbell Shoulder Press", "Shoulder press monolaterale con manubrio", "Lento avanti monolaterale|One arm dumbbell press", "dumbbell", "vertical_push", "compound", "external", 2, 90, "shoulders", "triceps"],
  ["landmine", "Single-Arm Landmine Press", "Landmine press monolaterale", "Landmine press", "barbell", "vertical_push", "compound", "external", 2.5, 90, "shoulders", "chest,triceps"],
  ["saclat", "Single-Arm Cable Lateral Raise", "Alzata laterale monolaterale al cavo", "Alzate laterali monolaterali ai cavi|One arm cable lateral", "cable", "lateral_raise", "isolation", "external", 2.5, 60, "shoulders", ""],
  ["sarear", "Single-Arm Cable Rear Delt Fly", "Alzata posteriore monolaterale al cavo", "Rear delt monolaterale|One arm reverse fly", "cable", "rear_delt", "isolation", "external", 2.5, 60, "shoulders", "back"],
  ["conccurl", "Concentration Curl", "Curl di concentrazione", "Concentration curl|Curl concentrato", "dumbbell", "elbow_flexion", "isolation", "external", 2, 60, "biceps", ""],
  ["sacablecurl", "Single-Arm Cable Curl", "Curl monolaterale al cavo", "Curl al cavo a un braccio|One arm cable curl", "cable", "elbow_flexion", "isolation", "external", 2.5, 60, "biceps", ""],
  ["saohext", "Single-Arm Overhead Extension", "French press monolaterale con manubrio", "Estensione sopra la testa monolaterale|One arm overhead extension", "dumbbell", "elbow_extension", "isolation", "external", 2, 60, "triceps", ""],
  ["sapd", "Single-Arm Cable Pushdown", "Pushdown monolaterale al cavo", "Push down monolaterale|One arm pushdown", "cable", "elbow_extension", "isolation", "external", 2.5, 60, "triceps", ""],
  ["sllegpress", "Single-Leg Press", "Leg press monopodalica", "Leg press a una gamba|Single leg leg press", "machine", "squat", "compound", "external", 5, 90, "quads", "glutes"],
  ["sllegext", "Single-Leg Extension", "Leg extension monopodalica", "Leg extension a una gamba", "machine", "knee_extension", "isolation", "external", 2.5, 60, "quads", ""],
  ["sllegcurl", "Single-Leg Curl", "Leg curl monopodalico", "Leg curl a una gamba", "machine", "knee_flexion", "isolation", "external", 2.5, 60, "hamstrings", ""],
  ["slrdl", "Single-Leg Romanian Deadlift", "Stacco rumeno monopodalico", "Stacco a una gamba|Single leg RDL", "dumbbell", "hinge", "compound", "external", 2, 90, "hamstrings,glutes", "back"],
  ["slhipthrust", "Single-Leg Hip Thrust", "Hip thrust monopodalico", "Ponte glutei a una gamba|Single leg glute bridge", "bodyweight", "hinge", "compound", "bw_plus", 2.5, 60, "glutes", "hamstrings"],
  ["pistol", "Pistol Squat", "Squat monopodalico", "Pistol|Single leg squat", "bodyweight", "squat", "compound", "bw_plus", 2.5, 90, "quads", "glutes"],
  ["stepup", "Step-Up", "Step-up", "Salita sul box|Salite sulla panca", "dumbbell", "lunge", "compound", "external", 2, 90, "quads", "glutes"],
  ["revlunge", "Reverse Lunge", "Affondo indietro", "Affondi indietro|Reverse lunges", "dumbbell", "lunge", "compound", "external", 2, 90, "quads,glutes", "hamstrings"],
  ["slcalf", "Single-Leg Calf Raise", "Calf raise monopodalico", "Polpacci a una gamba|One leg calf raise", "dumbbell", "calf_raise", "isolation", "external", 2, 60, "calves", ""],
  ["glutekick", "Cable Glute Kickback", "Slanci posteriori al cavo", "Kickback glutei|Glute kickback", "cable", "hip_extension", "isolation", "external", 2.5, 60, "glutes", "hamstrings"],
  ["cableabd", "Cable Hip Abduction", "Abduzione al cavo", "Slanci laterali al cavo|Standing cable abduction", "cable", "hip_abduction", "isolation", "external", 2.5, 60, "glutes", ""],
  ["burpee", "Burpees", "Burpee", "Burpees", "bodyweight", "cardio", "cardio", "bodyweight", 0, 60, "cardio", "", "reps"],
];

/** Single-arm / single-leg movements (load is per arm / per leg). */
export const UNILATERAL = new Set(["dbrow", "sarow", "samrow", "salatpd", "sadbpress", "sacablepress", "sacablefly", "sadbsp", "landmine", "saclat", "sarear",
  "conccurl", "sacablecurl", "bayesian", "kickback", "saohext", "sapd", "lunge", "bss", "sllegpress", "sllegext", "sllegcurl", "slrdl", "slhipthrust",
  "pistol", "stepup", "revlunge", "slcalf", "glutekick", "cableabd", "dbcurl"]);

export const MUSCLES = ["chest", "back", "shoulders", "biceps", "triceps", "forearms", "quads", "hamstrings", "glutes", "calves", "abs", "cardio"];

export function seedExercises(now: number) {
  return ROWS.map(r => ({
    id: "ex_" + r[0], name: { en: r[1], it: r[2] }, aliases: r[3] ? r[3].split("|") : [],
    equipment: r[4], pattern: r[5], mechanic: r[6], loadType: r[7], inc: r[8], rest: r[9], track: r[12] || "wr",
    laterality: UNILATERAL.has(r[0]) ? "unilateral" : "bilateral",
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
