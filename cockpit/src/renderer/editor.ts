import { basicSetup } from "codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { Compartment, EditorState } from "@codemirror/state";
import { LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { markdown } from "@codemirror/lang-markdown";
import { classHighlighter } from "@lezer/highlight";

/**
 * The editor a file pane switches to: CodeMirror 6, the engine Obsidian's own
 * editor is built on. Colours come from the app's CSS variables, so it follows
 * the dark/light switch; syntax uses classHighlighter's `tok-*` classes, styled
 * in index.html with the same VS Code palette as the read-only code view.
 */
const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--ground)", color: "var(--text)" },
  ".cm-scroller": { fontFamily: "var(--code-font, var(--mono))", fontSize: "var(--code-size, 12.5px)", lineHeight: "1.55" },
  ".cm-gutters": { backgroundColor: "var(--ground)", color: "var(--muted)", borderRight: "1px solid var(--line)" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "color-mix(in srgb, var(--text) 6%, transparent)" },
  ".cm-cursor": { borderLeftColor: "var(--live)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "color-mix(in srgb, var(--link) 35%, transparent)",
  },
  ".cm-panels": { backgroundColor: "var(--panel)", color: "var(--text)" },
});

export function createEditor(
  parent: HTMLElement,
  text: string,
  name: string,
  on: { change(): void; save(): void },
): EditorView {
  const language = new Compartment();
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      extensions: [
        // First, so it wins over anything basicSetup binds.
        keymap.of([{ key: "Mod-s", preventDefault: true, run: () => (on.save(), true) }]),
        basicSetup,
        syntaxHighlighting(classHighlighter),
        theme,
        language.of([]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) on.change();
        }),
      ],
    }),
  });
  if (/\.(md|markdown)$/i.test(name)) {
    view.dispatch({ effects: language.reconfigure(markdown({ codeLanguages: languages })) });
  } else {
    void LanguageDescription.matchFilename(languages, name)
      ?.load()
      .then((support) => view.dispatch({ effects: language.reconfigure(support) }));
  }
  return view;
}
