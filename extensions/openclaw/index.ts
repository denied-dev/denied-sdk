import createDeniedHook from "./src/handler";

export default function register(api) {
  api.on("before_tool_call", createDeniedHook(api.pluginConfig), {
    priority: 1000,
  });
}
