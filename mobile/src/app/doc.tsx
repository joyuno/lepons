import { useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";

import { useConnection } from "@/connection";
import { t } from "@/i18n";
import { inlineRuns, markdownBlocks } from "@/phone/chat";
import { canRenderMarkdown, documentKind } from "@/phone/document-kind";
import { fetchFile, openInViewer, type FetchedFile } from "@/open-file";
import { utf8 } from "@/relay/protocol";
import { Button, font, mono, radius, Screen, size, space, useTheme } from "@/ui";

type Shown =
  | { kind: "loading" }
  | { kind: "gone" }
  | { kind: "text"; text: string; markdown: boolean }
  | { kind: "native"; largeMarkdown?: boolean };

/**
 * Markdown uses the same small text-only parser as chat. Files that need a
 * viewer never open this page from the files tab; one reached any other way
 * (a lepons://doc link, say) gets the button, as does a file too large to draw:
 * nothing leaves for another app without a press.
 */
export default function Doc() {
  const params = useLocalSearchParams<{ s: string; p: string }>();
  const id = String(params.s ?? "");
  const path = String(params.p ?? "");
  const c = useConnection();
  const { c: p, s } = useTheme();
  const kind = documentKind(path);
  const [view, setView] = useState<Shown>({ kind: "loading" });
  const [note, setNote] = useState("");

  /** A large file is shown as "open in another app": it should not cross the relay twice. */
  const fetched = useRef<FetchedFile | undefined>(undefined);
  const getFile = async () => (fetched.current ??= await fetchFile(c.request, id, path));

  useEffect(() => {
    let live = true;
    const show = (next: Shown) => { if (live) setView(next); };
    fetched.current = undefined;
    setView({ kind: "loading" });
    setNote("");
    if (path === "" || path.split("/").includes("..")) {
      show({ kind: "gone" });
      return () => { live = false; };
    }
    if (kind === "native") {
      show({ kind: "native" });
      return () => { live = false; };
    }
    void (async () => {
      try {
        const file = await getFile();
        if (!file) return show({ kind: "gone" });
        if (!canRenderMarkdown(file.bin.byteLength)) return show({ kind: "native", largeMarkdown: true });
        let decoded: string | undefined;
        try { if (!file.bin.includes(0)) decoded = utf8(file.bin); } catch { /* binary file */ }
        if (kind === "markdown" && decoded !== undefined && !canRenderMarkdown(file.bin.byteLength, decoded)) return show({ kind: "native", largeMarkdown: true });
        show(decoded === undefined ? { kind: "native" } : { kind: "text", text: decoded, markdown: kind === "markdown" });
      } catch {
        show({ kind: "gone" });
      }
    })();
    return () => { live = false; };
  }, [id, path]);

  const openFile = async () => {
    setNote(t.loading);
    try {
      const file = await getFile();
      if (!file) throw new Error("file");
      const opened = await openInViewer(file, path);
      setNote(opened ? "" : t.openUnavailable);
    } catch {
      setNote(t.openUnavailable);
    }
  };

  return (
    <Screen>
      <View style={s.pathBox}>
        <Text style={s.mono} selectable>{path.split("/").join(" / ")}</Text>
      </View>
      {view.kind === "loading" ? <Text style={s.empty}>{t.loading}</Text> : null}
      {view.kind === "gone" ? <Text style={s.empty}>{t.docGone}</Text> : null}
      {view.kind === "text" ? (
        <>
          {view.markdown ? <Markdown text={view.text} /> : <Text style={[s.mono, { fontSize: size.sub, lineHeight: 21 }]} selectable>{view.text}</Text>}
        </>
      ) : null}
      {view.kind === "native" ? <>{view.largeMarkdown ? <Text style={s.dim}>{t.markdownTooLarge}</Text> : null}<Button title={t.openOtherApp} onPress={() => void openFile()} disabled={note === t.loading} /></> : null}
      {note ? <Text style={note === t.loading ? s.dim : s.error}>{note}</Text> : null}
    </Screen>
  );
}

/** Render only text and existing inline styles; Markdown cannot run scripts. */
function Markdown({ text }: { text: string }) {
  const { c: p, s } = useTheme();
  const inline = (value: string) => inlineRuns(value).map((run, i) => run.kind === "text" ? run.text
    : <Text key={i} style={run.kind === "bold" ? font.bold : { fontFamily: mono, backgroundColor: p.raise }}>{run.text}</Text>);
  return <View style={{ gap: space.md }}>
    {markdownBlocks(text).map((block, i) => {
      if (block.type === "code") return <ScrollView key={i} horizontal style={{ backgroundColor: p.raise, borderRadius: radius.sm }} contentContainerStyle={{ padding: space.md }}><Text selectable style={s.mono}>{block.text}</Text></ScrollView>;
      if (block.type === "list") return <View key={i} style={{ gap: space.xs }}>{block.items.map((item, n) => <View key={n} style={{ flexDirection: "row", gap: space.sm }}><Text style={s.text}>{block.ordered ? `${n + 1}.` : "•"}</Text><Text selectable style={[s.text, { flex: 1 }]}>{inline(item)}</Text></View>)}</View>;
      return <Text key={i} selectable accessibilityRole={block.type === "h" ? "header" : undefined} style={[s.text, block.type === "h" && font.bold, block.type === "quote" && { color: p.muted, borderLeftWidth: 3, borderLeftColor: p.line, paddingLeft: space.md }]}>{inline(block.text)}</Text>;
    })}
  </View>;
}
