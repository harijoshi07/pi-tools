import { createSubscriptionAuthStorage, type SubscriptionAuthStatus } from "../auth.ts";
import type {
  SubscriptionProviderDefinition,
  SubscriptionProviderRuntimeState,
  SubscriptionUsageWindowDefinition,
} from "./types.ts";

const ANTIGRAVITY_BASE_URLS = [
  "https://daily-cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
];

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_USER_AGENT =
  "antigravity/cli/1.2.4 (aidev_client; os_type=linux; arch=amd64; cl=982146307; auth_method=consumer)";

const CLIENT_ID =
  process.env.ANTIGRAVITY_CLIENT_ID ||
  Buffer.from(
    "MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
    "base64",
  ).toString("utf8");

const CLIENT_SECRET =
  process.env.ANTIGRAVITY_CLIENT_SECRET ||
  Buffer.from("R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=", "base64").toString("utf8");

const FIVE_HOUR_SECONDS = 5 * 60 * 60;
const SEVEN_DAY_SECONDS = 7 * 24 * 60 * 60;
const REQUEST_TIMEOUT_MS = 15_000;

interface AntigravityBucket {
  bucketId?: string;
  displayName?: string;
  window?: string;
  resetTime?: string;
  description?: string;
  remainingFraction?: number;
}

interface AntigravityGroup {
  displayName?: string;
  description?: string;
  buckets?: AntigravityBucket[];
}

interface AntigravityQuotaSummaryResponse {
  groups?: AntigravityGroup[];
  description?: string;
}

interface AntigravityTierInfo {
  id?: string;
  name?: string;
  description?: string;
}

interface AntigravityLoadCodeAssistResponse {
  currentTier?: AntigravityTierInfo;
  paidTier?: AntigravityTierInfo;
  project?: string;
  cloudaicompanionProject?: string;
}

interface AntigravityModelQuotaInfo {
  remainingFraction?: number;
  resetTime?: string;
}

interface AntigravityModelInfo {
  displayName?: string;
  quotaInfo?: AntigravityModelQuotaInfo;
}

interface AntigravityAvailableModelsResponse {
  models?: Record<string, AntigravityModelInfo>;
  defaultAgentModelId?: string;
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

function parseDateish(value: unknown): Date | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value < 1e12 ? value * 1000 : value;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  return undefined;
}

function authSourceLabel(authStatus: SubscriptionAuthStatus): string | undefined {
  if (authStatus.source === "environment") {
    return authStatus.label ?? "environment";
  }
  if (authStatus.source === "stored") {
    return "Pi auth.json";
  }
  if (authStatus.source === "runtime") {
    return "runtime token";
  }
  if (authStatus.source === "fallback") {
    return "fallback token";
  }
  return undefined;
}

async function refreshGoogleAccessToken(refreshToken: string): Promise<string> {
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Token refresh failed: ${errorText || response.statusText}`);
  }

  const data = (await response.json()) as { access_token?: string };
  if (!data.access_token) {
    throw new Error("Token refresh response missing access_token");
  }

  return data.access_token;
}

interface ResolvedAntigravityAuth {
  accessToken: string;
  projectId: string;
  authStatus: SubscriptionAuthStatus;
  email?: string;
}

async function resolveAntigravityAuth(): Promise<ResolvedAntigravityAuth | undefined> {
  const authStorage = createSubscriptionAuthStorage();
  const authStatus = authStorage.getAuthStatus("antigravity");
  const storedCred = authStorage.get("antigravity") as Record<string, unknown> | undefined;

  let accessToken: string | undefined;
  let projectId = process.env.ANTIGRAVITY_PROJECT_ID || "aicode-consumers";
  let email: string | undefined;

  if (storedCred && typeof storedCred === "object") {
    email = typeof storedCred.email === "string" ? storedCred.email : undefined;
    if (typeof storedCred.projectId === "string" && storedCred.projectId.length > 0) {
      projectId = storedCred.projectId;
    }

    const expires = parseNumber(storedCred.expires);
    const refreshToken = typeof storedCred.refresh === "string" ? storedCred.refresh : undefined;
    const currentAccess = typeof storedCred.access === "string" ? storedCred.access : undefined;

    // If token is expired or expiring in next 2 minutes and refresh token exists, refresh
    const isExpired = expires != null && Date.now() >= expires - 2 * 60 * 1000;
    if (isExpired && refreshToken) {
      try {
        accessToken = await refreshGoogleAccessToken(refreshToken);
        storedCred.access = accessToken;
        storedCred.expires = Date.now() + 3600 * 1000;
      } catch {
        // Fall back to current access token if refresh fails
        accessToken = currentAccess;
      }
    } else {
      accessToken = currentAccess;
    }
  }

  if (!accessToken) {
    accessToken = await authStorage.getApiKey("antigravity");
  }

  if (!accessToken) {
    return undefined;
  }

  return { accessToken, projectId, authStatus, email };
}

async function antigravityPost<T>(path: string, token: string, body: Record<string, unknown>): Promise<T> {
  const baseUrls = process.env.ANTIGRAVITY_BASE_URL
    ? [process.env.ANTIGRAVITY_BASE_URL]
    : ANTIGRAVITY_BASE_URLS;

  let lastError: Error | undefined;

  for (const baseUrl of baseUrls) {
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": process.env.ANTIGRAVITY_USER_AGENT || DEFAULT_USER_AGENT,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
      }

      return (await response.json()) as T;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError || new Error(`All Antigravity endpoints failed for ${path}`);
}

function createAntigravityBucketWindow(
  bucket: AntigravityBucket,
  groupName: string,
): SubscriptionUsageWindowDefinition | undefined {
  const remainingFraction = parseNumber(bucket.remainingFraction);
  if (remainingFraction == null) {
    return undefined;
  }

  const remainingPercent = clampPercent(remainingFraction * 100);
  const usedPercent = clampPercent(100 - remainingPercent);
  const resetAt = parseDateish(bucket.resetTime);

  const isWeekly = bucket.window?.toLowerCase().includes("week") || (bucket.bucketId?.toLowerCase().includes("week") ?? false);
  const windowSeconds = isWeekly ? SEVEN_DAY_SECONDS : FIVE_HOUR_SECONDS;

  let pacePercent: number | undefined;
  let detailLabel: string | undefined;

  if (resetAt) {
    const remainingSeconds = Math.max(0, Math.round((resetAt.getTime() - Date.now()) / 1000));
    const elapsedSeconds = Math.max(0, windowSeconds - remainingSeconds);
    pacePercent = clampPercent((elapsedSeconds / windowSeconds) * 100);
    detailLabel = `${formatPercent(remainingPercent)} remaining • ${formatPercent(pacePercent)} elapsed`;
  } else {
    detailLabel = `${formatPercent(remainingPercent)} remaining`;
  }

  let label: string;
  const isGemini = groupName.toLowerCase().includes("gemini");
  const prefix = isGemini ? "Gemini" : "Claude/GPT";
  const windowLabel = isWeekly ? "Weekly" : "5h";
  label = `${prefix} ${windowLabel}`;

  return {
    label,
    usedPercent,
    detailLabel,
    resetAt,
    pacePercent,
    notches: [25, 50, 75],
  };
}

function buildStatusLine(windows: SubscriptionUsageWindowDefinition[]): string {
  const primary = windows
    .filter((w) => w.usedPercent != null)
    .slice(0, 2)
    .map((w) => `${w.label} ${formatPercent(w.usedPercent)} used`);

  return primary.length > 0 ? primary.join(" • ") : "active";
}

export async function loadAntigravityRuntimeState(): Promise<SubscriptionProviderRuntimeState> {
  let auth: ResolvedAntigravityAuth | undefined;
  try {
    auth = await resolveAntigravityAuth();
  } catch (error) {
    return {
      state: "error",
      implementationStatus: "implemented",
      statusLine: "auth error",
      errorMessage: `Failed to resolve Antigravity authentication: ${error instanceof Error ? error.message : String(error)}`,
      usageWindows: [],
    };
  }

  if (!auth) {
    return {
      state: "error",
      implementationStatus: "implemented",
      statusLine: "auth missing",
      errorMessage: "No Antigravity credentials found. Run /login antigravity or configure Pi auth.json.",
      authHint: "Supports Google OAuth token from Pi auth.json or ANTIGRAVITY_ACCESS_TOKEN.",
      usageWindows: [],
    };
  }

  try {
    // Query quota summary and code assist tier in parallel
    const [quotaRes, assistRes] = await Promise.allSettled([
      antigravityPost<AntigravityQuotaSummaryResponse>("/v1internal:retrieveUserQuotaSummary", auth.accessToken, {}),
      antigravityPost<AntigravityLoadCodeAssistResponse>("/v1internal:loadCodeAssist", auth.accessToken, {
        metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" },
      }),
    ]);

    const usageWindows: SubscriptionUsageWindowDefinition[] = [];

    if (quotaRes.status === "fulfilled" && Array.isArray(quotaRes.value.groups)) {
      for (const group of quotaRes.value.groups) {
        const groupName = group.displayName || "";
        for (const bucket of group.buckets || []) {
          const window = createAntigravityBucketWindow(bucket, groupName);
          if (window) {
            usageWindows.push(window);
          }
        }
      }
    }

    // Fallback: If quota summary was empty or failed (e.g. free tier), query available models
    if (usageWindows.length === 0) {
      const modelsRes = await antigravityPost<AntigravityAvailableModelsResponse>(
        "/v1internal:fetchAvailableModels",
        auth.accessToken,
        { project: auth.projectId },
      ).catch(() => undefined);

      if (modelsRes?.models) {
        // Collect model quotas
        for (const [modelId, modelInfo] of Object.entries(modelsRes.models)) {
          if (!modelInfo.quotaInfo || parseNumber(modelInfo.quotaInfo.remainingFraction) == null) continue;
          if (modelId.startsWith("chat_") || modelId.startsWith("tab_")) continue;

          // Pick key models (e.g., flash lite and pro)
          if (modelId.includes("flash-lite") || modelId.includes("pro-low") || modelId.includes("claude")) {
            const rem = clampPercent((modelInfo.quotaInfo.remainingFraction ?? 0) * 100);
            const resetAt = parseDateish(modelInfo.quotaInfo.resetTime);
            usageWindows.push({
              label: modelInfo.displayName || modelId,
              usedPercent: clampPercent(100 - rem),
              detailLabel: `${formatPercent(rem)} remaining`,
              resetAt,
              notches: [25, 50, 75],
            });
          }
        }
      }
    }

    let planLabel = "Google AI";
    if (assistRes.status === "fulfilled") {
      const paid = assistRes.value.paidTier;
      const current = assistRes.value.currentTier;
      if (paid?.name) {
        planLabel = paid.name;
      } else if (current?.name) {
        planLabel = current.name;
      }
    }

    const notes = [
      `Plan: ${planLabel}${auth.email ? ` (${auth.email})` : ""}`,
      "Antigravity quotas share a 5-hour demand window and a weekly capacity limit.",
      "Quota is consumed proportionally to token cost across models in each group.",
    ];

    return {
      state: "ready",
      implementationStatus: "implemented",
      statusLine: buildStatusLine(usageWindows),
      description: `Antigravity quota windows (${planLabel}).`,
      authHint: authSourceLabel(auth.authStatus) ? `token: ${authSourceLabel(auth.authStatus)}` : undefined,
      usageHint: "Shows live 5-hour and weekly quota usage from Google Antigravity.",
      notes,
      usageWindows,
      lastUpdatedAt: new Date(),
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      state: "error",
      implementationStatus: "implemented",
      statusLine: "fetch failed",
      errorMessage: `Failed to load Antigravity usage: ${message}`,
      usageWindows: [],
    };
  }
}

export const antigravityProvider: SubscriptionProviderDefinition = {
  id: "antigravity",
  label: "Google Antigravity",
  shortLabel: "Antigravity",
  icon: "🪐",
  enabledByDefault: true,
  implementationStatus: "implemented",
  description: "Live 5-hour and weekly quota usage for Google Antigravity.",
  authHint: "Uses Antigravity OAuth login from Pi auth.json or ANTIGRAVITY_ACCESS_TOKEN.",
  usageHint: "Shows 5-hour and weekly quota limits for Gemini, Claude, and GPT models.",
  stability: "official",
  notes: [
    "Uses Antigravity Cloud Code Assist quota summary.",
    "Tracks 5-hour smoothing window and weekly tier capacity.",
  ],
  usageWindows: [
    { label: "Gemini 5h", statusLabel: "loading…", notches: [25, 50, 75] },
    { label: "Gemini Weekly", statusLabel: "loading…", notches: [25, 50, 75] },
    { label: "Claude/GPT 5h", statusLabel: "loading…", notches: [25, 50, 75] },
    { label: "Claude/GPT Weekly", statusLabel: "loading…", notches: [25, 50, 75] },
  ],
  loadRuntimeState: loadAntigravityRuntimeState,
};
