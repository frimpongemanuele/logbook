// Browser flows on an iPhone-sized Chromium. Run: node tests/e2e.mjs (serves ./public on :8765)
import { createRequire } from "module"; import { execSync, spawn } from "child_process"; import fs from "fs";
const require = createRequire(import.meta.url);
const { chromium } = require(execSync("npm root -g").toString().trim() + "/playwright");
const srv = spawn("python3", ["-m", "http.server", "8765", "-d", "public"], { stdio: "ignore" });
await new Promise(r => setTimeout(r, 800));
const STARTER = process.env.STARTER || "../private/logbook-starter-backup.json";
const out = "tests/shots"; fs.mkdirSync(out, { recursive: true });
const results = []; const ok = (name, cond) => { results.push([cond ? "PASS" : "FAIL", name]); };
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "en-GB", acceptDownloads: true });
const page = await ctx.newPage();
const errors = []; page.on("pageerror", e => errors.push(e.message)); page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
const shot = n => page.screenshot({ path: `${out}/${n}.png` });
const tapText = async (txt) => page.getByRole("button", { name: txt, exact: false }).first().click();
try {
  await page.goto("http://localhost:8765/");
  await page.waitForSelector("h1:has-text('Welcome')");
  ok("Fresh install shows welcome (no personal data shipped)", true);
  await shot("00-welcome");
  await page.setInputFiles('[data-in="importFile"]', STARTER);
  await page.waitForSelector("h1:has-text('Push')");
  ok("Starter backup import loads program", (await page.textContent(".toast")).includes("added"));
  ok("Today shows next day Push from rotation", true);
  ok("Last-time list shows bench 80×8 · 85×8 · 90×6", (await page.textContent(".card")).includes("80×8 · 85×8 · 90×6"));
  await shot("01-today");
  await tapText("Start workout");
  await page.waitForSelector(".ex-name");
  ok("Workout opens on Bench Press", (await page.textContent(".ex-name")).includes("Bench Press"));
  const cells = async () => page.$$eval(".set", els => els.map(e => [...e.querySelectorAll(".cell")].map(c => c.textContent.trim())));
  ok("Sets prefilled 80/8/2, 85/8/1, 90/6/1", JSON.stringify(await cells()) === JSON.stringify([["80","8","2"],["85","8","1"],["90","6","1"]]));
  await shot("02-workout");
  // log set 1 as 10 reps via keypad
  await page.locator('.set').nth(1-1).locator('[data-f="reps"]').click(); await page.waitForSelector(".keys");
  await shot("03-keypad");
  await page.click('[data-a="kKey"][data-v="1"]'); await page.click('[data-a="kKey"][data-v="0"]'); await page.click('[data-a="kOk"]');
  await page.locator('.set').nth(1-1).locator('[data-a="check"]').click();
  await page.waitForTimeout(250); ok("Set 1 ticked with 10 reps", (await cells())[0][1] === "10" && await page.$eval(".set", e => e.classList.contains("done")));
  ok("Rest timer started (3:00 for bench)", /2:5\d|3:00/.test(await page.textContent("[data-restbar] .t")));
  await shot("04-rest");
  // crash: reload mid-workout
  await page.reload(); await page.waitForSelector(".banner");
  ok("After reload: resume banner on Today", (await page.textContent(".banner")).includes("Unfinished workout"));
  await tapText("Resume"); await page.waitForSelector(".ex-name");
  ok("Logged set survived reload", (await cells())[0][1] === "10" && await page.$eval(".set", e => e.classList.contains("done")));
  // sets 2 and 3: 10 and 8 reps
  for (const [i, r] of [[2, "10"], [3, "8"]]) {
    await page.locator('.set').nth(i-1).locator('[data-f="reps"]').click();
    for (const ch of r) await page.click(`[data-a="kKey"][data-v="${ch}"]`);
    await page.click('[data-a="kOk"]'); await page.locator('.set').nth(i-1).locator('[data-a="check"]').click();
  }
  // RIR sheet
  await page.locator('.set').nth(3-1).locator('[data-a="wRir"]').click(); await page.waitForSelector(".rirs"); await shot("05-rir"); await page.click('[data-a="rirPick"][data-v="1"]');
  // undo delete on exercise 2
  await page.click('[data-a="goto"][data-v="1"]'); await page.waitForSelector(".ex-name:has-text('Incline Smith')");
  await page.locator('.set').nth(2-1).locator('[data-a="setMenu"]').click(); await page.click('.menu .danger');
  await page.waitForTimeout(250); ok("Delete set → 1 set left", (await cells()).length === 1);
  await page.click('[data-a="undo"]'); await page.waitForTimeout(250); ok("Undo restores set", (await cells()).length === 2);
  // substitute
  await page.click('[data-a="exMenu"]'); await tapText("Substitute"); await page.fill(".search", "incline dumb");
  await page.click('[data-a="picked"]'); await page.waitForSelector(".ex-name");
  ok("Substitution shows new name + replaces note", (await page.textContent(".ex-name")).includes("Incline Dumbbell") && (await page.textContent(".note")).includes("Incline Smith"));
  await shot("06-substitute");
  // finish
  await page.click('[data-a="askFinish"]'); await page.click('[data-a="confirmOk"]');
  await page.waitForSelector("h1:has-text('Workout complete')");
  const sum = await page.textContent(".scroll");
  ok("Summary: bench suggestion 82.5 / 87.5 / 92.5", sum.includes("Increase load") && sum.includes("82.5 / 87.5 / 92.5"));
  await shot("07-summary");
  await page.click('[data-a="sgAccept"]');
  await page.waitForTimeout(250); ok("Accepted suggestion", (await page.textContent(".scroll")).includes("Accepted"));
  await tapText("Done");
  await page.waitForSelector("h1");
  ok("Rotation advanced to Pull", (await page.textContent("h1")) === "Pull");
  // program updated
  await page.click('[data-a="tab"][data-v="programs"]'); await page.click('[data-a="openProgram"]'); await page.click('[data-a="openDay"][data-v="0"]');
  ok("Program Push now starts 82.5×8", (await page.textContent(".scroll")).includes("82.5×8"));
  await shot("08-day");
  await page.click('[data-a="openPe"][data-v="0"]'); await page.click('[data-a="tplAdd"]');
  await page.waitForTimeout(250); ok("Template editor: added a 4th set", (await page.$$(".tpl")).length === 4);
  await shot("09-pe");
  // history
  await page.click('[data-a="tab"][data-v="history"]'); await shot("10-history");
  ok("History lists 7 sessions (6 imported + today)", (await page.$$('[data-a="openSession"]')).length === 7);
  await page.click('[data-a="openSession"]'); await shot("11-session");
  // library + exercise detail
  await page.click('[data-a="tab"][data-v="library"]'); await page.fill(".search", "panca piana"); 
  ok("Search finds Italian name", (await page.textContent(".card")).includes("Bench Press"));
  await page.click('[data-a="openExercise"]'); await page.waitForSelector(".chart");
  ok("Exercise detail shows records + e1RM chart", (await page.textContent(".scroll")).includes("Heaviest"));
  await shot("12-exercise");
  // export + re-import
  await page.click('[data-a="tab"][data-v="more"]');
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click('[data-a="exportJson"]')]);
  const path = `${out}/backup.json`; await dl.saveAs(path);
  const bk = JSON.parse(fs.readFileSync(path, "utf8"));
  ok("Backup contains 7 completed sessions", bk.sessions.filter(s => s.status === "completed").length === 7);
  await page.setInputFiles('[data-in="importFile"]', path); await page.waitForSelector(".toast:has-text('Import')");
  ok("Re-import adds nothing (no duplicates)", (await page.textContent(".toast")).includes("0 added"));
  const [dl2] = await Promise.all([page.waitForEvent("download"), page.click('[data-a="exportCsv"]')]);
  await dl2.saveAs(`${out}/sets.csv`);
  ok("CSV export has header + rows", fs.readFileSync(`${out}/sets.csv`, "utf8").split("\n").length > 50);
  // Italian
  await page.click('[data-a="lang"][data-v="it"]'); await page.click('[data-a="tab"][data-v="today"]');
  ok("Italian UI", (await page.textContent(".tabbar")).includes("Oggi"));
  await shot("13-today-it");
  // offline reload via service worker
  await page.waitForTimeout(500); await ctx.setOffline(true); await page.reload(); await page.waitForSelector("h1");
  ok("Loads offline from service worker", (await page.textContent("h1")) === "Pull");
  await ctx.setOffline(false);
  // light theme screenshot of workout
  await page.click('[data-a="tab"][data-v="more"]'); await page.click('[data-a="theme"][data-v="light"]'); await page.click('[data-a="tab"][data-v="today"]');
  await page.click('[data-a="start"]'); await page.waitForSelector(".ex-name"); await shot("14-workout-light-it");
} catch (e) { results.push(["FAIL", "exception: " + e.message.split("\n")[0]]); await shot("zz-error"); }
ok("No page errors", errors.length === 0); if (errors.length) console.log(errors);
for (const r of results) console.log(r.join("  "));
await browser.close(); srv.kill();
