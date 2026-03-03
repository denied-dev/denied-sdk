// OpenClaw types
export type PluginHookToolContext = {
  agentId?: string;
  sessionKey?: string;
  toolName: string;
};

export type PluginHookBeforeToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
};

export type PluginHookBeforeToolCallResult = {
  params?: Record<string, unknown>;
  block?: boolean;
  blockReason?: string;
};

// Custom types
export type DeniedPluginConfig = {
  deniedUrl?: string;
  deniedApiKey?: string;
  failMode?: "open" | "closed";
};
