import type { ConnectFailure } from "./connect.ts";

/** A private IPv4 address -- reachable only on that network. */
export function isLanAddress(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * Whether a failed connect looks like macOS 15+ Local Network privacy rather
 * than a real missing route. A denied app's socket gets "no route to host",
 * and TN3179 says the first attempt can be denied before the operator has
 * even answered the prompt -- so one retry, and then advice that names the
 * permission instead of "check you're on the same network". Only LAN
 * addresses and .local names: a VPN is not subject to it.
 * https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy
 */
export function localNetworkSuspect(reason: ConnectFailure, host: string, platform: NodeJS.Platform): boolean {
  return platform === "darwin" && reason === "no_route" && (isLanAddress(host) || /\.local\.?$/i.test(host));
}
