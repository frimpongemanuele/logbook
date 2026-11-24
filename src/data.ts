// Pure export / import helpers (unit-tested).
import { csvEscape } from "./domain.js";
type Any = any;

export function setsCsv(sessions: Any[], lib: Map<string, Any>) {
  const rows = [["date", "session_id", "day", "exercise", "exercise_it", "set", "type", "load_kg", "reps", "rir", "rpe", "done", "target_reps_min", "target_reps_max", "target_rir", "date_unknown", "minutes", "speed_kmh", "incline_pct", "exercise_notes", "session_notes"]];
  for (const s of sessions.filter((x: Any) => x.status === "completed").sort((a: Any, b: Any) => a.startedAt - b.startedAt)) {
    for (const e of s.exercises) {
      if (e.skipped) continue;
      const ex = lib.get(e.exId);
      e.sets.forEach((x: Any, i: number) => rows.push([new Date(s.startedAt).toISOString(), s.id, s.dayName?.en || "", ex?.name.en || e.name?.en, ex?.name.it || e.name?.it, String(i + 1), x.type, String(x.load), String(x.reps), x.rir ?? "", x.rpe ?? (x.rir != null ? String(10 - Math.min(x.rir, 5)) : ""), x.done ? "1" : "0", x.t?.repsMin ?? "", x.t?.repsMax ?? "", x.t?.rir ?? "", s.dateUnknown ? "1" : "0", x.mins ?? "", x.speed ?? "", x.incline ?? "", e.notes || "", s.notes || ""]));
    }
  }
  return rows.map(r => r.map(csvEscape).join(",")).join("\n");
}

export function mergeImport(local: Record<string, Any[]>, incoming: Any) {
  const res = { added: 0, updated: 0, kept: 0, writes: {} as Record<string, Any[]> };
  const hasActive = (local.sessions || []).some((s: Any) => s.status === "in_progress");
  for (const store of ["exercises", "programs", "sessions"]) {
    const map = new Map((local[store] || []).map((x: Any) => [x.id, x]));
    res.writes[store] = [];
    for (const rec of incoming[store] || []) {
      if (!rec || typeof rec.id !== "string") continue;
      let r = rec;
      if (store === "sessions" && r.status === "in_progress" && hasActive && !map.has(r.id)) r = { ...r, status: "completed", endedAt: r.updatedAt || r.startedAt };
      const cur: Any = map.get(r.id);
      if (!cur) { res.added++; res.writes[store].push(r); }
      else if ((r.updatedAt || 0) > (cur.updatedAt || 0)) { res.updated++; res.writes[store].push(r); }
      else res.kept++;
    }
  }
  return res;
}

/** Everything in one readable text file: programs, every workout (completed or running) and all notes. */
export function fullText(sessions: Any[], programs: Any[], lib: Map<string, Any>, lang = "en") {
  const nm = (o: Any) => o?.[lang] || o?.en || o?.it || "";
  const out: string[] = ["JIMLOGS EXPORT", "Exported " + new Date().toISOString().slice(0, 10), ""];
  out.push("=== PROGRAMS ===");
  for (const p of programs) {
    out.push("", "# " + (p.name?.[lang] || p.name?.en || p.name || "Program"));
    for (const d of p.days || []) {
      out.push("  " + nm(d.name));
      for (const pe of d.exercises || []) out.push("    - " + nm(lib.get(pe.exId)?.name || pe.name) + (pe.notes ? "  [" + pe.notes + "]" : ""));
    }
  }
  out.push("", "=== WORKOUTS ===");
  for (const s of [...sessions].sort((a: Any, b: Any) => a.startedAt - b.startedAt)) {
    out.push("", new Date(s.startedAt).toISOString().slice(0, 10) + (s.dateUnknown ? " (date unknown)" : "") + " · " + nm(s.dayName) + (s.status === "completed" ? "" : " (in progress)"));
    if (s.notes) out.push("  Workout note: " + s.notes);
    for (const e of s.exercises || []) {
      if (e.skipped) continue;
      const ex = lib.get(e.exId);
      out.push("  " + nm(ex?.name || e.name));
      (e.sets || []).forEach((x: Any, i: number) => {
        const parts = [x.mins != null ? x.mins + " min" : "", x.speed != null ? x.speed + " km/h" : "", x.incline != null ? x.incline + "%" : "", x.load ? x.load + " kg" : "", x.reps != null ? "× " + x.reps : "", x.rir != null ? "RIR " + x.rir : ""].filter(Boolean);
        out.push(`    ${x.done ? "✓" : "·"} ${i + 1} (${x.type}) ${parts.join(" ")}`);
      });
      if (e.notes) out.push("    Note: " + e.notes);
    }
  }
  return out.join("\n") + "\n";
}
