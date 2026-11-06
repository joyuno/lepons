#!/usr/bin/env bash
# Store screenshots on the emulator (pixel_2 profile, 1080x1920): English, English dark, Korean.
# Run from mobile/ with the release APK installed. Leaves PNGs in store-shots/<set>/.
set -euo pipefail

statusbar() {
  adb shell settings put global sysui_demo_allowed 1
  d() { adb shell am broadcast -a com.android.systemui.demo -e command "$@" > /dev/null; }
  d enter
  d clock -e hhmm 0941
  d battery -e level 100 -e plugged false
  d network -e wifi show -e level 4 -e fully true
  d network -e mobile show -e datatype none -e level 4 -e fully true
  d notifications -e visible false
}

shoot() {
  rm -rf "out-$1"
  maestro test maestro/store-shots.yaml --test-output-dir="out-$1"
  mkdir -p "store-shots/$1"
  find "out-$1" -path '*takeScreenshot/*.png' -exec cp {} "store-shots/$1/" \;
}

statusbar
shoot en

adb shell cmd uimode night yes
shoot en-dark
adb shell cmd uimode night no

# Restart the framework with the new system locale (needs root; google_apis images allow it).
# The restart leaves a "system isn't responding" dialog over the app; the framework reads this on start and shows none.
adb shell settings put global hide_error_dialogs 1
adb root
adb wait-for-device
adb shell "setprop persist.sys.locale ko-KR; setprop sys.boot_completed 0; stop; sleep 2; start"
adb wait-for-device
for _ in $(seq 90); do
  [ "$(adb shell getprop sys.boot_completed | tr -d '\r')" = 1 ] && break
  sleep 2
done
sleep 15
adb shell input keyevent 82
echo "locale: $(adb shell getprop persist.sys.locale)"
statusbar
shoot ko
