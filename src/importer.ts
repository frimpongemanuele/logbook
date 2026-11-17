// Import parsers: plans and workout logs from text, CSV/TSV, Excel (.xlsx) and OCR'd images.
// Pure functions (no DOM) so every rule is unit-tested; the screen code lives in app.ts.
import { uid } from "./domain.js";

type Any = any;

/* ------------------------------------------------------------------ text helpers */
export function norm(s: string): string {
  return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim();
}
const STOP = new Set(["o", "e", "al", "ai", "alla", "alle", "allo", "con", "su", "di", "del", "della", "the", "with", "a", "and", "or", "da", "in", "il", "la", "le", "lo", "per"]);
const tokens = (s: string) => norm(s).split(" ").filter(w => w && !STOP.has(w));

/** Clean OCR noise: brackets, quotes, pipes, leading row numbers and stray symbols. */
export function cleanLine(line: string): string {
  let s = line.replace(/[{\[]/g, "(").replace(/[}\]]/g, ")").replace(/[“”″„]/g, '"').replace(/[’‘`´]/g, "'")
    .replace(/[|¦]/g, " ").replace(/ /g, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/^\d{1,3}[.,:)]?\s+(?=[^\d\s])/, "");          // spreadsheet row number
  s = s.replace(/^(?:[^\p{L}\d(]+\s*)+/u, "");                  // leading junk: "&", "~~", "©", "="
  return s.trim();
}

/* ------------------------------------------------------------------ muscles, days, reps */
const MUSCLE_WORDS: [RegExp, string][] = [
  [/^(petto|pettorali|chest|pecs?)$/, "chest"], [/^(dorso|schiena|dorsali|back|lats?)$/, "back"],
  [/^(spalle|deltoidi|shoulders?|delts?|sp ?post|spalle ?post|posteriori)$/, "shoulders"],
  [/^(bicipiti|biceps?)$/, "biceps"], [/^(tricipiti|triceps?)$/, "triceps"], [/^(avambr|avambracci|forearms?)$/, "forearms"],
  [/^(gambe|quadricipiti|quads?|legs?)$/, "quads"], [/^(femorali|hamstrings?)$/, "hamstrings"], [/^(glutei|glutes?)$/, "glutes"],
  [/^(polpacci|calves|calf)$/, "calves"], [/^(core|addominali|addome|abs?|abdominals?)$/, "abs"], [/^(cardio)$/, "cardio"],
];
export function muscleOf(word: string): string | null {
  const w = norm(word).replace(/\s+/g, " ");
  for (const [re, m] of MUSCLE_WORDS) if (re.test(w)) return m;
  return null;
}
const DAY_RE = /(luned[iì]|marted[iì]|mercoled[iì]|gioved[iì]|venerd[iì]|sabato|domenica|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\bday\s*[a-z0-9]+\b|\bgiorno\s*[a-z0-9]+\b|\bseduta\s*[a-z0-9]+\b|\bworkout\s*[a-z0-9]+\b|\bscheda\s*[a-z0-9]+\b|\b(push|pull|legs|gambe|upper|lower|full ?body)\b)/i;
const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s(\-/&])(\p{L})/gu, (_m, a, b) => a + b.toUpperCase());

export function dayName(raw: string): string {
  let s = cleanLine(raw).replace(/^#+\s*/, "").replace(/[:\-–]\s*$/, "").trim()
    .replace(/(^|\s)5(?=[a-zà-ù]{3,})/gi, "$1S").replace(/(^|\s)0(?=[a-zà-ù]{3,})/gi, "$1O");
  const m = s.search(DAY_RE);
  if (m > 0 && m < 12) s = s.slice(m);                           // drop OCR junk before the day word
  s = s.replace(/\b(push|pull|legs|upper|lower|gambe)\s+8\b/gi, "$1 B").replace(/\(\s*/g, "(").replace(/\s*\)/g, ")");
  if (/\([^)]*$/.test(s)) s += ")";
  return s === s.toUpperCase() ? titleCase(s) : s;
}

export interface SetSpec { type: "working" | "amrap"; min: number; max: number | null; mins: number | null }
/** "8-10" · "12" · "7, 8-10" · "Max/8" · "1 min" · "30 sec" → one spec per set. */
export function parseReps(expr: string, sets: number): SetSpec[] {
  const e = expr.toLowerCase().replace(/\s+/g, " ").trim();
  const n = Math.max(1, Math.min(20, sets || 1));
  const time = e.match(/(\d+(?:[.,]\d+)?)\s*(min|minuti|minutes?|m\b|'|sec|secondi|seconds?|s\b|")/);
  if (time) {
    const v = parseFloat(time[1].replace(",", "."));
    const mins = /sec|^s|"/.test(time[2]) ? Math.round((v / 60) * 100) / 100 : v;
    return Array.from({ length: n }, () => ({ type: "working" as const, min: 0, max: 0, mins }));
  }
  if (/max|amrap|cedimento|failure/.test(e)) {
    const k = parseInt((e.match(/(\d+)/) || [])[1] || "0", 10) || 1;
    return Array.from({ length: n }, () => ({ type: "amrap" as const, min: k, max: null, mins: null }));   // "Max/8" = at least 8, no ceiling
  }
  const parts = e.split(/\s*[,;/]\s*/).map(p => { const m = p.match(/(\d+)(?:\s*[-–]\s*(\d+))?/); return m ? [parseInt(m[1], 10), parseInt(m[2] || m[1], 10)] : null; }).filter(Boolean) as number[][];
  if (!parts.length) return Array.from({ length: n }, () => ({ type: "working" as const, min: 8, max: 12, mins: null }));
  return Array.from({ length: n }, (_, i) => { const p = parts[Math.min(i, parts.length - 1)]; return { type: "working" as const, min: Math.min(p[0], p[1]), max: Math.max(p[0], p[1]), mins: null }; });
}

/** 120" · 90s · 1'30 · 2 min · 1:30 · 90 → seconds */
export function parseRest(s: string): number | null {
  const e = (s || "").toLowerCase().trim();
  if (!e) return null;
  let m = e.match(/^(\d+)\s*['’:]\s*(\d{1,2})"?$/); if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  m = e.match(/^(\d+(?:[.,]\d+)?)\s*(min|minuti|minutes?|m|')$/); if (m) return Math.round(parseFloat(m[1].replace(",", ".")) * 60);
  m = e.match(/^(\d+)\s*(?:"|''|s|sec|secondi|seconds?)?$/); if (m) return parseInt(m[1], 10);
  return null;
}

/** Set schemes written next to reps: "(Piramidale)", "piramidale inverso", "full pyramid", "drop set" … */
export type Scheme = "straight" | "pyr_asc" | "pyr_desc" | "pyr_full" | "topback" | "drop";
export function schemeOf(text: string): Scheme | null {
  const s = norm(text);
  if (/piramid|pyramid/.test(s)) {
    if (/complet|full|triang|doppi|double/.test(s)) return "pyr_full";
    if (/discend|decresc|invers|revers|descend/.test(s)) return "pyr_desc";
    return "pyr_asc";                                            // "Piramidale" on its own = crescente
  }
  if (/drop ?set|stripping|scalar/.test(s)) return "drop";
  if (/top ?set|back ?off/.test(s)) return "topback";
  return null;
}

/* ------------------------------------------------------------------ plan from free text */
export interface PlanItem { raw: string; name: string; muscle: string | null; sets: SetSpec[]; rest: number | null; load: number | null; notes: string; scheme: Scheme | null; exId: string | null; score: number; isNew: boolean }
export interface PlanDay { name: string; items: PlanItem[] }

const REST_TAIL = /\s+(\d+\s*['’:]\s*\d{1,2}"?|\d+(?:[.,]\d+)?\s*(?:"|''|s|sec|secondi|min|minuti|m|')|\d{2,3})\s*$/i;
const X_FORM = /^(.*?)[\s:,\-–]+(\d{1,2})\s*[x×*]\s*(.+)$/i;
const TABLE_FORM = /^(.*?\S)\s+(\d{1,2})\s*[-–]?\s*((?:max\b\S*|amrap\b\S*|\d+(?:[.,]\d+)?\s*(?:min|minuti|sec|secondi|s)\b|\d+(?:\s*[-–]\s*\d+)?(?:\s*[,;/]\s*\d+(?:\s*[-–]\s*\d+)?)*)(?:\s*\(\s*([^)]*)\)?)?)\s*$/i;

/** One line → exercise item, or null if it isn't one. */
export function parseExerciseLine(line: string): PlanItem | null {
  let s = cleanLine(line);
  if (!s || !/\p{L}{2,}/u.test(s)) return null;
  let rest: number | null = null;
  const rt = s.match(REST_TAIL);
  if (rt) {
    const cand = s.slice(0, rt.index).trim();
    // a bare 2–3 digit tail is rest only if sets/reps are still left before it
    // only a rest if a sets/reps part is still left in front of it ("Treadmill 1 20 min" has none)
    if (TABLE_FORM.test(cand) || (X_FORM.test(cand) && /\d/.test((cand.match(X_FORM) || [])[3] || ""))) { rest = parseRest(rt[1]); s = cand; }
  }
  let name = "", sets = 0, repsExpr = "", note = "";
  let m = s.match(X_FORM);
  if (m && /\d/.test(m[3])) { name = m[1]; sets = parseInt(m[2], 10); repsExpr = m[3]; }
  else {
    m = s.match(TABLE_FORM);
    if (!m) return null;
    name = m[1]; sets = parseInt(m[2], 10); repsExpr = m[3]; note = (m[4] || "").trim();
  }
  repsExpr = repsExpr.replace(/\(.*$/, "").trim();
  if (!sets || sets > 20) return null;
  // optional muscle column in front: "Petto Panca piana" / "Sp.Post Facepull"
  let muscle: string | null = null;
  const words = name.trim().split(/\s+/);
  for (const k of [2, 1]) {
    if (words.length > k) { const mm = muscleOf(words.slice(0, k).join(" ")); if (mm) { muscle = mm; words.splice(0, k); break; } }
  }
  name = words.join(" ").replace(/^[^\p{L}\d(]+/u, "").replace(/[^\p{L}\d)]+$/u, "").trim();
  if (!name || !/\p{L}{2,}/u.test(name)) return null;
  const scheme = schemeOf(note) || schemeOf(line);
  if (scheme) note = "";
  return { raw: line.trim(), name, muscle, sets: parseReps(repsExpr, sets), rest, load: null, notes: note, scheme, exId: null, score: 0, isNew: true };
}

const isDayLine = (raw: string) => {
  const s = cleanLine(raw);
  if (!s || parseExerciseLine(raw)) return false;
  if (/^#+\s*\S/.test(raw.trim())) return true;
  return DAY_RE.test(s) && s.length <= 60;
};
const isHeaderLine = (s: string) => /esercizi|exercise/i.test(s) && /(set|serie|rip|reps)/i.test(s);

export function parsePlanLines(lines: string[]): PlanDay[] {
  const days: PlanDay[] = [];
  let cur: PlanDay | null = null;
  for (const raw of lines) {
    if (!raw || !raw.trim() || isHeaderLine(raw)) continue;
    if (isDayLine(raw)) { cur = { name: dayName(raw), items: [] }; days.push(cur); continue; }
    const it = parseExerciseLine(raw);
    if (!it) continue;
    if (!cur) { cur = { name: "Day 1", items: [] }; days.push(cur); }
    cur.items.push(it);
  }
  return days.filter(d => d.items.length);
}

/* ------------------------------------------------------------------ tables (CSV / Excel / paste) */
export function readDelimited(text: string): string[][] | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter(l => l.trim());
  if (lines.length < 2) return null;
  const score = (d: string) => lines.filter(l => l.includes(d)).length / lines.length;
  const delim = ["\t", ";", ","].find(d => score(d) >= 0.6);
  if (!delim) return null;
  const rows: string[][] = [];
  for (const line of lines) {
    const out: string[] = []; let cell = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"') { if (line[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
      else if (c === '"' && !cell) q = true;
      else if (c === delim) { out.push(cell.trim()); cell = ""; }
      else cell += c;
    }
    out.push(cell.trim());
    rows.push(out);
  }
  return rows;
}

const COLS: Record<string, RegExp> = {
  exercise: /^(esercizio|esercizi|exercise|exercises|nome|name|movimento)$/, muscle: /^(muscolo|muscoli|muscle|muscles|gruppo|group)$/,
  sets: /^(set|sets|serie|n serie)$/, reps: /^(ripetizioni|ripetizione|rip|reps|rep|repetitions)$/, rest: /^(recupero|rest|pausa|riposo)$/,
  load: /^(carico|peso|kg|weight|load|load kg|load_kg)$/, rir: /^(rir)$/, notes: /^(note|notes|nota)$/, day: /^(giorno|day|seduta|session|workout|scheda)$/,
  date: /^(data|date)$/, set: /^(n|set n|set #|set_no|#)$/, minutes: /^(minuti|minutes|min|durata|duration)$/,
};
function headerMap(row: string[]): Record<string, number> | null {
  const map: Record<string, number> = {};
  row.forEach((c, i) => { const n = norm(c).replace(/ /g, " "); for (const k in COLS) if (map[k] == null && COLS[k].test(n)) map[k] = i; });
  return map.exercise != null && (map.sets != null || map.reps != null || map.load != null) ? map : null;
}

export function parsePlanRows(rows: string[][]): PlanDay[] {
  const hi = rows.findIndex(r => headerMap(r));
  if (hi < 0) return parsePlanLines(rows.map(r => r.filter(Boolean).join(" ")));
  const h = headerMap(rows[hi])!;
  const days: PlanDay[] = []; let cur: PlanDay | null = null;
  const byDay = new Map<string, PlanDay>();
  for (const r of rows.slice(hi + 1)) {
    const cells = r.map(c => (c ?? "").toString().trim());
    const ex = cells[h.exercise] || "";
    const nonEmpty = cells.filter(Boolean);
    if (!nonEmpty.length) continue;
    const titleOnly = nonEmpty.length === 1 && !(h.sets != null && cells[h.sets]) && !(h.reps != null && cells[h.reps]);
    if (!ex || titleOnly) { cur = { name: dayName(nonEmpty.join(" ")), items: [] }; days.push(cur); continue; }
    const sets = parseInt(cells[h.sets] || "", 10) || (h.sets == null ? 3 : 1);
    const repsTxt = h.reps != null ? cells[h.reps] : "";
    const item: PlanItem = {
      raw: nonEmpty.join(" · "), name: ex.replace(/\s+/g, " "), muscle: h.muscle != null ? muscleOf(cells[h.muscle] || "") : null,
      sets: parseReps(repsTxt || (h.minutes != null && cells[h.minutes] ? cells[h.minutes] + " min" : ""), sets),
      rest: h.rest != null ? parseRest(cells[h.rest]) : null,
      load: h.load != null && cells[h.load] ? parseFloat(cells[h.load].replace(",", ".")) || null : null,
      notes: h.notes != null ? cells[h.notes] : "", scheme: schemeOf(repsTxt) || (h.notes != null ? schemeOf(cells[h.notes] || "") : null), exId: null, score: 0, isNew: true,
    };
    let target = cur;
    if (h.day != null && cells[h.day]) {
      const dn = dayName(cells[h.day]);
      target = byDay.get(dn) || null;
      if (!target) { target = { name: dn, items: [] }; byDay.set(dn, target); days.push(target); }
    }
    if (!target) { target = { name: "Day 1", items: [] }; days.push(target); cur = target; }
    target.items.push(item);
  }
  return days.filter(d => d.items.length);
}

/* ------------------------------------------------------------------ workout logs */
export interface LogSet { type: "warmup" | "working"; load: number; reps: number; rir: number | null; mins: number | null }
export interface LogExercise { name: string; optional: boolean; group: string | null; sets: LogSet[]; exId: string | null; isNew: boolean; score: number }
export interface LogSession { name: string; date: string | null; exercises: LogExercise[] }

const SET_LINE = /^\(?\s*(\d{1,2})\s*['’`´°]\s*(.*)$/;
export const looksLikeLog = (text: string) => text.split("\n").filter(l => SET_LINE.test(cleanLineKeepNum(l)) && /\d/.test(l.replace(SET_LINE, "$2"))).length >= 2;
function cleanLineKeepNum(l: string) { return l.replace(/[’‘`´]/g, "'").replace(/ /g, " ").trim(); }

function parseSetPart(part: string): LogSet | null {
  const p = part.trim();
  const tm = p.match(/^(\d+(?:[.,]\d+)?)\s*(min|minuti|minutes?)\b/i);
  if (tm) return { type: "working", load: 0, reps: 0, rir: null, mins: parseFloat(tm[1].replace(",", ".")) };
  const m = p.match(/^(\d+)(?:\s*[-–x×]\s*\+?\s*(\d+(?:[.,]\d+)?)\s*(?:kg|k\b|kgs)?)?/i);
  if (!m) return null;
  const rir = p.match(/(\d)\s*rir/i);
  return { type: "working", reps: parseInt(m[1], 10), load: m[2] ? parseFloat(m[2].replace(",", ".")) : 0, rir: rir ? parseInt(rir[1], 10) : null, mins: null };
}

/** The "Panca / 1’ 8 - 80 KG 2 RIR" notebook format. Sessions split by lines of dashes. */
export function parseLog(text: string): LogSession[] {
  const sessions: LogSession[] = [];
  let sess: LogSession = { name: "", date: null, exercises: [] };
  let cur: LogExercise[] = [];
  let groupN = 0;
  const flush = () => { sess.exercises = sess.exercises.filter(e => e.sets.length); if (sess.exercises.length) sessions.push(sess); sess = { name: "", date: null, exercises: [] }; cur = []; };
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = cleanLineKeepNum(raw);
    if (!line) continue;
    if (/^[\s—–\-_=*~·.]{3,}$/.test(line)) { flush(); continue; }
    const sm = line.match(SET_LINE);
    if (sm && /\d/.test(sm[2])) {
      if (!cur.length) continue;
      const no = parseInt(sm[1], 10), rest = sm[2];
      const warm = no === 0 || /riscald|warm/i.test(rest);
      const parts = cur.length > 1 ? rest.split("/") : [rest];
      parts.forEach((pt, i) => { const st = parseSetPart(pt); const ex = cur[Math.min(i, cur.length - 1)]; if (st && ex) { if (warm) st.type = "warmup"; if (/zavorra|weighted|\+/.test(pt) && st.load) { /* added load on bodyweight work */ } ex.sets.push(st); } });
      continue;
    }
    if (/^\d+\s*(week|settimana|sett)\b/i.test(line) || /^(week|settimana)\s*\d+/i.test(line)) continue;
    const dm = line.match(/^(\d{1,2})[\/.\-](\d{1,2})(?:[\/.\-](\d{2,4}))?$/);
    if (dm) { const y = dm[3] ? (dm[3].length === 2 ? "20" + dm[3] : dm[3]) : String(new Date().getFullYear()); sess.date = `${y}-${dm[2].padStart(2, "0")}-${dm[1].padStart(2, "0")}`; continue; }
    // exercise name line ("(Hammer curl" = optional; "A / B" = superset)
    const optional = /^\(/.test(line);
    const nameLine = line.replace(/^\(|\)$/g, "").trim();
    if (!/\p{L}{2,}/u.test(nameLine)) continue;
    const names = nameLine.split(/\s+\/\s+/).map(n => n.trim()).filter(Boolean);
    const group = names.length > 1 ? String.fromCharCode(65 + (groupN++ % 4)) : null;
    cur = names.map(n => ({ name: n, optional, group, sets: [], exId: null, isNew: true, score: 0 }));
    sess.exercises.push(...cur);
  }
  flush();
  return sessions.map((s, i) => ({ ...s, name: s.name || `Workout ${i + 1}` }));
}

/** CSV with a date column → sessions (Logbook's own CSV export, or similar). */
export function parseLogRows(rows: string[][]): LogSession[] | null {
  const hi = rows.findIndex(r => { const h = headerMap(r); return h && h.date != null; });
  if (hi < 0) return null;
  const h = headerMap(rows[hi])!;
  const idCol = rows[hi].findIndex(c => norm(c) === "session id");
  const out = new Map<string, LogSession>();
  for (const r of rows.slice(hi + 1)) {
    const ex = r[h.exercise]; if (!ex) continue;
    const date = (r[h.date] || "").slice(0, 10);
    const key = (idCol >= 0 ? r[idCol] : "") || date + "|" + (h.day != null ? r[h.day] : "");
    let s = out.get(key);
    if (!s) { s = { name: h.day != null && r[h.day] ? r[h.day] : `Workout ${date}`, date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null, exercises: [] }; out.set(key, s); }
    let e = s.exercises[s.exercises.length - 1];
    if (!e || e.name !== ex) { e = { name: ex, optional: false, group: null, sets: [], exId: null, isNew: true, score: 0 }; s.exercises.push(e); }
    const num = (i?: number) => (i == null || r[i] == null || r[i] === "" ? null : parseFloat(String(r[i]).replace(",", ".")));
    const typeCol = rows[hi].findIndex(c => norm(c) === "type");
    e.sets.push({ type: typeCol >= 0 && /warm/i.test(r[typeCol]) ? "warmup" : "working", load: num(h.load) ?? 0, reps: num(h.reps) ?? 0, rir: num(h.rir), mins: num(h.minutes) });
  }
  return [...out.values()];
}

/* ------------------------------------------------------------------ exercise matching */
function tokEq(a: string, b: string): boolean {
  if (a === b || a + "s" === b || b + "s" === a || a + "i" === b || b + "i" === a) return true;
  if (a.length >= 5 && b.length >= 5) {
    if (a.slice(0, 6) === b.slice(0, 6)) return true;                   // inclinata / inclinate
    if (Math.abs(a.length - b.length) <= 1) {                            // one OCR typo
      let d = 0, i = 0, j = 0;
      while (i < a.length && j < b.length) { if (a[i] === b[j]) { i++; j++; continue; } if (++d > 1) return false; if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; } }
      return d + (a.length - i) + (b.length - j) <= 1;
    }
  }
  return false;
}
function sim(name: string, cand: string): number {
  const cn = norm(name).replace(/ /g, ""), cc = norm(cand).replace(/ /g, "");
  if (!cn || !cc) return 0;
  if (cn === cc) return 1;
  if (cc.length >= 8 && cn.length > cc.length && cn.startsWith(cc)) return 0.6 + 0.3 * (cc.length / cn.length); // OCR glued words
  const A = tokens(name), B = tokens(cand);
  if (!A.length || !B.length) return 0;
  const used = new Set<number>(); let hit = 0, exact = 0;
  for (const a of A) {
    const j = B.findIndex((b, k) => !used.has(k) && tokEq(a, b));
    if (j >= 0) { used.add(j); hit++; const b = B[j]; if (a === b || a + "s" === b || b + "s" === a) exact++; }
  }
  const dice = (2 * hit) / (A.length + B.length);
  // candidate fully inside the name ("Panca piana" in "Panca piana bilanciere"): only on exact words,
  // so a fuzzy hit can't promote a one-word alias ("pressa" ≠ "presa")
  if (hit === B.length && hit < A.length && exact === B.length) return Math.max(dice, 0.6 + 0.35 * (B.length / A.length));
  if (hit === A.length && hit === B.length) return 0.98;
  return dice;
}
/** Best library match for a written name. Ties go to exercises you already use. */
export function matchExercise(name: string, lib: Any[], used: Set<string> = new Set()): { id: string | null; score: number } {
  let best: { id: string | null; score: number } = { id: null, score: 0 };
  for (const e of lib) {
    if (e.archived) continue;
    const cands = [e.name.en, e.name.it, ...(e.aliases || [])];
    let sc = Math.max(...cands.map((c: string) => sim(name, c)));
    if (used.has(e.id)) sc += 0.015;
    if (sc > best.score) best = { id: e.id, score: sc };
  }
  return best.score >= 0.6 ? best : { id: null, score: best.score };
}
export function matchAll(days: PlanDay[] | null, sessions: LogSession[] | null, lib: Any[], used: Set<string>) {
  for (const d of days || []) for (const it of d.items) { const m = matchExercise(it.name, lib, used); it.exId = m.id; it.score = m.score; it.isNew = !m.id; }
  for (const s of sessions || []) for (const e of s.exercises) { const m = matchExercise(e.name, lib, used); e.exId = m.id; e.score = m.score; e.isNew = !m.id; }
}

/* ------------------------------------------------------------------ building records */
function guessEquipment(n: string): string {
  const s = norm(n);
  if (/manubri|manubrio|dumbbell|db\b/.test(s)) return "dumbbell";
  if (/bilanciere|barbell|\bez\b|bb\b/.test(s)) return "barbell";
  if (/multipower|smith/.test(s)) return "smith";
  if (/cavo|cavi|cable|pulley|corda|rope/.test(s)) return "cable";
  if (/corpo libero|bodyweight|plank|crunch|trazioni|dips|piegamenti/.test(s)) return "bodyweight";
  return "machine";
}
export function newExerciseFor(name: string, muscle: string | null, timed: boolean, now: number) {
  const eq = guessEquipment(name);
  const cardio = muscle === "cardio";
  return {
    id: "ex_c_" + uid(), name: { en: name, it: name }, aliases: [], equipment: eq, pattern: cardio ? "cardio" : "other",
    mechanic: cardio ? "cardio" : "isolation", loadType: eq === "bodyweight" || cardio ? "bodyweight" : "external",
    inc: eq === "dumbbell" ? 2 : eq === "machine" ? 5 : eq === "bodyweight" ? 0 : 2.5, rest: 90,
    track: timed ? "time" : cardio ? "reps" : "wr",
    muscles: muscle ? [{ m: muscle, role: "primary" }] : [], notes: "", custom: true, archived: false, createdAt: now, updatedAt: now,
  };
}

/** Plan preview → program (+ the custom exercises it needs). */
export function buildProgramFromPlan(days: PlanDay[], name: string, now: number, lib: Map<string, Any>) {
  const created: Any[] = [];
  const createdByName = new Map<string, Any>();
  const prog = {
    id: uid(), name, description: "", status: "inactive", nextDay: 0, createdAt: now, updatedAt: now,
    days: days.map(d => ({
      id: uid(), name: { en: d.name, it: d.name },
      exercises: d.items.map(it => {
        const timed = it.sets.some(s => s.mins != null);
        let exId = it.exId;
        if (!exId) {
          const key = norm(it.name);
          let ex = createdByName.get(key);
          if (!ex) { ex = newExerciseFor(it.name, it.muscle, timed, now); createdByName.set(key, ex); created.push(ex); }
          exId = ex.id;
        }
        const ex = lib.get(exId!) || createdByName.get(norm(it.name));
        const tr = ex?.track || "wr";
        return {
          id: uid(), exId, group: null, optional: false, rest: it.rest, notes: it.notes || "", scheme: it.scheme || "straight",
          sets: it.sets.map(s => tr === "time"
            ? { id: uid(), type: "working", load: null, repsMin: 0, repsMax: 0, rir: null, mins: s.mins ?? 1 }
            : { id: uid(), type: s.type, load: it.load, repsMin: s.min, repsMax: s.max, rir: tr === "wr" ? (s.type === "amrap" ? 0 : 2) : null }),
        };
      }),
    })),
  };
  return { program: prog, created };
}

/** Log preview → completed sessions (+ custom exercises). */
export function buildSessionsFromLog(sessions: LogSession[], now: number, lib: Map<string, Any>) {
  const created: Any[] = []; const byName = new Map<string, Any>();
  const out = sessions.map((s, si) => {
    const started = s.date ? new Date(s.date + "T08:00:00").getTime() : now - (sessions.length - si) * 60_000;
    return {
      id: uid(), programId: null, dayId: null, dayName: { en: s.name, it: s.name }, status: "completed", imported: true, dateUnknown: !s.date,
      startedAt: started, endedAt: started, pausedMs: 0, pausedAt: null, idx: 0, rest: null, notes: "", sessionRpe: null, suggestions: [], createdAt: now, updatedAt: now,
      exercises: s.exercises.map(e => {
        let exId = e.exId;
        if (!exId) { const k = norm(e.name); let ex = byName.get(k); if (!ex) { ex = newExerciseFor(e.name, null, e.sets.some(x => x.mins != null), now); byName.set(k, ex); created.push(ex); } exId = ex.id; }
        const ex = lib.get(exId!) || byName.get(norm(e.name));
        return {
          id: uid(), peId: null, exId, plannedExId: exId, name: ex ? ex.name : { en: e.name, it: e.name }, group: e.group, optional: e.optional, skipped: false, notes: "",
          sets: e.sets.map(x => ({ id: uid(), type: x.type, load: x.load, reps: x.reps, mins: x.mins, rir: x.rir, rpe: null, done: true, doneAt: started, t: null })),
        };
      }),
    };
  });
  return { sessions: out, created };
}

/** Decide what a pasted / loaded text is and parse it. */
export function parseAny(text: string, rows: string[][] | null = null):
  { kind: "plan"; days: PlanDay[] } | { kind: "log"; sessions: LogSession[] } | { kind: "none" } {
  const r = rows || readDelimited(text);
  if (r) {
    const logs = parseLogRows(r);
    if (logs && logs.length) return { kind: "log", sessions: logs };
    const days = parsePlanRows(r);
    if (days.length) return { kind: "plan", days };
  }
  if (!rows && looksLikeLog(text)) { const s = parseLog(text); if (s.length) return { kind: "log", sessions: s }; }
  const days = parsePlanLines(text.replace(/\r\n?/g, "\n").split("\n"));
  return days.length ? { kind: "plan", days } : { kind: "none" };
}

/* ------------------------------------------------------------------ .xlsx reader (zip + XML, no library) */
async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const ds = new (globalThis as Any).DecompressionStream("deflate-raw");
  const stream = new Blob([data as Any]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function unzip(buf: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  const v = new DataView(buf), u8 = new Uint8Array(buf), files = new Map<string, Uint8Array>();
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip");
  const n = v.getUint16(eocd + 10, true); let p = v.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  for (let k = 0; k < n; k++) {
    if (v.getUint32(p, true) !== 0x02014b50) break;
    const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true);
    const nl = v.getUint16(p + 28, true), xl = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true), off = v.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nl));
    const lnl = v.getUint16(off + 26, true), lxl = v.getUint16(off + 28, true);
    const start = off + 30 + lnl + lxl, raw = u8.subarray(start, start + csize);
    if (/^xl\/(sharedStrings|workbook)\.xml$|^xl\/_rels\/workbook\.xml\.rels$|^xl\/worksheets\/[^/]+\.xml$/.test(name)) {
      files.set(name, method === 0 ? raw : method === 8 ? await inflateRaw(raw) : new Uint8Array());
    }
    p += 46 + nl + xl + cl;
  }
  return files;
}
const unxml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(+d)).replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCharCode(parseInt(h, 16))).replace(/&amp;/g, "&");
const colIdx = (ref: string) => { const l = ref.replace(/\d+/g, ""); let n = 0; for (const c of l) n = n * 26 + (c.charCodeAt(0) - 64); return n - 1; };

/** First worksheet of an .xlsx as rows of strings. */
export async function readXlsx(buf: ArrayBuffer): Promise<string[][]> {
  const files = await unzip(buf); const dec = new TextDecoder();
  const txt = (n: string) => (files.has(n) ? dec.decode(files.get(n)) : "");
  const shared = Array.from(txt("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)).map(m => unxml(Array.from(m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)).map(t => t[1]).join("")));
  let sheet = "xl/worksheets/sheet1.xml";
  const wb = txt("xl/workbook.xml"), rels = txt("xl/_rels/workbook.xml.rels");
  const first = wb.match(/<sheet\b[^>]*r:id="([^"]+)"/);
  if (first) { const rel = rels.match(new RegExp(`<Relationship\\b[^>]*Id="${first[1]}"[^>]*Target="([^"]+)"`)) || rels.match(new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${first[1]}"`)); if (rel) sheet = "xl/" + rel[1].replace(/^\/?xl\//, "").replace(/^\//, ""); }
  const xml = txt(sheet) || txt([...files.keys()].find(k => k.startsWith("xl/worksheets/")) || "");
  const rows: string[][] = [];
  for (const rm of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rn = parseInt((rm[1].match(/r="(\d+)"/) || [])[1] || String(rows.length + 1), 10);
    const row: string[] = [];
    for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1], body = cm[2] || "";
      const ref = (attrs.match(/r="([A-Z]+)\d+"/) || [])[1]; const ci = ref ? colIdx(ref) : row.length;
      const tp = (attrs.match(/t="([^"]+)"/) || [])[1];
      const vv = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      let val = "";
      if (tp === "s") val = shared[parseInt(vv || "0", 10)] ?? "";
      else if (tp === "inlineStr") val = unxml(Array.from(body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)).map(t => t[1]).join(""));
      else if (vv != null) val = unxml(vv);
      while (row.length < ci) row.push("");
      row[ci] = val;
    }
    while (rows.length < rn - 1) rows.push([]);
    rows[rn - 1] = row;
  }
  return rows;
}
