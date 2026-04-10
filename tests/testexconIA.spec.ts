import { test } from "@playwright/test";

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const CONFIG = {
  USERS: Number(process.env.USER_COUNT ?? 10),
  USER_ID_OFFSET: Number(process.env.USER_OFFSET ?? 1),
  PASSWORD: process.env.TEST_PASSWORD ?? "ADMINadmin123.",
  BASE_URL: process.env.BASE_URL ?? "https://www.simexamericas.org",
  DURATION_MS: Number(process.env.DURATION ?? 60000),
  BATCH_SIZE: Number(process.env.BATCH_SIZE ?? 3),
};

// ─────────────────────────────────────────────
// TIPOS
// ─────────────────────────────────────────────
type ApiMetric = {
  url: string;
  duration: number;
  status: number;
  size: number;
};

type Session = {
  email: string;
  apiMetrics: ApiMetric[];
  loginOk: boolean;
};

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
const percentile = (arr: number[], p: number) => {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.ceil((p / 100) * sorted.length) - 1];
};

const generateUsers = () =>
  Array.from({ length: CONFIG.USERS }, (_, i) => {
    const id = i + CONFIG.USER_ID_OFFSET;
    return `usuario${id}@usuario${id}.org`;
  });

// ─────────────────────────────────────────────
// LOGIN ROBUSTO
// ─────────────────────────────────────────────
async function login(page, email: string, password: string) {
  await page.goto(`${CONFIG.BASE_URL}/auth/signin`, {
    waitUntil: "domcontentloaded",
  });

  await page.fill("input[name=email]", email);
  await page.fill("input[name=password]", password);

  await Promise.all([
    page.click("button[type=submit]"),
    Promise.race([
      page.waitForURL((url) => !url.toString().includes("signin"), {
        timeout: 15000,
      }),
      page.waitForSelector('[data-testid="taskListAccordionparticipant"]', {
        timeout: 15000,
      }),
    ]),
  ]);

  if (page.url().includes("signin")) {
    throw new Error("Login falló");
  }
}

// 🔁 retry login
async function loginWithRetry(page, email, password) {
  for (let i = 0; i < 2; i++) {
    try {
      await login(page, email, password);
      return;
    } catch {
      if (i === 1) throw new Error("Login falló tras retry");
      await page.waitForTimeout(2000);
    }
  }
}

// ─────────────────────────────────────────────
// TEST PRINCIPAL
// ─────────────────────────────────────────────
test("Stress SimExAmericas FINAL PRO + APM", async ({ browser }) => {
  const users = generateUsers();
  const sessions: Session[] = [];
  const startTest = Date.now();

  // ─────────────────────────────
  // EJECUCIÓN EN BATCHES (CLAVE)
  // ─────────────────────────────
  for (let i = 0; i < users.length; i += CONFIG.BATCH_SIZE) {
    const batch = users.slice(i, i + CONFIG.BATCH_SIZE);

    await Promise.all(
      batch.map(async (email) => {
        const context = await browser.newContext();
        const page = await context.newPage();

        const session: Session = {
          email,
          apiMetrics: [],
          loginOk: false,
        };

        // ─────────────────────────────
        // 🔥 CAPTURA API
        // ─────────────────────────────
        page.on("request", (req: any) => {
          req._startTime = Date.now();
        });

        page.on("response", async (res) => {
          try {
            const url = res.url();
            if (!url.includes("/api")) return;

            const req: any = res.request();
            const start = req._startTime;
            if (!start) return;

            const duration = Date.now() - start;
            const status = res.status();

            let size = 0;
            try {
              size = Number(res.headers()["content-length"] || 0);
            } catch {}

            session.apiMetrics.push({
              url,
              duration,
              status,
              size,
            });
          } catch {}
        });

        try {
          await loginWithRetry(page, email, CONFIG.PASSWORD);
          session.loginOk = true;

          console.log(`✅ ${email} login OK`);

          const endTime = Date.now() + CONFIG.DURATION_MS;

          while (Date.now() < endTime) {
            const accordions = page.locator('[data-testid="taskListAccordionparticipant"]');
            const count = await accordions.count();

            if (count > 0) {
              const index = Math.floor(Math.random() * count);
              const acc = accordions.nth(index);

              try {
                await acc.click({ timeout: 3000 });
              } catch {}
            }

            await page.waitForTimeout(2000);
          }
        } catch (err) {
          console.log(`❌ ${email} login falló`);
        }

        sessions.push(session);
        await context.close();
      })
    );

    // 🔥 pausa entre batches
    await new Promise((r) => setTimeout(r, 2000));
  }

  // ─────────────────────────────
  // 📊 ANALISIS APIs
  // ─────────────────────────────
  const all = sessions.flatMap((s) => s.apiMetrics);
  const grouped: Record<string, ApiMetric[]> = {};

  for (const r of all) {
    const base = r.url.split("?")[0];
    if (!grouped[base]) grouped[base] = [];
    grouped[base].push(r);
  }

  console.log("\n📊 API ANALYSIS\n");

  Object.entries(grouped).forEach(([url, calls]) => {
    const times = calls.map((c) => c.duration);

    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const p95 = percentile(times, 95);
    const p99 = percentile(times, 99);

    const errors = calls.filter((c) => c.status >= 400).length;
    const sizeAvg = calls.reduce((a, b) => a + b.size, 0) / calls.length;

    console.log(`🔗 ${url}`);
    console.log(`   Count: ${calls.length}`);
    console.log(`   Avg: ${avg.toFixed(2)}ms`);
    console.log(`   p95: ${p95}ms`);
    console.log(`   p99: ${p99}ms`);
    console.log(`   Size avg: ${(sizeAvg / 1024).toFixed(2)} KB`);
    console.log(`   Errors: ${errors}\n`);
  });

  // ─────────────────────────────
  // 🐢 TOP LENTAS
  // ─────────────────────────────
  console.log("🐢 TOP 5 APIs MÁS LENTAS\n");

  const slowest = [...all]
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 5);

  slowest.forEach((r) => {
    console.log(`${r.duration}ms → ${r.url}`);
  });

  // ─────────────────────────────
  // 📊 RESUMEN FINAL
  // ─────────────────────────────
  const totalTime = (Date.now() - startTest) / 1000;

  console.log("\n📊 REPORTE FINAL\n");
  console.log(`⏱ TOTAL: ${totalTime.toFixed(2)}s`);
  console.log(`📊 Login fallidos: ${sessions.filter((s) => !s.loginOk).length}`);

  console.log("\n🔥 TEST COMPLETADO\n");
});
