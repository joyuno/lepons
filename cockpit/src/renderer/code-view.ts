import hljs from "highlight.js/lib/common";
import dos from "highlight.js/lib/languages/dos";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import powershell from "highlight.js/lib/languages/powershell";

// Beyond highlight.js's common set: what these nodes and this Windows host
// actually hold -- PowerShell and batch scripts, and Dockerfiles.
hljs.registerLanguage("dos", dos);
hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("powershell", powershell);

/** Whole names that say the language where there is no extension to. */
const byName: Record<string, string> = { dockerfile: "dockerfile", makefile: "makefile" };

/**
 * Highlighting runs on the renderer's thread, the same one every terminal
 * draws on, so past this size a file is shown plain rather than freezing them.
 */
// ponytail: fixed cut-off; highlight in a worker if large files need colour.
const HIGHLIGHT_LIMIT = 512 * 1024;

/** The highlight.js language for a file, or undefined when none fits. */
export function languageOf(name: string): string | undefined {
  const lower = name.toLowerCase();
  if (Object.hasOwn(byName, lower)) return byName[lower];
  const dot = lower.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const ext = lower.slice(dot + 1);
  return hljs.getLanguage(ext) ? ext : undefined;
}

/**
 * A text file as HTML for the code view: coloured where its language is
 * known, and always escaped -- highlight.js escapes what it emits, plaintext
 * included, which is what makes the result safe to set as markup.
 */
export function renderCode(name: string, text: string): string {
  const language = text.length <= HIGHLIGHT_LIMIT ? languageOf(name) : undefined;
  return hljs.highlight(text, { language: language ?? "plaintext", ignoreIllegals: true }).value;
}
