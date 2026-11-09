/**
 * Where the PC saved a phone's photo or file (cockpit/src/phone/server.ts
 * uploadName): "<temp>/lepons-phone-1a2b3c4d-IMG-0042.jpg", quoted when the
 * temp folder has a space. Its name part and extension, for "@IMG-0042.jpg".
 */
const uploaded = /"[^"\n]*lepons-phone-[0-9a-f]{8}(?:-([A-Za-z0-9_-]+))?(?:\.([a-z0-9]{1,8}))?"|[^\s"]*lepons-phone-[0-9a-f]{8}(?:-([A-Za-z0-9_-]+))?(?:\.([a-z0-9]{1,8}))?(?![^\s"])/g;
const pictures = new Set(["jpg", "jpeg", "png", "gif", "webp", "heic", "bmp"]);

/** A message as the chat shows it: each uploaded file's long path as "@name", or "@image" / "@file" when it kept no name. */
export function shownUploads(text: string): string {
  return text.replace(uploaded, (_whole, quotedName?: string, quotedExt?: string, name?: string, ext?: string) => {
    const base = quotedName ?? name;
    const kind = quotedExt ?? ext;
    if (!base) return kind && pictures.has(kind) ? "@image" : "@file";
    return `@${base}${kind ? `.${kind}` : ""}`;
  });
}

/**
 * A message that came back unsent, taken apart again: the saved paths it
 * starts with (withUploads puts them there), and the words after them.
 */
export function splitUploads(text: string): { paths: string[]; words: string } {
  const paths: string[] = [];
  let rest = text;
  for (;;) {
    const match = /^\s*(?:"([^"\n]*lepons-phone-[0-9a-f]{8}[^"\n]*)"|([^\s"]*lepons-phone-[0-9a-f]{8}[^\s"]*))(?=\s|$)/.exec(rest);
    if (!match) break;
    paths.push(match[1] ?? match[2]!);
    rest = rest.slice(match[0].length);
  }
  return { paths, words: rest.trim() };
}

/** The name a saved path shows as in a chip: "IMG-0042.jpg", or "image.png" / "file" when it kept none. */
export const uploadedName = (path: string): string => shownUploads(path.includes(" ") ? `"${path}"` : path).replace(/^@/, "");

/** What goes to the PC: the saved paths first (quoted when they hold a space), then the words. */
export function withUploads(text: string, paths: readonly string[]): string {
  return [...paths.map((path) => (/\s/.test(path) ? `"${path}"` : path)), text.trim()].filter(Boolean).join(" ");
}
