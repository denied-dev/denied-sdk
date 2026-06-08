import createDeniedHook from "./src/handler.js";
import { PluginRegisterApi } from "./src/types.js";

export default function register(api: PluginRegisterApi) {
  const config = api.pluginConfig ?? {};

  api.on("before_tool_call", createDeniedHook(config), {
    priority: 1000,
  });
}
