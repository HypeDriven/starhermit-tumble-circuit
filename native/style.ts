// The look of the HUD, the banner, the countdown, captions, toasts and
// screens: the browser build's css/main.css rewritten class-based in
// tools/ui-style.css and converted with `starhermit css` into
// assets/ui-style.json (`npm run css`), registered at start with the theme the
// runtime's own widgets take. The runtime's high contrast option (the old
// body.hc) is a token set.
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";

type Tokens = Record<string, string>;
const BASE: Tokens = { accent: "#ffd166", "panel-solid": "#101628", text: "#f2f6ff", "text-dim": "#b8c4de", danger: "#ef476f", ok: "#06d6a0", focus: "#8fb8ff", dark: "#20263a" };
const CONTRAST: Tokens = { "panel-solid": "#000000", text: "#ffffff", "text-dim": "#e0e0e0", accent: "#ffe600", focus: "#00cfff", ok: "#00ff9d", danger: "#ff5d7a" };

let current: Tokens = { ...BASE };
let css: ui.CssStyles | null = null;
let key = "";
export let highContrast = false;
export function initStyles(): void {
  css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  ui.setFont({ family: "sans-serif" });
  ui.setTheme({
    fontSize: 16, smallSize: 14, headingSize: 24, padding: 8, spacing: 10, radius: 12,
    text: BASE.text!, muted: BASE["text-dim"]!, panel: "#101628", control: "#1c2440", hovered: "#2a3352",
    pressed: "#323d60", field: "#1c2440", accent: BASE.accent!, focus: BASE.focus!, outline: "#5a6380",
  });
  key = "";
}
/** The contrast tokens (cheap when unchanged). */
export function applyTokens(hc: boolean): void {
  const k = String(hc);
  if (k === key || !css) return;
  key = k;
  highContrast = hc;
  current = { ...BASE, ...(hc ? CONTRAST : {}) };
  ui.setTokens({ ...css.tokens, ...current });
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$text" } },
    paragraph: { text: { color: "$text" } },
    heading: { text: { color: "$accent" } },
    widget: { focusRing: { color: "$focus", width: 3, offset: 2 } },
    scrollArea: { parts: { bar: { background: "#5a6380", radius: 4 } } },
    dialog: { background: "#00000000", padding: 0, parts: { backdrop: { background: "#080c1a8c" } } },
  });
  ui.setTheme({ text: current.text!, muted: current["text-dim"]!, accent: current.accent!, focus: current.focus! });
}
/** A token's current colour (draw calls take real colours). */
export function token(name: string): string { return current[name] ?? "#000000"; }
