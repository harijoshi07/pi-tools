import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createSubscriptionAuthStorage, type SubscriptionAuthStatus } from "../auth.ts";
import type {
  SubscriptionProviderDefinition,
  SubscriptionProviderRuntimeState,
  SubscriptionUsageWindowDefinition,
} from "./types.ts";

const CURSOR_DASHBOARD_URL = "https://api2.cursor.sh";
const CURSOR_CLOUD_API_URL = "https://api.cursor.com";
const REQUEST_TIMEOUT_MS = 15_000;

interface CursorPlanUsage {
  totalSpend?: number;
  includedSpend?: number;
  bonusSpend?: number;
  limit?: number;
  remainingBonus?: boolean;
  autoPercentUsed?: number;
  apiPercentUsed?: number;
  totalPercentUsed?: number;
}

interface CursorSpendLimitUsage {
  pooledUsed?: number;
  individualUsed?: number;
  individualLimit?: number;
  limitType?: string;
}

interface CursorCurrentPeriodUsageResponse {
  billingCycleStart?: string | number;
  billingCycleEnd?: string | number;
  planUsage?: CursorPlanUsage;
  spendLimitUsage?: CursorSpendLimitUsage;
  displayThreshold?: number;
  enabled?: boolean;
  displayMessage?: string;
  autoModelSelectedDisplayMessage?: string;
  namedModelSelectedDisplayMessage?: string;
}

interface CursorPlanInfoDetails {
  planName?: string;
  price?: string;
  billingCycleEnd?: string | number;
  includedUsagePeriod?: string;
}

interface CursorPlanInfoResponse {
  planInfo?: CursorPlanInfoDetails;
}

interface CursorSandUsageStatusResponse {
  currentPeriodStart?: string;
  usagePercent?: number;
  hasAvailableUsage?: boolean;
  hasNonZeroIncludedLimit?: boolean;
  cursorPlanName?: string;
}

interface CursorV1MeResponse {
  apiKeyName?: string;
  userId?: number;
  userEmail?: string;
  userFirstName?: string;
  userLastName?: string;
  createdAt?: string;
}

function parseNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function formatPercent(percent: number | undefined): string {
  return `${Math.round(percent ?? 0)}%`;
}

function formatDollars(cents: number | undefined): string {
  const value = (cents ?? 0) / 100;
  return `$${value.toFixed(2)}`;
}

function parseDateish(value: unknown): Date | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value < 1e12 ? value * 1000 : value;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  if (typeof value === "string") {
    const num = Number(value);
    if (!Number.isNaN(num) && num > 0) {
      const millis = num < 1e12 ? num * 1000 : num;
      const date = new Date(millis);
      return Number.isNaN(date.getTime()) ? undefined : date;
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  return undefined;
}

function getCursorKeychainAccessToken(): string | undefined {
  if (process.platform !== "darwin") {
    return undefined;
  }

  try {
    const token = execFileSync(
      "security",
      ["find-generic-password", "-s", "cursor-access-token", "-a", "cursor-user", "-w"],
      { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();

    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

interface CursorCliConfigAuthInfo {
  email?: string;
  displayName?: string;
  teamName?: string;
  teamId?: number;
  userId?: number;
}

function readCursorCliConfig(): CursorCliConfigAuthInfo | undefined {
  const configPath = join(homedir(), ".cursor", "cli-config.json");
  if (!existsSync(configPath)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as { authInfo?: CursorCliConfigAuthInfo };
    return parsed.authInfo;
  } catch {
    return undefined;
  }
}

interface ResolvedCursorAuth {
  sessionToken?: string;
  apiKey?: string;
  authStatus: SubscriptionAuthStatus;
  authInfo?: CursorCliConfigAuthInfo;
}

async function resolveCursorAuth(): Promise<ResolvedCursorAuth | undefined> {
  const authStorage = createSubscriptionAuthStorage();
  const authStatus = authStorage.getAuthStatus("cursor");
  const storedCred = authStorage.get("cursor") as Record<string, unknown> | undefined;

  let sessionToken =
    process.env.CURSOR_ACCESS_TOKEN ||
    process.env.CURSOR_SESSION_TOKEN;

  if (!sessionToken) {
    sessionToken = getCursorKeychainAccessToken();
  }

  if (!sessionToken && storedCred && typeof storedCred === "object") {
    if (typeof storedCred.access === "string" && storedCred.access.length > 0) {
      sessionToken = storedCred.access;
    } else if (typeof storedCred.token === "string" && storedCred.token.length > 0) {
      sessionToken = storedCred.token;
    }
  }

  let apiKey =
    process.env.CURSOR_API_KEY ||
    (await authStorage.getApiKey("cursor"));

  if (storedCred && typeof storedCred === "object" && typeof storedCred.key === "string") {
    apiKey = storedCred.key;
  }

  const authInfo = readCursorCliConfig();

  if (!sessionToken && !apiKey) {
    return undefined;
  }

  return { sessionToken, apiKey, authStatus, authInfo };
}

async function callCursorDashboard<T>(method: string, token: string): Promise<T> {
  const response = await fetch(`${CURSOR_DASHBOARD_URL}/aiserver.v1.DashboardService/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
      "x-cursor-client-type": "cli",
    },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  return (await response.json()) as T;
}

function buildStatusLine(windows: SubscriptionUsageWindowDefinition[]): string {
  const primary = windows
    .filter((w) => w.usedPercent != null)
    .slice(0, 2)
    .map((w) => `${w.label} ${formatPercent(w.usedPercent)} used`);

  return primary.length > 0 ? primary.join(" • ") : "active";
}

export async function loadCursorRuntimeState(): Promise<SubscriptionProviderRuntimeState> {
  let auth: ResolvedCursorAuth | undefined;
  try {
    auth = await resolveCursorAuth();
  } catch (error) {
    return {
      state: "error",
      implementationStatus: "implemented",
      statusLine: "auth error",
      errorMessage: `Failed to resolve Cursor auth: ${error instanceof Error ? error.message : String(error)}`,
      usageWindows: [],
    };
  }

  if (!auth) {
    return {
      state: "error",
      implementationStatus: "implemented",
      statusLine: "auth missing",
      errorMessage: "No Cursor credentials found. Log in with Cursor CLI / macOS Keychain, or configure CURSOR_API_KEY / CURSOR_ACCESS_TOKEN.",
      authHint: "Supports Cursor CLI session token (macOS keychain) or CURSOR_API_KEY.",
      usageWindows: [],
    };
  }

  // Path 1: Session token available (Full plan usage, limits, and reset dates)
  if (auth.sessionToken) {
    try {
      const [usageRes, planRes, sandRes] = await Promise.allSettled([
        callCursorDashboard<CursorCurrentPeriodUsageResponse>("GetCurrentPeriodUsage", auth.sessionToken),
        callCursorDashboard<CursorPlanInfoResponse>("GetPlanInfo", auth.sessionToken),
        callCursorDashboard<CursorSandUsageStatusResponse>("GetSandUsageStatus", auth.sessionToken),
      ]);

      if (usageRes.status === "rejected") {
        throw usageRes.reason;
      }

      const usage = usageRes.value;
      const planInfo = planRes.status === "fulfilled" ? planRes.value.planInfo : undefined;
      const sand = sandRes.status === "fulfilled" ? sandRes.value : undefined;

      const resetAt = parseDateish(usage.billingCycleEnd);
      const startAt = parseDateish(usage.billingCycleStart);

      let pacePercent: number | undefined;
      if (resetAt && startAt) {
        const totalDuration = Math.max(1, resetAt.getTime() - startAt.getTime());
        const elapsed = Math.max(0, Date.now() - startAt.getTime());
        pacePercent = clampPercent((elapsed / totalDuration) * 100);
      }

      const plan = usage.planUsage;
      const usageWindows: SubscriptionUsageWindowDefinition[] = [];

      if (plan) {
        if (plan.totalPercentUsed != null) {
          const usedPct = clampPercent(plan.totalPercentUsed);
          const detail = plan.limit != null && plan.totalSpend != null
            ? `${formatDollars(plan.totalSpend)} / ${formatDollars(plan.limit)}${pacePercent != null ? ` • ${formatPercent(pacePercent)} elapsed` : ""}`
            : pacePercent != null ? `${formatPercent(pacePercent)} elapsed` : undefined;

          usageWindows.push({
            label: "Monthly Total",
            usedPercent: usedPct,
            detailLabel: detail,
            resetAt,
            pacePercent,
            notches: [25, 50, 75],
          });
        }

        if (plan.autoPercentUsed != null) {
          usageWindows.push({
            label: "Auto Models",
            usedPercent: clampPercent(plan.autoPercentUsed),
            detailLabel: `${formatPercent(plan.autoPercentUsed)} used${pacePercent != null ? ` • ${formatPercent(pacePercent)} elapsed` : ""}`,
            resetAt,
            pacePercent,
            notches: [25, 50, 75],
          });
        }

        if (plan.apiPercentUsed != null) {
          usageWindows.push({
            label: "API Models",
            usedPercent: clampPercent(plan.apiPercentUsed),
            detailLabel: `${formatPercent(plan.apiPercentUsed)} used${pacePercent != null ? ` • ${formatPercent(pacePercent)} elapsed` : ""}`,
            resetAt,
            pacePercent,
            notches: [25, 50, 75],
          });
        }
      }

      if (sand && sand.usagePercent != null) {
        const startDate = sand.currentPeriodStart ? parseDateish(sand.currentPeriodStart) : undefined;
        const sandReset = startDate ? new Date(startDate.getTime() + 24 * 60 * 60 * 1000) : undefined;
        usageWindows.push({
          label: "Daily / On-Demand",
          usedPercent: clampPercent(sand.usagePercent),
          detailLabel: sand.hasAvailableUsage ? "Available" : "Limit reached",
          resetAt: sandReset,
          notches: [50, 75, 90],
        });
      }

      const planName = planInfo?.planName || sand?.cursorPlanName || "Cursor";
      const notes: string[] = [
        `Plan: ${planName}${planInfo?.price ? ` (${planInfo.price})` : ""}`,
      ];

      if (auth.authInfo?.email) {
        notes.push(`Account: ${auth.authInfo.email}${auth.authInfo.teamName ? ` · Team: ${auth.authInfo.teamName}` : ""}`);
      }

      if (usage.spendLimitUsage?.limitType) {
        notes.push(`Spend Limit: ${usage.spendLimitUsage.limitType} type`);
      }

      return {
        state: "ready",
        implementationStatus: "implemented",
        statusLine: buildStatusLine(usageWindows),
        description: `Cursor ${planName} subscription usage and limits.`,
        authHint: "Session token from Cursor CLI / Keychain",
        usageHint: "Tracks monthly plan usage, auto/API model quotas, and daily limits.",
        notes,
        usageWindows,
        lastUpdatedAt: new Date(),
      };
    } catch (error) {
      // If dashboard call fails and we have an API key, fall through to Cloud API
      if (!auth.apiKey) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          state: "error",
          implementationStatus: "implemented",
          statusLine: "fetch failed",
          errorMessage: `Failed to load Cursor usage: ${message}`,
          usageWindows: [],
        };
      }
    }
  }

  // Path 2: API key available
  if (auth.apiKey) {
    try {
      const response = await fetch(`${CURSOR_CLOUD_API_URL}/v1/me`, {
        headers: { Authorization: `Bearer ${auth.apiKey}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`Cloud API HTTP ${response.status}`);
      }

      const me = (await response.json()) as CursorV1MeResponse;

      return {
        state: "ready",
        implementationStatus: "implemented",
        statusLine: `API Key: ${me.apiKeyName || "connected"}`,
        description: "Cursor Cloud Agent API key connected.",
        authHint: `Key: ${me.apiKeyName || "Active"} (${me.userEmail || "configured"})`,
        usageHint: "Cursor Cloud API active. Log into Cursor CLI to view detailed monthly plan usage.",
        notes: [
          `Key Name: ${me.apiKeyName || "unknown"}`,
          `User: ${me.userFirstName || ""} ${me.userLastName || ""} <${me.userEmail || ""}>`.trim(),
        ],
        usageWindows: [
          {
            label: "Cloud API",
            statusLabel: me.apiKeyName || "connected",
            detailLabel: me.userEmail || "Key active",
          },
        ],
        lastUpdatedAt: new Date(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        state: "error",
        implementationStatus: "implemented",
        statusLine: "api key error",
        errorMessage: `Failed to authenticate Cursor Cloud API key: ${message}`,
        usageWindows: [],
      };
    }
  }

  return {
    state: "error",
    implementationStatus: "implemented",
    statusLine: "unconfigured",
    errorMessage: "Unable to load Cursor subscription details.",
    usageWindows: [],
  };
}

export const cursorProvider: SubscriptionProviderDefinition = {
  id: "cursor",
  label: "Cursor",
  shortLabel: "Cursor",
  icon: "⚡",
  enabledByDefault: true,
  implementationStatus: "implemented",
  description: "Live Cursor subscription usage, monthly plan spending, and model quotas.",
  authHint: "Uses Cursor session login from macOS keychain or CURSOR_API_KEY.",
  usageHint: "Shows monthly included usage, auto models, named models, and billing cycle resets.",
  stability: "official",
  notes: [
    "Connects to Cursor's dashboard service for live plan and model quota tracking.",
    "Shows monthly usage against included credits and billing cycle end.",
  ],
  usageWindows: [
    { label: "Monthly Total", statusLabel: "loading…", notches: [25, 50, 75] },
    { label: "Auto Models", statusLabel: "loading…", notches: [25, 50, 75] },
    { label: "API Models", statusLabel: "loading…", notches: [25, 50, 75] },
    { label: "Daily / On-Demand", statusLabel: "loading…", notches: [50, 75, 90] },
  ],
  loadRuntimeState: loadCursorRuntimeState,
};
