import { BrowserContext, Page, expect, test } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

/* ================= CONFIG ================= */
const CONFIG = {
  USERS: Number(process.env.USER_COUNT ?? 3),
  USER_OFFSET: Number(process.env.USER_OFFSET ?? 1),
  DURATION_MS: Number(process.env.SESSION_DURATION ?? 5) * 60 * 1000,
  PASSWORD: process.env.TEST_PASSWORD ?? "",
};

/* ================= TYPES ================= */
type ErrorCategory =
  | "TIMEOUT"
  | "SELECTOR"
  | "NAVIGATION"
  | "AUTH"
  | "NETWORK"
  | "UNKNOWN";

interface Timing {
  label: string;
  duration: number;
  success: boolean;
  timestamp: string;
}

interface Session {
  email: string;
  context: BrowserContext;
  page: Page;
  start: number;
  timings: Timing[];
  errors: { type: string; msg: string }[];
  accordion: number;
  loginOk: boolean;
}

/* ================= HELPERS ================= */
const now = () => new Date().toISOString();

const avg = (arr: number[]) =>
  arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

const percentile = (arr: number[], p: number) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.ceil((p / 100) * s.length) - 1];
};

/* ================= API TRACING ================= */
function attachApiTracing(page: Page, session: Session) {
  let first = true;

  page.on("response", async (res) => {
    const url = res.url();

    if (
      url.includes("api") ||
      url.includes("backend") ||
      url.includes("graphql") ||
      url.includes("simex")
    ) {
      try {
        const req = res.request();
        const timing = req.timing();

        const duration =
          timing.responseEnd > 0
            ? timing.responseEnd - timing.requestStart
            : 0;

        session.timings.push({
          label: first ? "API_FIRST_CALL" : "API_CALL",
          duration,
          success: res.status() < 400,
          timestamp: now(),
        });

        first = false;

        if (res.status() >= 400) {
          session.errors.push({
            type: "API_ERROR",
            msg: `${res.status()} ${url}`,
          });
        }
      } catch {}
    }
  });

  page.on("requestfailed", (req) => {
    session.errors.push({
      type: "REQUEST_FAILED",
      msg: req.url(),
    });

    console.log("💥 REQUEST FAILED:", req.url());
  });
}

/* ================= LOGIN ================= */
async function login(page: Page, session: Session) {
  const t0 = Date.now();

  try {
    await page.goto("/auth/signin");

    await page.fill('input[name="email"]', session.email);
    await page.fill('input[name="password"]', CONFIG.PASSWORD);
    await page.click('button[type="submit"]');

    // 🔥 FIX REAL
    await page.waitForSelector("#menu-dashboard-excon", {
      timeout: 15000,
    });

    session.loginOk = true;

    session.timings.push({
      label: "LOGIN",
      duration: Date.now() - t0,
      success: true,
      timestamp: now(),
    });

    console.log("✅ LOGIN:", session.email);
  } catch (e) {
    session.loginOk = false;

    session.errors.push({
      type: "LOGIN",
      msg: String(e),
    });

    console.log("❌ LOGIN FAIL:", session.email);
  }
}

/* ================= SESSION ================= */
async function runSession(session: Session) {
  const { page } = session;

  attachApiTracing(page, session);

  await login(page, session);
  if (!session.loginOk) return;

  // navegación
  await page.click("#menu-dashboard-excon");

  const start = Date.now();

  while (Date.now() - start < CONFIG.DURATION_MS) {
    try {
      const acc = page.locator('[data-testid="taskListAccordionsent"]');
      const count = await acc.count();

      if (count > 3) {
        const btn = acc.nth(3).locator("button");

        await btn.waitFor({ state: "visible", timeout: 5000 });
        await btn.click();

        session.accordion++;
      } else {
        console.log("⚠️ sin acordeones");
      }

      await page.waitForTimeout(1000);
    } catch (e) {
      session.errors.push({
        type: "UI",
        msg: String(e),
      });
    }
  }
}

/* ================= TEST ================= */
test("EXCON FINAL PRO", async ({ browser }) => {
  const sessions: Session[] = [];

  for (let i = 0; i < CONFIG.USERS; i++) {
    const id = CONFIG.USER_OFFSET + i;

    const context = await browser.newContext();
    const page = await context.newPage();

    sessions.push({
      email: `usuarioexcongeneral${id}@usuarioexcongeneral${id}.com`,
      context,
      page,
      start: Date.now(),
      timings: [],
      errors: [],
      accordion: 0,
      loginOk: false,
    });
  }

  await Promise.allSettled(sessions.map(runSession));

  /* ================= REPORT ================= */
  const allApi = sessions.flatMap((s) =>
    s.timings.filter((t) => t.label.includes("API")).map((t) => t.duration)
  );

  const first = sessions.flatMap((s) =>
    s.timings
      .filter((t) => t.label === "API_FIRST_CALL")
      .map((t) => t.duration)
  );

  const logins = sessions.flatMap((s) =>
    s.timings.filter((t) => t.label === "LOGIN").map((t) => t.duration)
  );

  console.log("\n📊 RESULTADOS\n");

  console.log("Login AVG:", avg(logins));
  console.log("API AVG:", avg(allApi));
  console.log("API P95:", percentile(allApi, 95));
  console.log("🔥 First Call AVG:", avg(first));

  const totalErrors = sessions.reduce((a, s) => a + s.errors.length, 0);

  console.log("Errores:", totalErrors);

  console.log("\n🚨 ERRORES AGRUPADOS");

  const grouped: any = {};

  sessions.forEach((s) => {
    s.errors.forEach((e) => {
      grouped[e.type] = (grouped[e.type] || 0) + 1;
    });
  });

  console.log(grouped);

  /* ================= ALERTAS ================= */
  if (avg(first) > 2000) {
    console.log("🚨 COLD START DETECTADO");
  }

  if (avg(allApi) > 2000) {
    console.log("🚨 BACKEND LENTO");
  }

  if (totalErrors > 0) {
    console.log("🚨 ERRORES DETECTADOS");
  }

  /* ================= CLEANUP ================= */
  await Promise.all(sessions.map((s) => s.context.close()));
});
