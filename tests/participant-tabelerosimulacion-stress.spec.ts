/**
 * ============================================================================
 * STRESS TEST v3 — Sesiones Activas
 * ============================================================================
 *
 * MEJORAS RESPECTO A v2:
 *
 *  🔬 GRANULARIDAD DE LOGIN (4 fases separadas):
 *     • LOGIN_NAV_MS        → tiempo de navegación a /auth/signin
 *     • LOGIN_API_MS        → duración real de POST /login (intercepción red)
 *     • LOGIN_NEXTAUTH_MS   → tiempo de signIn("credentials") en NextAuth
 *     • LOGIN_REDIRECT_MS   → tiempo hasta que la URL cambia post-login
 *
 *  🔬 GRANULARIDAD DE ACORDEÓN (2 mediciones separadas):
 *     • ACCORDION_INTERACTION_MS → solo el click + validación aria-expanded
 *       (sin waitForTimeout → ahora SÍ refleja mejoras de velocidad UI)
 *     • TASKS_API_MS             → duración real de POST /messagesdays-sent
 *       (intercepción de red → ves si el backend mejora)
 *
 *  📡 INTERCEPCIÓN DE RED (page.route + page.on("response")):
 *     • Captura status HTTP, URL, duración y tamaño de respuesta
 *     • Detecta errores 4xx/5xx automáticamente
 *     • Logs de APIs lentas (> SLA configurado)
 *
 *  📊 REPORTE HTML v3:
 *     • Barras de progreso visuales por fase
 *     • Tabla de llamadas API con percentiles p50/p90/p95
 *     • Comparativa clara: interacción UI vs latencia de red
 *     • Indicadores SLA por cada métrica individual
 *
 * INSTALACIÓN:
 *   npm install -D @playwright/test
 * ============================================================================
 */

import {
  BrowserContext,
  Page,
  Request,
  Response,
  expect,
  test,
} from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURACIÓN CENTRAL
// ─────────────────────────────────────────────────────────────────────────────

const TEST_CONFIG = {
  USEREXCONGENERAL_COUNT: Number(process.env.USER_COUNT ?? 1),
  USER_ID_OFFSET: Number(process.env.USER_OFFSET ?? 1),
  SESSION_DURATION_MS: Number(process.env.SESSION_DURATION ?? 10) * 60 * 1000,

  /**
   * Intervalos rotativos de ESPERA entre ciclos de acordeón.
   * ⚠️ IMPORTANTE: estos ya NO se incluyen en ACCORDION_INTERACTION_MS.
   * Son solo la pausa entre ciclos para simular comportamiento real del usuario.
   */
  ACCORDION_WAIT_INTERVALS_MS: [10_000, 20_000, 15_000, 30_000, 10_000],

  /** Índice (0-based) del acordeón objetivo en la lista */
  ACCORDION_INDEX: 4,

  /**
   * SLA por cada métrica individual.
   * Ahora que LOGIN y ACCORDION están desglosados, los umbrales son más precisos.
   */
  SLA_THRESHOLDS_MS: {
    // Login por fase
    LOGIN_NAV: 2_000, // Navegación a /auth/signin
    LOGIN_API: 1_500, // POST /login (solo backend)
    LOGIN_NEXTAUTH: 1_000, // Handshake NextAuth credentials
    LOGIN_REDIRECT: 2_000, // Redirect post-login

    // Acordeón por fase
    ACCORDION_INTERACTION: 800, // Click + aria-expanded (solo UI)
    TASKS_API: 2_000, // POST /messagesdays-sent (solo backend)

    // General
    TASK_CHECK: 1_500,
  },

  /**
   * Patrones de URL de APIs a interceptar para medir tiempos de red.
   * Ajusta según tu baseURL real.
   */
  API_PATTERNS: {
    LOGIN: /\/login$/,
    REFRESH: /\/refresh$/,
    TASKS_SENT: /messagesdays-sent/,
    TASKS_FILTER: /messagesdays-sent\/filter/,
  },

  DIRS: {
    REPORTS: "test-results/stress-reports",
    TRACES: "test-results/traces",
    LIGHTHOUSE: "test-results/stress-reports/lighthouse",
  },

  ENABLE_LIGHTHOUSE: false,

  TIMEOUTS: {
    TEST: 30 * 60 * 1000,
    TASKSENT_WAIT: 5_000,
    DEFAULT_ACTION: 10_000,
    PAGE_LOAD: 15_000,
  },

  DEFAULT_PASSWORD: process.env.TEST_PASSWORD ?? "ADMINadmin123.",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// TIPOS
// ─────────────────────────────────────────────────────────────────────────────

interface ParticipantUser {
  email: string;
  password: string;
}

type ErrorCategory =
  | "TIMEOUT"
  | "SELECTOR_NOT_FOUND"
  | "NAVIGATION"
  | "AUTH"
  | "NETWORK"
  | "UNKNOWN";

interface TimingEntry {
  label: string;
  durationMs: number;
  timestamp: string;
  success: boolean;
  detail?: string;
  errorCategory?: ErrorCategory;
}

/** Registro de una llamada HTTP interceptada */
interface ApiCallEntry {
  url: string;
  method: string;
  status: number;
  durationMs: number;
  responseBytes: number;
  timestamp: string;
  /** Etiqueta legible: "LOGIN_API", "TASKS_SENT", etc. */
  label: string;
  success: boolean;
}

interface ErrorEntry {
  timestamp: string;
  phase: string;
  message: string;
  category: ErrorCategory;
  cycleNumber: number;
  isFatal: boolean;
}

interface UserSession {
  user: ParticipantUser;
  context: BrowserContext;
  page: Page;
  startTime: number;
  accordionCount: number;
  loginSuccess: boolean;
  hadError: boolean;
  timings: TimingEntry[];
  apiCalls: ApiCallEntry[];
  errors: ErrorEntry[];
  accordionIntervalIndex: number;
  retryCount: number;
  _pageLoad?: { ttfbMs: number; domReadyMs: number; fullyLoadedMs: number };
}

interface TestStats {
  runAt: string;
  totalUsers: number;
  successfulLogins: number;
  failedLogins: number;
  totalAccordion: number;
  totalErrors: number;
  totalRetries: number;
  global: GlobalStats;
  users: UserReportDetail[];
}

interface GlobalStats {
  // Login desglosado
  avgLoginNavMs: number;
  avgLoginApiMs: number;
  avgLoginNextauthMs: number;
  avgLoginRedirectMs: number;
  p50LoginApiMs: number;
  p90LoginApiMs: number;
  p95LoginApiMs: number;

  // Acordeón desglosado
  avgAccordionInteractionMs: number;
  avgTasksApiMs: number;
  p50AccordionInteractionMs: number;
  p90AccordionInteractionMs: number;
  p95AccordionInteractionMs: number;
  p50TasksApiMs: number;
  p90TasksApiMs: number;
  p95TasksApiMs: number;

  // Task check
  avgTaskCheckMs: number;
}

interface UserReportDetail {
  email: string;
  accordion: number;
  sessionDurationMs: number;
  sessionDurationLabel: string;
  status: "success" | "failed";
  hadError: boolean;
  retryCount: number;
  traceFile: string | null;

  // Tiempos UI
  avgLoginNavMs: number;
  avgLoginApiMs: number;
  avgLoginNextauthMs: number;
  avgLoginRedirectMs: number;
  avgAccordionInteractionMs: number;
  p50AccordionInteractionMs: number;
  p90AccordionInteractionMs: number;
  p95AccordionInteractionMs: number;

  // Tiempos API (red)
  avgTasksApiMs: number;
  p50TasksApiMs: number;
  p90TasksApiMs: number;
  p95TasksApiMs: number;
  apiCallsCount: number;
  apiErrorsCount: number;

  pageLoad: {
    ttfbMs: number;
    domReadyMs: number;
    fullyLoadedMs: number;
  } | null;
  successRates: { accordion: number; taskCheck: number };
  errors: ErrorEntry[];
  timings: TimingEntry[];
  apiCalls: ApiCallEntry[];
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILIDADES
// ─────────────────────────────────────────────────────────────────────────────

const generateUsers = (count: number): ParticipantUser[] =>
  Array.from({ length: count }, (_, i) => {
    const id = i + 1 + TEST_CONFIG.USER_ID_OFFSET;
    return {
      email: `usuario${id}@usuario${id}.org`,
      password: TEST_CONFIG.DEFAULT_PASSWORD,
    };
  });

const formatTime = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
};

const msLabel = (ms: number): string =>
  ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;

const logUserAction = (
  email: string,
  message: string,
  type: "info" | "success" | "error" | "warning" = "info",
): void => {
  const icons = { info: "ℹ️", success: "✅", error: "❌", warning: "⚠️" };
  const tag = email ? ` [${email}]` : "";
  console.log(
    `[${new Date().toLocaleTimeString("es-ES")}] ${icons[type]}${tag} → ${message}`,
  );
};

const logSep = (char = "━", len = 70): void =>
  console.log("\n" + char.repeat(len) + "\n");
const ensureDir = (dir: string): void =>
  fs.mkdirSync(path.resolve(dir), { recursive: true });

function classifyError(err: unknown): ErrorCategory {
  const msg = String(err).toLowerCase();
  if (msg.includes("timeout")) return "TIMEOUT";
  if (msg.includes("no element") || msg.includes("locator"))
    return "SELECTOR_NOT_FOUND";
  if (msg.includes("navigation") || msg.includes("url")) return "NAVIGATION";
  if (msg.includes("401") || msg.includes("403") || msg.includes("auth"))
    return "AUTH";
  if (msg.includes("net::") || msg.includes("fetch") || msg.includes("network"))
    return "NETWORK";
  return "UNKNOWN";
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

function timingValues(timings: TimingEntry[], prefix: string): number[] {
  return timings
    .filter((t) => t.label.startsWith(prefix) && t.success)
    .map((t) => t.durationMs);
}

function apiValues(apiCalls: ApiCallEntry[], label: string): number[] {
  return apiCalls
    .filter((c) => c.label === label && c.success)
    .map((c) => c.durationMs);
}

function avgOf(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function successRate(timings: TimingEntry[], prefix: string): number {
  const all = timings.filter((t) => t.label.startsWith(prefix));
  if (!all.length) return 100;
  return (all.filter((t) => t.success).length / all.length) * 100;
}

function slaFlag(ms: number, threshold: number): string {
  return ms > threshold ? "  ⚠️ SUPERA SLA" : "";
}

// ─────────────────────────────────────────────────────────────────────────────
// WRAPPER DE MEDICIÓN
// ─────────────────────────────────────────────────────────────────────────────

async function measure<T>(
  label: string,
  session: UserSession,
  fn: () => Promise<T>,
  opts: { cycleNumber?: number; isFatal?: boolean } = {},
): Promise<T> {
  const start = Date.now();
  let success = true;
  let detail: string | undefined;
  let errorCategory: ErrorCategory | undefined;

  try {
    return await fn();
  } catch (err) {
    success = false;
    detail = String(err).slice(0, 200);
    errorCategory = classifyError(err);
    session.hadError = true;
    session.errors.push({
      timestamp: new Date().toISOString(),
      phase: label,
      message: String(err).slice(0, 300),
      category: errorCategory,
      cycleNumber: opts.cycleNumber ?? 0,
      isFatal: opts.isFatal ?? false,
    });
    throw err;
  } finally {
    const durationMs = Date.now() - start;
    session.timings.push({
      label,
      durationMs,
      timestamp: new Date().toISOString(),
      success,
      detail,
      errorCategory,
    });
    const slaKey = label.split(
      "_CYCLE_",
    )[0] as keyof typeof TEST_CONFIG.SLA_THRESHOLDS_MS;
    const sla = TEST_CONFIG.SLA_THRESHOLDS_MS[slaKey];
    const slaWarn = sla && durationMs > sla ? ` ⚠️ SLA(${msLabel(sla)})` : "";
    logUserAction(
      session.user.email,
      `⏱ ${label}: ${msLabel(durationMs)}${slaWarn} ${success ? "✅" : `❌ [${errorCategory}]`}`,
      success ? "info" : "warning",
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERCEPTOR DE RED
// Registra duración y status de cada llamada HTTP relevante
// ─────────────────────────────────────────────────────────────────────────────

function setupNetworkInterceptor(session: UserSession): void {
  const { page } = session;
  const pendingRequests = new Map<
    string,
    { start: number; label: string; method: string }
  >();

  /**
   * Clasifica una URL en una etiqueta legible.
   * Devuelve null si no es una URL que nos interesa medir.
   */
  function classifyUrl(url: string): string | null {
    if (TEST_CONFIG.API_PATTERNS.LOGIN.test(url)) return "LOGIN_API";
    if (TEST_CONFIG.API_PATTERNS.REFRESH.test(url)) return "REFRESH_API";
    if (TEST_CONFIG.API_PATTERNS.TASKS_FILTER.test(url))
      return "TASKS_FILTER_API";
    if (TEST_CONFIG.API_PATTERNS.TASKS_SENT.test(url)) return "TASKS_SENT_API";
    return null;
  }

  page.on("request", (req: Request) => {
    const label = classifyUrl(req.url());
    if (!label) return;
    pendingRequests.set(req.url(), {
      start: Date.now(),
      label,
      method: req.method(),
    });
  });

  page.on("response", async (res: Response) => {
    const entry = pendingRequests.get(res.url());
    if (!entry) return;
    pendingRequests.delete(res.url());

    const durationMs = Date.now() - entry.start;
    const success = res.status() < 400;

    let responseBytes = 0;
    try {
      const body = await res.body();
      responseBytes = body.length;
    } catch {
      // body no disponible (e.g. redirect)
    }

    const apiEntry: ApiCallEntry = {
      url: res.url(),
      method: entry.method,
      status: res.status(),
      durationMs,
      responseBytes,
      timestamp: new Date().toISOString(),
      label: entry.label,
      success,
    };

    session.apiCalls.push(apiEntry);

    const slaMap: Record<string, number> = {
      LOGIN_API: TEST_CONFIG.SLA_THRESHOLDS_MS.LOGIN_API,
      TASKS_SENT_API: TEST_CONFIG.SLA_THRESHOLDS_MS.TASKS_API,
    };
    const sla = slaMap[entry.label];
    const slaWarn = sla && durationMs > sla ? ` ⚠️ SLA(${msLabel(sla)})` : "";

    logUserAction(
      session.user.email,
      `📡 [${entry.method}] ${entry.label}: ${msLabel(durationMs)} | ${res.status()} | ${(responseBytes / 1024).toFixed(1)}kb${slaWarn}`,
      success ? "info" : "error",
    );
  });

  // Detectar errores de red (sin respuesta)
  page.on("requestfailed", (req: Request) => {
    const label = classifyUrl(req.url());
    if (!label) return;
    const entry = pendingRequests.get(req.url());
    if (!entry) return;
    pendingRequests.delete(req.url());

    const durationMs = Date.now() - entry.start;
    session.apiCalls.push({
      url: req.url(),
      method: entry.method,
      status: 0,
      durationMs,
      responseBytes: 0,
      timestamp: new Date().toISOString(),
      label,
      success: false,
    });
    session.hadError = true;
    logUserAction(
      session.user.email,
      `📡 ❌ ${label} falló: ${req.failure()?.errorText}`,
      "error",
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// TIEMPOS DE NAVEGACIÓN DEL BROWSER
// ─────────────────────────────────────────────────────────────────────────────

async function getNavTiming(page: Page) {
  return page.evaluate(() => {
    const t = performance.getEntriesByType(
      "navigation",
    )[0] as PerformanceNavigationTiming;
    if (!t) return null;
    return {
      ttfbMs: Math.round(t.responseStart - t.requestStart),
      domReadyMs: Math.round(t.domContentLoadedEventEnd - t.startTime),
      fullyLoadedMs: Math.round(t.loadEventEnd - t.startTime),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE OBJECTS
// ─────────────────────────────────────────────────────────────────────────────

class LoginPage {
  private readonly sel = {
    emailInput: 'input[name="email"]',
    passwordInput: 'input[name="password"]',
    submitButton: 'button[type="submit"]',
  };

  constructor(
    private page: Page,
    private session: UserSession,
  ) {}

  async login(email: string, password: string): Promise<void> {
    const { page, session } = this;

    // ── FASE 1: Navegación ────────────────────────────────────────────────
    await measure(
      "LOGIN_NAV",
      session,
      async () => {
        logUserAction(email, "Navegando a /auth/signin...", "info");
        await page.goto("/auth/signin", {
          waitUntil: "domcontentloaded",
          timeout: TEST_CONFIG.TIMEOUTS.PAGE_LOAD,
        });
        const nav = await getNavTiming(page);
        if (nav) {
          session._pageLoad = nav;
          logUserAction(
            email,
            `🌐 TTFB: ${msLabel(nav.ttfbMs)} | DOM: ${msLabel(nav.domReadyMs)} | Full: ${msLabel(nav.fullyLoadedMs)}`,
            "info",
          );
        }
        await page.locator(this.sel.emailInput).waitFor({
          state: "visible",
          timeout: TEST_CONFIG.TIMEOUTS.DEFAULT_ACTION,
        });
      },
      { isFatal: true },
    );

    // ── FASE 2: Llamada a API /login (la red la mide el interceptor)
    //            Aquí medimos el fill + click + espera de respuesta API ────
    await measure(
      "LOGIN_NEXTAUTH",
      session,
      async () => {
        await page.fill(this.sel.emailInput, email);
        await page.fill(this.sel.passwordInput, password);
        logUserAction(email, "Enviando credenciales...", "info");

        // El click dispara: POST /login (interceptado) → signIn NextAuth
        await page.click(this.sel.submitButton);

        // Esperar que NextAuth complete el handshake de credentials
        // (el iframe/fetch interno de next-auth/csrf + session)
        await page
          .waitForFunction(
            () =>
              document.cookie.includes("next-auth.session-token") ||
              document.cookie.includes("__Secure-next-auth.session-token"),
            { timeout: TEST_CONFIG.TIMEOUTS.DEFAULT_ACTION },
          )
          .catch(() => {
            // Cookie puede no existir en HTTP (dev). Continuamos.
            logUserAction(
              email,
              "Cookie de sesión no detectada (modo dev/HTTP)",
              "warning",
            );
          });
      },
      { isFatal: true },
    );

    // ── FASE 3: Redirect post-login ───────────────────────────────────────
    await measure(
      "LOGIN_REDIRECT",
      session,
      async () => {
        await page.waitForURL(/(dashboard|\/)/, {
          timeout: TEST_CONFIG.TIMEOUTS.DEFAULT_ACTION,
        });
        logUserAction(email, "✨ Login exitoso — dashboard cargado", "success");
      },
      { isFatal: true },
    );
  }
}

class TaskSentPage {
  private readonly sel = {
    tareasEnviadas: "[data-testid=messagetasksparticipant]",
    taskListAccordion: '[data-testid="taskListAccordionparticipant"]',
  };

  constructor(
    private page: Page,
    private session: UserSession,
  ) {}

  async hasTasksSent(): Promise<boolean> {
    try {
      await this.page.locator(this.sel.tareasEnviadas).waitFor({
        state: "visible",
        timeout: TEST_CONFIG.TIMEOUTS.TASKSENT_WAIT,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Ciclo de acordeón con tiempos SEPARADOS:
   *  • ACCORDION_INTERACTION_MS  → solo el click + validación aria (UI pura)
   *  • La pausa entre ciclos NO se incluye en la medición
   *
   * El tiempo de /messagesdays-sent lo captura el interceptor de red
   * automáticamente como TASKS_SENT_API.
   */
  async toggleAccordion(cycleNumber: number): Promise<void> {
    const { page, session } = this;
    const { user } = session;

    // Intervalo de ESPERA (no forma parte de ninguna medición)
    const waitMs =
      TEST_CONFIG.ACCORDION_WAIT_INTERVALS_MS[session.accordionIntervalIndex];
    session.accordionIntervalIndex =
      (session.accordionIntervalIndex + 1) %
      TEST_CONFIG.ACCORDION_WAIT_INTERVALS_MS.length;

    logUserAction(
      user.email,
      `🎡 Ciclo ${cycleNumber} | pausa configurada: ${msLabel(waitMs)}`,
      "info",
    );

    // ── MEDICIÓN: solo la interacción UI ──────────────────────────────────
    await measure(
      `ACCORDION_INTERACTION_CYCLE_${cycleNumber}`,
      session,
      async () => {
        const accordion = page
          .locator(this.sel.taskListAccordion)
          .nth(TEST_CONFIG.ACCORDION_INDEX);
        const button = accordion.locator("button[aria-expanded]");

        const currentState = await button.getAttribute("aria-expanded", {
          timeout: TEST_CONFIG.TIMEOUTS.DEFAULT_ACTION,
        });
        const isExpanded = currentState === "true";

        logUserAction(
          user.email,
          `Acordeón [${TEST_CONFIG.ACCORDION_INDEX}] → ${isExpanded ? "▼ abierto → cerrando" : "▶ cerrado → abriendo"}`,
          "info",
        );

        await button.click({ timeout: TEST_CONFIG.TIMEOUTS.TASKSENT_WAIT });

        // Valida que el DOM cambió (UI respondió)
        await expect(button)
          .toHaveAttribute("aria-expanded", isExpanded ? "false" : "true", {
            timeout: TEST_CONFIG.TIMEOUTS.DEFAULT_ACTION,
          })
          .catch(() =>
            logUserAction(
              user.email,
              "aria-expanded no cambió a tiempo",
              "warning",
            ),
          );

        logUserAction(
          user.email,
          `Acordeón ${isExpanded ? "cerrado ✕" : "abierto ✓"}`,
          "success",
        );

        // Si se abrió el acordeón, esperar a que la API /messagesdays-sent responda
        // (el interceptor ya la está midiendo; aquí esperamos que el contenido cargue)
        if (!isExpanded) {
          await page
            .locator(
              `${this.sel.taskListAccordion}:nth-child(${TEST_CONFIG.ACCORDION_INDEX + 1}) ul li`,
            )
            .first()
            .waitFor({
              state: "attached",
              timeout: TEST_CONFIG.TIMEOUTS.DEFAULT_ACTION,
            })
            .catch(() => {
              // Sin tareas en este grupo → normal
            });
        }
      },
      { cycleNumber, isFatal: false },
    );

    // ── Pausa entre ciclos (fuera de cualquier medición) ──────────────────
    logUserAction(
      user.email,
      `💤 Esperando ${msLabel(waitMs)} antes del próximo ciclo...`,
      "info",
    );
    await page.waitForTimeout(waitMs);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SESIÓN PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────────

async function maintainUserSession(session: UserSession): Promise<void> {
  const { user, page, context } = session;
  const safeEmail = user.email.replace(/[@.]/g, "_");

  ensureDir(TEST_CONFIG.DIRS.TRACES);

  // ── Configurar interceptor de red ANTES de cualquier navegación ──────
  setupNetworkInterceptor(session);

  // ── Iniciar traza (retain-on-failure) ─────────────────────────────────
  await context.tracing.start({
    screenshots: true,
    snapshots: true,
    sources: true,
    title: `Trace - ${user.email}`,
  });
  logUserAction(
    user.email,
    "🔴 Trace activo (solo se guarda si hay error)",
    "info",
  );

  const loginPage = new LoginPage(page, session);
  const taskSentPage = new TaskSentPage(page, session);
  let cycleNumber = 0;
  let criticalError: unknown = null;

  try {
    // ── FASE 1: Login ──────────────────────────────────────────────────
    await loginPage.login(user.email, user.password);
    session.loginSuccess = true;
    await page.waitForTimeout(1100);

    logUserAction(
      user.email,
      `🔄 Sesión activa | máximo: ${formatTime(TEST_CONFIG.SESSION_DURATION_MS)}`,
      "info",
    );

    // ── FASE 2: Loop de ciclos ────────────────────────────────────────
    while (true) {
      const elapsed = Date.now() - session.startTime;
      const remaining = TEST_CONFIG.SESSION_DURATION_MS - elapsed;

      if (elapsed >= TEST_CONFIG.SESSION_DURATION_MS) {
        logUserAction(
          user.email,
          `🏁 Sesión completada | ${formatTime(elapsed)} | acordeones: ${session.accordionCount}`,
          "success",
        );
        break;
      }

      cycleNumber++;
      logUserAction(
        user.email,
        `⏱ Ciclo ${cycleNumber} | ${formatTime(elapsed)} / ${formatTime(TEST_CONFIG.SESSION_DURATION_MS)} (resta: ${formatTime(remaining)})`,
        "info",
      );

      const hasTasks = await measure(
        `CHECK_TASKS_CYCLE_${cycleNumber}`,
        session,
        () => taskSentPage.hasTasksSent(),
        { cycleNumber },
      );

      if (hasTasks) {
        logUserAction(
          user.email,
          "🎯 Componente de tareas visible, ejecutando ciclo...",
          "info",
        );
        try {
          await taskSentPage.toggleAccordion(cycleNumber);
          session.accordionCount++;
        } catch (err) {
          session.retryCount++;
          logUserAction(
            user.email,
            `⚠️ Error ciclo ${cycleNumber} (recuperable): ${err}`,
            "warning",
          );
          await page.waitForTimeout(2000);
        }
      } else {
        logUserAction(
          user.email,
          "📭 Sin tareas visibles, esperando...",
          "info",
        );
        await page.waitForTimeout(2000);
      }
    }
  } catch (error) {
    criticalError = error;
    session.loginSuccess = false;
    session.hadError = true;
    logUserAction(user.email, `💥 Error crítico: ${error}`, "error");
    throw error;
  } finally {
    if (session.hadError) {
      const tracePath = path.join(
        path.resolve(TEST_CONFIG.DIRS.TRACES),
        `ERROR_${safeEmail}_trace.zip`,
      );
      await context.tracing.stop({ path: tracePath });
      logUserAction(user.email, `📦 Traza guardada → ${tracePath}`, "error");
      logUserAction(
        user.email,
        `   👉 Ver: npx playwright show-trace "${tracePath}"`,
        "info",
      );

      const errorLogPath = path.join(
        path.resolve(TEST_CONFIG.DIRS.TRACES),
        `ERROR_${safeEmail}_errors.json`,
      );
      fs.writeFileSync(
        errorLogPath,
        JSON.stringify(
          {
            user: user.email,
            totalErrors: session.errors.length,
            criticalError: criticalError ? String(criticalError) : null,
            errors: session.errors,
            apiCalls: session.apiCalls,
          },
          null,
          2,
        ),
      );
    } else {
      await context.tracing.stop();
      logUserAction(user.email, "🟢 Sin errores → traza descartada", "success");
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ESTADÍSTICAS
// ─────────────────────────────────────────────────────────────────────────────

function buildStats(sessions: UserSession[]): TestStats {
  const users: UserReportDetail[] = sessions.map((s) => {
    const safeEmail = s.user.email.replace(/[@.]/g, "_");
    const tracePath = s.hadError
      ? path.join(TEST_CONFIG.DIRS.TRACES, `ERROR_${safeEmail}_trace.zip`)
      : null;

    const accordionInteractionVals = timingValues(
      s.timings,
      "ACCORDION_INTERACTION_CYCLE",
    );
    const loginNavVals = timingValues(s.timings, "LOGIN_NAV");
    const loginNextauthVals = timingValues(s.timings, "LOGIN_NEXTAUTH");
    const loginRedirectVals = timingValues(s.timings, "LOGIN_REDIRECT");
    const taskCheckVals = timingValues(s.timings, "CHECK_TASKS_CYCLE");

    const loginApiVals = apiValues(s.apiCalls, "LOGIN_API");
    const tasksApiVals = apiValues(s.apiCalls, "TASKS_SENT_API");

    return {
      email: s.user.email,
      accordion: s.accordionCount,
      sessionDurationMs: Date.now() - s.startTime,
      sessionDurationLabel: formatTime(Date.now() - s.startTime),
      status: s.loginSuccess ? "success" : "failed",
      hadError: s.hadError,
      retryCount: s.retryCount,
      traceFile: tracePath,

      avgLoginNavMs: avgOf(loginNavVals),
      avgLoginApiMs: avgOf(loginApiVals),
      avgLoginNextauthMs: avgOf(loginNextauthVals),
      avgLoginRedirectMs: avgOf(loginRedirectVals),
      avgAccordionInteractionMs: avgOf(accordionInteractionVals),
      p50AccordionInteractionMs: percentile(accordionInteractionVals, 50),
      p90AccordionInteractionMs: percentile(accordionInteractionVals, 90),
      p95AccordionInteractionMs: percentile(accordionInteractionVals, 95),

      avgTasksApiMs: avgOf(tasksApiVals),
      p50TasksApiMs: percentile(tasksApiVals, 50),
      p90TasksApiMs: percentile(tasksApiVals, 90),
      p95TasksApiMs: percentile(tasksApiVals, 95),
      apiCallsCount: s.apiCalls.length,
      apiErrorsCount: s.apiCalls.filter((c) => !c.success).length,

      pageLoad: s._pageLoad ?? null,
      successRates: {
        accordion: successRate(s.timings, "ACCORDION_INTERACTION_CYCLE"),
        taskCheck: successRate(s.timings, "CHECK_TASKS_CYCLE"),
      },
      errors: s.errors,
      timings: s.timings,
      apiCalls: s.apiCalls,
    };
  });

  const successfulLogins = users.filter((u) => u.status === "success").length;

  const allLoginApiMs = users.flatMap((u) =>
    apiValues(u.apiCalls, "LOGIN_API"),
  );
  const allTasksApiMs = users.flatMap((u) =>
    apiValues(u.apiCalls, "TASKS_SENT_API"),
  );
  const allAccordionInteractionMs = users.flatMap((u) =>
    timingValues(u.timings, "ACCORDION_INTERACTION_CYCLE"),
  );

  return {
    runAt: new Date().toISOString(),
    totalUsers: sessions.length,
    successfulLogins,
    failedLogins: sessions.length - successfulLogins,
    totalAccordion: users.reduce((a, u) => a + u.accordion, 0),
    totalErrors: users.reduce((a, u) => a + u.errors.length, 0),
    totalRetries: users.reduce((a, u) => a + u.retryCount, 0),
    global: {
      avgLoginNavMs: avgOf(users.map((u) => u.avgLoginNavMs).filter(Boolean)),
      avgLoginApiMs: avgOf(allLoginApiMs),
      avgLoginNextauthMs: avgOf(
        users.map((u) => u.avgLoginNextauthMs).filter(Boolean),
      ),
      avgLoginRedirectMs: avgOf(
        users.map((u) => u.avgLoginRedirectMs).filter(Boolean),
      ),
      p50LoginApiMs: percentile(allLoginApiMs, 50),
      p90LoginApiMs: percentile(allLoginApiMs, 90),
      p95LoginApiMs: percentile(allLoginApiMs, 95),
      avgAccordionInteractionMs: avgOf(allAccordionInteractionMs),
      avgTasksApiMs: avgOf(allTasksApiMs),
      p50AccordionInteractionMs: percentile(allAccordionInteractionMs, 50),
      p90AccordionInteractionMs: percentile(allAccordionInteractionMs, 90),
      p95AccordionInteractionMs: percentile(allAccordionInteractionMs, 95),
      p50TasksApiMs: percentile(allTasksApiMs, 50),
      p90TasksApiMs: percentile(allTasksApiMs, 90),
      p95TasksApiMs: percentile(allTasksApiMs, 95),
      avgTaskCheckMs: avgOf(
        users.flatMap((u) => timingValues(u.timings, "CHECK_TASKS_CYCLE")),
      ),
    },
    users,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSOLA
// ─────────────────────────────────────────────────────────────────────────────

function printReport(stats: TestStats): void {
  const g = stats.global;
  logSep();
  console.log("📊  REPORTE FINAL — STRESS TEST v3");
  console.log(`    Ejecutado: ${stats.runAt}`);
  logSep();

  console.log("📈  RESUMEN GENERAL");
  console.log(`    ├─ Usuarios totales:         ${stats.totalUsers}`);
  console.log(`    ├─ ✅ Logins exitosos:       ${stats.successfulLogins}`);
  console.log(`    ├─ ❌ Logins fallidos:       ${stats.failedLogins}`);
  console.log(`    ├─ 💬 Acordeones totales:    ${stats.totalAccordion}`);
  console.log(`    ├─ 🔁 Reintentos totales:    ${stats.totalRetries}`);
  console.log(`    └─ 🐛 Errores totales:       ${stats.totalErrors}`);

  logSep("─");
  console.log("🔐  LOGIN — DESGLOSE DE FASES (UI + Red)");
  console.log("");
  console.log("    FASE                    │  AVG       │  SLA");
  console.log("    ────────────────────────┼────────────┼────────────");
  console.log(
    `    LOGIN_NAV (navegación)  │  ${msLabel(g.avgLoginNavMs).padEnd(9)} │  ${msLabel(TEST_CONFIG.SLA_THRESHOLDS_MS.LOGIN_NAV)}${slaFlag(g.avgLoginNavMs, TEST_CONFIG.SLA_THRESHOLDS_MS.LOGIN_NAV)}`,
  );
  console.log(
    `    LOGIN_API (backend)     │  ${msLabel(g.avgLoginApiMs).padEnd(9)} │  ${msLabel(TEST_CONFIG.SLA_THRESHOLDS_MS.LOGIN_API)}${slaFlag(g.avgLoginApiMs, TEST_CONFIG.SLA_THRESHOLDS_MS.LOGIN_API)}`,
  );
  console.log(
    `      ↳ p50 / p90 / p95    │  ${msLabel(g.p50LoginApiMs)} / ${msLabel(g.p90LoginApiMs)} / ${msLabel(g.p95LoginApiMs)}`,
  );
  console.log(
    `    LOGIN_NEXTAUTH (auth)   │  ${msLabel(g.avgLoginNextauthMs).padEnd(9)} │  ${msLabel(TEST_CONFIG.SLA_THRESHOLDS_MS.LOGIN_NEXTAUTH)}${slaFlag(g.avgLoginNextauthMs, TEST_CONFIG.SLA_THRESHOLDS_MS.LOGIN_NEXTAUTH)}`,
  );
  console.log(
    `    LOGIN_REDIRECT (nav)    │  ${msLabel(g.avgLoginRedirectMs).padEnd(9)} │  ${msLabel(TEST_CONFIG.SLA_THRESHOLDS_MS.LOGIN_REDIRECT)}${slaFlag(g.avgLoginRedirectMs, TEST_CONFIG.SLA_THRESHOLDS_MS.LOGIN_REDIRECT)}`,
  );

  logSep("─");
  console.log("🎡  ACORDEÓN — DESGLOSE (UI vs API de red)");
  console.log("");
  console.log(
    "    OPERACIÓN                    │  AVG       │  p50       │  p90       │  p95",
  );
  console.log(
    "    ─────────────────────────────┼────────────┼────────────┼────────────┼────────────",
  );
  console.log(
    `    ACCORDION_INTERACTION (UI)   │  ${msLabel(g.avgAccordionInteractionMs).padEnd(9)} │  ${msLabel(g.p50AccordionInteractionMs).padEnd(9)} │  ${msLabel(g.p90AccordionInteractionMs).padEnd(9)} │  ${msLabel(g.p95AccordionInteractionMs)}${slaFlag(g.avgAccordionInteractionMs, TEST_CONFIG.SLA_THRESHOLDS_MS.ACCORDION_INTERACTION)}`,
  );
  console.log(
    `    TASKS_SENT_API (backend)     │  ${msLabel(g.avgTasksApiMs).padEnd(9)} │  ${msLabel(g.p50TasksApiMs).padEnd(9)} │  ${msLabel(g.p90TasksApiMs).padEnd(9)} │  ${msLabel(g.p95TasksApiMs)}${slaFlag(g.avgTasksApiMs, TEST_CONFIG.SLA_THRESHOLDS_MS.TASKS_API)}`,
  );

  console.log("");
  console.log(
    "    💡 ACCORDION_INTERACTION = click + aria-expanded (solo frontend)",
  );
  console.log(
    "    💡 TASKS_SENT_API       = POST /messagesdays-sent (solo backend)",
  );
  console.log(
    "    → Si ACCORDION_INTERACTION baja pero TASKS_SENT_API no: optimizar backend",
  );
  console.log(
    "    → Si TASKS_SENT_API baja pero ACCORDION_INTERACTION no: optimizar frontend/re-renders",
  );

  logSep("─");
  console.log("👥  DETALLE POR USUARIO");
  logSep("─");

  for (const [i, u] of stats.users.entries()) {
    const icon = u.status === "success" ? "✅" : "❌";
    console.log(`${i + 1}. ${icon}${u.hadError ? " 🐛" : ""} ${u.email}`);
    console.log(
      `   ├─ Estado:                    ${u.status === "success" ? "Completado" : "Falló"}`,
    );
    console.log(`   ├─ Duración sesión:            ${u.sessionDurationLabel}`);
    console.log(`   ├─ Acordeones:                 ${u.accordion}`);
    console.log(
      `   ├─ Llamadas API interceptadas: ${u.apiCallsCount} (${u.apiErrorsCount} errores)`,
    );
    if (u.pageLoad) {
      console.log(
        `   ├─ Page load: TTFB ${msLabel(u.pageLoad.ttfbMs)} | DOM ${msLabel(u.pageLoad.domReadyMs)} | Full ${msLabel(u.pageLoad.fullyLoadedMs)}`,
      );
    }
    console.log(`   ├─ Login desglose:`);
    console.log(
      `   │    ├─ NAV:      ${msLabel(u.avgLoginNavMs)}${slaFlag(u.avgLoginNavMs, TEST_CONFIG.SLA_THRESHOLDS_MS.LOGIN_NAV)}`,
    );
    console.log(
      `   │    ├─ API:      ${msLabel(u.avgLoginApiMs)}${slaFlag(u.avgLoginApiMs, TEST_CONFIG.SLA_THRESHOLDS_MS.LOGIN_API)}`,
    );
    console.log(
      `   │    ├─ NEXTAUTH: ${msLabel(u.avgLoginNextauthMs)}${slaFlag(u.avgLoginNextauthMs, TEST_CONFIG.SLA_THRESHOLDS_MS.LOGIN_NEXTAUTH)}`,
    );
    console.log(
      `   │    └─ REDIRECT: ${msLabel(u.avgLoginRedirectMs)}${slaFlag(u.avgLoginRedirectMs, TEST_CONFIG.SLA_THRESHOLDS_MS.LOGIN_REDIRECT)}`,
    );
    console.log(`   ├─ Acordeón desglose:`);
    console.log(
      `   │    ├─ Interaction avg/p50/p90/p95: ${msLabel(u.avgAccordionInteractionMs)} / ${msLabel(u.p50AccordionInteractionMs)} / ${msLabel(u.p90AccordionInteractionMs)} / ${msLabel(u.p95AccordionInteractionMs)}`,
    );
    console.log(
      `   │    └─ Tasks API avg/p50/p90/p95:   ${msLabel(u.avgTasksApiMs)} / ${msLabel(u.p50TasksApiMs)} / ${msLabel(u.p90TasksApiMs)} / ${msLabel(u.p95TasksApiMs)}`,
    );
    if (u.errors.length > 0) {
      const grouped: Record<string, number> = {};
      for (const e of u.errors)
        grouped[e.category] = (grouped[e.category] ?? 0) + 1;
      console.log(
        `   ├─ Errores: ${Object.entries(grouped)
          .map(([k, v]) => `${k}×${v}`)
          .join(", ")}`,
      );
    }
    console.log(
      `   └─ Traza: ${u.traceFile ? `npx playwright show-trace "${u.traceFile}"` : "Sin errores (descartada)"}`,
    );
    console.log("");
  }

  ensureDir(TEST_CONFIG.DIRS.REPORTS);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(
    path.resolve(TEST_CONFIG.DIRS.REPORTS),
    `report_v3_${ts}.json`,
  );
  const htmlPath = jsonPath.replace(".json", ".html");

  fs.writeFileSync(jsonPath, JSON.stringify(stats, null, 2), "utf-8");
  fs.writeFileSync(htmlPath, buildHtmlReport(stats), "utf-8");

  console.log(`📄  Reporte JSON → ${jsonPath}`);
  console.log(`🌐  Reporte HTML → ${htmlPath}`);
  logSep();
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML REPORT v3
// ─────────────────────────────────────────────────────────────────────────────

function buildHtmlReport(stats: TestStats): string {
  const g = stats.global;

  const slaRow = (
    label: string,
    avg: number,
    threshold: number,
    p50 = 0,
    p90 = 0,
    p95 = 0,
    isApi = false,
  ) => {
    const ok = avg <= threshold;
    const pcts = p50
      ? `${msLabel(p50)} / ${msLabel(p90)} / ${msLabel(p95)}`
      : "—";
    const badge = ok
      ? `<span class="badge ok">✅ OK</span>`
      : `<span class="badge warn">⚠️ LENTO</span>`;
    const src = isApi
      ? `<span class="source-api">📡 red</span>`
      : `<span class="source-ui">🖥 UI</span>`;
    return `<tr>
      <td>${label} ${src}</td>
      <td class="${ok ? "" : "cell-warn"}">${msLabel(avg)}</td>
      <td>${pcts}</td>
      <td>${msLabel(threshold)}</td>
      <td>${badge}</td>
    </tr>`;
  };

  const apiRows = stats.users
    .flatMap((u) =>
      u.apiCalls.map(
        (c) => `
    <tr class="${c.success ? "" : "row-fail"}">
      <td>${u.email}</td>
      <td><span class="badge ${c.label.toLowerCase().replace(/_/g, "-")}">${c.label}</span></td>
      <td>${c.method}</td>
      <td class="${c.status >= 400 ? "cell-warn" : ""}">${c.status || "ERR"}</td>
      <td class="${c.durationMs > 2000 ? "cell-warn" : ""}">${msLabel(c.durationMs)}</td>
      <td>${(c.responseBytes / 1024).toFixed(1)} kb</td>
      <td class="msg">${c.timestamp.split("T")[1].slice(0, 8)}</td>
    </tr>`,
      ),
    )
    .join("");

  const userRows = stats.users
    .map(
      (u) => `
    <tr class="${u.status === "failed" ? "row-fail" : u.hadError ? "row-warn" : "row-ok"}">
      <td>${u.email}</td>
      <td>${u.status === "success" ? "✅" : "❌"}${u.hadError ? " 🐛" : ""}</td>
      <td>${u.accordion}</td>
      <td>${u.sessionDurationLabel}</td>
      <td>${u.pageLoad ? `${msLabel(u.pageLoad.ttfbMs)} / ${msLabel(u.pageLoad.domReadyMs)} / ${msLabel(u.pageLoad.fullyLoadedMs)}` : "—"}</td>
      <td>${msLabel(u.avgLoginNavMs)}</td>
      <td class="${u.avgLoginApiMs > TEST_CONFIG.SLA_THRESHOLDS_MS.LOGIN_API ? "cell-warn" : ""}">${msLabel(u.avgLoginApiMs)}</td>
      <td>${msLabel(u.avgLoginNextauthMs)}</td>
      <td>${msLabel(u.avgLoginRedirectMs)}</td>
      <td class="${u.avgAccordionInteractionMs > TEST_CONFIG.SLA_THRESHOLDS_MS.ACCORDION_INTERACTION ? "cell-warn" : ""}">${msLabel(u.avgAccordionInteractionMs)}</td>
      <td class="${u.avgTasksApiMs > TEST_CONFIG.SLA_THRESHOLDS_MS.TASKS_API ? "cell-warn" : ""}">${msLabel(u.avgTasksApiMs)} <small>${msLabel(u.p50TasksApiMs)}/${msLabel(u.p90TasksApiMs)}</small></td>
      <td>${u.successRates.accordion.toFixed(1)}%</td>
      <td>${u.errors.length} / ${u.retryCount}</td>
      <td>${u.traceFile ? `<code class="trace">${path.basename(u.traceFile)}</code>` : "—"}</td>
    </tr>`,
    )
    .join("");

  const errRows = stats.users
    .flatMap((u) =>
      u.errors.map(
        (e) => `
    <tr>
      <td>${u.email}</td>
      <td>${e.timestamp.split("T")[1].slice(0, 8)}</td>
      <td><span class="badge cat-${e.category.toLowerCase()}">${e.category}</span></td>
      <td>${e.phase}</td>
      <td>${e.isFatal ? "💥 Fatal" : "⚠️ Recup."}</td>
      <td class="msg">${e.message.slice(0, 180)}</td>
    </tr>`,
      ),
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>Stress Test v3 — ${stats.runAt}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg:        #0f1117;
    --surface:   #1a1d27;
    --surface2:  #22263a;
    --border:    #2e3354;
    --text:      #e2e8f0;
    --muted:     #64748b;
    --accent:    #38bdf8;
    --green:     #4ade80;
    --yellow:    #fbbf24;
    --red:       #f87171;
    --purple:    #a78bfa;
    --font:      'IBM Plex Sans', sans-serif;
    --mono:      'IBM Plex Mono', monospace;
  }

  body { font-family: var(--font); background: var(--bg); color: var(--text); padding: 32px 40px; line-height: 1.6; }
  h1 { font-size: 26px; font-weight: 700; color: var(--accent); letter-spacing: -0.5px; }
  h2 { font-size: 16px; font-weight: 600; color: var(--accent); border-bottom: 1px solid var(--border); padding-bottom: 8px; margin: 36px 0 16px; text-transform: uppercase; letter-spacing: 1px; }
  p.meta { color: var(--muted); font-family: var(--mono); font-size: 12px; margin: 6px 0 28px; }

  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; margin-bottom: 32px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px 18px; }
  .card .v { font-family: var(--mono); font-size: 28px; font-weight: 700; color: var(--accent); }
  .card .l { font-size: 11px; color: var(--muted); margin-top: 4px; }
  .card.warn .v { color: var(--yellow); }
  .card.danger .v { color: var(--red); }
  .card.ok .v { color: var(--green); }

  .insight-box { background: var(--surface); border-left: 3px solid var(--accent); border-radius: 0 8px 8px 0; padding: 14px 18px; margin: 16px 0 24px; font-size: 13px; color: var(--muted); }
  .insight-box strong { color: var(--text); }

  table { width: 100%; border-collapse: collapse; background: var(--surface); border-radius: 10px; overflow: hidden; margin-bottom: 28px; font-size: 12.5px; }
  th { background: var(--surface2); color: var(--muted); font-family: var(--mono); font-size: 11px; font-weight: 600; padding: 10px 14px; text-align: left; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid var(--border); }
  td { padding: 9px 14px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: var(--surface2); }
  tr.row-ok td:first-child { border-left: 3px solid var(--green); }
  tr.row-warn td:first-child { border-left: 3px solid var(--yellow); }
  tr.row-fail td:first-child { border-left: 3px solid var(--red); }
  .cell-warn { color: var(--yellow); font-weight: 600; }

  .badge { display: inline-block; padding: 2px 8px; border-radius: 6px; font-family: var(--mono); font-size: 10px; font-weight: 600; }
  .badge.ok { background: #14532d; color: var(--green); }
  .badge.warn { background: #451a03; color: var(--yellow); }
  .cat-timeout { background: #450a0a; color: var(--red); }
  .cat-selector_not_found { background: #431407; color: #fb923c; }
  .cat-navigation { background: #2e1065; color: var(--purple); }
  .cat-auth { background: #4a044e; color: #e879f9; }
  .cat-network { background: #0c4a6e; color: var(--accent); }
  .cat-unknown { background: #1e293b; color: var(--muted); }

  .source-api { background: #0c4a6e; color: var(--accent); display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 10px; font-family: var(--mono); margin-left: 4px; }
  .source-ui  { background: #14532d; color: var(--green); display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 10px; font-family: var(--mono); margin-left: 4px; }
  .login_api, .login-api     { background: #0c4a6e; color: var(--accent); }
  .tasks_sent_api, .tasks-sent-api { background: #14532d; color: var(--green); }
  .refresh_api, .refresh-api { background: #1e293b; color: var(--muted); }
  .tasks_filter_api, .tasks-filter-api { background: #2e1065; color: var(--purple); }

  .bar-container { display: flex; align-items: center; gap: 10px; }
  .bar { height: 8px; background: var(--accent); border-radius: 4px; transition: width 0.3s; min-width: 2px; }
  .bar.api { background: var(--yellow); }
  .bar.ui  { background: var(--green); }

  .msg { max-width: 260px; word-break: break-all; font-family: var(--mono); font-size: 10px; color: var(--muted); }
  .trace { font-family: var(--mono); font-size: 10px; color: var(--yellow); background: #451a03; padding: 2px 6px; border-radius: 4px; }

  footer { color: var(--muted); font-size: 11px; margin-top: 48px; border-top: 1px solid var(--border); padding-top: 20px; }
  footer strong { color: var(--text); }

  small { color: var(--muted); font-family: var(--mono); font-size: 10px; }
</style>
</head>
<body>

<h1>📊 Stress Test v3 — Informe de Rendimiento</h1>
<p class="meta">Ejecutado: ${stats.runAt} · Usuarios: ${stats.totalUsers} · Duración sesión: ${formatTime(TEST_CONFIG.SESSION_DURATION_MS)}</p>

<div class="grid">
  <div class="card ${stats.successfulLogins === stats.totalUsers ? "ok" : "danger"}">
    <div class="v">${stats.successfulLogins}/${stats.totalUsers}</div>
    <div class="l">Logins exitosos</div>
  </div>
  <div class="card">
    <div class="v">${stats.totalAccordion}</div>
    <div class="l">Acordeones totales</div>
  </div>
  <div class="card ${stats.totalErrors > 0 ? "danger" : "ok"}">
    <div class="v">${stats.totalErrors}</div>
    <div class="l">Errores registrados</div>
  </div>
  <div class="card ${stats.totalRetries > 0 ? "warn" : "ok"}">
    <div class="v">${stats.totalRetries}</div>
    <div class="l">Reintentos</div>
  </div>
  <div class="card ${g.avgLoginApiMs > TEST_CONFIG.SLA_THRESHOLDS_MS.LOGIN_API ? "warn" : "ok"}">
    <div class="v">${msLabel(g.avgLoginApiMs)}</div>
    <div class="l">Login API avg</div>
  </div>
  <div class="card ${g.avgTasksApiMs > TEST_CONFIG.SLA_THRESHOLDS_MS.TASKS_API ? "warn" : "ok"}">
    <div class="v">${msLabel(g.avgTasksApiMs)}</div>
    <div class="l">Tasks API avg</div>
  </div>
  <div class="card ${g.avgAccordionInteractionMs > TEST_CONFIG.SLA_THRESHOLDS_MS.ACCORDION_INTERACTION ? "warn" : "ok"}">
    <div class="v">${msLabel(g.avgAccordionInteractionMs)}</div>
    <div class="l">Acordeón UI avg</div>
  </div>
</div>

<div class="insight-box">
  <strong>¿Cómo leer este reporte?</strong><br>
  • <strong>Login API</strong> = POST /login medido en la red → refleja el backend puro.<br>
  • <strong>Accordion UI</strong> = click + aria-expanded, sin tiempo de espera → refleja el frontend puro.<br>
  • <strong>Tasks API</strong> = POST /messagesdays-sent medido en la red → refleja el backend del acordeón.<br>
  Si <em>Accordion UI</em> baja pero <em>Tasks API</em> no: el cuello de botella está en el <strong>backend</strong>.<br>
  Si <em>Tasks API</em> baja pero <em>Accordion UI</em> no: el cuello de botella está en el <strong>frontend / re-renders</strong>.
</div>

<h2>🔐 Login — Desglose por Fase</h2>
<table>
  <tr><th>Fase</th><th>AVG</th><th>p50 / p90 / p95</th><th>SLA</th><th>Estado</th></tr>
  ${slaRow("LOGIN_NAV — Navegación a /auth/signin", g.avgLoginNavMs, TEST_CONFIG.SLA_THRESHOLDS_MS.LOGIN_NAV)}
  ${slaRow("LOGIN_API — POST /login", g.avgLoginApiMs, TEST_CONFIG.SLA_THRESHOLDS_MS.LOGIN_API, g.p50LoginApiMs, g.p90LoginApiMs, g.p95LoginApiMs, true)}
  ${slaRow("LOGIN_NEXTAUTH — Handshake credentials", g.avgLoginNextauthMs, TEST_CONFIG.SLA_THRESHOLDS_MS.LOGIN_NEXTAUTH)}
  ${slaRow("LOGIN_REDIRECT — URL post-login", g.avgLoginRedirectMs, TEST_CONFIG.SLA_THRESHOLDS_MS.LOGIN_REDIRECT)}
</table>

<h2>🎡 Acordeón — Desglose UI vs API</h2>
<table>
  <tr><th>Operación</th><th>AVG</th><th>p50 / p90 / p95</th><th>SLA</th><th>Estado</th></tr>
  ${slaRow("ACCORDION_INTERACTION — Click + aria-expanded", g.avgAccordionInteractionMs, TEST_CONFIG.SLA_THRESHOLDS_MS.ACCORDION_INTERACTION, g.p50AccordionInteractionMs, g.p90AccordionInteractionMs, g.p95AccordionInteractionMs)}
  ${slaRow("TASKS_SENT_API — POST /messagesdays-sent", g.avgTasksApiMs, TEST_CONFIG.SLA_THRESHOLDS_MS.TASKS_API, g.p50TasksApiMs, g.p90TasksApiMs, g.p95TasksApiMs, true)}
</table>

<h2>👥 Detalle por Usuario</h2>
<table>
  <tr>
    <th>Email</th><th>Estado</th><th>Acord.</th><th>Duración</th>
    <th>Page Load (TTFB/DOM/Full)</th>
    <th>Login Nav</th><th>Login API</th><th>Login Auth</th><th>Login Redir</th>
    <th>Acord. UI</th><th>Tasks API (avg/p50/p90)</th>
    <th>% Éxito</th><th>Err/Ret</th><th>Traza</th>
  </tr>
  ${userRows}
</table>

<h2>📡 Llamadas API Interceptadas</h2>
<table>
  <tr><th>Usuario</th><th>Endpoint</th><th>Método</th><th>Status</th><th>Duración</th><th>Tamaño</th><th>Hora</th></tr>
  ${apiRows || "<tr><td colspan='7' style='text-align:center;color:var(--muted)'>Sin llamadas interceptadas</td></tr>"}
</table>

${
  stats.totalErrors > 0
    ? `
<h2>🐛 Errores Detectados</h2>
<table>
  <tr><th>Usuario</th><th>Hora</th><th>Categoría</th><th>Fase</th><th>Severidad</th><th>Mensaje</th></tr>
  ${errRows}
</table>`
    : "<h2>✅ Sin Errores</h2><p style='color:var(--green);margin-bottom:24px'>No se registraron errores durante el test.</p>"
}

<footer>
  <strong>Stress Test v3</strong> — Mejoras respecto a v2:<br>
  • Login desglosado en 4 fases: nav, API, NextAuth, redirect<br>
  • Accordion medido solo en interacción UI (sin tiempo de espera)<br>
  • Intercepción de red: mide duración y status HTTP de cada API<br>
  • Detección automática de regresiones por SLA por fase individual
</footer>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────────

test.describe("Stress Test v3: Sesiones Activas — Medición UI + API", () => {
  test(`${TEST_CONFIG.USEREXCONGENERAL_COUNT} usuarios · sesión ${TEST_CONFIG.SESSION_DURATION_MS / 60_000} min · login+accordion desglosado`, async ({
    browser,
  }) => {
    test.setTimeout(TEST_CONFIG.TIMEOUTS.TEST);

    const users = generateUsers(TEST_CONFIG.USEREXCONGENERAL_COUNT);

    logSep();
    console.log("🚀  STRESS TEST v3 — INICIANDO");
    logSep();
    console.log("⚙️  CONFIGURACIÓN:");
    console.log(`    ├─ Usuarios:                ${users.length}`);
    console.log(
      `    ├─ Duración sesión:         ${formatTime(TEST_CONFIG.SESSION_DURATION_MS)}`,
    );
    console.log(
      `    ├─ Intervalos de espera:    ${TEST_CONFIG.ACCORDION_WAIT_INTERVALS_MS.map(msLabel).join(" → ")}`,
    );
    console.log(
      `    ├─ Índice acordeón:         ${TEST_CONFIG.ACCORDION_INDEX}`,
    );
    console.log(
      `    ├─ Intercepción de red:     ✅ (login, refresh, tasks-sent)`,
    );
    console.log(`    ├─ Trace → solo en error:   ✅ (retain-on-failure)`);
    console.log(
      `    ├─ SLA Login API:           ${msLabel(TEST_CONFIG.SLA_THRESHOLDS_MS.LOGIN_API)}`,
    );
    console.log(
      `    ├─ SLA Accordion UI:        ${msLabel(TEST_CONFIG.SLA_THRESHOLDS_MS.ACCORDION_INTERACTION)}`,
    );
    console.log(
      `    └─ SLA Tasks API:           ${msLabel(TEST_CONFIG.SLA_THRESHOLDS_MS.TASKS_API)}`,
    );
    logSep();

    const sessions: UserSession[] = [];

    try {
      for (const user of users) {
        const context = await browser.newContext({
          viewport: { width: 1280, height: 720 },
        });
        sessions.push({
          user,
          context,
          page: await context.newPage(),
          startTime: Date.now(),
          accordionCount: 0,
          loginSuccess: false,
          hadError: false,
          timings: [],
          apiCalls: [],
          errors: [],
          accordionIntervalIndex: 0,
          retryCount: 0,
        });
        logUserAction(user.email, "Contexto creado", "success");
      }

      logSep();
      console.log("🔄  EJECUTANDO SESIONES EN PARALELO:");
      logSep();

      const results = await Promise.allSettled(
        sessions.map((s) => maintainUserSession(s)),
      );

      logSep();
      console.log("📊  RESULTADO POR SESIÓN:");
      results.forEach((r, i) => {
        const { email } = sessions[i].user;
        const { accordionCount, errors, apiCalls } = sessions[i];
        if (r.status === "fulfilled") {
          console.log(
            `    ✅ ${email.padEnd(45)} → ${accordionCount} acordeón(es) | ${errors.length} error(es) | ${apiCalls.length} API call(s)`,
          );
        } else {
          console.log(`    ❌ ${email.padEnd(45)} → FATAL: ${r.reason}`);
        }
      });

      const stats = buildStats(sessions);
      printReport(stats);
    } finally {
      logSep();
      console.log("🧹  CERRANDO RECURSOS:");
      for (const s of sessions) {
        await s.context.close();
        logUserAction(s.user.email, "Contexto cerrado", "info");
      }
      logSep();
      console.log("✨  TEST v3 COMPLETADO");
      logSep();
    }
  });
});
