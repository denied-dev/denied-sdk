import { DeniedClient } from "@denied-dev/denied-sdk";

import {
  DeniedPluginConfig,
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookToolContext,
} from "./types";

declare const process: { env: Record<string, string | undefined> };

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_FAIL_MODE = "open";

export default function createDeniedHook(config: DeniedPluginConfig) {
  const timeoutFromEnv = parseInt(process.env.DENIED_TIMEOUT_MS ?? "");
  const denied = new DeniedClient({
    url: config.deniedUrl,
    apiKey: config.deniedApiKey,
    timeout:
      config.timeout ??
      (Number.isFinite(timeoutFromEnv) ? timeoutFromEnv : DEFAULT_TIMEOUT_MS),
  });
  const failMode = (
    config.failMode ??
    process.env.DENIED_FAIL_MODE ??
    DEFAULT_FAIL_MODE
  ).toLowerCase();

  return async function beforeToolCallDeniedHook(
    event: PluginHookBeforeToolCallEvent,
    ctx: PluginHookToolContext,
  ): Promise<PluginHookBeforeToolCallResult | void> {
    try {
      const result = await denied.check({
        subject: {
          type: "openclaw",
          id: ctx.agentId ?? "unknown",
          properties: {
            sessionKey: ctx.sessionKey,
          },
        },
        action: { name: "execute" },
        resource: {
          type: "tool",
          id: event.toolName,
          properties: event.params,
        },
      });

      if (!result.decision) {
        console.log(`[plugin:denied-dev] Blocked tool call: ${event.toolName}`);
        return {
          block: true,
          blockReason: result.context?.reason ?? `Authorization denied`,
        };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[plugin:denied-dev] Failed: ${message}`);
      if (failMode === "closed") {
        return {
          block: true,
          blockReason: `Denied policy engine unavailable and fail-mode is closed. ${message}`,
        };
      }
    }

    return {
      block: false,
      params: { ...event.params },
    };
  };
}
