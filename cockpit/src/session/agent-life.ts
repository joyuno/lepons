import { execFile } from "node:child_process";

/**
 * Whether a session's AI is still there, or only the terminal it ran in. A
 * session is "ready" as long as its shell or connection lives, however long ago
 * the AI left. Everything here answers one way only: "gone" when that is certain.
 * What cannot be told reads as not gone, and the lamp stays as it was.
 */

/** One session to ask about: its shell's process here, or its tmux session there. */
export interface AgentProbe {
  key: string;
  pid?: number;
  tmux?: string;
}

const runProcess = (file: string, args: string[]): Promise<string> => new Promise((resolve, reject) => {
  execFile(file, args, { windowsHide: true, timeout: 15_000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
});

/**
 * The shells here with no child left: at their prompt, so the AI launched in them
 * has ended. Any child at all stays "not gone", whatever it is: no list of agent
 * names to fall behind (each runs through its own cmd, node or wrapper), and a
 * shell running `git log` after the AI left is simply not told apart until it ends.
 * ponytail: a prompt theme that keeps a helper as a child (gitstatusd) means never gone; compare foreground process groups if that shows up.
 */
export async function shellsAlone(probes: AgentProbe[], run = runProcess, platform: NodeJS.Platform = process.platform): Promise<string[]> {
  const shells = probes.filter((probe) => probe.pid !== undefined);
  if (shells.length === 0) return [];
  // Measured at 0.6 to 0.8 s of one hidden process, on Windows 11. Only the parent ids
  // are read, never a command line. A conpty shell has no conhost under it.
  const filter = shells.map((probe) => `ParentProcessId=${probe.pid}`).join(" OR ");
  const [file, args]: [string, string[]] = platform === "win32"
    ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; (Get-CimInstance Win32_Process -Filter '${filter}' -Property ParentProcessId).ParentProcessId`]]
    : ["ps", ["-A", "-o", "ppid="]];
  const output = await run(file, args).catch(() => undefined);
  if (output === undefined) return [];
  const parents = new Set(output.split(/\s+/).filter(Boolean).map(Number));
  return shells.filter((probe) => !parents.has(probe.pid!)).map((probe) => probe.key);
}

/**
 * Every pane on a PC and whether it has died. Not `pane_current_command`: a launch
 * line with a fallback (`{ claude --continue || claude; }`) shows the shell's name
 * there while the AI runs, the same as a shell at its prompt (measured, tmux 3.8).
 * The AI is the pane's own command, so the pane ends with it.
 */
export const tmuxPanesScript = `tmux list-panes -a -F '#{session_name} #{pane_dead}' 2>&1; echo "@tmux $?"`;

/** The sessions with no living pane in `tmuxPanesScript`'s output. A failure it does not recognise says nothing. */
export function tmuxGone(output: string, probes: AgentProbe[]): string[] {
  const code = /^@tmux (\d+)\s*$/m.exec(output)?.[1];
  if (code === undefined) return [];
  // tmux's own words for "nothing is running", old and new, as tmux itself exits (1). Not a tmux that
  // cannot start (127, and its server may be up), a missing one, or a socket it may not read.
  if (code !== "0" && (code !== "1" || !/^(?:no server running|no sessions|error connecting to .*\(No such file or directory\))/m.test(output))) return [];
  // endsWith: an rc file's title or colour with no newline sits in front of the first pane.
  const lines = output.split(/\r?\n/);
  return probes.filter((probe) => probe.tmux !== undefined && !lines.some((line) => line.endsWith(`${probe.tmux} 0`))).map((probe) => probe.key);
}

/**
 * Who is gone, a newly gone one read twice: between one AI and the next, as in
 * `claude update & claude` or `resume || new`, a shell has no child for a moment.
 */
export async function confirmGone(read: () => Promise<string[]>, known: ReadonlySet<string>, wait: () => Promise<void>): Promise<Set<string>> {
  const first = new Set(await read());
  if ([...first].every((key) => known.has(key))) return first;
  await wait();
  return new Set((await read()).filter((key) => first.has(key)));
}

/**
 * What wants a look, as looks: one at a time, `gapMs` after the last one ended. One
 * wanted during a look still happens, after the gap: that look may have read too soon.
 */
export function spacedLooks(look: () => Promise<void>, gapMs: number): () => void {
  let timer: NodeJS.Timeout | undefined;
  let looking = false;
  let again = false;
  let endedAt = -Infinity;
  const want = (): void => {
    if (looking) again = true;
    if (looking || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      looking = true;
      void look().catch(() => undefined).finally(() => {
        looking = false;
        endedAt = Date.now();
        if (again) {
          again = false;
          want();
        }
      });
    }, Math.max(0, endedAt + gapMs - Date.now()));
    timer.unref();
  };
  return want;
}
