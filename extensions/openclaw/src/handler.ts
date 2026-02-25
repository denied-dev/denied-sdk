import { DeniedClient } from "denied-sdk";

import {
  DeniedPluginConfig,
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookToolContext,
} from "./types";

export default function createDeniedHook(config: DeniedPluginConfig) {
  const denied = new DeniedClient({
    url: config.deniedUrl,
    apiKey: config.deniedApiKey,
  });

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
    }

    return {
      block: false,
      params: { ...event.params },
    };
  };
}
