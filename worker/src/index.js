// JimLogs push server: schedules ONE Web Push per user (the "rest is over" alert) with a Durable Object alarm.
// The caller proves who they are with a long random key kept on their phone; only a hash of it is used as the object name.
import { generateVapidKeys, sendPush } from "./webpush.js";

const ORIGINS = ["https://frimpongemanuele.github.io"];
const SUBJECT = "https://frimpongemanuele.github.io/logbook/";
const PUSH_HOSTS = [/(^|\.)push\.apple\.com$/, /(^|\.)googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];

const cors = (req) => { const o = req.headers.get("Origin"); return { "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0], "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Vary": "Origin" }; };
const reply = (req, status, body) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": typeof body === "string" ? "text/plain" : "application/json" } });
const sha256hex = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, "0")).join("");
const validSub = (s) => { try { const u = new URL(s.endpoint); return u.protocol === "https:" && PUSH_HOSTS.some(r => r.test(u.hostname)) && typeof s.keys?.p256dh === "string" && typeof s.keys?.auth === "string" && s.keys.p256dh.length < 200 && s.keys.auth.length < 100; } catch { return false; } };
const clip = (v, n) => String(v ?? "").slice(0, n);

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
    const url = new URL(req.url);
    if (url.pathname === "/vapid" && req.method === "GET") return reply(req, 200, await (await env.KEYS.get(env.KEYS.idFromName("vapid")).fetch("https://k/public")).text());
    if (req.method !== "POST" || !["/schedule", "/cancel", "/test"].includes(url.pathname)) return reply(req, 404, "not found");
    let m; try { const raw = await req.text(); if (raw.length > 4000) return reply(req, 413, "too big"); m = JSON.parse(raw); } catch { return reply(req, 400, "bad json"); }
    if (typeof m.key !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(m.key)) return reply(req, 401, "bad key");
    const timer = env.TIMER.get(env.TIMER.idFromName(await sha256hex(m.key)));
    const call = (path, body) => timer.fetch("https://t" + path, { method: "POST", body: JSON.stringify(body) });
    if (url.pathname === "/cancel") { await call("/cancel", {}); return reply(req, 200, { ok: true }); }
    if (!m.sub || !validSub(m.sub)) return reply(req, 400, "bad subscription");
    const now = Date.now();
    if (url.pathname === "/test") { await call("/schedule", { sub: m.sub, at: now + 3000, title: clip(m.title, 80), body: clip(m.body, 200), env: "test" }); return reply(req, 200, { ok: true }); }
    const at = Number(m.at); if (!(at > now - 60000 && at < now + 2 * 3600 * 1000)) return reply(req, 400, "bad time");
    await call("/schedule", { sub: m.sub, at: Math.max(at, now + 500), title: clip(m.title, 80), body: clip(m.body, 200) });
    return reply(req, 200, { ok: true });
  },
};

/** Holds the server's VAPID key pair (made on first use, never leaves the server except the public half). */
export class Keys {
  constructor(state) { this.state = state; }
  async load() { let k = await this.state.storage.get("keys"); if (!k) { k = await generateVapidKeys(); await this.state.storage.put("keys", k); } return k; }
  async fetch(req) { const k = await this.load(); const p = new URL(req.url).pathname; return p === "/private" ? new Response(JSON.stringify(k)) : new Response(k.publicKey); }
}

/** One per user: remembers the pending alert and fires it at the right second. */
export class RestTimer {
  constructor(state, env) { this.state = state; this.env = env; }
  async fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === "/cancel") { await this.state.storage.deleteAlarm(); await this.state.storage.delete("job"); return new Response("ok"); }
    const job = JSON.parse(await req.text());
    await this.state.storage.put("job", job); await this.state.storage.setAlarm(job.at);
    return new Response("ok");
  }
  async alarm() {
    const job = await this.state.storage.get("job"); if (!job) return;
    await this.state.storage.delete("job");
    try {
      const keys = await (await this.env.KEYS.get(this.env.KEYS.idFromName("vapid")).fetch("https://k/private")).json();
      await sendPush(job.sub, { title: job.title || "JimLogs", body: job.body || "" }, keys, SUBJECT);
    } catch { /* nothing to retry: a late alert is worse than none */ }
  }
}
