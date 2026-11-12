// The settings window's left tabs and the theme choice. Pure, so it is tested.

export type SettingsTab = "theme" | "font" | "language" | "startup" | "agents" | "llmKeys" | "tokens" | "allow" | "key" | "remotes" | "phone" | "pet" | "update" | "tour" | "about";

const TABS: SettingsTab[] = ["agents", "llmKeys", "tokens", "update", "remotes", "phone", "theme", "font", "language", "startup", "pet", "allow", "key", "tour", "about"];

// Allowing other PCs in (sshd) is only set up by Lepons on Windows.
export function settingsTabs(platform: string): SettingsTab[] {
  return platform === "win32" ? [...TABS] : TABS.filter((tab) => tab !== "allow");
}

export type ThemeChoice = "light" | "dark" | "system";

export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): "light" | "dark" {
  if (choice === "system") return prefersDark ? "dark" : "light";
  return choice;
}

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === "light" || value === "dark" || value === "system";
}

/** Code font size for terminals and file views, in px; 13 is the terminal's size before this setting. */
export const FONT_SIZE = { min: 10, max: 24, default: 13 };

export function fontSize(value: unknown): number {
  const size = Math.round(Number(value));
  return Number.isFinite(size) && value !== null && value !== "" ? Math.min(FONT_SIZE.max, Math.max(FONT_SIZE.min, size)) : FONT_SIZE.default;
}

/** Code font presets; "" keeps today's stack. D2Coding, JetBrains Mono and Fira Code ship with the app; the Windows ones fall through to that stack elsewhere. */
export const FONT_FAMILIES = ["", "D2Coding", "JetBrains Mono", "Fira Code", "Cascadia Mono", "Consolas"];

export function fontFamily(value: unknown): string {
  return typeof value === "string" && FONT_FAMILIES.includes(value) ? value : "";
}

/** The picked preset in front of a base stack. */
export function fontStack(family: string, base: string): string {
  return family ? `"${family}", ${base}` : base;
}
