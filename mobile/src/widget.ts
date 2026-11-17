import { ExtensionStorage } from "@bacons/apple-targets";
import { Platform } from "react-native";

import { t } from "./i18n";
import type { PhoneSessionView } from "./phone/types";
import { widgetSnapshot } from "./phone/widget-snapshot";

/** The App Group the widget extension reads (app.json, targets/widget/expo-target.config.js). */
const storage = Platform.OS === "ios" ? new ExtensionStorage("group.app.lepons.mobile") : undefined;

let written = "";
/** The last view sent, without its time: the time alone is no change. */
let lastBody = "";
let timer: ReturnType<typeof setTimeout> | undefined;
let next: string | undefined;

/** Sends what is waiting to the widget: at most every two seconds, and only when it changed. Not the time alone. */
function flush(): void {
  timer = undefined;
  if (!storage || next === undefined || next === written) return;
  written = next;
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
  if (!storage) return;
  if (pc === undefined || sessions === undefined) {
    lastBody = "";
    schedule("");
    return;
  }
  const snap = widgetSnapshot(pc, sessions, {
    waiting: t.widgetWaiting, working: t.widgetWorking, done: t.widgetDone, open: t.widgetOpen, more: t.widgetMore, asks: t.widgetAsks, empty: t.widgetEmpty,
  }, (mood) => (t as unknown as Record<string, string>)[`mood_${mood}`] ?? mood, 0);
  const body = JSON.stringify(snap);
  if (body === lastBody) return;
  lastBody = body;
  schedule(JSON.stringify({ ...snap, at: Date.now() }));
}
