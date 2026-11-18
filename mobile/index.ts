import "expo-router/entry";
import { Platform } from "react-native";
import { registerWidgetTaskHandler } from "react-native-android-widget";

import { widgetTaskHandler } from "./src/android-widget";

// The Android home-screen widget's taps and updates, run headless with the app closed (src/android-widget.tsx).
if (Platform.OS === "android") registerWidgetTaskHandler(widgetTaskHandler);
