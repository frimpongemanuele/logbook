import test from "node:test"; import assert from "node:assert/strict";
import { generateVapidKeys, vapidHeader, encryptPayload, sendPush, b64u, unb64u } from "../worker/src/webpush.js";
import worker, { RestTimer, Keys } from "../worker/src/index.js";

async function receiver() {
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { kp, auth, sub: { endpoint: "https://web.push.apple.com/abc", keys: { p256dh: b64u(await crypto.subtle.exportKey("raw", kp.publicKey)), auth: b64u(auth) } } };
}
async function hkdf(salt, ikm, info, len) { const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]); return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, len * 8)); }
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
const te = new TextEncoder();
// independent RFC 8291 decryption on the receiving side
async function decrypt(r, body) {
  const salt = body.slice(0, 16), idlen = body[20], asPub = body.slice(21, 21 + idlen), ct = body.slice(21 + idlen);
  const uaPub = new Uint8Array(await crypto.subtle.exportKey("raw", r.kp.publicKey));
  const asKey = await crypto.subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, r.kp.privateKey, 256));
  const prk = await hkdf(r.auth, secret, cat(te.encode("WebPush: info\0"), uaPub, asPub), 32);
  const cek = await hkdf(salt, prk, te.encode("Content-Encoding: aes128gcm\0"), 16), nonce = await hkdf(salt, prk, te.encode("Content-Encoding: nonce\0"), 12);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]), ct));
  assert.equal(pt[pt.length - 1], 2); return new TextDecoder().decode(pt.slice(0, -1));
}

test("payload encrypts so only the receiver can read it", async () => {
  const r = await receiver(); const body = await encryptPayload(r.sub.keys, JSON.stringify({ title: "Rest over", body: "Set 2 · 34 kg × 10 ✓" }));
  assert.deepEqual(JSON.parse(await decrypt(r, body)), { title: "Rest over", body: "Set 2 · 34 kg × 10 ✓" });
});
test("VAPID header carries a valid ES256 signature and the right audience", async () => {
  const keys = await generateVapidKeys(); const h = await vapidHeader("https://web.push.apple.com/xyz", "https://example.org/", keys, 1_000_000_000_000);
  const [, jwt, k] = h.match(/^vapid t=([^,]+), k=(.+)$/); assert.equal(k, keys.publicKey);
  const [a, b, c] = jwt.split("."); assert.equal(JSON.parse(new TextDecoder().decode(unb64u(b))).aud, "https://web.push.apple.com");
  const pub = await crypto.subtle.importKey("raw", unb64u(keys.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  assert.ok(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, unb64u(c), te.encode(a + "." + b)));
});
test("sendPush posts an encrypted body with VAPID + TTL headers", async () => {
  const r = await receiver(), keys = await generateVapidKeys(); let seen;
  const st = await sendPush(r.sub, { title: "t", body: "b" }, keys, "https://x.org/", async (u, o) => { seen = { u, o }; return { status: 201 }; });
  assert.equal(st, 201); assert.equal(seen.u, r.sub.endpoint); assert.equal(seen.o.headers["Content-Encoding"], "aes128gcm"); assert.ok(/^vapid t=/.test(seen.o.headers.Authorization));
  assert.deepEqual(JSON.parse(await decrypt(r, seen.o.body)), { title: "t", body: "b" });
});

// --- the Worker itself, with in-memory stand-ins for Durable Objects
function fakeEnv() {
  const stores = new Map(), objs = new Map();
  const mkState = (id) => { if (!stores.has(id)) stores.set(id, { data: new Map(), alarm: null }); const s = stores.get(id); return { storage: { get: async k => s.data.get(k), put: async (k, v) => { s.data.set(k, v); }, delete: async k => { s.data.delete(k); }, setAlarm: async t => { s.alarm = t; }, deleteAlarm: async () => { s.alarm = null; } } }; };
  const ns = (Cls) => { const n = { idFromName: x => x, get: (id) => { const k = Cls.name + id; if (!objs.has(k)) objs.set(k, new Cls(mkState(k), env)); const o = objs.get(k); return { fetch: (u, i) => o.fetch(new Request(u, i)) }; } }; return n; };
  const env = { TIMER: ns(RestTimer), KEYS: ns(Keys) }; env._stores = stores; env._objs = objs; return env;
}
const KEY = "k".repeat(40);
const post = (env, path, body) => worker.fetch(new Request("https://w" + path, { method: "POST", headers: { Origin: "https://frimpongemanuele.github.io" }, body: JSON.stringify(body) }), env);
test("worker: schedule sets one alarm, cancel clears it, alarm sends the push", async () => {
  const env = fakeEnv(), r = await receiver(); const at = Date.now() + 90000;
  assert.equal((await post(env, "/schedule", { key: KEY, sub: r.sub, at, title: "Rest over", body: "Set 2" })).status, 200);
  const timerStore = [...env._stores].find(([k]) => k.startsWith("RestTimer"))[1]; assert.equal(timerStore.alarm, at);
  await post(env, "/schedule", { key: KEY, sub: r.sub, at: at + 30000, title: "Rest over", body: "Set 2" }); assert.equal(timerStore.alarm, at + 30000, "same user replaces the alarm");
  await post(env, "/cancel", { key: KEY }); assert.equal(timerStore.alarm, null);
  await post(env, "/schedule", { key: KEY, sub: r.sub, at, title: "Rest over", body: "Set 2" });
  let sent; const real = globalThis.fetch; globalThis.fetch = async (u, o) => { sent = { u, o }; return { status: 201 }; };
  try { await [...env._objs].find(([k]) => k.startsWith("RestTimer"))[1].alarm(); } finally { globalThis.fetch = real; }
  assert.equal(sent.u, r.sub.endpoint); assert.deepEqual(JSON.parse(await decrypt(r, sent.o.body)), { title: "Rest over", body: "Set 2" });
  assert.equal(timerStore.data.has("job"), false);
});
test("worker: rejects weak keys, foreign push hosts and silly times", async () => {
  const env = fakeEnv(), r = await receiver();
  assert.equal((await post(env, "/schedule", { key: "short", sub: r.sub, at: Date.now() + 5000 })).status, 401);
  assert.equal((await post(env, "/schedule", { key: KEY, sub: { ...r.sub, endpoint: "https://evil.example.com/x" }, at: Date.now() + 5000 })).status, 400);
  assert.equal((await post(env, "/schedule", { key: KEY, sub: { ...r.sub, endpoint: "http://web.push.apple.com/x" }, at: Date.now() + 5000 })).status, 400);
  assert.equal((await post(env, "/schedule", { key: KEY, sub: r.sub, at: Date.now() + 9 * 3600 * 1000 })).status, 400);
  assert.equal((await worker.fetch(new Request("https://w/vapid"), env)).status, 200);
});
test("worker: /vapid is stable between calls", async () => {
  const env = fakeEnv(); const a = await (await worker.fetch(new Request("https://w/vapid"), env)).text(), b = await (await worker.fetch(new Request("https://w/vapid"), env)).text();
  assert.equal(a, b); assert.equal(unb64u(a).length, 65);
});
