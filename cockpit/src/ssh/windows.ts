/**
 * A Windows PC reached over SSH. Lepons asks it to run Git for Windows' bash
 * as the login shell (see allow-ssh.ts), so the POSIX snippets used for Macs
 * and Linux boxes run there unchanged; what is left differs only in paths.
 */

/** `uname -s` under Git Bash, MSYS2 or Cygwin: MINGW64_NT-10.0-26200, MSYS_NT-…, CYGWIN_NT-…. */
export function isWindowsUname(output: string): boolean {
  return /^(MINGW|MSYS|CYGWIN)/i.test(output.trim());
}

/**
 * Windows' SFTP server names folders `/C:/Users/me`; the operator knows
 * `C:/Users/me`, and that is also what Git Bash, claude.exe and the SFTP
 * server itself all accept. Other paths pass through.
 */
export function fromSftpPath(path: string): string {
  const drive = /^\/([A-Za-z]:)(\/.*)?$/.exec(path);
  return drive ? drive[1]! + (drive[2] ?? "/") : path;
}
