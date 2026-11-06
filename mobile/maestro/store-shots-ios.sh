#!/usr/bin/env bash
# Store screenshots on the newest "Pro Max" simulator (6.9"): English and Korean.
# Run from mobile/ with Lepons.app built for the simulator. Leaves PNGs in store-shots/<locale>/.
set -euo pipefail

xcrun simctl list devicetypes | grep 'Pro Max'
dev=""
for type in $(xcrun simctl list devicetypes | grep -Eo 'SimDeviceType\.iPhone-[0-9]+-Pro-Max' | sort -t- -k2 -n -r); do
  dev=$(xcrun simctl create shots "com.apple.CoreSimulator.$type" 2> /dev/null) && { echo "device: $type"; break; }
done
[ -n "$dev" ]

for pair in en:en_US ko:ko_KR; do
  lang=${pair%%:*} loc=${pair#*:}
  xcrun simctl shutdown "$dev" 2> /dev/null || true
  xcrun simctl boot "$dev"
  xcrun simctl bootstatus "$dev" > /dev/null
  xcrun simctl spawn "$dev" defaults write -g AppleLanguages -array "$lang"
  xcrun simctl spawn "$dev" defaults write -g AppleLocale -string "$loc"
  # The language only takes effect after a reboot.
  xcrun simctl shutdown "$dev"
  xcrun simctl boot "$dev"
  xcrun simctl bootstatus "$dev" > /dev/null
  xcrun simctl status_bar "$dev" override --time 9:41 --batteryState charged --batteryLevel 100 --cellularBars 4 --wifiBars 3
  xcrun simctl install "$dev" Lepons.app
  # Fails here, not deep in Maestro, if the simulator will not run the build.
  xcrun simctl launch "$dev" app.lepons.mobile
  sleep 5
  xcrun simctl terminate "$dev" app.lepons.mobile
  rm -rf "out-$lang"
  maestro --device "$dev" test maestro/store-shots.yaml --test-output-dir="out-$lang"
  mkdir -p "store-shots/$lang"
  find "out-$lang" -path '*takeScreenshot/*.png' -exec cp {} "store-shots/$lang/" \;
done
