// Program sharing by link: the whole program travels inside the link (compressed), no server involved.
//   https://…/logbook/#share=<code>   ·   code = base64url( deflate-raw( JSON payload ) )
import { uid } from "./domain.js";
const TYPES = ["working", "warmup", "top", "backoff", "amrap", "drop"];
function b64url(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++)
        s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(code) {
    const b = atob(code.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((code.length + 3) % 4));
    const out = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++)
        out[i] = b.charCodeAt(i);
    return out;
}
async function pipe(bytes, stream) {
    const s = new Blob([bytes]).stream().pipeThrough(stream);
    return new Uint8Array(await new Response(s).arrayBuffer());
}
export async function pack(obj) {
    return b64url(await pipe(new TextEncoder().encode(JSON.stringify(obj)), new globalThis.CompressionStream("deflate-raw")));
}
export async function unpack(code) {
    return JSON.parse(new TextDecoder().decode(await pipe(unb64url(code), new globalThis.DecompressionStream("deflate-raw"))));
}
/** Find a share code in a pasted link or text. */
export function extractCode(text) {
    const m = (text || "").match(/[#?&]share=([A-Za-z0-9_-]{20,})/);
    return m ? m[1] : null;
}
/** Program → compact payload. Custom exercises travel with it; weights only if asked. */
export function toPayload(p, lib, withLoads) {
    const cx = {};
    const days = p.days.map((d) => ({
        n: d.name.en || d.name.it,
        e: d.exercises.map((pe) => {
            const ex = lib.get(pe.exId);
            if (ex && (ex.custom || !pe.exId.startsWith("ex_") || pe.exId.startsWith("ex_c_"))) {
                cx[pe.exId] = { n: ex.name, eq: ex.equipment, lt: ex.loadType, inc: ex.inc, r: ex.rest, m: ex.muscles, tr: ex.track || "wr", la: ex.laterality || "bilateral", xt: ex.extras || [] };
            }
            return {
                x: pe.exId, xn: ex ? ex.name.en : "", g: pe.group || null, o: pe.optional ? 1 : 0, r: pe.rest ?? null, sc: pe.scheme || "straight", nt: pe.notes || "",
                s: pe.sets.map((s) => [Math.max(0, TYPES.indexOf(s.type)), withLoads ? (s.load ?? null) : null, s.repsMin, s.repsMax ?? null, s.rir ?? null, s.mins ?? null, s.speed ?? null, s.incline ?? null]),
            };
        }),
    }));
    return { v: 1, app: "logbook", n: p.name, ds: p.description || "", w: withLoads ? 1 : 0, d: days, cx };
}
export function validPayload(o) {
    return !!o && o.v === 1 && o.app === "logbook" && Array.isArray(o.d) && o.d.every((d) => Array.isArray(d.e));
}
/** Payload → a new program for this phone. Missing exercises are matched by name or created. */
export function fromPayload(o, lib, now, match) {
    const created = [];
    const map = new Map();
    const resolve = (x, xn) => {
        if (map.has(x))
            return map.get(x);
        let id = null;
        if (lib.has(x) && !x.startsWith("ex_c_"))
            id = x; // built-in exercise: same id everywhere
        const def = o.cx && o.cx[x];
        if (!id)
            id = match(def ? def.n.en || def.n.it : xn);
        if (!id) {
            const n = def ? def.n : { en: xn || "Exercise", it: xn || "Esercizio" };
            const ex = { id: "ex_c_" + uid(), name: { en: n.en || n.it, it: n.it || n.en }, aliases: [], equipment: def?.eq || "machine", pattern: "other", mechanic: def?.tr === "time" ? "cardio" : "isolation",
                loadType: def?.lt || "external", inc: def?.inc ?? 2.5, rest: def?.r ?? 90, muscles: def?.m || [], track: def?.tr || "wr", laterality: def?.la || "bilateral", ...(def?.xt?.length ? { extras: def.xt } : {}),
                notes: "", custom: true, archived: false, createdAt: now, updatedAt: now };
            created.push(ex);
            id = ex.id;
        }
        map.set(x, id);
        return id;
    };
    const program = {
        id: uid(), name: o.n || "Shared program", description: o.ds || "", status: "inactive", nextDay: 0, createdAt: now, updatedAt: now,
        days: o.d.map((d) => ({
            id: uid(), name: { en: d.n, it: d.n },
            exercises: d.e.map((e) => ({
                id: uid(), exId: resolve(e.x, e.xn), group: e.g || null, optional: !!e.o, rest: e.r ?? null, scheme: e.sc || "straight", notes: e.nt || "",
                sets: e.s.map((a) => ({ id: uid(), type: TYPES[a[0]] || "working", load: a[1] ?? null, repsMin: a[2] ?? 8, repsMax: a[3] === undefined ? 12 : a[3], rir: a[4] ?? null, ...(a[5] != null ? { mins: a[5] } : {}), ...(a[6] != null ? { speed: a[6] } : {}), ...(a[7] != null ? { incline: a[7] } : {}) })),
            })),
        })),
    };
    return { program, created };
}
