import { createContext, useContext } from "react";

// The theme attribute value the root carries (`data-oi-theme`), so a portalled overlay (a Radix dialog renders OUT of .oi-root,
// lib/portal-scope.ts) can carry the same value and so match the same `[data-bb-portaled-overlay][data-oi-theme="x"]` rule.
// undefined = no provider (Match BB, or a test): the overlay then carries no attribute and shows the host layer.
export const ThemeAttrContext = createContext<string | undefined>(undefined);
export const useThemeAttr = (): string | undefined => useContext(ThemeAttrContext);
