import { agents } from "../agent/agents.ts";
import type { ImportScan } from "../shared/ipc.ts";

/** One folder the import dialog offers, from this PC or a remote one. */
export interface ImportRow {
  /** `remote\0<destination>\0<path>` or `local\0<path>`. */
  id: string;
  kind: "remote" | "local";
  /** The PC it is on (destination); "" is this PC. */
  group: string;
  /** The folder's last path segment. */
  name: string;
  path: string;
  /** Which tools remembered it. */
  sources: string[];
  known: boolean;
  checked: boolean;
  /** Why the last attempt failed. */
  reason?: string;
  destination?: string;
  nodeId?: string;
}

export const CHIP_ORDER = ["VS Code", "Cursor", "Claude", "Codex", "OpenCode", "Grok", "Antigravity"];

const lastSegment = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** Remote folders per PC first, then this PC's; new ones start ticked, except the home folder. */
export function importRows(scan: ImportScan): ImportRow[] {
  const rows: ImportRow[] = [];
  for (const found of scan.remote) {
    for (const folder of found.folders) {
      rows.push({
        id: `remote\0${found.destination}\0${folder.path}`,
        kind: "remote",
        group: found.destination,
        name: lastSegment(folder.path),
        path: folder.path,
        sources: found.sources,
        known: folder.known,
        checked: !folder.known,
        destination: found.destination,
        nodeId: found.nodeId,
      });
    }
  }
  for (const found of scan.local) {
    rows.push({
      id: `local\0${found.path}`,
      kind: "local",
      group: "",
      name: lastSegment(found.path),
      path: found.path,
      sources: found.tools.map((tool) => agents[tool].short),
      known: found.known,
      checked: !found.known && found.path !== scan.home,
    });
  }
  return rows;
}

/** Source filters: only the tools that have rows, in a fixed order. */
export function importChips(rows: readonly ImportRow[]): Array<{ source: string; count: number }> {
  return CHIP_ORDER.map((source) => ({ source, count: rows.filter((row) => row.sources.includes(source)).length })).filter((chip) => chip.count > 0);
}

/** A result of undefined means the row is in; a string is why it is not. */
export function afterImport(
  rows: readonly ImportRow[],
  results: ReadonlyMap<string, string | undefined>,
): { rows: ImportRow[]; added: number; failed: number } {
  let added = 0;
  let failed = 0;
  const next = rows.map((row) => {
    if (!results.has(row.id)) return row;
    const reason = results.get(row.id);
    if (reason === undefined) {
      added += 1;
      const { reason: _gone, ...rest } = row;
      return { ...rest, known: true, checked: false };
    }
    failed += 1;
    return { ...row, reason };
  });
  return { rows: next, added, failed };
}
