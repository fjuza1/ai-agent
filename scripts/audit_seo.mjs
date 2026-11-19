import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import lighthouse from "lighthouse";
import { Launcher } from "chrome-launcher";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const categories = ["performance", "accessibility", "best-practices", "seo"];
const seoThreshold = 0.97;
const accessibilityThreshold = 0.95;

export function auditTargets(stickerId) {
  return [
    { name: "sticker-home", url: "http://127.0.0.1:3001/" },
    { name: "sticker-marketplace", url: "http://127.0.0.1:3001/marketplace" },
    { name: "sticker-detail", url: `http://127.0.0.1:3001/stickers/${encodeURIComponent(stickerId)}` },
    { name: "supplement-home", url: "http://127.0.0.1:3002/" },
    { name: "supplement-category", url: "http://127.0.0.1:3002/category/family-planning-bundles" },
    { name: "supplement-detail", url: "http://127.0.0.1:3002/product/seo-audit-family-kit" },
  ];
}

export function seoResult(lhr) {
  const seo = lhr.categories?.seo;
  const failures = (seo?.auditRefs ?? [])
    .filter((ref) => ref.weight > 0)
    .map((ref) => ({ id: ref.id, ...lhr.audits[ref.id] }))
    .filter((audit) => audit.score !== 1 && !["notApplicable", "manual", "informative"].includes(audit.scoreDisplayMode))
    .map((audit) => `${audit.id}: ${audit.title}${audit.explanation ? ` — ${audit.explanation}` : ""}`);
  return { score: seo?.score, passed: Number.isFinite(seo?.score) && seo.score >= seoThreshold, failures };
}

export function accessibilityResult(lhr) {
  const accessibility = lhr.categories?.accessibility;
  const failures = (accessibility?.auditRefs ?? [])
    .filter((ref) => ref.weight > 0)
    .map((ref) => ({ id: ref.id, ...lhr.audits[ref.id] }))
    .filter((audit) => audit.score !== 1 && !["notApplicable", "manual", "informative"].includes(audit.scoreDisplayMode))
    .map((audit) => `${audit.id}: ${audit.title}${audit.explanation ? ` — ${audit.explanation}` : ""}`);
  return {
    score: accessibility?.score,
    passed: Number.isFinite(accessibility?.score) && accessibility.score >= accessibilityThreshold,
    failures,
  };
}

export async function assertPortAvailable(port) {
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ port, host: "127.0.0.1", exclusive: true }, resolve);
    });
  } catch (error) {
    throw new Error(`Audit port ${port} is unavailable; stop its owner and retry. No existing process was stopped.`, { cause: error });
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
}

async function main() {
  const output = path.resolve(root, process.env.LIGHTHOUSE_REPORT_DIR || "reports/lighthouse");
  await mkdir(output, { recursive: true });
  const summary = ["# Lighthouse audit", "", "Gates: **SEO 97 minimum** and **Accessibility 95 minimum** on every route. Other categories are reported, not gated.", "",
    "> Local synthetic fixture only; not evidence of product approval or deployed-site scores.", "",
    "| Route | Performance | Accessibility | Best practices | SEO | Result |",
    "| --- | ---: | ---: | ---: | ---: | --- |"];
  const details = [];
  const children = new Set();
  let browser;
  let fixtureDir;
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
    for (const child of children) child.kill("SIGTERM");
    browser?.kill();
    process.exitCode = 1;
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  function start(args, cwd, env) {
    if (interrupted) throw new Error("Audit interrupted");
    const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    children.add(child);
    child.log = "";
    child.on("error", (error) => { child.spawnError = error; });
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => { child.log = (child.log + chunk.toString()).slice(-12000); });
    }
    return child;
  }

  async function stop(child) {
    if (child.exitCode === null && child.signalCode === null && !child.spawnError) {
      const exited = once(child, "exit").catch(() => {});
      child.kill("SIGTERM");
      await Promise.race([exited, delay(5000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
    }
    children.delete(child);
  }

  async function ready(child, url) {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (interrupted || child.spawnError || child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Server failed for ${url}: ${child.spawnError || child.log}`);
      }
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: "manual" });
        await response.body?.cancel();
        if (response.status === 200 && /Ready in/i.test(child.log)) return;
      } catch {}
      await delay(250);
    }
    throw new Error(`Server readiness timed out for ${url}\n${child.log}`);
  }

  try {
    // Both ports must be free before starting anything; never audit an unrelated server.
    await assertPortAvailable(3001);
    await assertPortAvailable(3002);
    for (const app of ["sticker-market", "usa-christmas-supplements"]) {
      await readFile(path.join(root, "apps", app, ".next", "BUILD_ID")).catch(() => {
        throw new Error(`Missing production build for ${app}; run npm run build first.`);
      });
    }
    fixtureDir = await mkdtemp(path.join(output, ".audit-fixture-"));
    const catalogPath = path.join(fixtureDir, "synthetic-catalog.json");
    // These flags exercise the catalog filter only, and never enter the published catalog.
    await writeFile(catalogPath, JSON.stringify([{
      id: "seo-audit-family-kit",
      name: "Synthetic SEO audit family kit — not for sale",
      description: "Synthetic test fixture for local page auditing only. Not a real medical product, manufacturing verification, or health recommendation.",
      price_cents: 500,
      origin_country: "USA",
      verified_usa_manufacturing: true,
      review_status: "approved",
      verification_source: "https://example.invalid/synthetic-audit-only",
      categories: ["family-planning-bundles"],
      goals: [],
      delivery: { in_stock: false, express: false },
      // Agent-style discovery metadata so the gate covers the search bar, keywords and store buttons.
      used_for: ["Family Planning", "Synthetic Audit"],
      search_keywords: ["synthetic audit kit", "family planning gift"],
      store_links: {
        amazon: "https://www.amazon.com/s?k=Synthetic+SEO+audit+family+kit&tag=audit-20",
        alza: "https://www.alza.sk/search.htm?exps=Synthetic+SEO+audit+family+kit",
        direct: "/go/seo-audit-family-kit",
      },
    }]));
    await writeFile(path.join(fixtureDir, "daily_featured.json"), JSON.stringify({
      version: 1, date: new Date().toISOString().slice(0, 10), top_picks: ["seo-audit-family-kit"], trending_searches: ["synthetic audit kit"],
    }));
    const env = {
      ...process.env,
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      DATABASE_URL: `file:${path.join(fixtureDir, "audit.db").replaceAll("\\", "/")}`,
      SUPPLEMENT_CATALOG_PATH: catalogPath,
      STICKER_APP_URL: "http://127.0.0.1:3001",
      SUPPLEMENT_APP_URL: "http://127.0.0.1:3002",
      ADSENSE_CLIENT_ID: "",
      ADSENSE_SLOT_ID: "",
      STRIPE_SECRET_KEY: "",
      STRIPE_WEBHOOK_SECRET: "",
      RESEND_API_KEY: "",
    };
    const stickerRequire = createRequire(path.join(root, "apps", "sticker-market", "package.json"));
    const database = start([stickerRequire.resolve("prisma/build/index.js"), "db", "push",
      "--schema", path.join(root, "apps", "sticker-market", "prisma", "schema.prisma")], root, env);
    const dbTimeout = setTimeout(() => database.kill("SIGTERM"), 60000);
    let dbCode;
    try { [dbCode] = await once(database, "exit"); } finally { clearTimeout(dbTimeout); }
    if (dbCode !== 0) throw new Error(`Could not initialize isolated audit database:\n${database.log}`);
    const servers = [
      { app: "sticker-market", port: 3001 },
      { app: "usa-christmas-supplements", port: 3002 },
    ].map(({ app, port }) => ({
      port,
      child: start([createRequire(path.join(root, "apps", app, "package.json")).resolve("next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(port)],
        path.join(root, "apps", app), env),
    }));
    await Promise.all(servers.map(({ child, port }) => ready(child, `http://127.0.0.1:${port}/`)));
    const stickers = JSON.parse(await readFile(path.join(root, "data", "stickers_catalog.json"), "utf8"));
    if (!stickers[0]?.id) throw new Error("Sticker catalog contains no sample detail page.");
    const profileDir = path.join(fixtureDir, "chrome");
    await mkdir(profileDir);
    // Keep ownership even if launch fails after Chrome has already spawned.
    browser = new Launcher({
      chromePath: process.env.CHROME_PATH || undefined,
      handleSIGINT: false,
      userDataDir: profileDir,
      chromeFlags: ["--headless", "--disable-gpu", ...(process.env.CI ? ["--no-sandbox", "--disable-dev-shm-usage"] : [])],
    });
    await browser.launch();
    let failed = false;
    for (const target of auditTargets(stickers[0].id)) {
      if (interrupted) throw new Error("Audit interrupted");
      try {
        for (const { child, port } of servers) {
          if (child.spawnError || child.exitCode !== null || child.signalCode !== null) {
            throw new Error(`Owned server on port ${port} stopped:\n${child.spawnError || child.log}`);
          }
        }
        await Promise.all(["html", "json", "error.json"].map((extension) =>
          rm(path.join(output, `${target.name}.${extension}`), { force: true })));
        const response = await fetch(target.url, { redirect: "manual", signal: AbortSignal.timeout(15000) });
        const html = await response.text();
        if (response.status !== 200) throw new Error(`Expected HTTP 200, received ${response.status}`);
        if (target.name === "supplement-category" && !html.includes('href="/product/seo-audit-family-kit"')) {
          throw new Error("Audited category does not contain the synthetic product fixture.");
        }
        const result = await lighthouse(target.url, {
          port: browser.port,
          output: ["html", "json"],
          onlyCategories: categories,
          logLevel: "error",
        });
        if (!result?.lhr) throw new Error("Lighthouse returned no report.");
        await Promise.all(["html", "json"].map((extension, index) =>
          writeFile(path.join(output, `${target.name}.${extension}`), result.report[index])));
        const lhr = result.lhr;
        if (lhr.runtimeError) throw new Error(`${lhr.runtimeError.code}: ${lhr.runtimeError.message}`);
        if (lhr.finalDisplayedUrl !== target.url) throw new Error(`Unexpected audited URL: ${lhr.finalDisplayedUrl}`);
        if (categories.some((id) => !Number.isFinite(lhr.categories[id]?.score))) throw new Error("A Lighthouse category has no numeric score.");
        const seo = seoResult(lhr);
        const accessibility = accessibilityResult(lhr);
        failed ||= !seo.passed || !accessibility.passed;
        const scores = categories.map((id) => (lhr.categories[id].score * 100).toFixed(1));
        const passed = seo.passed && accessibility.passed;
        summary.push(`| ${target.url} | ${scores.join(" | ")} | ${passed ? "PASS" : "FAIL"} |`);
        console.log(`${target.name}: ${categories.map((id, i) => `${id}=${scores[i]}`).join(", ")} ${passed ? "PASS" : "FAIL"}`);
        if (!seo.passed) {
          const rules = seo.failures.length ? seo.failures : ["SEO score below 97; inspect the full report."];
          for (const rule of rules) console.error(`  ${rule}`);
          details.push("", `Failing SEO rules for **${target.name}**:`, ...rules.map((rule) => `- ${rule}`), "");
        }
        if (!accessibility.passed) {
          const rules = accessibility.failures.length ? accessibility.failures : ["Accessibility score below 95; inspect the full report."];
          for (const rule of rules) console.error(`  ${rule}`);
          details.push("", `Failing accessibility rules for **${target.name}**:`, ...rules.map((rule) => `- ${rule}`), "");
        }
      } catch (error) {
        failed = true;
        console.error(`${target.name}: ${error.message}`);
        summary.push(`| ${target.url} | — | — | — | — | ERROR |`);
        details.push("", `${target.name}: ${error.message}`, "");
        await writeFile(path.join(output, `${target.name}.error.json`), JSON.stringify({ url: target.url, error: error.message }, null, 2));
      }
    }
    if (failed) process.exitCode = 1;
  } catch (error) {
    process.exitCode = 1;
    console.error(error.message);
    summary.push("", `**Audit setup failed:** ${error.message}`);
  } finally {
    if (browser) {
      try {
        const closed = browser.chromeProcess ? once(browser.chromeProcess, "close").catch(() => {}) : Promise.resolve();
        browser.kill();
        await Promise.race([closed, delay(5000)]);
      } catch (error) {
        console.error(error);
        process.exitCode = 1;
      }
    }
    const cleanup = await Promise.allSettled([...children].map(stop));
    if (fixtureDir) cleanup.push(...await Promise.allSettled([
      rm(fixtureDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
    ]));
    for (const result of cleanup) {
      if (result.status === "rejected") {
        process.exitCode = 1;
        console.error(`Audit cleanup failed: ${result.reason}`);
        details.push("", `**Cleanup failed:** ${result.reason}`);
      }
    }
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    const markdown = `${[...summary, ...details].join("\n")}\n`;
    console.log(`\n${markdown}`);
    await writeFile(path.join(output, "summary.md"), markdown);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
    console.log(`Lighthouse reports: ${output}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
