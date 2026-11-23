// "orientation": "portrait" makes Android imply android.hardware.screen.portrait as a required feature, and
// Play now refuses a release for it (devices without that feature could not install). The app only prefers
// portrait, so the feature is declared optional.
const { withAndroidManifest } = require("expo/config-plugins");

module.exports = (config) =>
  withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults.manifest;
    const features = (manifest["uses-feature"] ??= []);
    if (!features.some((feature) => feature.$["android:name"] === "android.hardware.screen.portrait")) {
      features.push({ $: { "android:name": "android.hardware.screen.portrait", "android:required": "false" } });
    }
    return mod;
  });
