import * as SecureStore from "expo-secure-store";
import { getRandomBytes } from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";

import { forgetOpened } from "./open-file.ts";
import { chatMemory } from "./phone/chat-rows.ts";
import { draftBook } from "./phone/drafts.ts";
import { outbox } from "./phone/outbox.ts";
import { savedBook, type SavedDisk } from "./phone/saved.ts";
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

/** saved.ts's paths, under the app's documents: a cache folder the OS may empty is no place for what offline shows. */
const savedDisk: SavedDisk = {
  read(path) {
    const file = new File(Paths.document, path);
    return file.exists ? file.bytesSync() : undefined;
  },
  write(path, bytes) {
    const file = new File(Paths.document, path);
    file.parentDirectory.create({ intermediates: true, idempotent: true });
    const tmp = new File(Paths.document, `${path}.tmp`);
    tmp.writeSync(bytes);
    // ponytail: expo-file-system's overwrite deletes the old file just before the rename, so a kill in that gap loses the copy (never leaves half of one); a native replace would close it.
    tmp.moveSync(file, { overwrite: true });
  },
  remove(path) {
    const dir = new Directory(Paths.document, path);
    if (dir.exists) return dir.delete();
    const file = new File(Paths.document, path);
    if (file.exists) file.delete();
  },
  list(path) {
    const dir = new Directory(Paths.document, path);
    if (!dir.exists) return [];
    return dir.list().flatMap((one) => (one instanceof File ? [{ name: one.name, modified: one.lastModified ?? 0 }] : []));
  },
};

/**
 * The key that seals the saved copies, made once per install. A Keychain that throws (locked) gives none and makes none:
 * a new key then would orphan every copy sealed with the old one. Asked once and kept: two first writes at once would
 * each make a key, and the copy sealed with the lost one would read as broken.
 */
let savedKeyNow: Promise<Uint8Array | undefined> | undefined;
const savedKey = () => (savedKeyNow ??= readSavedKey().then((key) => {
  if (!key) savedKeyNow = undefined;
  return key;
}));
async function readSavedKey(): Promise<Uint8Array | undefined> {
  try {
    const hex = await get("savedKey");
    if (hex && /^[0-9a-f]{64}$/.test(hex)) return hexToBytes(hex);
    const key = getRandomBytes(32);
    await set("savedKey", bytesToHex(key));
    return key;
  } catch {
    return undefined;
  }
}

/** The last list, bots and chats of each PC, for when it cannot be reached (saved.ts). */
export const saved = savedBook({
  disk: savedDisk, key: savedKey, random: getRandomBytes,
  timer: { set: (run, ms) => setTimeout(run, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
  now: Date.now,
});

/** The phone's static key pair: made once per install, never leaves the device. */
export async function phoneKey(): Promise<KeyPair> {
  const saved = await get("phoneKey");
  if (saved && /^[0-9a-f]{64}$/.test(saved)) return keyPairFromPrivate(hexToBytes(saved));
  const pair = keyPairFromPrivate(getRandomBytes(32));
  await set("phoneKey", bytesToHex(pair.privateKey));
  return pair;
}

/** A PC this phone is paired with: one per Lepons install, each its own relay, sign-in and name. */
export interface Pc extends Pairing {
  /** The PC key's first 8 bytes in hex: what a push names it by (cockpit phone-host sendPush). */
  id: string;
  server: string;
  /** What the owner called it here; undefined until named or learned from the PC. */
  name?: string;
}

export const pcIdOf = (pcStaticPub: Uint8Array) => bytesToHex(pcStaticPub).slice(0, 16);

const pcOf = (raw: unknown): Pc | undefined => {
  const p = raw as { roomId?: unknown; pcStaticPub?: unknown; server?: unknown; name?: unknown } | null;
  if (typeof p?.roomId !== "string" || !/^[0-9a-f]{32}$/.test(p.roomId) || typeof p.pcStaticPub !== "string" || !/^[0-9a-f]{64}$/.test(p.pcStaticPub)) return undefined;
  const pcStaticPub = hexToBytes(p.pcStaticPub);
  return {
    id: pcIdOf(pcStaticPub), roomId: p.roomId, pcStaticPub,
    server: typeof p.server === "string" && validServer(p.server) ? p.server : DEFAULT_SERVER,
    ...(typeof p.name === "string" && p.name.trim() ? { name: p.name.trim().slice(0, 40) } : {}),
  };
};

/** The paired PCs and the one in use. A phone paired before there could be several has its one PC moved over. */
export async function loadPcs(): Promise<{ pcs: Pc[]; active: string | undefined }> {
  let pcs: Pc[] = [];
  try {
    pcs = (JSON.parse((await get("pcs")) ?? "[]") as unknown[]).map(pcOf).filter((pc): pc is Pc => pc !== undefined);
  } catch {}
  let active = (await get("activePc")) ?? undefined;
  const old = await get("pairing");
  if (pcs.length === 0 && old) {
    try {
      const pc = pcOf({ ...JSON.parse(old), server: await loadServer() });
      if (pc) {
        pcs = [pc];
        active = pc.id;
        const token = await get("token");
        if (token) await set(`token_${pc.id}`, token);
        await savePcs(pcs, active);
        // Only once the list holds it: a failed write leaves the old pairing to move next time.
        await Promise.all([del("pairing"), del("token")]);
      }
    } catch {}
  }
  return { pcs, active: pcs.some((pc) => pc.id === active) ? active : pcs[0]?.id };
}

export async function savePcs(pcs: readonly Pc[], active: string | undefined): Promise<void> {
  await set("pcs", JSON.stringify(pcs.map((pc) => ({ roomId: pc.roomId, pcStaticPub: bytesToHex(pc.pcStaticPub), server: pc.server, ...(pc.name ? { name: pc.name } : {}) }))));
  await (active ? set("activePc", active) : del("activePc"));
}

/** Forgets one PC's sign-in; with the last PC gone, also what was typed, opened and placed on the map. The phone's own key stays. */
export async function forgetPc(id: string, last: boolean): Promise<void> {
  // First: a SecureStore that throws must not leave what the PC showed on disk.
  saved.forgetPc(id);
  await del(`token_${id}`);
  // Its PCs' names in the sessions tab's order go with it.
  if (loadPcOrder(id).length > 0) {
    const { [id]: _gone, ...rest } = pcOrders ?? {};
    pcOrders = rest;
    try {
      pcOrderFile().writeSync(JSON.stringify(pcOrders));
    } catch {}
  }
  if (!last) return;
  await drafts.clear();
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

/** A PC's sign-in, by its id. */
export const loadToken = async (pc: string) => (await get(`token_${pc}`)) || undefined;
export const saveToken = (pc: string, token: string) => (token ? set(`token_${pc}`, token) : del(`token_${pc}`));

/** The widget's link heard the PC unpair this phone (android-widget.tsx); the app acts on it when it next opens or comes back. */
export const markUnpaired = (pc: string) => set("unpairedPc", pc);
export const takeUnpaired = async () => {
  const pc = (await get("unpairedPc")) || undefined;
  if (pc) await del("unpairedPc");
  return pc;
};

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

/**
 * The sessions tab's PC order, per paired PC, as moved in 편집: each PC by its opaque id (its label from a PC older
 * than that). A file, like the map's spots.
 */
const pcOrderFile = () => new File(Paths.document, "pc-order.json");
let pcOrders: Record<string, string[]> | undefined;
export function loadPcOrder(pairing: string): string[] {
  if (!pcOrders) {
    try {
      pcOrders = JSON.parse(pcOrderFile().textSync()) as Record<string, string[]>;
    } catch {
      pcOrders = {};
    }
  }
  const saved = pcOrders[pairing];
  return Array.isArray(saved) ? saved.filter((key) => typeof key === "string") : [];
}
export function savePcOrder(pairing: string, order: string[]): void {
  loadPcOrder(pairing);
  pcOrders = { ...pcOrders, [pairing]: order };
  try {
    pcOrderFile().writeSync(JSON.stringify(pcOrders));
  } catch {}
}
