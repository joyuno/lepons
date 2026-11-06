/** If the installed viewer fails, leave the user the system share sheet. */
export async function previewOrShare(preview: () => Promise<boolean>, share: () => Promise<boolean>): Promise<boolean> {
  try { if (await preview()) return true; } catch { /* Try sharing below. */ }
  try { return await share(); } catch { return false; }
}
