import type { PhoneRoute, QueryName } from "../phone/contract.ts";
import type { PhoneApi } from "../phone/server.ts";
import type { RelayConnection } from "./client.ts";
import type { Message } from "./protocol.ts";

/**
 * Serves one relay link with the phone API: its sign-in (password + TOTP,
 * its lockout), its routes, its answers. The sign-in rides in the message's
 * `token` field; nothing reaches here but a sealed, approved link.
 *
 * GET /api/events opens the link's one live stream: a 200 res, then
 * {"t":"event","name":"state"|"screen"|"output"|"flow",data} one by one,
 * and "end" when the sign-in ends it. A second one replaces the first.
 */
export function relayBridge(api: PhoneApi): (send: (message: Message) => void) => RelayConnection {
  return (send) => {
    let stopEvents: (() => void) | undefined;
    const quit = () => {
      stopEvents?.();
      stopEvents = undefined;
    };
    // An event too big for one frame (events are not chunked) is dropped,
    // never thrown into whoever is pushing output.
    const safeSend = (message: Message) => {
      try {
        send(message);
      } catch {
        if (message.t === "res") send({ t: "res", id: message.id, status: 500, body: { error: "internal" } });
      }
    };

    const serve = async (request: Extract<Message, { t: "req" }>): Promise<void> => {
      const { id } = request;
      const url = new URL(request.path, "http://phone");
      if (`${request.method} ${url.pathname}` === ("GET /api/events" satisfies PhoneRoute)) {
        quit();
        const opened = api.watch(request.token, url.searchParams.get("s" satisfies QueryName<"GET /api/events">), {
          send: (name, data) => safeSend({ t: "event", name, data }),
          end: () => {
            stopEvents = undefined;
            safeSend({ t: "event", name: "end" });
          },
        }, url.searchParams.get("live" satisfies QueryName<"GET /api/events">) === "1");
        if (!opened) {
          safeSend({ t: "res", id, status: 401, body: { error: "signin" } });
          return;
        }
        stopEvents = opened.stop;
        safeSend({ t: "res", id, status: 200, body: { ok: true } });
        for (const [name, data] of opened.first) safeSend({ t: "event", name, data });
        return;
      }
      // A 16 KiB cap on a request body.
      if (request.body !== undefined && JSON.stringify(request.body).length > 16 * 1024) {
        safeSend({ t: "res", id, status: 413, body: { error: "too large" } });
        return;
      }
      const body = request.method !== "POST" ? undefined
        : typeof request.body === "object" && request.body !== null && !Array.isArray(request.body) ? (request.body as Record<string, unknown>) : {};
      const reply = await api.call({ method: request.method, path: request.path, token: request.token, body, bin: request.bin });
      safeSend({
        t: "res",
        id,
        status: reply.status,
        ...(reply.token === undefined ? {} : { token: reply.token }),
        ...(reply.bin === undefined ? { body: reply.body } : { bin: reply.bin, type: reply.headers?.["content-type"] ?? "application/octet-stream" }),
      });
    };

    return {
      message(message) {
        if (message.t !== "req") return;
        serve(message).catch(() => safeSend({ t: "res", id: message.id, status: 500, body: { error: "internal" } }));
      },
      close: quit,
    };
  };
}
