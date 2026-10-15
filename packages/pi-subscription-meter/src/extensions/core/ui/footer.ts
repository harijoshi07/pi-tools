import type { Theme } from "@earendil-works/pi-coding-agent";
import type {
  SubscriptionProviderDefinition,
  SubscriptionProviderId,
  SubscriptionProviderRuntimeState,
  SubscriptionUsageWindowDefinition,
} from "../providers/index.ts";
import type { SubscriptionMeterSettings, SubscriptionUsageDisplayMode } from "../settings.ts";
import { renderProgressBar, type ProgressBarTheme } from "./progress-bar.ts";

export const SUBSCRIPTION_FOOTER_STATUS_KEY = "subscription-meter";

export const DEFAULT_PROVIDER_ICONS: Record<SubscriptionProviderId, string> = {
  antigravity: "🪐",
  cursor: "⚡",
  anthropic: "✻",
  "openai-codex": "✳",
  "github-copilot": "🐙",
  openrouter: "🔀",
  xai: "𝕏",
  "kimi-coding": "🌙",
  opencode: "💻",
  kilocode: "⚡",
};

export function getProviderIcon(provider: SubscriptionProviderDefinition): string {
  return provider.icon || DEFAULT_PROVIDER_ICONS[provider.id] || "●";
}

export function mapModelProviderToSubscriptionProviderId(
  provider?: string,
): SubscriptionProviderId | null {
  if (!provider) return null;
  const p = provider.trim().toLowerCase();
  if (p === "antigravity" || p.includes("antigravity")) return "antigravity";
  if (p === "cursor" || p.includes("cursor")) return "cursor";
  if (p === "anthropic" || p.includes("claude")) return "anthropic";
  if (p === "openai" || p.includes("codex") || p === "chatgpt" || p === "openai-codex") return "openai-codex";
  if (p === "github-copilot" || p.includes("copilot") || p === "github") return "github-copilot";
  if (p === "openrouter") return "openrouter";
  if (p === "xai" || p.includes("grok")) return "xai";
  if (p === "kimi" || p.includes("kimi")) return "kimi-coding";
  if (p === "opencode" || p.includes("opencode")) return "opencode";
  return null;
}

export type WindowCategory = "daily" | "weekly" | "monthly" | "other";

export function categorizeWindow(label: string): WindowCategory {
  const l = label.toLowerCase();
  if (
    l.includes("5h") ||
    l.includes("daily") ||
    l.includes("day") ||
    l.includes("24h") ||
    l.includes("on-demand") ||
    l.includes("session")
  ) {
    return "daily";
  }
  if (l.includes("7d") || l.includes("week") || l.includes("weekly")) {
    return "weekly";
  }
  if (
    l.includes("month") ||
    l.includes("monthly") ||
    l.includes("total") ||
    l.includes("billing") ||
    l.includes("period") ||
    l.includes("credits") ||
    l.includes("extra") ||
    l.includes("spend")
  ) {
    return "monthly";
  }
  return "other";
}

/**
 * Formats compact remaining time until quota reset:
 * - "56m"
 * - "6d 10h"
 * - "2h 15m"
 */
export function formatCompactRemainingTime(resetAt: Date | undefined, now = Date.now()): string {
  if (!resetAt || !(resetAt instanceof Date) || Number.isNaN(resetAt.getTime())) {
    return "";
  }
  const totalSeconds = Math.ceil((resetAt.getTime() - now) / 1000);
  if (totalSeconds <= 0) return "";

  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (days >= 1) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours >= 1) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

function selectActiveWindows(
  windows: SubscriptionUsageWindowDefinition[],
  providerId: SubscriptionProviderId,
  activeModelId?: string,
): SubscriptionUsageWindowDefinition[] {
  if (providerId === "antigravity" && activeModelId) {
    const isClaude = activeModelId.toLowerCase().includes("claude");
    const filtered = windows.filter((w) =>
      isClaude ? w.label.toLowerCase().includes("claude") : w.label.toLowerCase().includes("gemini"),
    );
    if (filtered.length > 0) return filtered;
  }
  return windows;
}

function usageTone(
  percent: number,
  mode: SubscriptionUsageDisplayMode,
): Parameters<Theme["fg"]>[0] {
  if (mode === "remaining") {
    if (percent <= 10) return "error";
    if (percent <= 25) return "warning";
    return "success";
  }
  if (percent >= 90) return "error";
  if (percent >= 75) return "warning";
  return "accent";
}

function formatWindowText(
  window: SubscriptionUsageWindowDefinition,
  categoryLabel: "D" | "W" | "M",
  displayMode: SubscriptionUsageDisplayMode,
  now?: number,
): string {
  const percent = displayMode === "remaining"
    ? Math.max(0, 100 - (window.usedPercent ?? 0))
    : (window.usedPercent ?? 0);
  const modeText = displayMode === "remaining" ? "left" : "used";
  const time = formatCompactRemainingTime(window.resetAt, now);

  const rounded = Math.round(percent);
  return time
    ? `${categoryLabel}:${rounded}% ${modeText} ${time}`
    : `${categoryLabel}:${rounded}% ${modeText}`;
}

const fallbackTheme: ProgressBarTheme = {
  fg: (_color, text) => text,
};

export interface RenderSubscriptionFooterOptions {
  theme?: Theme;
  now?: number;
  activeModelId?: string;
  activeProviderId?: SubscriptionProviderId;
}

export function renderActiveProviderFooter(
  provider: SubscriptionProviderDefinition,
  state: SubscriptionProviderRuntimeState | undefined,
  settings: SubscriptionMeterSettings,
  options?: RenderSubscriptionFooterOptions,
): string | undefined {
  if (!settings.showFooter) {
    return undefined;
  }

  const icon = getProviderIcon(provider);

  if (!state || state.state === "loading") {
    return `${icon} [loading...]`;
  }

  if (state.state === "error") {
    return `${icon} [error]`;
  }

  const allWindows = (state.usageWindows ?? []).filter((w) => w.usedPercent != null || w.statusLabel);
  if (allWindows.length === 0) {
    return undefined;
  }

  const windows = selectActiveWindows(allWindows, provider.id, options?.activeModelId);

  // Group windows into daily, weekly, monthly
  let dailyWindow: SubscriptionUsageWindowDefinition | undefined;
  let weeklyWindow: SubscriptionUsageWindowDefinition | undefined;
  let monthlyWindow: SubscriptionUsageWindowDefinition | undefined;

  for (const win of windows) {
    const cat = categorizeWindow(win.label);
    if (cat === "daily" && !dailyWindow) dailyWindow = win;
    else if (cat === "weekly" && !weeklyWindow) weeklyWindow = win;
    else if (cat === "monthly" && !monthlyWindow) monthlyWindow = win;
  }

  // Selected window parts
  const textParts: string[] = [];
  const now = options?.now ?? Date.now();

  if (dailyWindow) {
    textParts.push(formatWindowText(dailyWindow, "D", settings.displayMode, now));
  }
  if (weeklyWindow) {
    textParts.push(formatWindowText(weeklyWindow, "W", settings.displayMode, now));
  }
  if (monthlyWindow && (!weeklyWindow || !dailyWindow)) {
    textParts.push(formatWindowText(monthlyWindow, "M", settings.displayMode, now));
  }

  // Fallback if no categorized window was found
  if (textParts.length === 0 && windows[0]) {
    const win = windows[0];
    const cat = categorizeWindow(win.label);
    const prefix = cat === "daily" ? "D" : cat === "weekly" ? "W" : cat === "monthly" ? "M" : "D";
    textParts.push(formatWindowText(win, prefix as "D" | "W" | "M", settings.displayMode, now));
  }

  if (textParts.length === 0) {
    return undefined;
  }

  // Primary window for the progress bar (just the first / daily window)
  const barWindow = dailyWindow ?? windows[0];
  const barPercent = settings.displayMode === "remaining"
    ? Math.max(0, 100 - (barWindow?.usedPercent ?? 0))
    : (barWindow?.usedPercent ?? 0);

  const progressBar = renderProgressBar(options?.theme ?? fallbackTheme, {
    width: 10,
    usedPercent: barPercent,
    notches: [],
    markerNotches: undefined,
    filledColor: usageTone(barPercent, settings.displayMode),
    emptyColor: "dim",
  });

  return `${icon} ${progressBar} ${textParts.join(" · ")}`;
}

/**
 * Renders the compact subscription footer status for the active provider.
 * Accepts either a single provider or a provider list / map for compatibility.
 */
export function renderSubscriptionFooter(
  providerOrList: SubscriptionProviderDefinition | SubscriptionProviderDefinition[] | undefined,
  stateOrMap: SubscriptionProviderRuntimeState | Map<SubscriptionProviderId, SubscriptionProviderRuntimeState> | undefined,
  settings: SubscriptionMeterSettings,
  options?: RenderSubscriptionFooterOptions,
): string | undefined {
  if (!settings.showFooter) {
    return undefined;
  }

  let provider: SubscriptionProviderDefinition | undefined;
  let state: SubscriptionProviderRuntimeState | undefined;

  if (Array.isArray(providerOrList)) {
    const activeId = options?.activeProviderId;
    provider = activeId
      ? providerOrList.find((p) => p.id === activeId) ?? providerOrList[0]
      : providerOrList[0];
    if (stateOrMap instanceof Map && provider) {
      state = stateOrMap.get(provider.id);
    }
  } else {
    provider = providerOrList;
    if (stateOrMap instanceof Map && provider) {
      state = stateOrMap.get(provider.id);
    } else if (stateOrMap && !Array.isArray(stateOrMap)) {
      state = stateOrMap as SubscriptionProviderRuntimeState;
    }
  }

  if (!provider) {
    return undefined;
  }

  return renderActiveProviderFooter(provider, state, settings, options);
}
