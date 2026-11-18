import { ExtensionStorage } from "@bacons/apple-targets";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

import { showOnAndroid } from "./android-widget";
import { t } from "./i18n";
import type { PhoneSessionView } from "./phone/types";
import { widgetSnapshot } from "./phone/widget-snapshot";

/** The App Group the widget extension reads (app.json, targets/widget/expo-target.config.js). */
const storage = Platform.OS === "ios" ? new ExtensionStorage("group.app.lepons.mobile") : undefined;
/** Android's widget (android-widget.tsx) reads what the app keeps for it in its own storage. */
const android = Platform.OS === "android";

let written = "";
/** The last view sent, without its time: the time alone is no change. */
let lastBody = "";
let timer: ReturnType<typeof setTimeout> | undefined;
let next: string | undefined;

/** Sends what is waiting to the widget: at most every two seconds, and only when it changed. Not the time alone. */
function flush(): void {
  timer = undefined;
  if (next === undefined || next === written) return;
  written = next;
  if (android) return showOnAndroid(next);
  if (!storage) return;
  storage.set("snapshot", next || undefined);
  ExtensionStorage.reloadWidget();
}

const schedule = (json: string) => {
  next = json;
  if (!timer) timer = setTimeout(flush, json ? 2000 : 0);
};

/**
 * The widget's view of the PC in use, from the live list; nothing when no PC is signed in.
 * ponytail: written while the app has its link; with the app closed the widget keeps the last one (step 1).
 */
export function updateWidget(pc: string | undefined, sessions: readonly PhoneSessionView[] | undefined): void {
  if (!storage && !android) return;
  if (pc === undefined || sessions === undefined) {
    lastBody = "";
    schedule("");
    return;
  }
  const moodLabel = (mood: string) => (t as unknown as Record<string, string>)[`mood_${mood}`] ?? mood;
  const snap = widgetSnapshot(pc, sessions, {
    waiting: t.widgetWaiting, working: t.widgetWorking, done: t.widgetDone, open: t.widgetOpen, more: t.widgetMore, asks: t.widgetAsks, empty: t.widgetEmpty,
    failed: t.widgetFailed, changed: t.widgetChanged,
    moods: Object.fromEntries(["working", "waiting", "done", "failed", "idle", "shellOnly"].map((mood) => [mood, moodLabel(mood)])),
  }, moodLabel, 0);
  const body = JSON.stringify(snap);
  if (body === lastBody) return;
  lastBody = body;
  schedule(JSON.stringify({ ...snap, at: Date.now() }));
}

/**
 * What the iPhone widget needs to answer by itself (targets/widget/Relay.swift): this phone's key, the PC in use and the
 * sign-in. In the Keychain shared with the widget only (the App Group as access group), readable once the phone has
 * been unlocked since it started, as the app's own items. Nothing when no PC is signed in. Android's widget runs in
 * the app's own process and reads the app's sign-in from its store (android-widget.tsx), so it needs no copy.
 */
export async function updateWidgetLink(link: { key: string; room: string; pc: string; server: string; token: string } | undefined): Promise<void> {
  if (Platform.OS !== "ios") return;
  const options = { keychainService: "lepons.widget", accessGroup: "group.app.lepons.mobile", keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
  try {
    if (link) await SecureStore.setItemAsync("link", JSON.stringify(link), options);
    else await SecureStore.deleteItemAsync("link", options);
  } catch {
    // A Keychain that refuses leaves the widget showing, not answering: it opens the app instead.
  }
}
