import * as SecureStore from "expo-secure-store";
import { getRandomBytes } from "expo-crypto";
import { File, Paths } from "expo-file-system";

import { forgetOpened } from "./open-file.ts";
import { chatMemory } from "./phone/chat-rows.ts";
import { draftBook } from "./phone/drafts.ts";
import { outbox } from "./phone/outbox.ts";
import { DEFAULT_SERVER, bytesToHex, hexToBytes, keyPairFromPrivate, validServer, type KeyPair } from "./relay/protocol.ts";
import type { Spot } from "../../cockpit/src/renderer/workflowmap/hold.ts";

/** Everything lives in the Keychain / Keystore, readable only while the phone is unlocked once. */
const options = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

export interface Pairing {
  roomId: string;
  pcStaticPub: Uint8Array;
}

const get = (key: string) => SecureStore.getItemAsync(key, options);
const set = (key: string, value: string) => SecureStore.setItemAsync(key, value, options);
const del = (key: string) => SecureStore.deleteItemAsync(key, options);

/** Text typed but not sent. In the Keychain, not a file: it can hold anything private; drafts.ts cuts it to fit. */
export const drafts = draftBook({ get, set, del });
/** Text on its way to the PC, per session: it outlives the box that sent it. */
export const sends = outbox(drafts);
/** The chats seen since the app started, so one opens at once. In memory only. */
export const chats = chatMemory();

/** The phone's static key pair: made once per install, never leaves the device. */
export async function phoneKey(): Promise<KeyPair> {
  const saved = await get("phoneKey");
  if (saved && /^[0-9a-f]{64}$/.test(saved)) return keyPairFromPrivate(hexToBytes(saved));
  const pair = keyPairFromPrivate(getRandomBytes(32));
  await set("phoneKey", bytesToHex(pair.privateKey));
  return pair;
}

export async function loadPairing(): Promise<Pairing | undefined> {
  const raw = await get("pairing");
  if (!raw) return undefined;
  try {
    const p = JSON.parse(raw) as { roomId?: unknown; pcStaticPub?: unknown };
    if (typeof p.roomId === "string" && /^[0-9a-f]{32}$/.test(p.roomId) && typeof p.pcStaticPub === "string" && /^[0-9a-f]{64}$/.test(p.pcStaticPub)) {
      return { roomId: p.roomId, pcStaticPub: hexToBytes(p.pcStaticPub) };
    }
  } catch {}
  return undefined;
}

export async function savePairing(pairing: Pairing): Promise<void> {
  await set("pairing", JSON.stringify({ roomId: pairing.roomId, pcStaticPub: bytesToHex(pairing.pcStaticPub) }));
}

/** Forgets the PC and its sign-in; the phone's own key stays. */
export async function clearPairing(): Promise<void> {
  await Promise.all([del("pairing"), del("token"), drafts.clear()]);
  forgetOpened();
  // The project and PC names in it go with the PC, as the privacy page says.
  mapSpots = {};
  try {
    spotsFile().delete();
  } catch {}
}

export async function loadServer(): Promise<string> {
  const saved = await get("server");
  return saved && validServer(saved) ? saved : DEFAULT_SERVER;
}

export async function saveServer(server: string): Promise<void> {
  if (!validServer(server)) throw new Error("bad server");
  await set("server", server);
}

export const loadToken = async () => (await get("token")) || undefined;
export const saveToken = (token: string) => (token ? set("token", token) : del("token"));

/** "입력 대기 알림" turned off in settings; on unless the user said so. */
export const loadPushOff = async () => (await get("pushOff")) === "1";
export const savePushOff = (off: boolean) => (off ? set("pushOff", "1") : del("pushOff"));

/** "완료 요약 알림" turned off; on unless the user said so. */
export const loadDoneOff = async () => (await get("doneOff")) === "1";
export const saveDoneOff = (off: boolean) => (off ? set("doneOff", "1") : del("doneOff"));

/** The session screen's terminal text size; medium unless picked. */
export type TermSize = "small" | "medium" | "large";
export const loadTermSize = async (): Promise<TermSize> => {
  const saved = await get("termSize");
  return saved === "small" || saved === "large" ? saved : "medium";
};
export const saveTermSize = (size: TermSize) => (size === "medium" ? del("termSize") : set("termSize", size));

/**
 * Light or dark as the owner picked it; nothing until the first press, and the phone's own setting rules. A file like the
 * map's spots: it is no secret, and it is read before the first draw, so it must not wait on the Keychain.
 */
export type Scheme = "light" | "dark";
const schemeFile = () => new File(Paths.document, "scheme.txt");
export function loadScheme(): Scheme | undefined {
  try {
    const saved = schemeFile().textSync();
    return saved === "light" || saved === "dark" ? saved : undefined;
  } catch {
    return undefined;
  }
}
export function saveScheme(scheme: Scheme): void {
  try {
    schemeFile().writeSync(scheme);
  } catch {}
}

/**
 * Where projects were moved on the map, per PC. A file, not the map's web view: Android's has no
 * localStorage (@expo/dom-webview leaves DOM storage off), and not the Keychain, which is for secrets
 * and may refuse a value over 2 KB.
 */
export type MapSpots = Record<string, Record<string, Spot>>;
const spotsFile = () => new File(Paths.document, "map-spots.json");
let mapSpots: MapSpots | undefined;
export function loadMapSpots(): MapSpots {
  if (!mapSpots) {
    try {
      mapSpots = JSON.parse(spotsFile().textSync()) as MapSpots;
    } catch {
      mapSpots = {};
    }
  }
  return mapSpots;
}
export function saveMapSpot(pc: string, id: string, spot: Spot): MapSpots {
  const spots = loadMapSpots();
  mapSpots = { ...spots, [pc]: { ...spots[pc], [id]: spot } };
  try {
    spotsFile().writeSync(JSON.stringify(mapSpots));
  } catch {}
  return mapSpots;
}
