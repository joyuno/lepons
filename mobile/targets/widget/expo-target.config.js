// The home-screen widget (WidgetKit, Swift): the PC in use's sessions, or the newest question waiting
// on it. The app writes what it shows into the App Group (src/widget.ts); see
// docs/superpowers/specs/2026-11-17-phone-widget-design.md.
/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: "widget",
  name: "LeponsWidget",
  // Interactive widgets (a button that answers in place, the next step) need iOS 17.
  deploymentTarget: "17.0",
  // Lepons' own palette (src/ui.tsx), light and dark.
  colors: {
    wBg: { light: "#ffffff", dark: "#171e26" },
    wRaise: { light: "#e9ebef", dark: "#1e2731" },
    wText: { light: "#1f2328", dark: "#cdd6e0" },
    wMuted: { light: "#59636e", dark: "#909cab" },
    wGo: { light: "#1a7f37", dark: "#3fb950" },
    wLive: { light: "#9a5f0a", dark: "#e8a33d" },
    wStop: { light: "#c42f33", dark: "#ec5d5e" },
    wIdle: { light: "#b6bec7", dark: "#3a4552" },
  },
  entitlements: {
    "com.apple.security.application-groups": config.ios.entitlements["com.apple.security.application-groups"],
  },
});
