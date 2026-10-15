import test from "node:test";
import assert from "node:assert/strict";
import {
  categorizeWindow,
  formatCompactRemainingTime,
  mapModelProviderToSubscriptionProviderId,
  renderActiveProviderFooter,
  renderSubscriptionFooter,
} from "../src/extensions/core/ui/footer.ts";

test("categorizeWindow recognizes window types", () => {
  assert.equal(categorizeWindow("Gemini 5h"), "daily");
  assert.equal(categorizeWindow("Daily / On-Demand"), "daily");
  assert.equal(categorizeWindow("24h window"), "daily");
  assert.equal(categorizeWindow("Gemini Weekly"), "weekly");
  assert.equal(categorizeWindow("7d Sonnet"), "weekly");
  assert.equal(categorizeWindow("Monthly Total"), "monthly");
  assert.equal(categorizeWindow("Billing Period"), "monthly");
  assert.equal(categorizeWindow("Extra (USD)"), "monthly");
  assert.equal(categorizeWindow("Random Model"), "other");
});

test("formatCompactRemainingTime formats minutes, hours, and days remaining", () => {
  const baseTime = 1700000000000;
  // 56 minutes
  const in56m = new Date(baseTime + 56 * 60 * 1000);
  assert.equal(formatCompactRemainingTime(in56m, baseTime), "56m");

  // 6 days 10 hours
  const in6d10h = new Date(baseTime + (6 * 24 + 10) * 3600 * 1000);
  assert.equal(formatCompactRemainingTime(in6d10h, baseTime), "6d 10h");

  // 2 hours 15 minutes
  const in2h15m = new Date(baseTime + (2 * 3600 + 15 * 60) * 1000);
  assert.equal(formatCompactRemainingTime(in2h15m, baseTime), "2h 15m");

  // 1 day exactly
  const in1d = new Date(baseTime + 24 * 3600 * 1000);
  assert.equal(formatCompactRemainingTime(in1d, baseTime), "1d");

  // past reset
  const inPast = new Date(baseTime - 1000);
  assert.equal(formatCompactRemainingTime(inPast, baseTime), "");

  // undefined / invalid
  assert.equal(formatCompactRemainingTime(undefined, baseTime), "");
});

test("mapModelProviderToSubscriptionProviderId maps active model providers", () => {
  assert.equal(mapModelProviderToSubscriptionProviderId("antigravity"), "antigravity");
  assert.equal(mapModelProviderToSubscriptionProviderId("cursor"), "cursor");
  assert.equal(mapModelProviderToSubscriptionProviderId("anthropic"), "anthropic");
  assert.equal(mapModelProviderToSubscriptionProviderId("claude"), "anthropic");
  assert.equal(mapModelProviderToSubscriptionProviderId("openai"), "openai-codex");
  assert.equal(mapModelProviderToSubscriptionProviderId("copilot"), "github-copilot");
  assert.equal(mapModelProviderToSubscriptionProviderId("xai"), "xai");
  assert.equal(mapModelProviderToSubscriptionProviderId("kimi-coding"), "kimi-coding");
});

test("renderActiveProviderFooter renders provider icon, compact bar, and D & W limits", () => {
  const agProvider = {
    id: "antigravity",
    label: "Google Antigravity",
    shortLabel: "Antigravity",
    icon: "🪐",
    enabledByDefault: true,
    implementationStatus: "implemented",
    description: "",
    authHint: "",
    usageHint: "",
    stability: "official",
    notes: [],
    usageWindows: [],
  };

  const baseTime = 1700000000000;
  const state = {
    state: "ready",
    usageWindows: [
      {
        label: "Gemini 5h",
        usedPercent: 60,
        resetAt: new Date(baseTime + 56 * 60 * 1000), // 56m
      },
      {
        label: "Gemini Weekly",
        usedPercent: 13,
        resetAt: new Date(baseTime + (6 * 24 + 10) * 3600 * 1000), // 6d 10h
      },
    ],
  };

  const settings = {
    version: 1,
    enabledProviders: ["antigravity"],
    displayMode: "used",
    resetTimeDisplayMode: "relative",
    showThresholdNotches: true,
    showNowNotch: true,
    showFooter: true,
  };

  const footer = renderActiveProviderFooter(agProvider, state, settings, { now: baseTime });
  assert.equal(footer, "🪐 ██████░░░░ D:60% used 56m · W:13% used 6d 10h");
});

test("renderActiveProviderFooter renders Cursor with D & M limits", () => {
  const cursorProvider = {
    id: "cursor",
    label: "Cursor",
    shortLabel: "Cursor",
    icon: "⚡",
    enabledByDefault: true,
    implementationStatus: "implemented",
    description: "",
    authHint: "",
    usageHint: "",
    stability: "official",
    notes: [],
    usageWindows: [],
  };

  const baseTime = 1700000000000;
  const state = {
    state: "ready",
    usageWindows: [
      {
        label: "Daily / On-Demand",
        usedPercent: 0,
        resetAt: new Date(baseTime + 24 * 3600 * 1000), // 1d
      },
      {
        label: "Monthly Total",
        usedPercent: 23,
        resetAt: new Date(baseTime + (14 * 24 + 6) * 3600 * 1000), // 14d 6h
      },
    ],
  };

  const settings = {
    version: 1,
    enabledProviders: ["cursor"],
    displayMode: "used",
    resetTimeDisplayMode: "relative",
    showThresholdNotches: false,
    showNowNotch: false,
    showFooter: true,
  };

  const footer = renderActiveProviderFooter(cursorProvider, state, settings, { now: baseTime });
  assert.equal(footer, "⚡ ░░░░░░░░░░ D:0% used 1d · M:23% used 14d 6h");
});

test("renderSubscriptionFooter returns undefined when showFooter is false", () => {
  const agProvider = {
    id: "antigravity",
    label: "Google Antigravity",
    shortLabel: "Antigravity",
    icon: "🪐",
    enabledByDefault: true,
    implementationStatus: "implemented",
    description: "",
    authHint: "",
    usageHint: "",
    stability: "official",
    notes: [],
    usageWindows: [],
  };

  const settings = {
    version: 1,
    enabledProviders: ["antigravity"],
    displayMode: "used",
    resetTimeDisplayMode: "relative",
    showThresholdNotches: false,
    showNowNotch: false,
    showFooter: false,
  };

  assert.equal(renderSubscriptionFooter(agProvider, { state: "ready", usageWindows: [] }, settings), undefined);
});
