/**
 * @xterm/headless reads navigator.userAgent and navigator.platform at load
 * time (`.includes("Firefox")` …) unless it thinks it runs under Node. React
 * Native's navigator has neither, so importing it crashed the session screen.
 * Import this before @xterm/headless.
 */
const nav = (globalThis as unknown as { navigator?: Record<string, unknown> }).navigator;
if (nav) {
  if (typeof nav.userAgent !== "string") nav.userAgent = "ReactNative";
  if (typeof nav.platform !== "string") nav.platform = "";
} else {
  (globalThis as unknown as { navigator?: Record<string, unknown> }).navigator = { userAgent: "ReactNative", platform: "" };
}

export {};
