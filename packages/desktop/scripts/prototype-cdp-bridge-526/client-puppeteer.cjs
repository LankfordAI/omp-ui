// PROTOTYPE (#526) — throwaway; not product code.
//
// Part (a): drive the bridge with puppeteer-core 25.3.0 exactly the way omp
// connects (browserURL, defaultViewport: null, protocolTimeout: 60000).
//
//   SPIKE_DEPS=/tmp/omp-ui-526 node client-puppeteer.cjs <cdp_url> <dev_url> <out_dir>
"use strict";
/* global document, devicePixelRatio, innerWidth, innerHeight -- identifiers inside page.evaluate() callbacks run in the page */

const fs = require("node:fs");
const path = require("node:path");

const [cdpUrl, devUrl, outDir] = process.argv.slice(2);
if (!cdpUrl || !devUrl || !outDir) {
  console.error("usage: node client-puppeteer.cjs <cdp_url> <dev_url> <out_dir>");
  process.exit(2);
}
if (!process.env.SPIKE_DEPS) {
  console.error("SPIKE_DEPS is unset. Install puppeteer-core into a scratch prefix first (see README.md) and export SPIKE_DEPS=<prefix>.");
  process.exit(2);
}
const puppeteer = require(require.resolve("puppeteer-core", { paths: [process.env.SPIKE_DEPS] }));

const steps = [];
const started = Date.now();

function timeout(ms, label) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}: timed out after ${ms} ms`)), ms));
}

async function step(name, fn, ms = 15000) {
  const t0 = Date.now();
  try {
    const detail = await Promise.race([fn(), timeout(ms, name)]);
    steps.push({ name, ok: true, ms: Date.now() - t0, detail });
    console.log(`ok   ${name} (${Date.now() - t0} ms)`, JSON.stringify(detail));
  } catch (err) {
    steps.push({ name, ok: false, ms: Date.now() - t0, detail: err.message });
    console.log(`FAIL ${name} (${Date.now() - t0} ms)`, err.message);
  }
}

(async () => {
  let browser;
  let page;
  await step("connect", async () => {
    browser = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null, protocolTimeout: 60000 });
    return {
      targets: browser.targets().map((t) => t.type()),
      version: await browser.version(),
      userAgent: await browser.userAgent(),
    };
  });
  if (!browser) return done();

  await step("pages", async () => {
    const pages = await browser.pages();
    page = pages[0];
    return { length: pages.length, url: page?.url() };
  });
  if (!page) return done();

  await step("goto", async () => {
    await page.goto(devUrl, { waitUntil: "load" });
    return { url: page.url(), title: await page.title() };
  });

  await step("screenshot", async () => {
    const file = path.join(outDir, "puppeteer-shot.png");
    await page.screenshot({ path: file });
    const bytes = fs.readFileSync(file);
    return { bytes: bytes.length, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  });

  await step("click", async () => {
    await page.click("#btn");
    return { out: await page.$eval("#out", (el) => el.textContent) };
  });

  await step("type", async () => {
    await page.type("#input", "hello");
    return { value: await page.$eval("#input", (el) => el.value) };
  });

  await step("evaluate", () =>
    page.evaluate(() => ({
      title: document.title,
      out: document.querySelector("#out").textContent,
      ua: navigator.userAgent,
      dpr: devicePixelRatio,
      w: innerWidth,
      h: innerHeight,
    })),
  );

  await step("setViewport", async () => {
    await page.setViewport({ width: 1024, height: 700 });
    return { inner: await page.evaluate(() => [innerWidth, innerHeight]) };
  });

  let p1;
  await step("newPage-1", async () => {
    p1 = await browser.newPage();
    return { samePage: p1 === page, pages: (await browser.pages()).length };
  });
  await step("newPage-2", async () => {
    const p2 = await browser.newPage();
    return { samePage: p2 === page, sameAsFirst: p2 === p1, pages: (await browser.pages()).length };
  });

  await step("createCDPSession", async () => {
    const session = await page.target().createCDPSession();
    let claimError = null;
    try {
      await session.send("OMP.claimTarget");
    } catch (err) {
      claimError = err.message;
    }
    await session.detach();
    return { claimError };
  });

  await step("close", async () => {
    await page.close();
    return { closed: page.isClosed(), pages: (await browser.pages()).length };
  }, 5000);

  await step("browser.close", async () => {
    await browser.close();
    return { connected: browser.connected };
  });

  done();

  function done() {
    const allOk = steps.every((s) => s.ok);
    const result = { steps, totalMs: Date.now() - started, allOk };
    fs.writeFileSync(path.join(outDir, "puppeteer-run.json"), `${JSON.stringify(result, null, 2)}\n`);
    console.log(`${allOk ? "ALL OK" : "SOME FAILED"} in ${result.totalMs} ms -> ${path.join(outDir, "puppeteer-run.json")}`);
    process.exit(allOk ? 0 : 1);
  }
})();
