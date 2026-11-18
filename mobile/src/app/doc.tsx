import { setStringAsync } from "expo-clipboard";
import { useLocalSearchParams } from "expo-router";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";

import { useConnection, useTermSize } from "@/connection";
import { t } from "@/i18n";
import { inlineRuns } from "@/phone/chat";
import { codeLines, langOf, ROW_CHARS, type CodeLine, type TokenKind } from "@/phone/code-tokens";
import { canRenderMarkdown, documentKind } from "@/phone/document-kind";
import { replyBlocks } from "@/phone/reply";
import { fetchFile, fetchOutside, openInViewer, type FetchedFile, type OutsideRefusal } from "@/open-file";
import { utf8 } from "@/relay/protocol";
import { Button, font, mono, monoSizes, radius, Screen, SelectableText, size, space, useTheme } from "@/ui";

type Shown =
  | { kind: "loading" }
  | { kind: "gone"; why?: OutsideRefusal }
  | { kind: "text"; text: string; markdown: boolean }
  | { kind: "native"; largeMarkdown?: boolean };

/**
 * Markdown uses the same small text-only parser as chat. Files that need a
 * viewer never open this page from the files tab; one reached any other way
 * (a lepons://doc link, say) gets the button, as does a file too large to draw:
 * nothing leaves for another app without a press. `o=1`: `p` is a path outside
 * the folder as the agent printed it, read only, which the PC may refuse.
 */
export default function Doc() {
  const params = useLocalSearchParams<{ s: string; p: string; o?: string }>();
  const id = String(params.s ?? "");
  const path = String(params.p ?? "");
  const outside = params.o === "1";
  const c = useConnection();
  const { c: p, s } = useTheme();
  const kind = documentKind(path);
  const [view, setView] = useState<Shown>({ kind: "loading" });
  const [note, setNote] = useState("");

  /** A large file is shown as "open in another app": it should not cross the relay twice. */
  const fetched = useRef<FetchedFile | undefined>(undefined);
  const refused = useRef<OutsideRefusal | undefined>(undefined);
  const getFile = async () => {
    if (fetched.current || !outside) return (fetched.current ??= await fetchFile(c.request, id, path));
    const got = await fetchOutside(c.request, id, path);
    if (typeof got === "string") refused.current = got;
    else fetched.current = got;
    return fetched.current;
  };
  const why = (refusal: OutsideRefusal | undefined) =>
    refusal === "secret" ? t.outsideSecret : refusal === "big" ? t.outsideBig : refusal === "old" ? t.outsideOld : undefined;

  useEffect(() => {
    let live = true;
    const show = (next: Shown) => { if (live) setView(next); };
    fetched.current = undefined;
    refused.current = undefined;
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
        if (!file) return show({ kind: "gone", why: refused.current });
        if (!canRenderMarkdown(file.bin.byteLength)) return show({ kind: "native", largeMarkdown: true });
        let decoded: string | undefined;
        try { if (!file.bin.includes(0)) decoded = utf8(file.bin); } catch { /* binary file */ }
        if (kind === "markdown" && decoded !== undefined && !canRenderMarkdown(file.bin.byteLength, decoded)) return show({ kind: "native", largeMarkdown: true });
        // Markdown with a very long line or of great size reads as code: one paragraph of it would be a Text too big to draw.
        const drawable = decoded !== undefined && decoded.length <= 200_000 && !new RegExp(`[^\n]{${ROW_CHARS}}`).test(decoded);
        show(decoded === undefined ? { kind: "native" } : { kind: "text", text: decoded, markdown: kind === "markdown" && drawable });
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
      setNote(why(refused.current) ?? t.openUnavailable);
    }
  };

  // Code and other text get their own page: a list of lines, not one text
  // the size of the file, which a phone stops drawing past a certain height.
  if (view.kind === "text" && !view.markdown) return <Code path={path} text={view.text} outside={outside} />;

  return (
    <Screen>
      <Text style={s.crumbs} numberOfLines={2} ellipsizeMode="head" selectable>{crumbs(path)}{outside ? `  ·  ${t.outsideNote}` : ""}</Text>
      {view.kind === "loading" ? <Text style={s.empty}>{t.loading}</Text> : null}
      {view.kind === "gone" ? <Text style={s.empty}>{why(view.why) ?? t.docGone}</Text> : null}
      {view.kind === "text" ? <Markdown text={view.text} /> : null}
      {view.kind === "native" ? <>{view.largeMarkdown ? <Text style={s.dim}>{t.markdownTooLarge}</Text> : null}<Button title={t.openOtherApp} onPress={() => void openFile()} disabled={note === t.loading} /></> : null}
      {note ? <Text style={note === t.loading ? s.dim : s.error}>{note}</Text> : null}
    </Screen>
  );
}

/** The most a code file's 선택 view draws as one text: past it the file stays line by line, with 복사 for all of it. */
const SELECT_CHARS = 100_000;

/** "src/app/doc.tsx" as "src › app › doc.tsx". */
const crumbs = (path: string) => path.replace(/\\/g, "/").split("/").filter(Boolean).join(" › ");

/** About how wide a cell's text runs: wide (CJK) characters count double (the chat's Table). */
const cellWidth = (text: string) => Math.min(240, Math.max(56, [...text].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0x2e7f ? 14 : 8), 0) + 2 * space.sm));

type Block = ReturnType<typeof replyBlocks>[number];
/** Words, not a box: what runs together in one selectable text (as the chat's FlowText). */
const flows = (block: Block) => block.type !== "code" && block.type !== "table" && block.type !== "hr";

/**
 * Render only text and existing inline styles; Markdown cannot run scripts.
 * Paragraphs, headings, lists and quotes in a row are one SelectableText, so on
 * iOS part of them can be dragged over and copied, across paragraphs: a
 * selectable Text there copies only the whole of itself.
 */
function Markdown({ text }: { text: string }) {
  const { c: p, s } = useTheme();
  const inline = (value: string) => inlineRuns(value).map((run, i) => run.kind === "text" ? run.text
    : <Text key={i} style={run.kind === "bold" ? font.bold : { fontFamily: mono, backgroundColor: p.raise }}>{run.text}</Text>);
  const groups: Block[][] = [];
  for (const block of replyBlocks(text)) {
    const last = groups.at(-1);
    if (last && flows(block) && flows(last[0]!)) last.push(block);
    else groups.push([block]);
  }
  return <View style={{ gap: space.md }}>
    {groups.map((group, i) => {
      const block = group[0]!;
      if (flows(block)) return (
        <SelectableText key={i} style={s.text}>
          {group.map((part, j) => (
            <Fragment key={j}>
              {/* Between blocks a short empty line, about the gap the boxes had. */}
              {j > 0 ? <>{"\n"}<Text style={{ fontSize: 6, lineHeight: 12 }}>{"\n"}</Text></> : null}
              {part.type === "list" ? part.items.map((item, n) => (
                <Fragment key={n}>
                  {n > 0 ? "\n" : null}
                  <Text style={{ color: p.muted }}>{part.ordered ? `${(part.start ?? 1) + n}. ` : "•  "}</Text>
                  {inline(item)}
                </Fragment>
              ))
              : part.type === "quote" ? <Text style={{ color: p.muted }}><Text style={{ color: p.line }}>{"▎ "}</Text>{inline(part.text)}</Text>
              : part.type === "h" ? <Text style={font.bold}>{inline(part.text)}</Text>
              : part.type === "p" ? inline(part.text) : null}
            </Fragment>
          ))}
        </SelectableText>
      );
      if (block.type === "hr") return <View key={i} style={{ height: StyleSheet.hairlineWidth, backgroundColor: p.line }} />;
      if (block.type === "table") {
        const all = [block.head, ...block.rows];
        const widths = Array.from({ length: Math.max(...all.map((row) => row.length)) }, (_, j) => Math.max(...all.map((row) => cellWidth(row[j] ?? ""))));
        return <ScrollView key={i} horizontal style={{ flexGrow: 0 }} showsHorizontalScrollIndicator={false}>
          <View style={{ borderWidth: StyleSheet.hairlineWidth, borderColor: p.line, borderRadius: radius.sm, borderCurve: "continuous", overflow: "hidden" }}>
            {all.map((row, r) => <View key={r} style={{ flexDirection: "row", backgroundColor: r === 0 ? p.raise : undefined, borderTopWidth: r === 0 ? 0 : StyleSheet.hairlineWidth, borderTopColor: p.line }}>
              {widths.map((width, j) => <Text key={j} selectable style={[s.text, { width, fontSize: size.sub, lineHeight: 20, paddingHorizontal: space.sm, paddingVertical: space.xs }, r === 0 && font.semibold]}>{inline(row[j] ?? "")}</Text>)}
            </View>)}
          </View>
        </ScrollView>;
      }
      // A plain box that wraps, as in the chat: a sideways ScrollView measured one line of code as several.
      if (block.type === "code") return <View key={i} style={{ backgroundColor: p.raise, borderRadius: radius.sm, borderCurve: "continuous", padding: space.md }}><SelectableText style={s.mono}>{block.text}</SelectableText></View>;
      return null;
    })}
  </View>;
}

/**
 * A code file as a code viewer reads it: line numbers, colour, the mono size
 * picked in settings, long lines wrapped under their own number (or, turned
 * off, the page scrolls sideways), and the whole file one press from the
 * clipboard. A selection cannot cross rows, so 선택 shows the file as one text
 * to drag over, line breaks and all. An HTML file opens as the
 * page it draws, with scripts off and no way to leave it; its code is a press away.
 */
function Code({ path, text, outside }: { path: string; text: string; outside?: boolean }) {
  const { c: p, s } = useTheme();
  const sized = monoSizes[useTermSize()];
  const rows = useMemo(() => codeLines(text, langOf(path)), [text, path]);
  const [wrap, setWrap] = useState(true);
  const html = /^x?html?$/.test(langOf(path) ?? "");
  const [page, setPage] = useState(html);
  const [copied, setCopied] = useState(false);
  const [height, setHeight] = useState(0);
  const lines = rows.reduce((most, row) => Math.max(most, row.n ?? 0), 0);
  const gutter = (String(lines).length + 1) * sized.fontSize * 0.62;
  const colors: Record<TokenKind, string> = { plain: p.text, comment: p.muted, string: p.go, number: p.live, keyword: p.link, tag: p.link };
  // 선택: the whole file as one text, so a drag can run across lines (each row is a text of its own, and on iOS
  // a row copies only whole). No numbers there, so a copy carries none. Not past SELECT_CHARS: one text view draws all of it.
  const [selecting, setSelecting] = useState(false);
  const canSelect = text.length <= SELECT_CHARS;
  const tokens = (item: CodeLine) => item.tokens.map((token, i) => token.kind === "plain" ? token.text
    : <Text key={i} style={{ color: colors[token.kind], fontStyle: token.kind === "comment" ? "italic" : "normal" }}>{token.text}</Text>);
  const row = ({ item }: { item: CodeLine }) => (
    <View style={{ flexDirection: "row", paddingRight: space.md }}>
      <Text style={{ fontFamily: mono, ...sized, width: gutter, textAlign: "right", paddingRight: space.sm, color: p.dim }}>{item.n ?? ""}</Text>
      <Text selectable style={[{ fontFamily: mono, ...sized, color: p.text }, wrap && { flex: 1 }]}>{tokens(item)}</Text>
    </View>
  );
  const list = (
    <FlatList
      data={rows}
      renderItem={row}
      keyExtractor={(_, i) => String(i)}
      initialNumToRender={60}
      windowSize={15}
      style={wrap ? { flex: 1 } : { height }}
      contentContainerStyle={{ paddingVertical: space.md }}
    />
  );
  const tool = (label: string, onPress: () => void, on = false) => (
    <Pressable accessibilityRole="button" accessibilityState={{ selected: on }} onPress={onPress} hitSlop={8}
      style={({ pressed }) => ({ paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius.sm, borderWidth: 1, borderColor: on ? p.link : p.line, opacity: pressed ? 0.6 : 1 })}>
      <Text style={[s.dim, on && { color: p.link }]}>{label}</Text>
    </Pressable>
  );
  return (
    <SafeAreaView style={s.safe} edges={["bottom", "left", "right"]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: p.line, backgroundColor: p.card }}>
        <Text style={[s.crumbs, { flex: 1 }]} numberOfLines={1} ellipsizeMode="head">{crumbs(path)}</Text>
        {html ? tool(page ? t.viewCode : t.viewPage, () => setPage((on) => !on)) : null}
        {page || selecting ? null : tool(t.codeWrap, () => setWrap((on) => !on), wrap)}
        {page || !canSelect ? null : tool(t.codeSelect, () => setSelecting((on) => !on), selecting)}
        {tool(copied ? t.copied : t.copy, () => void setStringAsync(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }))}
      </View>
      {outside ? <Text style={[s.dim, { paddingHorizontal: space.lg, paddingVertical: space.xs, fontSize: size.caption, backgroundColor: p.raise }]}>{t.outsideNote}</Text> : null}
      {page ? (
        // No scripts, and no navigation: a tapped link or a form stays on this page.
        // Images and styles the page names on the web still load.
        <WebView
          style={{ flex: 1 }}
          source={{ html: text }}
          originWhitelist={["*"]}
          javaScriptEnabled={false}
          domStorageEnabled={false}
          setSupportMultipleWindows={false}
          allowFileAccess={false}
          onShouldStartLoadWithRequest={(request) => request.url.startsWith("about:") || request.url.startsWith("data:")}
        />
      ) : selecting && canSelect ? (
        <ScrollView style={{ flex: 1, backgroundColor: p.card }} contentContainerStyle={{ padding: space.md }}>
          {/* A cut row (no number) goes on the line before it: a copy keeps the file's own line breaks. */}
          <SelectableText style={{ fontFamily: mono, ...sized, color: p.text }}>
            {rows.map((item, i) => <Fragment key={i}>{i > 0 && item.n !== undefined ? "\n" : null}{tokens(item)}</Fragment>)}
          </SelectableText>
        </ScrollView>
      ) : (
        <View style={{ flex: 1, backgroundColor: p.card }} onLayout={(event) => setHeight(event.nativeEvent.layout.height)}>
          {wrap ? list : <ScrollView horizontal>{list}</ScrollView>}
        </View>
      )}
    </SafeAreaView>
  );
}
