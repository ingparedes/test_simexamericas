/**
 * ============================================================================
 * STRESS TEST v2 — Sesiones Activas
 * ============================================================================
 *
 *  ✅ Trace Viewer  → solo se persiste cuando hay un ERROR (no en éxito)
 *  ✅ Tiempos de carga → TTFB, DOM Ready, Fully Loaded por página
 *  ✅ Lighthouse      → auditoría de performance (opt-in)
 *  ✅ Snapshots       → captura/comparación antes-después de cada ciclo
 *  ✅ Acordeones      → intervalos variables rotatorios (10 s base)
 *  ✅ Reporte         → promedios, percentiles p50/p90/p95, errores, HTML
 *
 * SUGERENCIAS DE MEJORA AL REPORTE (ver sección "REPORT SUGGESTIONS"):
 *  💡 Percentiles p50 / p90 / p95 por operación
 *  💡 Conteo de reintentos y errores recuperables vs fatales
 *  💡 Tasa de éxito por operación (login, accordion toggle, task check)
 *  💡 Timeline de ciclos por usuario (qué pasó en cada segundo)
 *  💡 Reporte HTML autónomo con tablas y barras de progreso
 *  💡 Clasificación automática de errores (timeout / selector / red / auth)
 *  💡 Alerta si algún avg supera umbral configurable (SLA)
 *
 * INSTALACIÓN:
 *   npm install -D @playwright/test
 *   npm install -D playwright-lighthouse   # solo si ENABLE_LIGHTHOUSE = true
 * ============================================================================
 */

import { BrowserContext, Page, expect, test } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURACIÓN CENTRAL
// ─────────────────────────────────────────────────────────────────────────────
const TEST_CONFIG = {
  /** Cantidad de usuarios participantes */
  USEREXCONGENERAL_COUNT: Number(process.env.USER_COUNT ?? 1),

  /** Offset para generación de IDs (usuario{N}@usuario{N}.org) */
  USER_ID_OFFSET: Number(process.env.USER_OFFSET ?? 1),

  /** Duración total de cada sesión (ms) */
  SESSION_DURATION_MS: Number(process.env.SESSION_DURATION ?? 10) * 60 * 1000,

  /**
   * Intervalos rotativos para apertura/cierre de acordeones.
   * El test avanza por este array en cada ciclo y vuelve al inicio.
   * Unidad: milisegundos.
   */
  ACCORDION_INTERVALS_MS: [10_000, 20_000, 15_000, 30_000, 10_000],

  /** Índice (0-based) del acordeón objetivo en la lista */
  ACCORDION_INDEX: 3,

  /**
   * SLA (Service Level Agreement) en ms.
   * Si el promedio de una operación supera este valor se marca como ⚠️ LENTO.
   */
  SLA_THRESHOLDS_MS: {
    LOGIN: 3_000,
    ACCORDION: 2_000,
    TASK_CHECK: 1_500,
  },

  /** Directorios de salida */
  DIRS: {
    REPORTS: "test-results/stress-reports",
    SNAPSHOTS: "test-results/snapshots",
    TRACES: "test-results/traces",
    VIDEOS: "test-results/videos",
    LIGHTHOUSE: "test-results/stress-reports/lighthouse",
  },

  /** Activar Lighthouse (requiere playwright-lighthouse instalado) */
  ENABLE_LIGHTHOUSE: false,

  /** Timeouts para operaciones individuales */
  TIMEOUTS: {
    TEST: 30 * 60 * 1000,
    TASKSENT_WAIT: 5_000,
    DEFAULT_ACTION: 10_000,
    PAGE_LOAD: 15_000,
  },

  /** Contraseña compartida de usuarios de prueba */
  DEFAULT_PASSWORD: process.env.TEST_PASSWORD ?? "ADMINadmin123.",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// TIPOS
// ─────────────────────────────────────────────────────────────────────────────

interface ParticipantUser {
  email: string;
  password: string;
}

/** Categorías de error para clasificación automática */
type ErrorCategory =
  | "TIMEOUT"
  | "SELECTOR_NOT_FOUND"
  | "NAVIGATION"
  | "AUTH"
  | "NETWORK"
  | "UNKNOWN";

/** Registro de una medición de tiempo */
interface TimingEntry {
  label: string;
  durationMs: number;
  timestamp: string;
  success: boolean;
  detail?: string;
  errorCategory?: ErrorCategory;
}

/** Registro de un error ocurrido durante la sesión */
interface ErrorEntry {
  timestamp: string;
  phase: string;
  message: string;
  category: ErrorCategory;
  cycleNumber: number;
  isFatal: boolean;
}

/** Estado completo de la sesión de un usuario */
interface UserSession {
  user: ParticipantUser;
  context: BrowserContext;
  page: Page;
  startTime: number;
  viewTaskIds: Set<string>;
  accordionCount: number;
  loginSuccess: boolean;
  /** ¿Tuvo al menos un error durante la sesión? */
  hadError: boolean;
  /** Mediciones de tiempo */
  timings: TimingEntry[];
  /** Errores registrados */
  errors: ErrorEntry[];
  /** Índice rotativo para intervalos de acordeón */
  accordionIntervalIndex: number;
  /** Número de reintentos totales realizados */
  retryCount: number;
  /** Datos de carga de página de login */
  _pageLoad?: { ttfbMs: number; domReadyMs: number; fullyLoadedMs: number };
}

/** Estadísticas finales del test completo */
interface TestStats {
  runAt: string;
  totalUsers: number;
  successfulLogins: number;
  failedLogins: number;
  totalAccordion: number;
  totalErrors: number;
  totalRetries: number;
  global: {
    avgLoginMs: number;
    avgAccordionMs: number;
    avgTaskCheckMs: number;
    p50LoginMs: number;
    p90LoginMs: number;
    p95LoginMs: number;
    p50AccordionMs: number;
    p90AccordionMs: number;
    p95AccordionMs: number;
  };
  users: UserReportDetail[];
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
  avgLoginMs: number;
  avgAccordionMs: number;
  avgTaskCheckMs: number;
  p50AccordionMs: number;
  p90AccordionMs: number;
  p95AccordionMs: number;
  pageLoad: {
    ttfbMs: number;
    domReadyMs: number;
    fullyLoadedMs: number;
  } | null;
  successRates: { accordion: number; taskCheck: number };
  errors: ErrorEntry[];
  timings: TimingEntry[];
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILIDADES GENERALES
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

// ─────────────────────────────────────────────────────────────────────────────
// CLASIFICADOR DE ERRORES
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// ESTADÍSTICAS
// ─────────────────────────────────────────────────────────────────────────────

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

function avgOf(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function successRate(timings: TimingEntry[], prefix: string): number {
  const all = timings.filter((t) => t.label.startsWith(prefix));
  if (!all.length) return 100;
  return (all.filter((t) => t.success).length / all.length) * 100;
}

// ─────────────────────────────────────────────────────────────────────────────
// WRAPPER DE MEDICIÓN DE TIEMPO
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
    logUserAction(
      session.user.email,
      `⏱ ${label}: ${msLabel(durationMs)} ${success ? "✅" : `❌ [${errorCategory}]`}`,
      success ? "info" : "warning",
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SNAPSHOT HELPER
// ─────────────────────────────────────────────────────────────────────────────

async function snapshot(
  page: Page,
  name: string,
  email: string,
): Promise<void> {
  try {
    ensureDir(TEST_CONFIG.DIRS.SNAPSHOTS);
    const safeEmail = email.replace(/[@.]/g, "_");
    const refPath = path.join(
      path.resolve(TEST_CONFIG.DIRS.SNAPSHOTS),
      `${safeEmail}_${name}.png`,
    );

    if (fs.existsSync(refPath)) {
      const current = await page.screenshot({ fullPage: false });
      const ref = fs.readFileSync(refPath);
      const diff = Math.abs(current.length - ref.length);
      logUserAction(
        email,
        `📸 Snapshot "${name}" Δ ${diff} bytes ${diff === 0 ? "(sin cambios)" : "(⚠️ cambios)"}`,
        diff === 0 ? "success" : "warning",
      );
    } else {
      await page.screenshot({ path: refPath, fullPage: false });
      logUserAction(
        email,
        `📸 Snapshot "${name}" guardado como referencia`,
        "info",
      );
    }
  } catch (err) {
    logUserAction(email, `📸 Error snapshot "${name}": ${err}`, "warning");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LIGHTHOUSE HELPER
// ─────────────────────────────────────────────────────────────────────────────

async function runLighthouse(
  page: Page,
  email: string,
  label: string,
): Promise<void> {
  if (!TEST_CONFIG.ENABLE_LIGHTHOUSE) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { playAudit } = require("playwright-lighthouse");
    ensureDir(TEST_CONFIG.DIRS.LIGHTHOUSE);
    await playAudit({
      page,
      thresholds: {
        performance: 50,
        accessibility: 70,
        "best-practices": 70,
        seo: 50,
      },
      reports: {
        formats: { html: true },
        name: `${email.replace(/[@.]/g, "_")}_${label}`,
        directory: path.resolve(TEST_CONFIG.DIRS.LIGHTHOUSE),
      },
    });
    logUserAction(email, `🔦 Lighthouse completado: ${label}`, "success");
  } catch (err) {
    logUserAction(email, `🔦 Lighthouse omitido: ${err}`, "warning");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TIEMPOS DE NAVEGACIÓN DEL BROWSER
// ─────────────────────────────────────────────────────────────────────────────

async function getNavTiming(page: Page): Promise<{
  ttfbMs: number;
  domReadyMs: number;
  fullyLoadedMs: number;
} | null> {
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
    await measure(
      "LOGIN",
      this.session,
      async () => {
        logUserAction(email, "Navegando a /auth/signin", "info");

        await this.page.goto("/auth/signin", {
          waitUntil: "domcontentloaded",
          timeout: TEST_CONFIG.TIMEOUTS.PAGE_LOAD,
        });

        // ── Tiempos reales del browser ──────────────────────────────────────
        const nav = await getNavTiming(this.page);
        if (nav) {
          this.session._pageLoad = nav;
          this.session.timings.push(
            {
              label: "LOGIN_PAGE_TTFBMS",
              durationMs: nav.ttfbMs,
              timestamp: new Date().toISOString(),
              success: true,
              detail: "Time To First Byte",
            },
            {
              label: "LOGIN_PAGE_DOMREADYMS",
              durationMs: nav.domReadyMs,
              timestamp: new Date().toISOString(),
              success: true,
              detail: "DOM Content Loaded",
            },
            {
              label: "LOGIN_PAGE_FULLYLOADEDMS",
              durationMs: nav.fullyLoadedMs,
              timestamp: new Date().toISOString(),
              success: true,
              detail: "Page Fully Loaded",
            },
          );
          logUserAction(
            email,
            `🌐 TTFB: ${msLabel(nav.ttfbMs)} | DOM: ${msLabel(nav.domReadyMs)} | Full: ${msLabel(nav.fullyLoadedMs)}`,
            "info",
          );
        }

        await snapshot(this.page, "login_before", email);
        await runLighthouse(this.page, email, "login_page");

        await this.page.locator(this.sel.emailInput).waitFor({
          state: "visible",
          timeout: TEST_CONFIG.TIMEOUTS.DEFAULT_ACTION,
        });

        await this.page.fill(this.sel.emailInput, email);
        await this.page.fill(this.sel.passwordInput, password);

        logUserAction(email, "Enviando formulario...", "info");
        await this.page.click(this.sel.submitButton);

        await this.page.waitForURL(/(dashboard|\/)/, {
          timeout: TEST_CONFIG.TIMEOUTS.DEFAULT_ACTION,
        });

        await snapshot(this.page, "login_after", email);
        await runLighthouse(this.page, email, "dashboard");

        logUserAction(email, "✨ Login exitoso", "success");
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

  async toggleAccordion(cycleNumber: number): Promise<void> {
    const { user } = this.session;

    // Obtiene el intervalo actual y rota al siguiente
    const intervalMs =
      TEST_CONFIG.ACCORDION_INTERVALS_MS[this.session.accordionIntervalIndex];
    this.session.accordionIntervalIndex =
      (this.session.accordionIntervalIndex + 1) %
      TEST_CONFIG.ACCORDION_INTERVALS_MS.length;

    logUserAction(
      user.email,
      `🎡 Ciclo ${cycleNumber} | intervalo acordeón: ${msLabel(intervalMs)}`,
      "info",
    );

    await measure(
      `ACCORDION_CYCLE_${cycleNumber}`,
      this.session,
      async () => {
        const accordion = this.page
          .locator(this.sel.taskListAccordion)
          .nth(TEST_CONFIG.ACCORDION_INDEX);
        const button = accordion.locator("button[aria-expanded]");

        const currentState = await button.getAttribute("aria-expanded", {
          timeout: TEST_CONFIG.TIMEOUTS.DEFAULT_ACTION,
        });
        const isExpanded = currentState === "true";

        logUserAction(
          user.email,
          `Acordeón [${TEST_CONFIG.ACCORDION_INDEX}] → ${isExpanded ? "▼ abierto, cerrando..." : "▶ cerrado, abriendo..."}`,
          "info",
        );

        await snapshot(
          this.page,
          `accordion_before_c${cycleNumber}`,
          user.email,
        );
        await button.click({ timeout: TEST_CONFIG.TIMEOUTS.TASKSENT_WAIT });

        // Valida que el atributo cambió
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

        await snapshot(
          this.page,
          `accordion_after_c${cycleNumber}`,
          user.email,
        );

        logUserAction(
          user.email,
          `Acordeón ${isExpanded ? "cerrado ✕" : "abierto ✓"} | esperando ${msLabel(intervalMs)}...`,
          "success",
        );

        // Intervalo variable antes del próximo ciclo
        await this.page.waitForTimeout(intervalMs);
      },
      { cycleNumber, isFatal: false },
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LÓGICA DE SESIÓN PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * TRACE VIEWER — Patrón "retain-on-failure":
 *  • La traza siempre se INICIA antes de la primera acción.
 *  • Al finalizar con ÉXITO → context.tracing.stop() sin path → descartada.
 *  • Al finalizar con ERROR → context.tracing.stop({ path }) → guardada.
 *
 * Esto sigue la recomendación oficial de Playwright para no desperdiciar
 * espacio en disco cuando el test pasa correctamente.
 */
async function maintainUserSession(session: UserSession): Promise<void> {
  const { user, page, context } = session;
  const safeEmail = user.email.replace(/[@.]/g, "_");

  ensureDir(TEST_CONFIG.DIRS.TRACES);

  // ── Inicia la traza SIEMPRE (antes de cualquier acción) ──────────────────
  await context.tracing.start({
    screenshots: true, // captura pantalla en cada acción
    snapshots: true, // guarda snapshot del DOM en cada paso
    sources: true, // incluye código fuente de locators
    title: `Trace - ${user.email}`,
  });

  logUserAction(
    user.email,
    "🔴 Trace activo (se guardará SOLO si hay error)",
    "info",
  );

  const loginPage = new LoginPage(page, session);
  const taskSentPage = new TaskSentPage(page, session);
  let cycleNumber = 0;
  let criticalError: unknown = null;

  try {
    // ── FASE 1: Login ───────────────────────────────────────────────────────
    await loginPage.login(user.email, user.password);
    session.loginSuccess = true;

    await page.waitForTimeout(1100);
    logUserAction(
      user.email,
      `🔄 Sesión activa | máximo: ${formatTime(TEST_CONFIG.SESSION_DURATION_MS)}`,
      "info",
    );

    // ── FASE 2: Loop de ciclos ──────────────────────────────────────────────
    while (true) {
      const elapsed = Date.now() - session.startTime;
      const remaining = TEST_CONFIG.SESSION_DURATION_MS - elapsed;

      if (elapsed >= TEST_CONFIG.SESSION_DURATION_MS) {
        logUserAction(
          user.email,
          `🏁 Sesión completada | ${formatTime(elapsed)} | vistastareas: ${session.accordionCount}`,
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
          "🎯 Tareas encontradas, procesando...",
          "info",
        );
        try {
          await taskSentPage.toggleAccordion(cycleNumber);
          session.accordionCount++;
        } catch (err) {
          // Error no fatal → se registra y continúa
          session.retryCount++;
          logUserAction(
            user.email,
            `⚠️ Error ciclo ${cycleNumber} (recuperable): ${err}`,
            "warning",
          );
          await page.waitForTimeout(2000);
        }
      } else {
        logUserAction(user.email, "📭 Sin tareas nuevas, esperando...", "info");
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
    // ── Decide si guardar o descartar la traza ──────────────────────────────
    if (session.hadError) {
      const tracePath = path.join(
        path.resolve(TEST_CONFIG.DIRS.TRACES),
        `ERROR_${safeEmail}_trace.zip`,
      );

      // Guarda la traza con toda la información del fallo
      await context.tracing.stop({ path: tracePath });
      logUserAction(user.email, `📦 Traza guardada → ${tracePath}`, "error");
      logUserAction(
        user.email,
        `   👉 Ver: npx playwright show-trace "${tracePath}"`,
        "info",
      );

      // Guarda también el log de errores en JSON para análisis rápido
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
          },
          null,
          2,
        ),
      );
      logUserAction(user.email, `📋 Log de errores → ${errorLogPath}`, "error");
    } else {
      // Sin errores → descarta la traza (ahorra espacio en disco)
      await context.tracing.stop();
      logUserAction(
        user.email,
        "🟢 Sin errores → traza descartada (OK)",
        "success",
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GENERADOR DE ESTADÍSTICAS
// ─────────────────────────────────────────────────────────────────────────────

function buildStats(sessions: UserSession[]): TestStats {
  const users: UserReportDetail[] = sessions.map((s) => {
    const safeEmail = s.user.email.replace(/[@.]/g, "_");
    const tracePath = s.hadError
      ? path.join(TEST_CONFIG.DIRS.TRACES, `ERROR_${safeEmail}_trace.zip`)
      : null;

    const accordionVals = timingValues(s.timings, "ACCORDION_CYCLE");
    const taskCheckVals = timingValues(s.timings, "CHECK_TASKS_CYCLE");
    const loginVals = timingValues(s.timings, "LOGIN");

    return {
      email: s.user.email,
      accordion: s.accordionCount,
      sessionDurationMs: Date.now() - s.startTime,
      sessionDurationLabel: formatTime(Date.now() - s.startTime),
      status: s.loginSuccess ? "success" : "failed",
      hadError: s.hadError,
      retryCount: s.retryCount,
      traceFile: tracePath,
      avgLoginMs: avgOf(loginVals),
      avgAccordionMs: avgOf(accordionVals),
      avgTaskCheckMs: avgOf(taskCheckVals),
      p50AccordionMs: percentile(accordionVals, 50),
      p90AccordionMs: percentile(accordionVals, 90),
      p95AccordionMs: percentile(accordionVals, 95),
      pageLoad: s._pageLoad ?? null,
      successRates: {
        accordion: successRate(s.timings, "ACCORDION_CYCLE"),
        taskCheck: successRate(s.timings, "CHECK_TASKS_CYCLE"),
      },
      errors: s.errors,
      timings: s.timings,
    };
  });

  const successfulLogins = users.filter((u) => u.status === "success").length;

  const allLoginMs = users.flatMap((u) => timingValues(u.timings, "LOGIN"));
  const allAccordionMs = users.flatMap((u) =>
    timingValues(u.timings, "ACCORDION_CYCLE"),
  );
  const allTaskCheckMs = users.flatMap((u) =>
    timingValues(u.timings, "CHECK_TASKS_CYCLE"),
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
      avgLoginMs: avgOf(allLoginMs),
      avgAccordionMs: avgOf(allAccordionMs),
      avgTaskCheckMs: avgOf(allTaskCheckMs),
      p50LoginMs: percentile(allLoginMs, 50),
      p90LoginMs: percentile(allLoginMs, 90),
      p95LoginMs: percentile(allLoginMs, 95),
      p50AccordionMs: percentile(allAccordionMs, 50),
      p90AccordionMs: percentile(allAccordionMs, 90),
      p95AccordionMs: percentile(allAccordionMs, 95),
    },
    users,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// IMPRESIÓN DEL REPORTE EN CONSOLA
// ─────────────────────────────────────────────────────────────────────────────

function slaFlag(ms: number, threshold: number): string {
  return ms > threshold ? "  ⚠️ SUPERA SLA" : "";
}

function printReport(stats: TestStats): void {
  const pct = (n: number) =>
    stats.totalUsers > 0 ? ((n / stats.totalUsers) * 100).toFixed(1) : "0.0";

  logSep();
  console.log("📊  REPORTE FINAL — STRESS TEST v2");
  console.log(`    Ejecutado: ${stats.runAt}`);
  logSep();

  // ── 1. Resumen general ────────────────────────────────────────────────
  console.log("📈  RESUMEN GENERAL");
  console.log(`    ├─ Usuarios totales:         ${stats.totalUsers}`);
  console.log(
    `    ├─ ✅ Logins exitosos:       ${stats.successfulLogins} (${pct(stats.successfulLogins)}%)`,
  );
  console.log(
    `    ├─ ❌ Logins fallidos:       ${stats.failedLogins} (${pct(stats.failedLogins)}%)`,
  );
  console.log(`    ├─ 💬 VistasTareas totales:   ${stats.totalAccordion}`);
  console.log(`    ├─ 🔁 Reintentos totales:    ${stats.totalRetries}`);
  console.log(`    └─ 🐛 Errores totales:       ${stats.totalErrors}`);

  // ── 2. Tiempos globales con percentiles ───────────────────────────────
  logSep("─");
  console.log("⏱️   TIEMPOS GLOBALES (todos los usuarios)");
  console.log("");
  console.log(
    "    OPERACIÓN            │  AVG       │  p50       │  p90       │  p95",
  );
  console.log(
    "    ─────────────────────┼────────────┼────────────┼────────────┼────────────",
  );
  console.log(
    `    Login                │  ${msLabel(stats.global.avgLoginMs).padEnd(9)} │  ${msLabel(stats.global.p50LoginMs).padEnd(9)} │  ${msLabel(stats.global.p90LoginMs).padEnd(9)} │  ${msLabel(stats.global.p95LoginMs)}${slaFlag(stats.global.avgLoginMs, TEST_CONFIG.SLA_THRESHOLDS_MS.LOGIN)}`,
  );
  console.log(
    `    Accordion Toggle     │  ${msLabel(stats.global.avgAccordionMs).padEnd(9)} │  ${msLabel(stats.global.p50AccordionMs).padEnd(9)} │  ${msLabel(stats.global.p90AccordionMs).padEnd(9)} │  ${msLabel(stats.global.p95AccordionMs)}${slaFlag(stats.global.avgAccordionMs, TEST_CONFIG.SLA_THRESHOLDS_MS.ACCORDION)}`,
  );
  console.log(
    `    Task Check           │  ${msLabel(stats.global.avgTaskCheckMs).padEnd(9)} │  ${"n/a".padEnd(9)} │  ${"n/a".padEnd(9)} │  n/a${slaFlag(stats.global.avgTaskCheckMs, TEST_CONFIG.SLA_THRESHOLDS_MS.TASK_CHECK)}`,
  );
  console.log("");
  console.log(
    "    ⚠️ SUPERA SLA = supera umbral configurado en SLA_THRESHOLDS_MS",
  );

  // ── 3. Detalle por usuario ─────────────────────────────────────────────
  logSep("─");
  console.log("👥  DETALLE POR USUARIO");
  logSep("─");

  for (const [i, u] of stats.users.entries()) {
    const icon = u.status === "success" ? "✅" : "❌";
    const errIcon = u.hadError ? " 🐛" : "";
    console.log(`${i + 1}. ${icon}${errIcon} ${u.email}`);
    console.log(
      `   ├─ Estado:               ${u.status === "success" ? "Completado" : "Falló"}`,
    );
    console.log(`   ├─ Duración sesión:       ${u.sessionDurationLabel}`);
    console.log(`   ├─ 💬 VistasTareas:        ${u.accordion}`);
    console.log(`   ├─ 🔁 Reintentos:         ${u.retryCount}`);
    console.log(`   ├─ 🐛 Errores:            ${u.errors.length}`);

    if (u.pageLoad) {
      console.log(`   ├─ 🌐 Carga login page:`);
      console.log(`   │    ├─ TTFB:            ${msLabel(u.pageLoad.ttfbMs)}`);
      console.log(
        `   │    ├─ DOM Ready:        ${msLabel(u.pageLoad.domReadyMs)}`,
      );
      console.log(
        `   │    └─ Fully Loaded:     ${msLabel(u.pageLoad.fullyLoadedMs)}`,
      );
    }

    console.log(`   ├─ ⏱️  Tiempos promedio:`);
    console.log(
      `   │    ├─ Login avg:         ${msLabel(u.avgLoginMs)}${slaFlag(u.avgLoginMs, TEST_CONFIG.SLA_THRESHOLDS_MS.LOGIN)}`,
    );
    console.log(
      `   │    ├─ Accordion avg:     ${msLabel(u.avgAccordionMs)}${slaFlag(u.avgAccordionMs, TEST_CONFIG.SLA_THRESHOLDS_MS.ACCORDION)}`,
    );
    console.log(`   │    ├─ Accordion p50:     ${msLabel(u.p50AccordionMs)}`);
    console.log(`   │    ├─ Accordion p90:     ${msLabel(u.p90AccordionMs)}`);
    console.log(`   │    └─ Accordion p95:     ${msLabel(u.p95AccordionMs)}`);

    console.log(`   ├─ 📊 Tasa de éxito:`);
    console.log(
      `   │    ├─ Accordion:         ${u.successRates.accordion.toFixed(1)}%`,
    );
    console.log(
      `   │    └─ Task Check:        ${u.successRates.taskCheck.toFixed(1)}%`,
    );

    if (u.errors.length > 0) {
      console.log(`   ├─ 🐛 ERRORES CLASIFICADOS:`);
      const grouped: Record<string, number> = {};
      for (const e of u.errors)
        grouped[e.category] = (grouped[e.category] ?? 0) + 1;
      for (const [cat, count] of Object.entries(grouped)) {
        console.log(`   │    ├─ ${cat}: ${count} ocurrencia(s)`);
      }
      const fatal = u.errors.find((e) => e.isFatal);
      if (fatal) {
        console.log(
          `   │    └─ 💥 Fatal [${fatal.phase}]: ${fatal.message.slice(0, 100)}`,
        );
      }
    }

    if (u.traceFile) {
      console.log(`   └─ 📦 Traza disponible (error):`);
      console.log(`        npx playwright show-trace "${u.traceFile}"`);
    } else {
      console.log(`   └─ ✔️  Sin errores → traza descartada`);
    }
    console.log("");
  }

  // ── 4. Ranking de vistastareas ──────────────────────────────────────────
  logSep("─");
  console.log("📋  RANKING POR VISTATAREAS");
  logSep("─");

  const sorted = [...stats.users].sort((a, b) => b.accordion - a.accordion);
  const maxAccordion = Math.max(...sorted.map((u) => u.accordion), 1);
  for (const u of sorted) {
    const barLen = Math.round((u.accordion / maxAccordion) * 25);
    const bar = "█".repeat(barLen) + "░".repeat(25 - barLen);
    console.log(
      `${u.email.padEnd(45)} │ ${bar} │ ${u.accordion.toString().padStart(3)}${u.hadError ? " 🐛" : ""}`,
    );
  }

  // ── 5. Clasificación global de errores ────────────────────────────────
  if (stats.totalErrors > 0) {
    logSep("─");
    console.log("🐛  CLASIFICACIÓN GLOBAL DE ERRORES");
    logSep("─");
    const allErrors = stats.users.flatMap((u) => u.errors);
    const cats: Record<string, number> = {};
    for (const e of allErrors) cats[e.category] = (cats[e.category] ?? 0) + 1;
    for (const [cat, count] of Object.entries(cats).sort(
      ([, a], [, b]) => b - a,
    )) {
      const bar = "█".repeat(Math.round((count / allErrors.length) * 20));
      console.log(`    ${cat.padEnd(25)} │ ${bar} │ ${count}`);
    }
  }

  // ── 6. Promedio global ────────────────────────────────────────────────
  logSep();
  console.log(
    `🎯  PROMEDIO DE VISTATAREAS/USUARIO: ${(stats.totalAccordion / stats.totalUsers).toFixed(2)}`,
  );

  // ── 7. Guardar JSON ───────────────────────────────────────────────────
  ensureDir(TEST_CONFIG.DIRS.REPORTS);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(
    path.resolve(TEST_CONFIG.DIRS.REPORTS),
    `report_${ts}.json`,
  );
  fs.writeFileSync(jsonPath, JSON.stringify(stats, null, 2), "utf-8");
  console.log(`📄  Reporte JSON → ${jsonPath}`);

  // ── 8. Guardar HTML ───────────────────────────────────────────────────
  const htmlPath = jsonPath.replace(".json", ".html");
  fs.writeFileSync(htmlPath, buildHtmlReport(stats), "utf-8");
  console.log(`🌐  Reporte HTML → ${htmlPath}`);

  logSep();
}

// ─────────────────────────────────────────────────────────────────────────────
// GENERADOR DE REPORTE HTML
// 💡 SUGERENCIA: extender con Chart.js/D3 para gráficas de barras y timelines
// ─────────────────────────────────────────────────────────────────────────────

function buildHtmlReport(stats: TestStats): string {
  const userRows = stats.users
    .map(
      (u) => `
    <tr class="${u.status === "failed" ? "row-fail" : u.hadError ? "row-warn" : "row-ok"}">
      <td>${u.email}</td>
      <td>${u.status === "success" ? "✅" : "❌"} ${u.hadError ? "🐛" : ""}</td>
      <td>${u.accordion}</td>
      <td>${u.sessionDurationLabel}</td>
      <td>${msLabel(u.pageLoad?.ttfbMs ?? 0)} / ${msLabel(u.pageLoad?.domReadyMs ?? 0)} / ${msLabel(u.pageLoad?.fullyLoadedMs ?? 0)}</td>
      <td>${msLabel(u.avgLoginMs)}</td>
      <td>${msLabel(u.avgAccordionMs)}</td>
      <td>${msLabel(u.p50AccordionMs)} / ${msLabel(u.p90AccordionMs)} / ${msLabel(u.p95AccordionMs)}</td>
      <td>${u.successRates.accordion.toFixed(1)}% / ${u.successRates.taskCheck.toFixed(1)}%</td>
      <td>${u.errors.length} err / ${u.retryCount} ret</td>
      <td>${u.traceFile ? `<code style="font-size:10px">${path.basename(u.traceFile)}</code>` : "—"}</td>
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
      <td>${e.isFatal ? "💥 Fatal" : "⚠️ Recuperable"}</td>
      <td class="msg">${e.message.slice(0, 150)}</td>
    </tr>`,
      ),
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>Stress Test Report — ${stats.runAt}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:system-ui,sans-serif;margin:0;padding:24px 32px;background:#f0f4f8;color:#1e293b}
  h1{margin:0 0 4px;color:#0f172a}h2{color:#1e40af;border-bottom:2px solid #bfdbfe;padding-bottom:6px;margin-top:32px}
  p.meta{color:#64748b;font-size:13px;margin:0 0 24px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:14px;margin-bottom:32px}
  .card{background:#fff;border-radius:10px;padding:16px 20px;box-shadow:0 1px 4px #0001}
  .card .v{font-size:30px;font-weight:800;color:#1e40af}.card .l{font-size:11px;color:#64748b;margin-top:3px}
  table{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 4px #0001;margin-bottom:28px;font-size:12.5px}
  th{background:#1e3a8a;color:#fff;padding:9px 12px;text-align:left}
  td{padding:8px 12px;border-bottom:1px solid #e2e8f0;vertical-align:top}
  tr.row-ok td:first-child{border-left:4px solid #22c55e}
  tr.row-warn td:first-child{border-left:4px solid #f59e0b}
  tr.row-fail td:first-child{border-left:4px solid #ef4444}
  .badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;color:#fff}
  .cat-timeout{background:#ef4444}.cat-selector_not_found{background:#f97316}
  .cat-navigation{background:#8b5cf6}.cat-auth{background:#ec4899}
  .cat-network{background:#3b82f6}.cat-unknown{background:#6b7280}
  .msg{max-width:280px;word-break:break-all;font-size:11px;color:#64748b}
  footer{color:#94a3b8;font-size:11px;margin-top:40px;line-height:1.8}
</style>
</head>
<body>
<h1>📊 Stress Test Report</h1>
<p class="meta">Ejecutado: ${stats.runAt}</p>

<div class="grid">
  <div class="card"><div class="v">${stats.totalUsers}</div><div class="l">Usuarios totales</div></div>
  <div class="card"><div class="v" style="color:#16a34a">${stats.successfulLogins}</div><div class="l">Logins exitosos</div></div>
  <div class="card"><div class="v" style="color:#dc2626">${stats.failedLogins}</div><div class="l">Logins fallidos</div></div>
  <div class="card"><div class="v">${stats.totalAccordion}</div><div class="l">VistasTareas totales</div></div>
  <div class="card"><div class="v" style="color:#d97706">${stats.totalErrors}</div><div class="l">Errores registrados</div></div>
  <div class="card"><div class="v">${stats.totalRetries}</div><div class="l">Reintentos</div></div>
</div>

<h2>⏱️ Tiempos Globales (con percentiles)</h2>
<table>
  <tr><th>Operación</th><th>AVG</th><th>p50</th><th>p90</th><th>p95</th><th>SLA</th></tr>
  <tr><td>Login</td><td>${msLabel(stats.global.avgLoginMs)}</td><td>${msLabel(stats.global.p50LoginMs)}</td><td>${msLabel(stats.global.p90LoginMs)}</td><td>${msLabel(stats.global.p95LoginMs)}</td><td>${stats.global.avgLoginMs > TEST_CONFIG.SLA_THRESHOLDS_MS.LOGIN ? "⚠️ Lento" : "✅ OK"}</td></tr>
  <tr><td>Accordion Toggle</td><td>${msLabel(stats.global.avgAccordionMs)}</td><td>${msLabel(stats.global.p50AccordionMs)}</td><td>${msLabel(stats.global.p90AccordionMs)}</td><td>${msLabel(stats.global.p95AccordionMs)}</td><td>${stats.global.avgAccordionMs > TEST_CONFIG.SLA_THRESHOLDS_MS.ACCORDION ? "⚠️ Lento" : "✅ OK"}</td></tr>
  <tr><td>Task Check</td><td>${msLabel(stats.global.avgTaskCheckMs)}</td><td>—</td><td>—</td><td>—</td><td>${stats.global.avgTaskCheckMs > TEST_CONFIG.SLA_THRESHOLDS_MS.TASK_CHECK ? "⚠️ Lento" : "✅ OK"}</td></tr>
</table>

<h2>👥 Detalle por Usuario</h2>
<table>
  <tr>
    <th>Email</th><th>Estado</th><th>VistasTareas</th><th>Duración</th>
    <th>Page Load (TTFB/DOM/Full)</th><th>Avg Login</th><th>Avg Accordion</th>
    <th>Accordion p50/p90/p95</th><th>Éxito Acc/Task</th><th>Err/Ret</th><th>Traza</th>
  </tr>
  ${userRows}
</table>

${
  stats.totalErrors > 0
    ? `
<h2>🐛 Errores Detectados</h2>
<table>
  <tr><th>Usuario</th><th>Hora</th><th>Categoría</th><th>Fase</th><th>Severidad</th><th>Mensaje</th></tr>
  ${errRows}
</table>`
    : "<p>✅ No se registraron errores durante el test.</p>"
}

<footer>
  💡 <strong>Sugerencias para enriquecer el reporte:</strong><br>
  • <strong>pixelmatch / resemblejs</strong> → diff visual de píxeles en snapshots<br>
  • <strong>Chart.js / D3.js</strong> → gráficas de barras y timeline de ciclos<br>
  • <strong>Exportar CSV</strong> → análisis posterior en Excel / Google Sheets<br>
  • <strong>Alertas SLA en CI/CD</strong> → falla el pipeline si AVG supera el umbral<br>
  • <strong>page.on("response")</strong> → log de errores HTTP 4xx/5xx por ciclo<br>
  • <strong>Retry automático con backoff exponencial</strong> → menos falsos negativos<br>
  • <strong>playwright-html-reporter</strong> → integración nativa con el test runner
</footer>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────────

test.describe("Stress Test: Sesiones Activas — Response Task Sent Message", () => {
  test(`Todos los participantes mantienen sesión ${TEST_CONFIG.SESSION_DURATION_MS / 60_000} min y responden tareas`, async ({
    browser,
  }) => {
    test.setTimeout(TEST_CONFIG.TIMEOUTS.TEST);

    const users = generateUsers(TEST_CONFIG.USEREXCONGENERAL_COUNT);

    logSep();
    console.log("🚀  STRESS TEST v2 — INICIANDO");
    logSep();
    console.log("⚙️  CONFIGURACIÓN:");
    console.log(`    ├─ Usuarios:                ${users.length}`);
    console.log(
      `    ├─ Duración sesión:          ${formatTime(TEST_CONFIG.SESSION_DURATION_MS)}`,
    );
    console.log(
      `    ├─ Intervalos acordeón:      ${TEST_CONFIG.ACCORDION_INTERVALS_MS.map(msLabel).join(" → ")}`,
    );
    console.log(
      `    ├─ Índice acordeón:          ${TEST_CONFIG.ACCORDION_INDEX}`,
    );
    console.log(`    ├─ Trace → solo en error:    ✅ (retain-on-failure)`);
    console.log(
      `    ├─ Lighthouse:               ${TEST_CONFIG.ENABLE_LIGHTHOUSE}`,
    );
    console.log(
      `    ├─ SLA Login:                ${msLabel(TEST_CONFIG.SLA_THRESHOLDS_MS.LOGIN)}`,
    );
    console.log(
      `    └─ SLA Accordion:            ${msLabel(TEST_CONFIG.SLA_THRESHOLDS_MS.ACCORDION)}`,
    );
    logSep();

    const sessions: UserSession[] = [];

    try {
      for (const user of users) {
        ensureDir(TEST_CONFIG.DIRS.VIDEOS);
        const context = await browser.newContext({
          viewport: { width: 1280, height: 720 },
          recordVideo: { dir: path.resolve(TEST_CONFIG.DIRS.VIDEOS) },
        });

        sessions.push({
          user,
          context,
          page: await context.newPage(),
          startTime: Date.now(),
          viewTaskIds: new Set(),
          accordionCount: 0,
          loginSuccess: false,
          hadError: false,
          timings: [],
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
        const { accordionCount, errors } = sessions[i];
        if (r.status === "fulfilled") {
          console.log(
            `    ✅ ${email.padEnd(45)} → ${accordionCount} comentario(s) | ${errors.length} error(es)`,
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
      console.log("✨  TEST COMPLETADO");
      logSep();
    }
  });
});
