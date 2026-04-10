import { test, BrowserContext, Page } from "@playwright/test";
import * as dotenv from "dotenv";

dotenv.config();

/* ================= CONFIG ================= */
const CONFIG = {
  USERS: Number(process.env.USER_COUNT || 10),
  USER_ID_OFFSET: Number(process.env.USER_OFFSET || 1),
  DURATION_MS: Number(process.env.DURATION || 2) * 60 * 1000,
  PASSWORD: process.env.TEST_PASSWORD || "",
  BASE_URL: process.env.BASE_URL || "",
};

/* ================= TYPES ================= */
interface ApiMetric {
  url: string;
  duration: number;
  status: number;
  size: number;
}

interface UserSession {
  email: string;
  context: BrowserContext;
  page: Page;
  apiMetrics: ApiMetric[];
  loginFailed: boolean;
}

/* ================= HELPERS ================= */
const ms = (n: number) =>
  n > 1000 ? `${(n / 1000).toFixed(2)}s` : `${n}ms`;

const avg = (arr: number[]) =>
  arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

function percentile(arr: number[], p: number) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * p)];
}

/* ================= CONCURRENCY ================= */
let activeRequests = 0;
let maxConcurrent = 0;

/* ================= API TRACING ================= */
function attachApiTracing(page: Page, session: UserSession) {
  page.on("request", () => {
    activeRequests++;
    maxConcurrent = Math.max(maxConcurrent, activeRequests);
  });

  page.on("requestfinished", () => activeRequests--);
  page.on("requestfailed", () => activeRequests--);

  page.on("response", async (res) => {
    if (!res.url().includes("/api")) return;

    try {
      const start = Date.now();
      const body = await res.body();
      const duration = Date.now() - start;

      session.apiMetrics.push({
        url: res.url(),
        duration,
        status: res.status(),
        size: body.length,
      });
    } catch {}
  });
}

/* ================= LOGIN ================= */
async function login(page: Page, session: UserSession) {
  try {
    await page.goto(`${CONFIG.BASE_URL}/auth/signin`);

    await page.fill("input[name=email]", session.email);
    await page.fill("input[name=password]", CONFIG.PASSWORD);
    await page.click("button[type=submit]");

    const success = await Promise.race([
      page.waitForSelector('[data-testid="taskListAccordionparticipant"]', { timeout: 10000 }),
      page.waitForFunction(() => !window.location.href.includes("signin"), { timeout: 10000 }),
    ]).then(() => true).catch(() => false);

    if (!success) {
      session.loginFailed = true;
      return;
    }

    console.log(`✅ ${session.email} login OK`);
  } catch {
    session.loginFailed = true;
  }
}

/* ================= LONG TASK ================= */
async function enableLongTasks(page: Page) {
  await page.evaluate(() => {
    window.__longTasks = [];

    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__longTasks.push(entry.duration);
      }
    }).observe({ entryTypes: ["longtask"] });
  });
}

/* ================= TEST ================= */
test("SimExAmericas APM FULL", async ({ browser }) => {
  console.log("CONFIG:", CONFIG);

  const sessions: UserSession[] = [];

  /* ===== Crear usuarios ===== */
  for (let i = 0; i < CONFIG.USERS; i++) {
    const id = CONFIG.USER_ID_OFFSET + i;
    const email = `usuario${id}@usuario${id}.org`;

    const context = await browser.newContext();
    const page = await context.newPage();

    const session: UserSession = {
      email,
      context,
      page,
      apiMetrics: [],
      loginFailed: false,
    };

    attachApiTracing(page, session);
    sessions.push(session);

    await new Promise((r) => setTimeout(r, 300));
  }

  /* ===== Ejecutar ===== */
  await Promise.allSettled(
    sessions.map(async (s) => {
      const { page } = s;

      await enableLongTasks(page);

      await login(page, s);
      if (s.loginFailed) return;

      const start = Date.now();

      while (Date.now() - start < CONFIG.DURATION_MS) {
        try {
          const totalStart = Date.now();

          const btn = page
            .locator('[data-testid="taskListAccordionparticipant"]')
            .first()
            .locator("button");

          await btn.click();

          await page.waitForTimeout(1000);

          const totalTime = Date.now() - totalStart;

          // opcional: guardar totalTime si quieres métricas UI
        } catch {}
      }
    })
  );

  /* ================= REPORTE ================= */

  console.log("\n📊 APM REPORT\n");

  const allApis = sessions.flatMap((s) => s.apiMetrics);

  const durationSec = CONFIG.DURATION_MS / 1000;
  console.log("⚡ Throughput:", (allApis.length / durationSec).toFixed(2), "req/s");
  console.log("🔥 Max concurrency:", maxConcurrent);

  const grouped: Record<string, ApiMetric[]> = {};

  for (const api of allApis) {
    const key = api.url.split("?")[0];
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(api);
  }

  Object.entries(grouped).forEach(([url, metrics]) => {
    const times = metrics.map((m) => m.duration);
    const sizes = metrics.map((m) => m.size);
    const errors = metrics.filter((m) => m.status >= 400).length;

    console.log(`\n🔗 ${url}`);
    console.log(`   Count: ${metrics.length}`);
    console.log(`   Avg: ${ms(avg(times))}`);
    console.log(`   p95: ${ms(percentile(times, 0.95))}`);
    console.log(`   p99: ${ms(percentile(times, 0.99))}`);
    console.log(`   Size avg: ${(avg(sizes) / 1024).toFixed(2)} KB`);
    console.log(`   Errors: ${errors}`);
  });

  console.log("\n🐢 TOP 5 APIs MÁS LENTAS\n");

  const slowest = [...allApis]
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 5);

  slowest.forEach((a) =>
    console.log(`${ms(a.duration)} → ${a.url}`)
  );

  /* ===== Long Tasks ===== */
  const longTasks = await sessions[0].page.evaluate(() => window.__longTasks || []);
  console.log("\n🧠 Long tasks:", longTasks.length);

  console.log("\n🔥 TEST COMPLETADO\n");

  await Promise.all(sessions.map((s) => s.context.close()));
});
