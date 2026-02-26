import createDeniedHook from "./src/handler";

export default function register(api) {
  const config = api.pluginConfig ?? {};

  api.on("before_tool_call", createDeniedHook(config), {
    priority: 1000,
  });
}
