import { useThemeAttr } from "../theme/context.ts";

declare const __BB_PLUGIN_ID__: string | undefined;

export function usePortalScopeProps(): {
  "data-bb-portaled-overlay": "";
  "data-bb-plugin-root"?: "";
  "data-bb-plugin"?: string;
  "data-oi-theme"?: string;
} {
  const pluginId =
    typeof __BB_PLUGIN_ID__ === "string" ? __BB_PLUGIN_ID__ : undefined;
  const theme = useThemeAttr();
  return {
    "data-bb-portaled-overlay": "",
    ...(theme !== undefined ? { "data-oi-theme": theme } : {}),
    "data-bb-plugin-root": "",
    ...(pluginId !== undefined ? { "data-bb-plugin": pluginId } : {}),
  };
}
