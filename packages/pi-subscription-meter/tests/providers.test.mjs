import test from "node:test";
import assert from "node:assert/strict";
import {
  subscriptionProviders,
  antigravityProvider,
  cursorProvider,
  createDefaultSubscriptionProviderRegistry,
} from "../src/extensions/core/providers/index.ts";

test("antigravityProvider is registered with valid metadata", () => {
  assert.equal(antigravityProvider.id, "antigravity");
  assert.equal(antigravityProvider.label, "Google Antigravity");
  assert.equal(antigravityProvider.enabledByDefault, true);
  assert.equal(antigravityProvider.implementationStatus, "implemented");
  assert.equal(typeof antigravityProvider.loadRuntimeState, "function");
  assert.ok(subscriptionProviders.some((p) => p.id === "antigravity"));
});

test("cursorProvider is registered with valid metadata", () => {
  assert.equal(cursorProvider.id, "cursor");
  assert.equal(cursorProvider.label, "Cursor");
  assert.equal(cursorProvider.enabledByDefault, true);
  assert.equal(cursorProvider.implementationStatus, "implemented");
  assert.equal(typeof cursorProvider.loadRuntimeState, "function");
  assert.ok(subscriptionProviders.some((p) => p.id === "cursor"));
});

test("SubscriptionProviderRegistry includes Antigravity and Cursor by default", () => {
  const registry = createDefaultSubscriptionProviderRegistry();
  const enabled = registry.getEnabledProviders().map((p) => p.id);
  assert.ok(enabled.includes("antigravity"));
  assert.ok(enabled.includes("cursor"));
});
