// Browser flows on an iPhone-sized Chromium. Run: node tests/e2e.mjs (serves ./public on :8765)
import { createRequire } from "module"; import { execSync, spawn } from "child_process"; import fs from "fs";
const require = createRequire(import.meta.url);
const { chromium } = require(execSync("npm root -g").toString().trim() + "/playwright");
const srv = spawn("python3", ["-m", "http.server", "8765", "-d", "public"], { stdio: "ignore" });
await new Promise(r => setTimeout(r, 800));
const STARTER = process.env.STARTER || "../private/logbook-starter-backup.json";
const XLSX = "../private/fixtures/plan.xlsx", IMG = "/mnt/user-data/uploads/788a6ce7-image.jpg";
const out = "tests/shots"; fs.mkdirSync(out, { recursive: true });
const results = []; const ok = (name, cond) => { results.push([cond ? "PASS" : "FAIL", name]); };
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "en-GB", acceptDownloads: true, colorScheme: "dark" });
const page = await ctx.newPage();
const errors = []; page.on("pageerror", e => errors.push(e.message)); page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
const shot = n => page.screenshot({ path: `${out}/${n}.png` });
const tapText = async (txt) => page.getByRole("button", { name: txt, exact: false }).first().click();
try {
  await page.goto("http://localhost:8765/");
  await page.waitForSelector("h1:has-text('Welcome')");
  ok("Fresh install shows welcome (no personal data shipped)", true);
  await shot("00-welcome");
  await page.setInputFiles('[data-in="impFile"]', STARTER);
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
  const restSecs = async () => { const t = (await page.textContent("[data-restbar] .t")).trim(); const [m, x] = t.split(":").map(Number); return m * 60 + x; };
  const r0 = await restSecs(); await page.click('[data-a="restMinus"]'); await page.waitForTimeout(150);
  ok("Rest −30s", r0 - (await restSecs()) >= 29);
  await page.click('[data-a="restEdit"]'); await page.waitForSelector('[data-a="restAlways"]');
  await page.click('[data-a="kKey"][data-v="C"]'); await page.click('[data-a="kKey"][data-v="9"]'); await page.click('[data-a="kKey"][data-v="0"]');
  await shot("04c-rest-edit");
  await page.click('[data-a="restAlways"]'); await page.waitForTimeout(200);
  ok("Rest edited to 90s and saved for the exercise", (await restSecs()) <= 90 && (await page.textContent(".toast")).includes("90s") && (await page.textContent(".ex-meta")).includes("90s"));
  // crash: reload mid-workout
  await page.reload(); await page.waitForSelector(".bar-card.hot");
  ok("After reload: compact resume bar on Today", (await page.textContent(".bar-card.hot")).includes("Workout in progress"));
  ok("Resume bar is compact (< 80px)", (await page.$eval(".bar-card.hot", e => e.getBoundingClientRect().height)) < 80);
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
  ok("Next button names the next exercise", (await page.textContent(".nextbtn")).includes("Incline Smith Press"));
  // drag to reorder inside the workout list sheet: move exercise 1 (Bench) to position 3
  const dragHandle = async (fromIdx, toIdx) => {
    const hs = await page.$$(".sortable .handle"); const a = await hs[fromIdx].boundingBox(); const b = await hs[toIdx].boundingBox();
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
    const ty = b.y + b.height / 2 + (toIdx > fromIdx ? 8 : -8);
    for (let k = 1; k <= 12; k++) { await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2 + (ty - a.y - a.height / 2) * k / 12); await page.waitForTimeout(16); }
    await page.mouse.up(); await page.waitForTimeout(300);
  };
  await page.click('[data-a="wkList"]'); await page.waitForSelector(".orow");
  await shot("04b-order-sheet");
  await dragHandle(0, 2);
  const order = await page.$$eval(".orow b", els => els.map(e => e.textContent.trim()));
  ok("Workout drag: Bench moved to 3rd", order[2] === "Bench Press" && order[0] === "Incline Smith Press");
  await page.click('[data-a="gotoClose"][data-v="2"]'); await page.waitForTimeout(200);
  ok("Current exercise stays Bench after reorder", (await page.textContent(".ex-name")).includes("Bench Press"));
  await page.click('[data-a="wkList"]'); await dragHandle(2, 0); await page.click('[data-a="gotoClose"][data-v="0"]'); await page.waitForTimeout(200);
  ok("Dragged back: Bench first again", (await page.$$eval("#strip button", b => b[0].textContent)).includes("Bench Press"));
  // undo delete on exercise 2
  await page.click('[data-a="goto"][data-v="1"]'); await page.waitForSelector(".ex-name:has-text('Incline Smith')");
  // changing set 1 load carries over to set 2 (same planned load, not yet edited)
  await page.locator('.set').nth(0).locator('[data-f="load"]').click(); await page.click('[data-a="kStep"][data-v="2.5"]'); await page.click('[data-a="kOk"]'); await page.waitForTimeout(200);
  ok("Load edit carries to later unticked set (42.5/42.5)", JSON.stringify((await cells()).map(c => c[0])) === JSON.stringify(["42.5", "42.5"]));
  await page.locator('.set').nth(2-1).locator('[data-a="setMenu"]').click(); await page.click('.menu .danger');
  await page.waitForTimeout(250); ok("Delete set → 1 set left", (await cells()).length === 1);
  await page.click('[data-a="undo"]'); await page.waitForTimeout(250); ok("Undo restores set", (await cells()).length === 2);
  // substitute
  await page.click('[data-a="exMenu"]'); await tapText("Substitute"); await page.fill(".search", "incline dumb");
  await page.click('[data-a="picked"]'); await page.waitForSelector(".ex-name");
  ok("Substitution shows new name + replaces note", (await page.textContent(".ex-name")).includes("Incline Dumbbell") && (await page.textContent(".note")).includes("Incline Smith"));
  await shot("06-substitute");
  // cardio: add Jump Rope (reps only) and Treadmill (minutes)
  for (const q of ["jump rope", "treadmill"]) {
    await page.click('[data-a="addToWorkout"]'); await page.fill(".search", q); await page.click('[data-a="picked"]'); await page.waitForSelector(".ex-name");
  }
  ok("Treadmill row shows minutes, no kg/RIR", (await page.$$eval(".set", els => els[0].querySelectorAll(".cell").length)) === 1 && (await page.textContent(".sets-head")).includes("Minutes"));
  await page.locator(".set").nth(0).locator('[data-f="mins"]').click(); await page.click('[data-a="kKey"][data-v="2"]'); await page.click('[data-a="kKey"][data-v="0"]'); await page.click('[data-a="kOk"]');
  await page.locator(".set").nth(0).locator('[data-a="check"]').click(); await page.waitForTimeout(150);
  await shot("06b-cardio-time");
  await page.click('#strip button:has-text("Jump Rope")'); await page.waitForTimeout(150);
  ok("Jump Rope row shows reps only", (await page.$$eval(".set", els => els[0].querySelectorAll(".cell").length)) === 1 && !(await page.textContent(".ex-meta")).includes("kg"));
  await page.locator(".set").nth(0).locator('[data-f="reps"]').click(); for (const ch of "100") await page.click(`[data-a="kKey"][data-v="${ch}"]`); await page.click('[data-a="kOk"]');
  await page.locator(".set").nth(0).locator('[data-a="check"]').click(); await page.waitForTimeout(150);
  // finish
  await page.click('[data-a="askFinish"]'); await page.click('[data-a="confirmOk"]');
  await page.waitForSelector("h1:has-text('Workout complete')");
  const sum = await page.textContent(".scroll");
  ok("Summary: bench suggestion 82.5 / 87.5 / 92.5", sum.includes("Increase load") && sum.includes("82.5 / 87.5 / 92.5"));
  ok("No load suggestion for cardio; cardio line shown", !sum.includes("Jump Rope") && !sum.includes("Treadmill") && sum.includes("Cardio: 20 min · 100 reps"));
  await shot("07-summary");
  await page.click('[data-a="sgAccept"]');
  await page.waitForTimeout(250); ok("Accepted suggestion", (await page.textContent(".scroll")).includes("Accepted"));
  await tapText("Done");
  await page.waitForSelector("h1");
  ok("Rotation advanced to Pull", (await page.textContent("h1")) === "Pull");
  ok("No backup prompt on Today", !(await page.$('[data-a="exportJson"]')));
  ok("More tab shows a backup-due dot", !!(await page.$(".tabbar .badge-dot")));
  // program updated
  await page.click('[data-a="tab"][data-v="programs"]'); await page.click('[data-a="openProgram"]'); await page.click('[data-a="openDay"][data-v="0"]');
  ok("Program Push now starts 82.5×8", (await page.textContent(".scroll")).includes("82.5×8"));
  // drag in the program day editor, and it persists
  const names = async () => page.$$eval('.sortable [data-a="openPe"] b', els => els.map(e => e.textContent.trim()));
  const before = await names();
  await dragHandle(4, 0);
  const after = await names();
  ok("Program drag: last exercise moved to top", after[0] === before[4] && after[1] === before[0]);
  await page.reload(); await page.click('[data-a="tab"][data-v="programs"]'); await page.click('[data-a="openProgram"]'); await page.click('[data-a="openDay"][data-v="0"]');
  ok("Program order persisted after reload", JSON.stringify(await names()) === JSON.stringify(after));
  await dragHandle(0, 4);
  ok("Program drag back restores order", JSON.stringify(await names()) === JSON.stringify(before));
  await shot("08-day");
  await page.click('[data-a="openPe"][data-v="0"]');
  ok("Rest saved to the program exercise (90 s)", (await page.textContent(".scroll")).includes("90 s"));
  await page.click('[data-a="tplAdd"]');
  await page.waitForTimeout(250); ok("Template editor: added a 4th set", (await page.$$(".tpl")).length === 4);
  await shot("09-pe");
  // history
  await page.click('[data-a="tab"][data-v="history"]'); await shot("10-history");
  ok("History lists 7 sessions (6 imported + today)", (await page.$$('[data-a="openSession"]')).length === 7);
  ok("History progress chart with exercise picker", !!(await page.$('select[data-in="histEx"]')) && !!(await page.$(".scroll .chart")));
  await page.selectOption('select[data-in="histEx"]', "ex_bench"); await page.click('[data-a="histM"][data-v="top"]'); await page.waitForTimeout(150);
  ok("Bench top weight trend: 90 → 90 kg (±0)", (await page.textContent(".delta")).includes("±0 kg"));
  await page.click('[data-a="histM"][data-v="e1rm"]'); await page.waitForTimeout(150);
  ok("Bench e1RM trend: +7 kg (110.5 → 117)", (await page.textContent(".delta")).includes("+7 kg"));
  await shot("10b-history-chart");
  // swipe to delete (pointer drag), undo, full swipe, no accidental open
  const swipe = async (sel, dx) => { const b = await page.locator(sel).first().boundingBox(); const y = b.y + b.height / 2, x = b.x + b.width - 20;
    await page.mouse.move(x, y); await page.mouse.down(); for (let k = 1; k <= 10; k++) { await page.mouse.move(x + dx * k / 10, y + 1); await page.waitForTimeout(16); } await page.mouse.up(); await page.waitForTimeout(300); };
  const nRows = async () => (await page.$$('.swipe [data-a="openSession"]')).length;
  const rows0 = await nRows();
  await swipe(".swipe-in", -140);
  ok("Swipe left reveals Delete (row not opened)", !!(await page.$(".swipe.open")) && (await page.$("h1")) && (await page.textContent("h1")) === "History");
  await shot("11a-swipe-open");
  await page.click(".swipe.open .swipe-del"); await page.waitForTimeout(250);
  ok("Delete removes the workout", (await nRows()) === rows0 - 1 && (await page.textContent(".toast")).includes("Workout deleted"));
  await page.click('[data-a="undo"]'); await page.waitForTimeout(250);
  ok("Undo brings it back", (await nRows()) === rows0);
  await swipe(".swipe-in", -330); await page.waitForTimeout(250);
  ok("Full swipe deletes straight away", (await nRows()) === rows0 - 1);
  await page.click('[data-a="undo"]'); await page.waitForTimeout(250);
  await swipe(".swipe-in", -140); await page.click("h1"); await page.waitForTimeout(400);
  ok("Tapping elsewhere closes the open row", !(await page.$(".swipe.open")));
  await page.click('[data-a="openSession"]'); await shot("11-session");
  // library + exercise detail
  // delete exercises: unused one by swipe; used one from its page (removed from programs, undo restores)
  await page.click('[data-a="tab"][data-v="library"]'); await page.fill(".search", "plank"); await page.waitForTimeout(150);
  await swipe(".libcard .swipe-in", -140); await page.click(".swipe.open .swipe-del"); await page.waitForTimeout(250);
  ok("Swipe-delete an unused exercise", !(await page.$('.libcard [data-a="openExercise"]')));
  await page.fill(".search", "triceps pushdown"); await page.waitForTimeout(150);
  await page.click('[data-a="openExercise"]'); await page.click('[data-a="exEdit"]'); await page.click('.menu .danger');
  ok("Deleting a used exercise asks first (in your programs)", (await page.textContent(".sheet")).includes("in 1 place"));
  await page.click('[data-a="confirmOk"]'); await page.waitForTimeout(250);
  ok("Deleted exercise leaves the library", (await page.textContent("h1")) === "Library" && !(await page.$('[data-a="openExercise"]')));
  await page.click('[data-a="undo"]'); await page.waitForTimeout(250);
  await page.click('[data-a="tab"][data-v="programs"]'); await page.click('[data-a="openProgram"]'); await page.click('[data-a="openDay"][data-v="0"]');
  ok("Undo puts it back in the program day", (await page.textContent(".scroll")).includes("Triceps Pushdown"));
  await page.click('[data-a="tab"][data-v="more"]');
  ok("More lists deleted exercises with Restore", (await page.textContent(".scroll")).includes("Deleted exercises") && (await page.textContent(".scroll")).includes("Plank"));
  await page.click('[data-a="restoreEx"]'); await page.waitForTimeout(200);
  ok("Restore deleted exercise", !(await page.textContent(".scroll")).includes("Deleted exercises"));
  ok("No zoom: viewport locked + touch-action manipulation", (await page.getAttribute('meta[name="viewport"]', "content")).includes("user-scalable=no") && (await page.evaluate(() => getComputedStyle(document.documentElement).touchAction)) === "manipulation");
  ok("Status bar not translucent (no iOS edge blur over the app)", (await page.getAttribute('meta[name="apple-mobile-web-app-status-bar-style"]', "content")) === "default");
  await page.click('[data-a="tab"][data-v="library"]'); await page.fill(".search", "panca piana"); 
  ok("Search finds Italian name", (await page.textContent(".card")).includes("Bench Press"));
  await page.click('[data-a="openExercise"]'); await page.waitForSelector(".chart");
  ok("Exercise detail shows records + e1RM chart", (await page.textContent(".scroll")).includes("Heaviest"));
  await shot("12-exercise");
  // export + re-import
  await page.click('[data-a="tab"][data-v="more"]');
  ok("More shows backup card at the top", (await page.textContent(".scroll .card")).includes("Back up your data"));
  await shot("12b-more");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click('[data-a="exportJson"]')]);
  const path = `${out}/backup.json`; await dl.saveAs(path);
  const bk = JSON.parse(fs.readFileSync(path, "utf8"));
  ok("Backup contains 7 completed sessions", bk.sessions.filter(s => s.status === "completed").length === 7);
  await page.setInputFiles('[data-in="impFile"]', path); await page.waitForSelector(".toast:has-text('Import')");
  ok("Re-import adds nothing (no duplicates)", (await page.textContent(".toast")).includes("0 added"));
  const [dl2] = await Promise.all([page.waitForEvent("download"), page.click('[data-a="exportCsv"]')]);
  await dl2.saveAs(`${out}/sets.csv`);
  ok("CSV export has header + rows", fs.readFileSync(`${out}/sets.csv`, "utf8").split("\n").length > 50);
  ok("Backup clears the More dot", !(await page.$(".tabbar .badge-dot")));
  // theme follows the system (context is dark)
  await page.click('[data-a="theme"][data-v="system"]');
  ok("Theme: System follows the phone (dark)", (await page.getAttribute("html", "data-theme")) === "dark");
  // Italian
  await page.click('[data-a="lang"][data-v="it"]'); await page.click('[data-a="tab"][data-v="today"]');
  ok("Italian UI", (await page.textContent(".tabbar")).includes("Oggi"));
  await shot("13-today-it");
  // offline reload via service worker
  await page.waitForTimeout(500); await ctx.setOffline(true); await page.reload(); await page.waitForSelector("h1");
  ok("Loads offline from service worker", (await page.textContent("h1")) === "Pull");
  await ctx.setOffline(false);
  // ---- import: pasted plan
  await page.click('[data-a="tab"][data-v="more"]'); await page.click('[data-a="lang"][data-v="en"]'); await page.click('[data-a="openImport"]');
  await page.fill('[data-in="impText"]', "LUNEDÌ (PUSH A)\nPetto Panca piana bilanciere 3 7, 8-10 (Piramidale) 120\"\nSpalle Alzate laterali ai cavi 4 12-15 60\"\nGIOVEDÌ (GAMBE & CORE)\nGambe Leg press 4 8-10 120\"\nDorso Row presa singola 3 10 90\"\nCore Plank 3 1 min 60\"");
  await page.click('[data-a="impReadText"]'); await page.waitForSelector(".improw");
  const imp = await page.textContent(".scroll");
  ok("Paste import preview: 2 days, matches + 1 new", (await page.$$(".dayinp")).length === 2 && imp.includes("Bench Press") && imp.includes("Cable Lateral Raise") && imp.includes("New: Row presa singola") && imp.includes("3 × 1 min"));
  await shot("15-import-preview");
  await page.click('[data-a="impEdit"][data-v="1"][data-i="0"]'); await page.fill("#sheetText", "4 x 6-8 150s"); await page.click('[data-a="textOk"]'); await page.waitForTimeout(150);
  ok("Edit sets in preview", (await page.textContent('[data-a="impEdit"][data-v="1"][data-i="0"]')).includes("4 × 6–8 · 150"));
  await page.fill('[data-in="impName"]', "Scheda novembre"); await page.click('[data-a="impCreate"]'); await page.waitForTimeout(300);
  ok("Program created from import and active", (await page.inputValue("#pname")) === "Scheda novembre" && (await page.textContent(".toast")).includes("1 new"));
  await page.click('[data-a="tab"][data-v="today"]');
  ok("Today now shows the imported plan's first day", (await page.textContent("h1")).includes("Lunedì"));
  // ---- import: Excel file
  if (fs.existsSync(XLSX)) {
    await page.click('[data-a="tab"][data-v="more"]'); await page.click('[data-a="openImport"]');
    await page.setInputFiles('[data-in="impFile"]', XLSX); await page.waitForSelector(".improw");
    ok("Excel import preview has day rows", (await page.inputValue(".dayinp")) === "Lunedì (Push A)");
    await page.click('[data-a="impReset"]');
  }
  // ---- import: image without internet → clear message (OCR engine can't download here)
  if (fs.existsSync(IMG)) {
    await page.setInputFiles('[data-in="impFile"]', IMG); await page.waitForSelector(".errline", { timeout: 20000 });
    ok("Image import offline → explains internet is needed once", (await page.textContent(".errline")).includes("internet"));
    // the app's own image clean-up (JS), checked with the same OCR engine (Tesseract CLI)
    const b64 = fs.readFileSync(IMG).toString("base64");
    const png = await page.evaluate(async (b) => { const img = new Image(); img.src = "data:image/jpeg;base64," + b; await img.decode(); return window.__logbook.preprocess(img).toDataURL("image/png"); }, b64);
    fs.writeFileSync(`${out}/prep-js.png`, Buffer.from(png.split(",")[1], "base64"));
    const txt = execSync(`tesseract ${out}/prep-js.png - -l ita+eng --psm 6 2>/dev/null`).toString();
    ok("JS image clean-up: OCR finds all 5 day headers", ["LUNED", "MARTED", "GIOVED", "VENERD", "SABATO"].every(d => txt.toUpperCase().includes(d)));
  }
  // light theme screenshot of workout
  await page.click('[data-a="tab"][data-v="more"]'); await page.click('[data-a="theme"][data-v="light"]'); await page.click('[data-a="tab"][data-v="today"]');
  await page.click('[data-a="start"]'); await page.waitForSelector(".ex-name"); await shot("14-workout-light-it");
  await page.click('[data-a="askFinish"]'); await page.waitForSelector(".sheet");
  ok("Finishing with nothing ticked offers to discard", /Niente registrato|Nothing logged/.test(await page.textContent(".sheet")));
  await page.click('[data-a="confirmOk"]'); await page.waitForTimeout(250);
  ok("Empty workout discarded, not saved to History", !(await page.$(".bar-card.hot")));
} catch (e) { results.push(["FAIL", "exception: " + e.message.split("\n")[0]]); await shot("zz-error"); }
const real = errors.filter(e => !/ERR_TUNNEL_CONNECTION_FAILED|ERR_INTERNET_DISCONNECTED|Error: offline/.test(e));
ok("No page errors (besides the expected offline OCR download)", real.length === 0); if (real.length) console.log(real);
for (const r of results) console.log(r.join("  "));
await browser.close(); srv.kill();
