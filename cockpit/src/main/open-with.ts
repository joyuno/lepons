/**
 * "Open with Lepons": what a launch was asked to open, and the Explorer
 * menu entries (per user, no admin) that ask it. macOS hands paths over as
 * open-file events instead, and declares its types in package.json.
 */
import { execFile } from "node:child_process";
import { posix, win32 } from "node:path";

/**
 * The paths in a launch's argv. The exe comes first, and in development
 * (`electron .`) the app's folder after it. Chromium switches and anything
 * not an absolute path (a relative one has no folder to be relative to by
 * the time a second instance's argv arrives) are not paths to open.
 */
export function openArgs(argv: readonly string[], defaultApp: boolean): string[] {
  return argv.slice(defaultApp ? 2 : 1)
    // Explorer's "D:\" for a drive reads back as D:" -- the backslash escaped the closing quote.
    .map((arg) => (/^[A-Za-z]:"$/.test(arg) ? `${arg.slice(0, 2)}\\` : arg))
    .filter((arg) => !arg.startsWith("-") && (win32.isAbsolute(arg) || posix.isAbsolute(arg)));
}

/** Under HKCU\Software\Classes: files, folders, and a folder's empty space (%V, the folder shown). */
const MENU_KEYS = [
  ["*\\shell\\Lepons", "%1"],
  ["Directory\\shell\\Lepons", "%1"],
  ["Directory\\Background\\shell\\Lepons", "%V"],
] as const;

/** The reg.exe calls that point the menu entries at `exe`. Each is an argv: no shell sees the path. */
export function explorerMenuCalls(exe: string, label: string): string[][] {
  return MENU_KEYS.flatMap(([key, arg]) => {
    const full = `HKCU\\Software\\Classes\\${key}`;
    return [
      ["add", full, "/ve", "/d", label, "/f"],
      ["add", full, "/v", "Icon", "/d", `"${exe}",0`, "/f"],
      // Offered only when one item is selected: several folders at once would each start an AI chooser.
      ["add", full, "/v", "MultiSelectModel", "/d", "Single", "/f"],
      ["add", `${full}\\command`, "/ve", "/d", `"${exe}" "${arg}"`, "/f"],
    ];
  });
}

/**
 * Writes the entries on every start, so an update or a moved install keeps
 * them pointing at this exe. build/installer.nsh takes them out on uninstall.
 */
export async function registerExplorerMenu(exe: string, label: string): Promise<void> {
  for (const args of explorerMenuCalls(exe, label)) {
    await new Promise<void>((resolve) => execFile("reg.exe", args, { windowsHide: true, timeout: 5000 }, () => resolve()));
  }
}
