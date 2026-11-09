import { Linking, Platform, Text } from "react-native";

import { t } from "@/i18n";
import { Group, GroupRow, Screen, useTheme } from "@/ui";

// Bundled fonts and the main runtime libraries; each opens its full license text.
// SF Symbols are drawn by iOS itself and are not shipped in the app.
const items: Array<[name: string, license: string, url: string]> = [
  ["Pretendard © 2021 Kil Hyung-jin", "SIL Open Font License 1.1", "https://github.com/orioncactus/pretendard/blob/main/LICENSE"],
  // The icons shipped on the other platform only; iOS draws SF Symbols itself.
  ...(Platform.OS === "android" ? [["Material Symbols © Google", "Apache License 2.0", "https://github.com/google/material-design-icons/blob/master/LICENSE"] as [string, string, string]] : []),
  ["React Native © Meta Platforms", "MIT", "https://github.com/facebook/react-native/blob/main/LICENSE"],
  ["React © Meta Platforms", "MIT", "https://github.com/facebook/react/blob/main/LICENSE"],
  ["Expo © 650 Industries", "MIT", "https://github.com/expo/expo/blob/main/LICENSE"],
  ["react-native-screens © Software Mansion", "MIT", "https://github.com/software-mansion/react-native-screens/blob/main/LICENSE"],
  ["react-native-gesture-handler © Software Mansion", "MIT", "https://github.com/software-mansion/react-native-gesture-handler/blob/main/LICENSE"],
  ["react-native-safe-area-context © Th3rd Wave", "MIT", "https://github.com/AppAndFlow/react-native-safe-area-context/blob/main/LICENSE"],
  ["noble-ciphers © Paul Miller", "MIT", "https://github.com/paulmillr/noble-ciphers/blob/main/LICENSE"],
  ["noble-curves © Paul Miller", "MIT", "https://github.com/paulmillr/noble-curves/blob/main/LICENSE"],
  ["noble-hashes © Paul Miller", "MIT", "https://github.com/paulmillr/noble-hashes/blob/main/LICENSE"],
  ["xterm.js © The xterm.js authors", "MIT", "https://github.com/xtermjs/xterm.js/blob/master/LICENSE"],
  ["d3-force © Mike Bostock", "ISC", "https://github.com/d3/d3-force/blob/main/LICENSE"],
];

export default function Licenses() {
  const { s } = useTheme();
  return (
    <Screen>
      <Text style={s.dim}>{t.licensesHint}</Text>
      <Group>
        {items.map(([name, license, url]) => <GroupRow key={name} title={name} detail={license} onPress={() => void Linking.openURL(url)} />)}
      </Group>
    </Screen>
  );
}
