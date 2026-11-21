// Pure export / import helpers (unit-tested).
import { csvEscape } from "./domain.js";
export function setsCsv(sessions, lib) {
    const rows = [["date", "session_id", "day", "exercise", "exercise_it", "set", "type", "load_kg", "reps", "rir", "rpe", "done", "target_reps_min", "target_reps_max", "target_rir", "date_unknown", "minutes", "speed_kmh", "incline_pct"]];
    for (const s of sessions.filter((x) => x.status === "completed").sort((a, b) => a.startedAt - b.startedAt)) {
        for (const e of s.exercises) {
            if (e.skipped)
                continue;
            const ex = lib.get(e.exId);
            e.sets.forEach((x, i) => rows.push([new Date(s.startedAt).toISOString(), s.id, s.dayName?.en || "", ex?.name.en || e.name?.en, ex?.name.it || e.name?.it, String(i + 1), x.type, String(x.load), String(x.reps), x.rir ?? "", x.rpe ?? (x.rir != null ? String(10 - Math.min(x.rir, 5)) : ""), x.done ? "1" : "0", x.t?.repsMin ?? "", x.t?.repsMax ?? "", x.t?.rir ?? "", s.dateUnknown ? "1" : "0", x.mins ?? "", x.speed ?? "", x.incline ?? ""]));
        }
    }
    return rows.map(r => r.map(csvEscape).join(",")).join("\n");
}
export function mergeImport(local, incoming) {
    const res = { added: 0, updated: 0, kept: 0, writes: {} };
    const hasActive = (local.sessions || []).some((s) => s.status === "in_progress");
    for (const store of ["exercises", "programs", "sessions"]) {
        const map = new Map((local[store] || []).map((x) => [x.id, x]));
        res.writes[store] = [];
        for (const rec of incoming[store] || []) {
            if (!rec || typeof rec.id !== "string")
                continue;
            let r = rec;
            if (store === "sessions" && r.status === "in_progress" && hasActive && !map.has(r.id))
                r = { ...r, status: "completed", endedAt: r.updatedAt || r.startedAt };
            const cur = map.get(r.id);
            if (!cur) {
                res.added++;
                res.writes[store].push(r);
            }
            else if ((r.updatedAt || 0) > (cur.updatedAt || 0)) {
                res.updated++;
                res.writes[store].push(r);
            }
            else
                res.kept++;
        }
    }
    return res;
}
