import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { t } from "./i18n.ts";

// A push that lands while the app is open still shows, quietly.
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
});

/**
 * Asks for notifications (Android 13+ and iOS ask the user) and returns this
 * install's Expo push token; undefined when the user said no. The channel
 * comes first: Android shows no prompt without one.
 */
export async function expoPushToken(): Promise<string | undefined> {
  if (Platform.OS === "web") return undefined;
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("waiting", { name: t.mood_waiting, importance: Notifications.AndroidImportance.HIGH });
    // The all-done push: shown, never heard.
    await Notifications.setNotificationChannelAsync("done", { name: t.channelDone, importance: Notifications.AndroidImportance.LOW, sound: null, enableVibrate: false });
  }
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== "granted") status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== "granted") return undefined;
  const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
  return (await Notifications.getExpoPushTokenAsync({ projectId })).data;
}

/** The session a tapped push names (the PC's opaque id), or undefined. */
export function tappedSession(response: Notifications.NotificationResponse | null | undefined): string | undefined {
  const session = response?.notification.request.content.data?.session;
  return typeof session === "string" && /^[0-9a-f]{16}$/.test(session) ? session : undefined;
}

/** A tapped push that names no one session (several waiting, or all done): the sessions tab. */
export const tappedList = (response: Notifications.NotificationResponse | null | undefined): boolean =>
  response?.notification.request.content.data?.open === "sessions";
