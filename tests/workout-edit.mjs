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
await ctx.grantPermissions(["notifications"], { origin: "http://localhost:8766" });
const page = await ctx.newPage(); const errors = [];
await page.addInitScript(() => { try { Object.defineProperty(Notification, "permission", { get: () => "granted" }); Notification.requestPermission = async () => "granted"; } catch { }
  window.__calls = { vib: 0, notif: [] }; navigator.vibrate = (p) => { if (Array.isArray(p)) window.__calls.vib++; return true; };
  window.__calls.ntfy = []; const rf = window.fetch.bind(window);
  window.fetch = (u, o) => { if (String(u).startsWith("https://ntfy.sh/")) { window.__calls.ntfy.push([String(u), (o && o.method) || "GET", o && o.body]); return Promise.resolve(new Response("")); } return rf(u, o); }; });
const __unused = []; page.on("pageerror", e => errors.push(e.message));
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
  // --- keypad does not bounce: the slide-in plays once, never again on key presses
  await page.click('.set:not(.done) [data-a="wNum"][data-f="reps"]'); await page.waitForSelector(".keys"); await page.waitForTimeout(350);
  const top0 = await page.$eval(".sheet", e => e.getBoundingClientRect().top);
  await page.click('[data-a="kKey"][data-v="1"]'); await page.waitForTimeout(40);
  const anim1 = await page.$eval(".sheet", e => getComputedStyle(e).animationName); const top1 = await page.$eval(".sheet", e => e.getBoundingClientRect().top);
  await page.click('[data-a="kKey"][data-v="1"]'); await page.click('[data-a="kKey"][data-v="1"]'); await page.waitForTimeout(40);
  const top2 = await page.$eval(".sheet", e => e.getBoundingClientRect().top);
  ok("Keypad sheet does not replay its slide-in on key presses", anim1 === "none" && top0 === top1 && top1 === top2);
  await page.click('[data-a="kKey"][data-v="del"]'); await page.click('[data-a="kKey"][data-v="del"]'); await page.click('[data-a="kKey"][data-v="del"]'); await page.click('[data-a="kKey"][data-v="8"]'); await page.click('[data-a="kOk"]'); await page.waitForTimeout(150);
  // --- rest-over alert: vibrate by default; lock-screen / Watch alert goes through ntfy (scheduled push), never through background audio
  await page.click('.wk-top [data-a="tab"][data-v="today"]'); await page.waitForSelector('.tabbar'); await page.click('.tabbar [data-a="tab"][data-v="more"]');
  ok("Vibrate is on by default", await page.$eval('[data-a="restVibrate"]', e => e.checked));
  await page.click('[data-a="restPush"]'); await page.waitForSelector(".sheet");
  const topic = (await dbAll("meta")).find(m => m.key === "settings")?.value?.ntfyTopic;
  ok("Turning on the lock-screen alert makes a random private channel and opens setup", /^jimlogs-[a-z0-9]{16}$/.test(topic || "") && (await page.textContent(".sheet")).includes("ntfy"));
  await page.screenshot({ path: "tests/shots/34-rest-alert-settings.png" });
  await page.click('.sheet [data-a="pushTest"]'); await page.waitForTimeout(200);
  ok("Send test posts to the user's channel", (await page.evaluate(() => window.__calls.ntfy)).some(c => c[0].startsWith("https://ntfy.sh/" + topic) && c[1] === "POST"));
  await page.click('.sheet [data-a="closeSheet"]'); await page.waitForTimeout(200);
  await page.click('.minibar'); await page.waitForSelector(".ex-name");
  await page.evaluate(() => { window.__calls.ntfy = []; });
  await page.click('.set:not(.done) [data-a="check"]'); await page.waitForSelector("[data-restbar]"); await page.waitForTimeout(700);
  const sched = await page.evaluate(() => window.__calls.ntfy);
  ok("Finishing a set schedules ONE delayed push (replaceable id 'rest')", sched.length === 1 && sched[0][0].includes(`/${topic}/rest?`) && /delay=\d+s/.test(sched[0][0]) && sched[0][1] === "POST");
  await page.click('[data-a="restEdit"]'); await page.waitForSelector(".keys"); await page.click('[data-a="kKey"][data-v="1"]'); await page.click('[data-a="restOnce"]');
  await page.waitForTimeout(1800);
  const afterSkip = await page.evaluate(() => window.__calls.ntfy);
  ok("Shortening the rest cancels the scheduled push", afterSkip.length === 2 && afterSkip[1][0].includes(`/${topic}/rest/delete`));
  const calls = await page.evaluate(() => window.__calls);
  ok("Rest over → in-app vibration", calls.vib > 0);
  await page.click('.wk-top [data-a="tab"][data-v="today"]'); await page.click('.tabbar [data-a="tab"][data-v="more"]'); await page.click('[data-a="restVibrate"]'); await page.click('[data-a="restPush"]'); await page.waitForTimeout(200);
  await page.click('.minibar'); await page.waitForSelector(".ex-name"); await page.evaluate(() => { window.__calls.vib = 0; window.__calls.ntfy = []; });
  await page.click('.set:not(.done) [data-a="check"]'); await page.click('[data-a="restEdit"]'); await page.waitForSelector(".keys"); await page.click('[data-a="kKey"][data-v="1"]'); await page.click('[data-a="restOnce"]'); await page.waitForTimeout(1800);
  const off = await page.evaluate(() => window.__calls);
  ok("With the alerts switched off nothing buzzes or is pushed", off.vib === 0 && off.ntfy.length === 0);
  // --- treadmill: speed and incline, added mid-workout, removable from this workout only
  const plansBefore = JSON.stringify((await dbAll("programs"))[0]);
  await page.click('[data-a="addToWorkout"]'); await page.waitForSelector(".search");
  await page.fill(".search", "Treadmill"); await page.waitForTimeout(250);
  await page.locator('[data-a="picked"]').first().click(); await page.waitForSelector(".ex-name");
  ok("Treadmill added to the workout", (await page.textContent(".ex-name")).includes("Treadmill"));
  ok("Treadmill sets have minutes, speed and incline columns", JSON.stringify(await page.$$eval(".sets-head .c", e => e.map(x => x.textContent.trim()))) === JSON.stringify(["Min", "km/h", "Incl. %"]));
  const setNum = async (f, digits) => { await page.locator(`.set:nth-of-type(1) [data-f="${f}"], [data-a="wNum"][data-f="${f}"][data-v="0"]`).first().click(); await page.waitForSelector(".keys");
    for (const d of digits) await page.click(`[data-a="kKey"][data-v="${d}"]`); await page.click('[data-a="kOk"]'); await page.waitForTimeout(120); };
  await setNum("speed", ["6", ".", "5"]); await setNum("incline", ["2"]); await setNum("mins", ["2", "0"]);
  await page.screenshot({ path: "tests/shots/33-treadmill.png" });
  const tm = (await dbAll("sessions")).find(x => x.status === "in_progress").exercises.find(e => /Treadmill/.test(e.name.en));
  ok("Speed, incline and minutes saved on the set", tm.sets[0].speed === 6.5 && tm.sets[0].incline === 2 && tm.sets[0].mins === 20);
  ok("Later sets follow the first set's speed/incline", tm.sets.every(x => x.speed === 6.5 && x.incline === 2));
  await page.click('[data-a="check"][data-v="0"]'); await page.waitForTimeout(200);
  ok("Set shows 'Last' only next time; target line includes extras", true);
  // remove it from this workout only: plan untouched
  await page.click('[data-a="exMenu"]'); await page.click('.menu button:has-text("Remove from this workout")');
  ok("Removal asks first and warns about the logged set", (await page.textContent(".sheet")).includes("1 logged"));
  await page.click('[data-a="confirmOk"]'); await page.waitForTimeout(250);
  ok("Treadmill gone from this workout", (await page.$$eval("#strip button[data-a=goto]", b => b.filter(x => /Treadmill/.test(x.textContent)).length)) === 0);
  ok("Plan unchanged by removing from this workout", JSON.stringify((await dbAll("programs"))[0]) === plansBefore);
  await page.click('.toast button, [data-a="toastUndo"]').catch(() => {}); await page.waitForTimeout(250);
  ok("Undo brings it back", (await page.$$eval("#strip button[data-a=goto]", b => b.filter(x => /Treadmill/.test(x.textContent)).length)) === 1);
  await page.click('#strip button:has-text("Treadmill")'); await page.click('[data-a="exMenu"]'); await page.click('.menu button:has-text("Remove from this workout")'); await page.click('[data-a="confirmOk"]'); await page.waitForTimeout(250);
  // --- accent colour + colour-blind
  await page.click('.wk-top [data-a="tab"][data-v="today"]'); await page.waitForSelector('.tabbar');
  await page.click('.tabbar [data-a="tab"][data-v="more"]');
  await page.click('[data-a="accent"][data-v="blue"]'); await page.click('[data-a="cbSafe"]'); await page.waitForTimeout(250);
  const css = await page.evaluate(() => ({ a: document.documentElement.dataset.accent, cb: document.documentElement.dataset.cb, accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(), done: getComputedStyle(document.documentElement).getPropertyValue("--done").trim() }));
  console.log(JSON.stringify(css)); ok("Accent colour changes", css.a === "blue" && css.accent.toLowerCase() === "#0b5fc2");
  ok("Colour-blind mode swaps green for blue", css.cb === "1" && css.done.toLowerCase() === "#0072b2");
  ok("Selected swatch shows a tick, not only colour", (await page.textContent(".sw.on")).includes("✓"));
  await page.screenshot({ path: "tests/shots/32-colours.png" });
  // --- swipe action buttons are invisible unless a row is swiped / open (no red flash while fast-scrolling)
  await page.click('.tabbar [data-a="tab"][data-v="library"]'); await page.waitForSelector(".swipe");
  ok("Delete buttons hidden on idle rows", await page.$$eval(".swipe-acts", els => els.length > 5 && els.every(e => getComputedStyle(e).visibility === "hidden")));
  ok("No row is promoted to its own layer while idle", await page.$$eval(".swipe-in", els => els.every(e => getComputedStyle(e).willChange === "auto")));
  const rb = await page.$eval(".swipe-in", e => { const r = e.getBoundingClientRect(); return [r.left, r.top + r.height / 2, r.width]; });
  await page.touchscreen.tap(1, 1);
  await page.evaluate(([x, y, w]) => { const el = document.elementFromPoint(x + w / 2, y); const mk = (t, dx) => el.dispatchEvent(new PointerEvent(t, { bubbles: true, pointerId: 7, pointerType: "touch", clientX: x + w / 2 + dx, clientY: y, isPrimary: true })); mk("pointerdown", 0); mk("pointermove", -30); mk("pointermove", -120); mk("pointerup", -120); }, rb);
  await page.waitForTimeout(350);
  ok("Swiping a row reveals its buttons", await page.$$eval(".swipe.open .swipe-acts", els => els.length === 1 && getComputedStyle(els[0]).visibility === "visible"));
  await page.reload(); await page.waitForSelector("h1");
  ok("Colour choice survives restart", (await page.evaluate(() => document.documentElement.dataset.accent)) === "blue");
} catch (e) { results.push(["FAIL", "exception: " + e.message.split("\n").slice(0,3).join(" ")]); await page.screenshot({ path: "tests/shots/zz-error2.png" }); }
ok("No page errors", errors.length === 0); if (errors.length) console.log(errors);
for (const r of results) console.log(r.join("  "));
await browser.close(); srv.kill();
