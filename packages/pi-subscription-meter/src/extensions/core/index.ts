import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle } from "@earendil-works/pi-tui";
import {
  createDefaultSubscriptionProviderRegistry,
  type SubscriptionProviderId,
  type SubscriptionProviderRuntimeState,
} from "./providers/index.ts";
import { loadSubscriptionMeterSettings, saveSubscriptionMeterSettings } from "./settings.ts";
import {
  mapModelProviderToSubscriptionProviderId,
  renderSubscriptionFooter,
  SUBSCRIPTION_FOOTER_STATUS_KEY,
} from "./ui/footer.ts";
import { ProviderSettingsDialog } from "./ui/provider-settings-dialog.ts";
import { SubscriptionsDialog } from "./ui/subscriptions-dialog.ts";

const FOOTER_REFRESH_INTERVAL_MS = 60_000;

export default function (pi: ExtensionAPI) {
  let currentSettings = loadSubscriptionMeterSettings();
  const providerRegistry = createDefaultSubscriptionProviderRegistry(currentSettings.enabledProviders);

  const runtimeStates = new Map<SubscriptionProviderId, SubscriptionProviderRuntimeState>();
  let lastRefreshTime = 0;
  let isRefreshing = false;
  let lastContext: ExtensionContext | null = null;
  let currentModelProvider: string | undefined;
  let currentModelId: string | undefined;

  function updateActiveModel(model?: { provider?: string; id?: string }) {
    if (model?.provider) {
      currentModelProvider = model.provider;
    }
    if (model?.id) {
      currentModelId = model.id;
    }
  }

  function resolveCurrentProviderId(): SubscriptionProviderId {
    const mapped = mapModelProviderToSubscriptionProviderId(currentModelProvider);
    if (mapped && providerRegistry.isProviderEnabled(mapped)) {
      return mapped;
    }

    try {
      const raw = readFileSync(join(homedir(), ".pi", "agent", "settings.json"), "utf8");
      const parsed = JSON.parse(raw);
      const defaultMapped = mapModelProviderToSubscriptionProviderId(parsed.defaultProvider);
      if (defaultMapped && providerRegistry.isProviderEnabled(defaultMapped)) {
        return defaultMapped;
      }
    } catch {
      // fallback
    }

    const enabled = providerRegistry.getEnabledProviders();
    return enabled[0]?.id ?? "antigravity";
  }

  function refreshFooterStatus(ctx?: ExtensionContext, force = false): void {
    if (ctx) {
      lastContext = ctx;
      updateActiveModel(ctx.model);
    }
    const activeCtx = lastContext;
    if (!activeCtx || !activeCtx.hasUI) {
      return;
    }

    if (!currentSettings.showFooter) {
      activeCtx.ui.setStatus(SUBSCRIPTION_FOOTER_STATUS_KEY, undefined);
      return;
    }

    const activeProviderId = resolveCurrentProviderId();
    const activeProvider = providerRegistry.getProvider(activeProviderId);

    // Immediately render current runtime state for the active provider
    const immediateText = renderSubscriptionFooter(
      activeProvider,
      runtimeStates.get(activeProviderId),
      currentSettings,
      {
        theme: activeCtx.ui.theme,
        activeModelId: currentModelId,
      },
    );
    activeCtx.ui.setStatus(SUBSCRIPTION_FOOTER_STATUS_KEY, immediateText);

    const now = Date.now();
    if (!force && now - lastRefreshTime < FOOTER_REFRESH_INTERVAL_MS && runtimeStates.has(activeProviderId)) {
      return;
    }

    if (isRefreshing) {
      return;
    }

    isRefreshing = true;

    void (async () => {
      try {
        if (activeProvider?.loadRuntimeState) {
          const state = await activeProvider.loadRuntimeState();
          runtimeStates.set(activeProvider.id, state);
        }
      } catch {
        // Keep prior state or let provider report its own error
      } finally {
        lastRefreshTime = Date.now();
        isRefreshing = false;

        if (lastContext?.hasUI && currentSettings.showFooter) {
          const updatedProvider = providerRegistry.getProvider(resolveCurrentProviderId());
          const updatedText = renderSubscriptionFooter(
            updatedProvider,
            runtimeStates.get(resolveCurrentProviderId()),
            currentSettings,
            {
              theme: lastContext.ui.theme,
              activeModelId: currentModelId,
            },
          );
          lastContext.ui.setStatus(SUBSCRIPTION_FOOTER_STATUS_KEY, updatedText);
        }
      }
    })();
  }

  // Session & Turn lifecycle for live footer updates
  pi.on("session_start", (_event, ctx) => {
    updateActiveModel(ctx.model);
    refreshFooterStatus(ctx, false);
  });

  pi.on("turn_start", (_event, ctx) => {
    updateActiveModel(ctx.model);
    refreshFooterStatus(ctx, false);
  });

  pi.on("before_provider_request", (_event, ctx) => {
    updateActiveModel(ctx.model);
    refreshFooterStatus(ctx, false);
  });

  pi.on("message_end", (event, ctx) => {
    const msg = event.message as { provider?: string; model?: string } | undefined;
    updateActiveModel({
      provider: msg?.provider ?? ctx.model?.provider,
      id: msg?.model ?? ctx.model?.id,
    });
    refreshFooterStatus(ctx, false);
  });

  pi.on("turn_end", (_event, ctx) => {
    updateActiveModel(ctx.model);
    refreshFooterStatus(ctx, false);
  });

  pi.on("agent_end", (_event, ctx) => {
    updateActiveModel(ctx.model);
    refreshFooterStatus(ctx, false);
  });

  const footerTimer = setInterval(() => {
    if (lastContext) {
      refreshFooterStatus(lastContext, false);
    }
  }, FOOTER_REFRESH_INTERVAL_MS);
  footerTimer.unref?.();

  pi.on("session_shutdown", () => {
    clearInterval(footerTimer);
  });

  let subscriptionsOverlayHandle: OverlayHandle | null = null;
  let closeSubscriptionsOverlay: (() => void) | null = null;

  pi.registerCommand("subscriptions", {
    description: "Show subscription providers in a floating dialog or toggle footer (/subscriptions [close|footer on|off])",
    handler: async (args, ctx) => {
      lastContext = ctx;

      const normalizedArgs = args.trim().toLowerCase();

      if (normalizedArgs === "footer on" || normalizedArgs === "footer off") {
        const showFooter = normalizedArgs === "footer on";
        currentSettings = saveSubscriptionMeterSettings({
          ...currentSettings,
          showFooter,
        });
        refreshFooterStatus(ctx, true);
        ctx.ui.notify(`Subscription footer meter ${showFooter ? "enabled" : "disabled"}.`, "info");
        return;
      }

      if (ctx.mode !== "tui") {
        ctx.ui.notify("/subscriptions requires TUI mode", "error");
        return;
      }

      if (normalizedArgs === "close") {
        if (closeSubscriptionsOverlay) {
          closeSubscriptionsOverlay();
        }
        return;
      }

      if (subscriptionsOverlayHandle) {
        if (!subscriptionsOverlayHandle.isFocused()) {
          subscriptionsOverlayHandle.focus();
          ctx.ui.notify("Subscriptions overlay focused.", "info");
        } else {
          ctx.ui.notify("Subscriptions overlay is already open and focused.", "info");
        }
        return;
      }

      currentSettings = loadSubscriptionMeterSettings();
      providerRegistry.setEnabledProviders(currentSettings.enabledProviders);

      let dialog: SubscriptionsDialog | undefined;
      let settingsOverlayOpen = false;

      void ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        const saveAndApplySettings = (nextSettings: {
          enabledProviders?: SubscriptionProviderId[];
          displayMode?: "used" | "remaining";
          resetTimeDisplayMode?: "absolute" | "relative";
          showThresholdNotches?: boolean;
          showNowNotch?: boolean;
          showFooter?: boolean;
        }) => {
          try {
            const savedSettings = saveSubscriptionMeterSettings({
              version: 1,
              enabledProviders: nextSettings.enabledProviders ?? currentSettings.enabledProviders,
              displayMode: nextSettings.displayMode ?? currentSettings.displayMode,
              resetTimeDisplayMode: nextSettings.resetTimeDisplayMode ?? currentSettings.resetTimeDisplayMode,
              showThresholdNotches: nextSettings.showThresholdNotches ?? currentSettings.showThresholdNotches,
              showNowNotch: nextSettings.showNowNotch ?? currentSettings.showNowNotch,
              showFooter: nextSettings.showFooter ?? currentSettings.showFooter,
            });

            currentSettings = savedSettings;
            providerRegistry.setEnabledProviders(savedSettings.enabledProviders);
            dialog?.setProviders(providerRegistry.getEnabledProviders());
            dialog?.setDisplayMode(savedSettings.displayMode);
            dialog?.setResetTimeDisplayMode(savedSettings.resetTimeDisplayMode);
            dialog?.setShowThresholdNotches(savedSettings.showThresholdNotches);
            dialog?.setShowNowNotch(savedSettings.showNowNotch);
            tui.requestRender();
            refreshFooterStatus(ctx, true);
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            ctx.ui.notify(`Failed to save subscription settings: ${message}`, "error");
          }
        };

        const openSettings = () => {
          if (settingsOverlayOpen) {
            return;
          }

          settingsOverlayOpen = true;

          void ctx.ui
            .custom<void>(
              (overlayTui, overlayTheme, _overlayKeybindings, overlayDone) => {
                const settingsDialog = new ProviderSettingsDialog({
                  theme: overlayTheme,
                  providers: providerRegistry.getAllProviders(),
                  enabledProviderIds: providerRegistry.getEnabledProviders().map((provider) => provider.id),
                  displayMode: currentSettings.displayMode,
                  resetTimeDisplayMode: currentSettings.resetTimeDisplayMode,
                  showThresholdNotches: currentSettings.showThresholdNotches,
                  showNowNotch: currentSettings.showNowNotch,
                  showFooter: currentSettings.showFooter,
                  onEnabledProvidersChange: (enabledProviderIds) => {
                    saveAndApplySettings({ enabledProviders: enabledProviderIds });
                    overlayTui.requestRender();
                  },
                  onDisplayModeChange: (displayMode) => {
                    saveAndApplySettings({ displayMode });
                    overlayTui.requestRender();
                  },
                  onResetTimeDisplayModeChange: (resetTimeDisplayMode) => {
                    saveAndApplySettings({ resetTimeDisplayMode });
                    overlayTui.requestRender();
                  },
                  onShowThresholdNotchesChange: (showThresholdNotches) => {
                    saveAndApplySettings({ showThresholdNotches });
                    overlayTui.requestRender();
                  },
                  onShowNowNotchChange: (showNowNotch) => {
                    saveAndApplySettings({ showNowNotch });
                    overlayTui.requestRender();
                  },
                  onShowFooterChange: (showFooter) => {
                    saveAndApplySettings({ showFooter });
                    overlayTui.requestRender();
                  },
                  onClose: () => overlayDone(undefined),
                });

                return {
                  render(width: number) {
                    return settingsDialog.render(width);
                  },
                  invalidate() {
                    settingsDialog.invalidate();
                  },
                  handleInput(data: string) {
                    settingsDialog.handleInput(data);
                    overlayTui.requestRender();
                  },
                };
              },
              {
                overlay: true,
                overlayOptions: {
                  width: "70%",
                  minWidth: 60,
                  maxHeight: "80%",
                  anchor: "center",
                  margin: 2,
                },
              },
            )
            .catch((error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              ctx.ui.notify(`Failed to open subscription settings: ${message}`, "error");
            })
            .finally(() => {
              settingsOverlayOpen = false;
              dialog?.invalidate();
              tui.requestRender();
            });
        };

        closeSubscriptionsOverlay = () => done(undefined);

        dialog = new SubscriptionsDialog({
          providers: providerRegistry.getEnabledProviders(),
          displayMode: currentSettings.displayMode,
          resetTimeDisplayMode: currentSettings.resetTimeDisplayMode,
          showThresholdNotches: currentSettings.showThresholdNotches,
          showNowNotch: currentSettings.showNowNotch,
          theme,
          onClose: () => done(undefined),
          onOpenSettings: openSettings,
          requestRender: () => tui.requestRender(),
        });

        return {
          render(width: number) {
            return dialog?.render(width) ?? [];
          },
          invalidate() {
            dialog?.invalidate();
          },
          handleInput(data: string) {
            dialog?.handleInput(data);
            tui.requestRender();
          },
        };
      }, {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "75%",
          minWidth: 44,
          maxHeight: "85%",
          margin: 2,
        },
        onHandle: (handle) => {
          subscriptionsOverlayHandle = handle;
        },
      })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Failed to open subscriptions overlay: ${message}`, "error");
        })
        .finally(() => {
          dialog?.dispose();
          subscriptionsOverlayHandle = null;
          closeSubscriptionsOverlay = null;
        });
    },
  });
}
