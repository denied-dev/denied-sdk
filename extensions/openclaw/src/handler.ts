import { DeniedClient } from "@denied-dev/sdk";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DeniedPluginConfig,
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookToolContext,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_FAIL_MODE = "open";
const DEFAULT_CONTEXT_MAX_BYTES = 20_000;

function positiveInteger(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function expandHome(value: string): string {
  if (value === "~" || value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function truncateJsonValue(value: unknown, maxBytes: number): unknown {
  let raw: string;
  let serializable = value;
  try {
    raw = JSON.stringify(value);
  } catch {
    serializable = String(value);
    raw = JSON.stringify(serializable);
  }
  const originalBytes = Buffer.byteLength(raw, "utf-8");
  if (originalBytes <= maxBytes) {
    return serializable;
  }
  return {
    truncated: true,
    max_bytes: maxBytes,
    original_bytes: originalBytes,
    preview: truncateUtf8(raw, maxBytes),
  };
}

function truncateUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf-8");
  let end = Math.max(0, Math.min(maxBytes, buffer.length));
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return buffer.subarray(0, end).toString("utf-8");
}

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
  const requestConfig = config.request ?? {};
  const includeToolInput = requestConfig.includeToolInput !== false;
  const includeHookPayload = requestConfig.includeHookPayload !== false;
  const maxContextBytes = positiveInteger(
    requestConfig.maxContextBytes,
    DEFAULT_CONTEXT_MAX_BYTES,
  );
  const auditConfig = config.audit ?? {};
  const audit = {
    enabled: auditConfig.enabled === true,
    dir: expandHome(auditConfig.dir ?? path.join(os.homedir(), ".denied", "audit")),
    includeRawPayload: auditConfig.includeRawPayload !== false,
    includeMappedRequest: auditConfig.includeMappedRequest !== false,
    includeDecision: auditConfig.includeDecision !== false,
  };

  function appendAuditRecord(
    payload: Record<string, unknown>,
    request: Record<string, unknown>,
    decision: unknown,
  ) {
    if (!audit.enabled) {
      return;
    }

    try {
      fs.mkdirSync(audit.dir, { recursive: true });
      const record: Record<string, unknown> = {
        timestamp: new Date().toISOString(),
      };
      if (audit.includeRawPayload) {
        record.hook_payload = truncateJsonValue(payload, maxContextBytes);
      }
      if (audit.includeMappedRequest) {
        record.mapped_request = truncateJsonValue(request, maxContextBytes);
      }
      if (audit.includeDecision) {
        record.decision = truncateJsonValue(decision, maxContextBytes);
      }
      fs.appendFileSync(
        path.join(audit.dir, "denied-openclaw-hook.jsonl"),
        `${JSON.stringify(record)}\n`,
        "utf-8",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[plugin:denied-dev] Failed to write audit record: ${message}`);
    }
  }

  return async function beforeToolCallDeniedHook(
    event: PluginHookBeforeToolCallEvent,
    ctx: PluginHookToolContext,
  ): Promise<PluginHookBeforeToolCallResult | void> {
    const hookPayload = { event, ctx };
    const resourceProperties: Record<string, unknown> = {};
    if (includeToolInput) {
      resourceProperties.tool_input = truncateJsonValue(
        event.params ?? {},
        maxContextBytes,
      );
    }
    const context: Record<string, unknown> = {
      integration: "denied-openclaw-hook",
      hook_event_name: "before_tool_call",
      authz_direction: "agent-to-world",
    };
    if (includeHookPayload) {
      context.hook_payload = truncateJsonValue(hookPayload, maxContextBytes);
    }
    const request = {
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
        properties: resourceProperties,
      },
      context,
    };

    try {
      const result = await denied.check(request);
      appendAuditRecord(hookPayload, request, result);

      if (!result.decision) {
        console.log(`[plugin:denied-dev] Blocked tool call: ${event.toolName}`);
        return {
          block: true,
          blockReason: result.context?.reason ?? `Authorization denied`,
        };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendAuditRecord(hookPayload, request, { error: message });
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
