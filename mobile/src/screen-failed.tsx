import { Text } from "react-native";

import { t } from "@/i18n";
import { Button, Screen, useTheme } from "@/ui";

/** What a screen shows when drawing it threw: the route's `ErrorBoundary` export, so the other screens keep working. */
export function ScreenFailed({ retry }: { retry: () => Promise<void> }) {
  const { s } = useTheme();
  return (
    <Screen>
      <Text accessibilityRole="header" style={s.title}>{t.screenFailed}</Text>
      <Button title={t.retry} onPress={() => void retry()} />
    </Screen>
  );
}
