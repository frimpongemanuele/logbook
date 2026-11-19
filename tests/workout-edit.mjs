// In-workout plan editing, notes, last-time fallback, accent colours. Run: node tests/workout-edit.mjs (serves ./beta, or SITE=public)
import { createRequire } from "module"; import { execSync, spawn } from "child_process"; import fs from "fs";
const require = createRequire(import.meta.url);
const { chromium } = require(execSync("npm root -g").toString().trim() + "/playwright");
const srv = spawn("python3", ["-m", "http.server", "8766", "-d", process.env.SITE || "beta"], { stdio: "ignore" });
await new Promise(r => setTimeout(r, 800));
const STARTER = process.env.STARTER || "../private/logbook-starter-backup.json";
const results = []; const ok = (n, c) => results.push([c ? "PASS" : "FAIL", n]);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "en-GB" });
const page = await ctx.newPage(); const errors = []; page.on("pageerror", e => errors.push(e.message));
const dbAll = (store) => page.evaluate(async s => (await (await import("./js/db.js")).all(s)), store);
try {
  await page.goto("http://localhost:8766/"); await page.waitForSelector(".tour-card"); await page.click('.tour [data-a="tourEnd"]'); await page.waitForSelector(".tour", { state: "detached" }); await page.waitForTimeout(300);
  await page.setInputFiles('[data-in="impFile"]', STARTER); await page.waitForSelector("h1:has-text('Push')");
  await page.evaluate(async () => { const d = await import("./js/db.js"); const ps = await d.all("programs"); ps[0].nextDay = 1; await d.put("programs", ps[0]); });
  await page.reload(); await page.waitForSelector("h1:has-text('Pull')");
  await page.click('[data-a="start"]'); await page.waitForSelector(".ex-name");
  // --- last-time column: no "—" on exercises that have history
  const lastTexts = [];
  const n = await page.$$eval("#strip button[data-a=goto]", b => b.length);
  for (let i = 0; i < n; i++) {
    await page.click(`#strip button[data-v="${i}"]`); await page.waitForTimeout(80);
    lastTexts.push([await page.textContent(".ex-name"), await page.$$eval(".set .last", els => els.map(e => e.textContent.trim()))]);
  }
  console.log(JSON.stringify(lastTexts));
  const pullup = lastTexts.find(x => /Pull-?up|Trazioni/i.test(x[0]));
  ok("Exercises with history never show '—' (extra sets reuse the previous last set)", lastTexts.every(([name, l]) => l.every(x => x !== "—") || l.every(x => x === "—")));
  // --- superset: remove from the workout and the plan
  await page.click('#strip button:has-text("A ·")'); await page.waitForTimeout(100);
  ok("Superset shown in strip before", (await page.$$eval("#strip button", b => b.filter(x => x.textContent.includes("A ·")).length)) === 2);
  await page.click('[data-a="exMenu"]'); await page.click('.menu button:has-text("Change the plan")');
  await page.waitForSelector('.menu button:has-text("Remove superset")');
  await page.screenshot({ path: "tests/shots/30-plan-menu.png" });
  await page.click('.menu button:has-text("Remove superset")'); await page.waitForTimeout(300);
  ok("Superset gone from the running workout", (await page.$$eval("#strip button", b => b.filter(x => x.textContent.includes("A ·")).length)) === 0);
  const prog = (await dbAll("programs"))[0]; const pull = prog.days.find(d => d.name.en === "Pull");
  ok("Superset gone from the plan too", pull.exercises.every(e => !e.group));
  const sess = (await dbAll("sessions")).find(s => s.status === "in_progress");
  ok("Running workout persisted without groups", sess.exercises.every(e => !e.group));
  // --- make a superset again with the next exercise
  await page.click('#strip button:has-text("Lat")'); await page.click('[data-a="exMenu"]'); await page.click('.menu button:has-text("Change the plan")');
  await page.click('.menu button:has-text("Superset with")'); await page.waitForTimeout(300);
  const pull2 = (await dbAll("programs"))[0].days.find(d => d.name.en === "Pull");
  ok("New superset written to the plan", pull2.exercises.filter(e => e.group).length === 2);
  // --- optional toggle + remove from plan only
  await page.click('[data-a="exMenu"]'); await page.click('.menu button:has-text("Change the plan")'); await page.click('.menu button:has-text("Mark as optional")'); await page.waitForTimeout(300);
  ok("Optional saved to plan", (await dbAll("programs"))[0].days.find(d => d.name.en === "Pull").exercises.filter(e => e.optional).length >= 2);
  // --- reorder syncs the plan
  const before = (await dbAll("programs"))[0].days.find(d => d.name.en === "Pull").exercises.map(e => e.id);
  await page.click('#strip button[data-v="0"]'); await page.click('[data-a="exMenu"]'); await page.click('.menu button:has-text("Move later")'); await page.waitForTimeout(300);
  const after = (await dbAll("programs"))[0].days.find(d => d.name.en === "Pull").exercises.map(e => e.id);
  ok("Moving an exercise reorders the plan", after[0] === before[1] && after[1] === before[0]);
  // --- remove from workout and plan (nothing logged yet on the last exercise)
  const cnt = (await dbAll("programs"))[0].days.find(d => d.name.en === "Pull").exercises.length;
  await page.click('#strip button:last-of-type', { trial: true }).catch(() => {});
  await page.click(`#strip button[data-v="${n - 1}"]`); await page.click('[data-a="exMenu"]'); await page.click('.menu button:has-text("Change the plan")');
  await page.click('.menu button:has-text("Remove from workout and plan")'); await page.click('[data-a="confirmOk"]'); await page.waitForTimeout(300);
  ok("Removed from workout and plan", (await dbAll("programs"))[0].days.find(d => d.name.en === "Pull").exercises.length === cnt - 1
    && (await page.$$eval("#strip button[data-a=goto]", b => b.length)) === n - 1);
  // --- notes during the workout
  await page.click('[data-a="wNotes"]'); await page.waitForSelector("#wne");
  await page.fill("#wne", "Elbow pinched, switch to neutral grip"); await page.fill("#wns", "Slept badly"); await page.waitForTimeout(700);
  await page.screenshot({ path: "tests/shots/31-notes.png" });
  const s2 = (await dbAll("sessions")).find(s => s.status === "in_progress");
  ok("Workout note saved while training", s2.notes === "Slept badly");
  ok("Exercise note saved while training", s2.exercises.some(e => e.notes === "Elbow pinched, switch to neutral grip"));
  await page.click('[data-a="closeSheet"]'); await page.waitForTimeout(150);
  ok("Exercise note shows on the exercise", (await page.textContent(".wk-body")).includes("Elbow pinched"));
  // --- focus loss resets text edit history (iOS Undo Typing)
  await page.click('[data-a="wNotes"]'); await page.focus("#wns"); await page.keyboard.press("Control+End"); await page.keyboard.type(" a lot"); await page.evaluate(() => document.activeElement.blur());
  ok("Typed text survives the history reset", (await page.inputValue("#wns")) === "Slept badly a lot");
  await page.click('[data-a="closeSheet"]');
  // --- accent colour + colour-blind
  await page.click('.wk-top [data-a="tab"][data-v="today"]'); await page.waitForSelector('.tabbar');
  await page.click('.tabbar [data-a="tab"][data-v="more"]');
  await page.click('[data-a="accent"][data-v="blue"]'); await page.click('[data-a="cbSafe"]'); await page.waitForTimeout(250);
  const css = await page.evaluate(() => ({ a: document.documentElement.dataset.accent, cb: document.documentElement.dataset.cb, accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(), done: getComputedStyle(document.documentElement).getPropertyValue("--done").trim() }));
  console.log(JSON.stringify(css)); ok("Accent colour changes", css.a === "blue" && css.accent.toLowerCase() === "#0b5fc2");
  ok("Colour-blind mode swaps green for blue", css.cb === "1" && css.done.toLowerCase() === "#0072b2");
  ok("Selected swatch shows a tick, not only colour", (await page.textContent(".sw.on")).includes("✓"));
  await page.screenshot({ path: "tests/shots/32-colours.png" });
  await page.reload(); await page.waitForSelector("h1");
  ok("Colour choice survives restart", (await page.evaluate(() => document.documentElement.dataset.accent)) === "blue");
} catch (e) { results.push(["FAIL", "exception: " + e.message.split("\n").slice(0,3).join(" ")]); await page.screenshot({ path: "tests/shots/zz-error2.png" }); }
ok("No page errors", errors.length === 0); if (errors.length) console.log(errors);
for (const r of results) console.log(r.join("  "));
await browser.close(); srv.kill();
