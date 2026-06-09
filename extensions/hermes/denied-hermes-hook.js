#!/usr/bin/env node
// Denied SDK - Hermes Agent pre_tool_call shell hook.
// Zero dependencies. Requires Node.js 18+ for native fetch.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_DENIED_URL = "https://api.denied.dev";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_FAIL_MODE = "open"; // "open" | "closed"
const DEFAULT_CONTEXT_MAX_BYTES = 20_000;
const DEFAULT_REDACT_KEYS = [
  "api_key",
  "apikey",
  "authorization",
  "password",
  "secret",
  "token",
];
const AGENT_HOOKS_DIR = "agent-hooks";
const VALID_FAIL_MODES = new Set(["open", "closed"]);
const VALID_SUBJECT_IDS = new Set(["session", "task", "tool_call"]);

function log(message) {
  process.stderr.write(`[denied-dev] ${message}\n`);
}

function allow(reason) {
  const output = {};
  if (reason) {
    output.reason = reason;
    output.message = reason;
  }
  process.stdout.write(JSON.stringify(output));
}

function block(reason) {
  process.stdout.write(
    JSON.stringify({
      action: "block",
      message: reason || "Authorization denied by Denied policy engine.",
    }),
  );
}

function failSafe(message, failMode) {
  log(message);
  if (failMode === "closed") {
    block(`Denied policy engine unavailable and fail-mode is closed. ${message}`);
  } else {
    allow(`Denied policy engine unavailable and fail-mode is open. ${message}`);
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  return raw ? JSON.parse(raw) : {};
}

function expandHome(filePath) {
  if (!filePath) return filePath;
  if (filePath === "~") return os.homedir();
  if (filePath.startsWith("~/")) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

function hermesDataDir() {
  const scriptDir = __dirname;
  if (path.basename(scriptDir) === AGENT_HOOKS_DIR) {
    return path.dirname(scriptDir);
  }
  if (fs.existsSync("/opt/data")) {
    return "/opt/data";
  }
  return path.join(os.homedir(), ".hermes");
}

function interpolateEnv(value) {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name) => process.env[name] ?? "");
  }
  if (Array.isArray(value)) return value.map(interpolateEnv);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, interpolateEnv(nested)]),
    );
  }
  return value;
}

function readConfigFile() {
  const explicitPath = process.env.DENIED_CONFIG || process.env.DENIED_HERMES_CONFIG;
  const expandedExplicitPath = expandHome(explicitPath);
  const candidatePaths = explicitPath
    ? [expandedExplicitPath]
    : [
        path.join(hermesDataDir(), "denied.json"),
        expandHome("~/.hermes/denied.json"),
        "/opt/data/denied.json",
      ];

  const configPath = candidatePaths.find((candidate) => candidate && fs.existsSync(candidate));
  if (explicitPath && !configPath) {
    throw new Error(`Denied config was explicitly set but not found at ${expandedExplicitPath}`);
  }
  if (!configPath) return {};

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    return interpolateEnv(JSON.parse(raw));
  } catch (err) {
    const message = `Failed to read Denied config at ${configPath}: ${
      err instanceof Error ? err.message : String(err)
    }`;
    if (explicitPath) {
      throw new Error(message);
    }
    log(`${message}; continuing with env/default config.`);
    return {};
  }
}

function parsePositiveInteger(value, fallback, name) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(String(value));
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  log(`Invalid ${name}: ${value}. Using default ${fallback}.`);
  return fallback;
}

function normalizeFailMode(value) {
  const mode = String(value || DEFAULT_FAIL_MODE).toLowerCase();
  if (VALID_FAIL_MODES.has(mode)) return mode;
  log(`Invalid failMode: ${value}. Using default ${DEFAULT_FAIL_MODE}.`);
  return DEFAULT_FAIL_MODE;
}

function normalizeSubjectId(value) {
  const subjectId = String(value || "session");
  if (VALID_SUBJECT_IDS.has(subjectId)) return subjectId;
  log(`Invalid subjectId: ${value}. Using default session.`);
  return "session";
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function resolveConfig() {
  const fileConfig = readConfigFile();
  const requestConfig = asObject(fileConfig.request);
  const redactionConfig = asObject(fileConfig.redaction);
  const auditConfig = asObject(fileConfig.audit);
  const redactionKeys = asArray(redactionConfig.keys);
  return {
    url: process.env.DENIED_URL || fileConfig.url || DEFAULT_DENIED_URL,
    apiKey: process.env.DENIED_API_KEY || fileConfig.apiKey || "",
    failMode: normalizeFailMode(
      process.env.DENIED_FAIL_MODE || fileConfig.failMode || DEFAULT_FAIL_MODE,
    ),
    timeoutMs: parsePositiveInteger(
      process.env.DENIED_TIMEOUT_MS || fileConfig.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      "timeoutMs",
    ),
    includeToolInput: requestConfig.includeToolInput ?? true,
    useSemanticMapping: fileConfig.useSemanticMapping ?? true,
    subjectId: normalizeSubjectId(fileConfig.subjectId || "session"),
    includeHookPayload: requestConfig.includeHookPayload ?? true,
    redactionEnabled: redactionConfig.enabled ?? true,
    maxContextBytes: parsePositiveInteger(
      requestConfig.maxContextBytes,
      DEFAULT_CONTEXT_MAX_BYTES,
      "request.maxContextBytes",
    ),
    redactKeys: redactionKeys.length > 0 ? redactionKeys : DEFAULT_REDACT_KEYS,
    audit: {
      enabled: auditConfig.enabled === true,
      dir: expandHome(auditConfig.dir || path.join(hermesDataDir(), "denied-audit")),
      includeRawPayload: auditConfig.includeRawPayload ?? true,
      includeMappedRequest: auditConfig.includeMappedRequest ?? true,
      includeDecision: auditConfig.includeDecision ?? true,
    },
  };
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function basenameForCommand(command) {
  const trimmed = command.trim();
  if (!trimmed) return "unknown";
  const first = trimmed.split(/\s+/)[0];
  return path.basename(first);
}

function inferShellEffect(command) {
  const effectPatterns = [
    [/\b(rm|rmdir|unlink)\b/i, "delete"],
    [/\bsed\s+-i\b/i, "update"],
    [/\bchmod\b|\bchown\b|\bchgrp\b/i, "update"],
    [/[^|]>\s*\S|[^|]>>\s*\S/, "create"],
    [/\b(cp|mv|mkdir|touch|rsync|scp|wget\s+-O|curl\s+-o)\b/i, "create"],
    [/\b(tee|dd)\b/i, "create"],
    [
      /\b(cat|head|tail|less|more|grep|find|ls|pwd|whoami|echo(?!\s.*>)|file|stat|wc|diff|which|type|env|printenv|date|uname)\b/i,
      "read",
    ],
  ];

  for (const [pattern, effect] of effectPatterns) {
    if (pattern.test(command)) return effect;
  }
  return "execute";
}

function inferEffect(toolName, toolInput) {
  const lowerTool = toolName.toLowerCase();
  const command = toolInput.command;

  if ((lowerTool === "terminal" || lowerTool === "bash") && typeof command === "string") {
    return inferShellEffect(command);
  }

  const patterns = [
    [/^(read|glob|grep|webfetch|websearch|web_search|listmcpresourcestool|readmcpresourcetool)$/i, "read"],
    [/^(write|notebookedit)$/i, "create"],
    [/^(edit|multiedit|patch)$/i, "update"],
    [/(^|_)(execute|run|call|invoke|batch)(_|$)/i, "execute"],
    [/(^|_)(share|add_.*_member)(_|$)/i, "update"],
    [/(^|_)(merge|fork|copy|move)(_|$)/i, "update"],
    [/(^|_)(lock|unlock|restore)(_|$)/i, "update"],
    [/(^|_)(delete|remove|drop|unshare)(_|$)/i, "delete"],
    [/(^|_)(update|modify|edit|change|set|patch|rename|mark)(_|$)/i, "update"],
    [/(^|_)(write|create|add|insert|post|save|send|upload)(_|$)/i, "create"],
    [/(^|_)(read|get|fetch|load|list|search|query|retrieve)(_|$)/i, "read"],
  ];

  for (const [pattern, action] of patterns) {
    if (pattern.test(toolName)) return action;
  }
  return "execute";
}

function normalizeOperationName(value) {
  return String(value || "unknown")
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase() || "unknown";
}

function inferOperation(toolName, toolInput) {
  const lowerTool = toolName.toLowerCase();

  if (lowerTool === "terminal" || lowerTool === "bash") {
    return "run_command";
  }

  if (lowerTool === "websearch") return "web_search";
  if (lowerTool === "webfetch") return "web_fetch";

  const method = firstString(toolInput.method);
  if (method && firstString(toolInput.url, toolInput.uri, toolInput.endpoint)) {
    return `http_${method.toLowerCase()}`;
  }

  return normalizeOperationName(toolName);
}

function resolvePath(inputPath, cwd) {
  if (typeof inputPath !== "string" || !inputPath) return undefined;
  const expanded = expandHome(inputPath);
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.normalize(path.join(cwd || "", expanded));
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.length > 0);
}

function isSensitiveKey(key, redactKeys) {
  const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
  return redactKeys.some((redactKey) => {
    const candidate = String(redactKey).toLowerCase().replace(/[^a-z0-9]/g, "");
    return candidate && normalized.includes(candidate);
  });
}

function redactStringSecrets(value) {
  return value
    .replace(
      /(\bauthorization:\s*(?:bearer|basic)?\s+)([^\s"';&|]+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(\b(?:api[_-]?key|apikey|token|secret|password|authorization)\b\s*=\s*)([^\s"';&|]+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(--(?:api[-_]?key|token|secret|password|authorization)(?:=|\s+))([^\s"';&|]+)/gi,
      "$1[REDACTED]",
    );
}

function redactValue(value, redactKeys, seen = new WeakSet()) {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, redactKeys, seen));
  }

  if (value && typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);

    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        isSensitiveKey(key, redactKeys)
          ? "[REDACTED]"
          : redactValue(nested, redactKeys, seen),
      ]),
    );
  }

  return typeof value === "string" ? redactStringSecrets(value) : value;
}

function truncateJsonValue(value, maxBytes) {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf-8") <= maxBytes) return value;

  return {
    truncated: true,
    max_bytes: maxBytes,
    original_bytes: Buffer.byteLength(json, "utf-8"),
    preview: json.slice(0, maxBytes),
  };
}

function inferResource(toolName, toolInput, cwd, effect, useSemanticMapping) {
  if (!useSemanticMapping) {
    return { type: "tool", id: toolName, capability: "tool.call" };
  }

  const lowerTool = toolName.toLowerCase();
  if (lowerTool === "terminal" || lowerTool === "bash") {
    const command = typeof toolInput.command === "string" ? toolInput.command : "";
    return {
      type: "command",
      id: basenameForCommand(command),
      capability: "shell.command",
      properties: { command },
    };
  }

  const pathValue = firstString(
    toolInput.path,
    toolInput.file_path,
    toolInput.filePath,
    toolInput.filename,
  );
  if (pathValue) {
    return {
      type: "file",
      id: resolvePath(pathValue, cwd) || pathValue,
      capability:
        effect === "read"
          ? "filesystem.read"
          : effect === "delete"
            ? "filesystem.delete"
            : "filesystem.write",
      properties: { path: pathValue },
    };
  }

  const urlValue = firstString(toolInput.url, toolInput.uri, toolInput.endpoint);
  if (urlValue) {
    return {
      type: "url",
      id: urlValue,
      capability: "network.request",
      properties: {
        url: urlValue,
        method: firstString(toolInput.method) || undefined,
      },
    };
  }

  if (lowerTool.includes("web_search") || lowerTool.includes("websearch")) {
    return {
      type: "web-search",
      id: "default",
      capability: "network.search",
      properties: { query: firstString(toolInput.query) || undefined },
    };
  }

  return { type: "tool", id: toolName, capability: "tool.call" };
}

function subjectIdFromPayload(payload, mode) {
  if (mode === "task") return payload.extra?.task_id || payload.session_id || "unknown";
  if (mode === "tool_call") return payload.extra?.tool_call_id || payload.session_id || "unknown";
  return payload.session_id || payload.extra?.task_id || "unknown";
}

function hookPayloadForContext(payload, config) {
  const hookPayload = config.redactionEnabled
    ? redactValue(payload, config.redactKeys)
    : payload;
  return truncateJsonValue(hookPayload, config.maxContextBytes);
}

function redactIfEnabled(value, config) {
  return config.redactionEnabled ? redactValue(value, config.redactKeys) : value;
}

function boundedIfEnabled(value, config) {
  return truncateJsonValue(redactIfEnabled(value, config), config.maxContextBytes);
}

function createCheckRequest(payload, config) {
  const toolName = payload.tool_name || "unknown";
  const toolInput = asObject(payload.tool_input);
  const extra = asObject(payload.extra);
  const cwd = typeof payload.cwd === "string" ? payload.cwd : undefined;
  const effect = inferEffect(toolName, toolInput);
  const operation = inferOperation(toolName, toolInput);
  const resourceInfo = inferResource(
    toolName,
    toolInput,
    cwd,
    effect,
    config.useSemanticMapping,
  );

  const resourceProperties = {
    ...(resourceInfo.properties || {}),
    tool_name: toolName,
    tool_call_id: extra.tool_call_id,
    raw_tool: {
      name: toolName,
      ...(config.includeToolInput ? { input: boundedIfEnabled(toolInput, config) } : {}),
    },
  };

  if (Object.hasOwn(resourceProperties, "command")) {
    resourceProperties.command = boundedIfEnabled(resourceProperties.command, config);
  }

  const context = {
    integration: "denied-hermes-shell-hook",
    hook_event_name: payload.hook_event_name,
    authz_direction: "agent-to-world",
  };

  if (config.includeHookPayload) {
    context.hook_payload = hookPayloadForContext(payload, config);
  }

  return {
    subject: {
      type: "hermes-agent",
      id: subjectIdFromPayload(payload, config.subjectId),
      properties: {
        runtime: "hermes-agent",
        session_id: payload.session_id,
        task_id: extra.task_id,
        cwd,
      },
    },
    action: {
      name: operation,
      properties: {
        effect,
        tool_name: toolName,
        capability: resourceInfo.capability,
      },
    },
    resource: {
      type: resourceInfo.type,
      id: resourceInfo.id,
      properties: resourceProperties,
    },
    context,
  };
}

function appendAuditRecord(payload, request, decision, config) {
  if (!config.audit.enabled) return;

  try {
    fs.mkdirSync(config.audit.dir, { recursive: true });
    const record = {
      timestamp: new Date().toISOString(),
    };

    if (config.audit.includeRawPayload) {
      record.hook_payload = truncateJsonValue(
        redactIfEnabled(payload, config),
        config.maxContextBytes,
      );
    }
    if (config.audit.includeMappedRequest) {
      record.mapped_request = truncateJsonValue(
        redactIfEnabled(request, config),
        config.maxContextBytes,
      );
    }
    if (config.audit.includeDecision) {
      record.decision = redactIfEnabled(decision, config);
    }

    fs.appendFileSync(
      path.join(config.audit.dir, "denied-hermes-hook.jsonl"),
      `${JSON.stringify(record)}\n`,
      "utf-8",
    );
  } catch (err) {
    log(`Failed to write audit record: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function checkDenied(request, config) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const headers = { "Content-Type": "application/json" };
    if (config.apiKey) headers["X-API-Key"] = config.apiKey;

    const response = await fetch(`${config.url.replace(/\/+$/, "")}/pdp/check`, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  let config;
  try {
    config = resolveConfig();
  } catch (err) {
    failSafe(
      err instanceof Error ? err.message : String(err),
      normalizeFailMode(process.env.DENIED_FAIL_MODE || DEFAULT_FAIL_MODE),
    );
    return;
  }

  if (!config.apiKey) {
    failSafe("DENIED_API_KEY/apiKey is not set. Skipping authorization check.", config.failMode);
    return;
  }

  let payload;
  try {
    payload = await readStdin();
  } catch {
    failSafe("Failed to parse Hermes hook stdin.", config.failMode);
    return;
  }

  if (payload.hook_event_name !== "pre_tool_call") {
    allow("Denied Hermes hook only enforces pre_tool_call events.");
    return;
  }

  const request = createCheckRequest(payload, config);

  try {
    const result = await checkDenied(request, config);
    appendAuditRecord(payload, request, result, config);
    const reason =
      result?.context?.reason ||
      (result?.decision === true
        ? "Authorization allowed by Denied policy engine."
        : "Authorization denied by Denied policy engine.");

    if (result?.decision === true) {
      allow(reason);
    } else if (result?.decision === false) {
      log(`Blocked tool call: ${payload.tool_name || "unknown"}`);
      block(reason);
    } else {
      failSafe("Unexpected PDP response: missing or invalid 'decision' field.", config.failMode);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendAuditRecord(
      payload,
      request,
      { error: `Failed to reach Denied PDP: ${message}` },
      config,
    );
    failSafe(`Failed to reach Denied PDP: ${message}`, config.failMode);
  }
}

module.exports = {
  main,
};

if (require.main === module) {
  main().catch((err) => {
    failSafe(
      `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
      DEFAULT_FAIL_MODE,
    );
  });
}
