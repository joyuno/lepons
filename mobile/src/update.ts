import Constants from "expo-constants";
import { Linking, Platform } from "react-native";

/** This build's version, as app.json says. */
export const installed = Constants.expoConfig?.version ?? "";

/** Set in eas.json's production-apk profile: the APK on GitHub and lepons.app, not Play's. */
const fromGithub = process.env.EXPO_PUBLIC_STORE === "github";

const APP_STORE = "https://apps.apple.com/app/id6829282468";
/** Play shows a closed-test tester the test version on the same page. */
const PLAY = "https://play.google.com/store/apps/details?id=app.lepons.mobile";
/** The latest release's APK, the same file lepons.app links to. */
const APK = "https://github.com/joyuno/lepons/releases/latest/download/Lepons-Android.apk";

/** True when x.y.z `a` is later than `b`. */
export const newerVersion = (a: string, b: string): boolean => {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

/**
 * The App Store's current version of this app, undefined when it cannot say.
 * ponytail: iPhone only; Play publishes no version to ask, so Android just offers its page.
 */
export async function storeVersion(): Promise<string | undefined> {
  if (Platform.OS !== "ios") return undefined;
  for (const country of ["", "&country=kr"]) {
    try {
      const reply = await fetch(`https://itunes.apple.com/lookup?bundleId=app.lepons.mobile${country}`);
      const version: unknown = (await reply.json())?.results?.[0]?.version;
      if (typeof version === "string") return version;
    } catch { /* offline: nothing to compare */ }
  }
  return undefined;
}

/**
 * Where this copy updates. A store app cannot replace itself, so this opens the place that can: the APK for a copy
 * from GitHub or lepons.app, Play for Play's (testers included), and on an iPhone the App Store -- or TestFlight
 * when this build is newer than the store's or the store has none, which only a TestFlight build can be.
 */
export function openUpdate(latest: string | undefined): void {
  if (Platform.OS === "android") {
    void Linking.openURL(fromGithub ? APK : PLAY);
    return;
  }
  const testflight = latest === undefined || newerVersion(installed, latest);
  if (testflight) void Linking.openURL("itms-beta://").catch(() => Linking.openURL(APP_STORE));
  else void Linking.openURL(APP_STORE);
}

/** The store page, as settings' 업데이트 opens it: the App Store's version is asked first, to tell TestFlight from the store. */
export const openStore = () => void storeVersion().then(openUpdate);
