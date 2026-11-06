import { useEffect, useState } from "react";
import { RefreshControl, Text, View } from "react-native";

import { useConnection } from "@/connection";
import { t } from "@/i18n";
import type { AccountState, PcAccounts } from "@/phone/types";
import { accountsOf } from "@/phone/validate";
import { font, Group, Lamp, Screen, Section, size, space, useTheme } from "@/ui";

/** The lamp for a sign-in: green in, red out, grey unknown or not installed. */
const lamp = { in: "live", out: "failed", unknown: "off", none: "off" } as const satisfies Record<AccountState, "live" | "failed" | "off">;

/** AI 계정, view only: each PC's agents and whether they are signed in. Signing in stays on the PC. */
export default function Accounts() {
  const c = useConnection();
  const { c: p, s } = useTheme();
  /** undefined while asking; null when the PC did not answer. */
  const [pcs, setPcs] = useState<PcAccounts | null>();
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    const reply = await c.request("GET", "/api/accounts", { timeoutMs: 30_000 }).catch(() => undefined);
    setPcs((reply?.status === 200 ? accountsOf(reply.body) : undefined) ?? null);
  };
  useEffect(() => {
    void load();
  }, []);

  return (
    <Screen refresh={<RefreshControl refreshing={refreshing} tintColor={p.muted} onRefresh={() => {
      setRefreshing(true);
      void load().finally(() => setRefreshing(false));
    }} />}>
      <Text style={s.dim}>{t.accountsHint}</Text>
      {pcs === undefined ? <Text style={s.empty}>{t.accountsLoading}</Text> : null}
      {pcs === null ? <Text style={s.error}>{t.accountsFailed}</Text> : null}
      {pcs?.map((pc, i) => (
        <Section key={`${pc.pc}-${i}`} title={pc.pc}>
          <Group>
            {pc.agents.map((agent) => (
              <View key={agent.name} style={[s.row, { minHeight: 44, paddingHorizontal: space.lg, paddingVertical: space.sm }]} accessible accessibilityLabel={`${agent.name}, ${t[`account_${agent.state}`]}`}>
                <Lamp state={lamp[agent.state]} />
                <Text style={[s.text, font.semibold, { flex: 1 }]} numberOfLines={1}>{agent.name}</Text>
                <Text style={[s.dim, { fontSize: size.footnote }]}>{t[`account_${agent.state}`]}</Text>
              </View>
            ))}
          </Group>
        </Section>
      ))}
    </Screen>
  );
}
