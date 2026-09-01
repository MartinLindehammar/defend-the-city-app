// Real headless-browser end-to-end test (requires Puppeteer + a running
// dev server) — the strongest verification available: actually loads the
// game, waits for asset loading, clicks to place units, starts a battle,
// and checks for any console/page errors during real execution.
//
// This is heavier than the other test-*.mjs files (needs a browser binary
// and a live server) so it's not part of a quick check — run it after any
// change that touches scene bootstrap, asset loading, or the placement/
// battle UI flow. To run:
//   npm install --no-save puppeteer   (one-time, if not already present)
//   npm run dev -- --port 5199 --host 127.0.0.1   (in one terminal)
//   node test-e2e.mjs                              (in another)
// If Puppeteer can't find a Chrome install automatically, see the
// PUPPETEER_EXECUTABLE_PATH note near the launch() call below.

import puppeteer from "puppeteer";

const URL = "http://localhost:5199";

async function run() {
  const launchOptions = { headless: "new", args: ["--no-sandbox"] };
  // If Puppeteer's bundled Chrome isn't found, set PUPPETEER_EXECUTABLE_PATH
  // to an existing Chrome/Chromium install, e.g.:
  //   PUPPETEER_EXECUTABLE_PATH=/path/to/chrome node test-e2e.mjs
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  const browser = await puppeteer.launch(launchOptions);
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text());
      console.error("  [console.error]", msg.text());
    }
  });
  page.on("pageerror", (err) => {
    pageErrors.push(err.message);
    console.error("  [pageerror]", err.message);
  });
  page.on("requestfailed", (req) => {
    console.error("  [request failed]", req.url(), req.failure()?.errorText);
  });
  page.on("response", (res) => {
    if (res.status() >= 400) console.error(`  [http ${res.status()}]`, res.url());
  });

  console.log(`Loading ${URL} ...`);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });

  // Wait for the loading screen to hide (assets finished loading).
  await page.waitForFunction(
    () => document.getElementById("loading-screen")?.classList.contains("hidden"),
    { timeout: 20000 }
  );
  console.log("Loading screen hidden — assets loaded, scene built.");

  // Dismiss the how-to-play modal, exactly as a real player does before
  // they can place anything. It opens automatically on any browser that
  // hasn't seen it, and Puppeteer starts from a fresh profile every run,
  // so it is ALWAYS up at this point. It's a full-viewport overlay, so
  // leaving it open silently swallows every placement click — verified
  // directly with elementFromPoint at the exact coordinates this test
  // clicks, which reported "intro-modal" rather than the canvas. Without
  // this step the test reports "spent: 0" and then fails at the battle
  // check, blaming placement for what is really an unclosed dialog.
  await page.click("#intro-modal-close-btn");
  await new Promise((r) => setTimeout(r, 200));
  const introStillOpen = await page.$eval("#intro-modal", (el) => !el.classList.contains("hidden"));
  if (introStillOpen) throw new Error("How-to-play modal did not close; placement clicks would be swallowed.");

  // Sanity-check the generated level actually populated the scene: check
  // canvas exists and has nonzero size, and grab some basic stats via a
  // page-exposed check (topbar text, population value).
  const populationText = await page.$eval("#population-value", (el) => el.textContent);
  console.log(`Starting population displayed: ${populationText}`);
  if (populationText !== "12") throw new Error(`Expected starting population 12, got "${populationText}"`);

  // Place a few defenders on the green (defender) side. We don't know
  // exact terrain coordinates (randomly generated), so click several
  // spread-out screen positions on the left half of the canvas and accept
  // whichever ones land on valid, clickable ground.
  const canvas = await page.$("canvas");
  const box = await canvas.boundingBox();
  const clickPoints = [
    [box.width * 0.3, box.height * 0.5],
    [box.width * 0.25, box.height * 0.4],
    [box.width * 0.35, box.height * 0.6],
    [box.width * 0.28, box.height * 0.35],
  ];
  let placed = 0;
  for (const [dx, dy] of clickPoints) {
    await page.mouse.click(box.x + dx, box.y + dy);
    await new Promise((r) => setTimeout(r, 150));
  }
  const populationAfter = await page.$eval("#population-value", (el) => el.textContent);
  const populationSpent = 12 - parseInt(populationAfter, 10);
  placed = populationSpent > 0 ? "some" : "none";
  console.log(`Population after placement attempts: ${populationAfter} (spent: ${populationSpent})`);
  // Fail HERE, at the real cause, rather than letting a placement problem
  // surface later as a confusing "battle didn't start" error.
  if (populationSpent <= 0) {
    throw new Error("No defenders were placed — every placement click was rejected or swallowed.");
  }

  // Start the battle. The PRIMARY check is a fixed, reliable window: the
  // simulation must run actively with zero errors for several seconds.
  // Full battle completion is checked too, but only as INFORMATIONAL —
  // large generated maps can legitimately take longer than any fixed
  // timeout to resolve (more travel distance for the same unit speed),
  // and that's correct pacing, not a bug. Don't fail the test over it.
  await page.click("#start-battle-btn");
  console.log("Battle started, running for 10s (primary check)...");
  await new Promise((r) => setTimeout(r, 10000));
  // The dedicated "Phase: ..." topbar label was removed (self-explanatory
  // UI, per explicit request), so the equivalent check is the same signal
  // the game itself uses to leave the placement phase: the Start Battle
  // button is hidden the moment `phase` becomes "battle" (see main.js's
  // click handler) and never reappears through the result phase either —
  // this still proves the game actually left placement and is running (or
  // has already concluded), not stuck.
  const startBtnDisplay = await page.$eval("#start-battle-btn", (el) => el.style.display);
  console.log(`start-battle-btn display after 10s: "${startBtnDisplay}"`);
  if (startBtnDisplay !== "none") {
    throw new Error(`Expected battle to have started (Start Battle button hidden) after 10s, but display was "${startBtnDisplay}"`);
  }

  console.log("Waiting up to 40 more seconds to see if it reaches a conclusion (informational only)...");
  const reachedEnd = await page
    .waitForFunction(() => !document.getElementById("result-banner")?.classList.contains("hidden"), { timeout: 40000 })
    .then(() => true)
    .catch(() => false);
  if (reachedEnd) {
    const resultText = await page.$eval("#result-text", (el) => el.textContent);
    console.log(`Battle concluded within the window. Result: "${resultText}"`);
  } else {
    console.log("Battle didn't conclude within 50s total — informational, not a failure (see comment above).");
  }

  await browser.close();

  console.log(`\nConsole errors: ${consoleErrors.length}`);
  consoleErrors.forEach((e) => console.error("  CONSOLE ERROR:", e));
  console.log(`Page (uncaught) errors: ${pageErrors.length}`);
  pageErrors.forEach((e) => console.error("  PAGE ERROR:", e));

  if (consoleErrors.length > 0 || pageErrors.length > 0) {
    console.error("\nFAIL: errors detected during real headless playthrough.");
    process.exit(1);
  }
  console.log("\nNo errors detected during a real headless playthrough (load, place units, run battle 8s).");
}

run().catch((err) => {
  console.error("Test harness failure:", err);
  process.exit(1);
});
