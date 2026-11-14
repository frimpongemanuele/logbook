// Minimal IndexedDB wrapper. Every write resolves only after the transaction commits.
const DB_NAME = "logbook";
const DB_VERSION = 1;
export const STORES = ["exercises", "programs", "sessions", "meta"];
let dbp = null;
export function open() {
    if (dbp)
        return dbp;
    dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains("exercises"))
                db.createObjectStore("exercises", { keyPath: "id" });
            if (!db.objectStoreNames.contains("programs"))
                db.createObjectStore("programs", { keyPath: "id" });
            if (!db.objectStoreNames.contains("sessions")) {
                const s = db.createObjectStore("sessions", { keyPath: "id" });
                s.createIndex("startedAt", "startedAt");
                s.createIndex("status", "status");
            }
            if (!db.objectStoreNames.contains("meta"))
                db.createObjectStore("meta", { keyPath: "key" });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error("Database blocked by another open tab"));
    });
    return dbp;
}
function done(tx) {
    return new Promise((res, rej) => {
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
        tx.onabort = () => rej(tx.error || new Error("Transaction aborted"));
    });
}
export async function all(store) {
    const db = await open();
    return new Promise((res, rej) => {
        const r = db.transaction(store).objectStore(store).getAll();
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
    });
}
export async function get(store, key) {
    const db = await open();
    return new Promise((res, rej) => {
        const r = db.transaction(store).objectStore(store).get(key);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
    });
}
export async function put(store, value) {
    const db = await open();
    const tx = db.transaction(store, "readwrite");
    // structured clone of a plain copy guards against accidental proxies / functions
    tx.objectStore(store).put(JSON.parse(JSON.stringify(value)));
    return done(tx);
}
export async function putMany(store, values) {
    if (!values.length)
        return;
    const db = await open();
    const tx = db.transaction(store, "readwrite");
    const os = tx.objectStore(store);
    for (const v of values)
        os.put(JSON.parse(JSON.stringify(v)));
    return done(tx);
}
export async function del(store, key) {
    const db = await open();
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    return done(tx);
}
export async function clearAll() {
    const db = await open();
    const tx = db.transaction([...STORES], "readwrite");
    for (const s of STORES)
        tx.objectStore(s).clear();
    return done(tx);
}
export async function getMeta(key, fallback) {
    const r = await get("meta", key);
    return r ? r.value : fallback;
}
export async function setMeta(key, value) {
    return put("meta", { key, value });
}
