import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A scratch folder for a test, removed when the test process exits. Tests that
 * made their own with mkdtemp left them behind -- a thousand folders in temp
 * after a few dozen runs.
 *
 * On exit rather than in an after() hook: deleting the folders while the test
 * runner was finishing up made the local-terminal test hang about one run in
 * two on Windows, with node-pty still shutting its terminals down.
 */
const made: string[] = [];
process.on("exit", () => {
  for (const dir of made) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort: a folder still in use stays for the OS to clear.
    }
  }
});

export function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}
