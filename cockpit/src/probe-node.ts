/**
 * Connects the cockpit's session layer to a real node and reports what
 * happened. This is a verification tool, not part of the app.
 *
 *   node src/probe-node.ts --host H --user U --key PATH [--trust SHA256:...]
 *
 * Without --trust the host is unfamiliar and the probe refuses, printing the
 * fingerprint to compare against `ssh-keygen -lf` on the node. That refusal is
 * the designed behaviour, not a failure of the probe.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { MemoryKnownHosts, hostId } from "./ssh/known-hosts.ts";
import { NodeSession } from "./ssh/session.ts";

const { values } = parseArgs({
  options: {
    host: { type: "string" },
    port: { type: "string", default: "22" },
    user: { type: "string" },
    key: { type: "string" },
    trust: { type: "string" },
    command: { type: "string", default: "uname -a; echo LEPONS_PTY_OK; exit\n" },
  },
});

if (!values.host || !values.user || !values.key) {
  console.error("usage: probe-node.ts --host H --user U --key PATH [--trust SHA256:...]");
  process.exit(2);
}

const port = Number(values.port);
const store = new MemoryKnownHosts();
if (values.trust) {
  store.remember(hostId(values.host, port), values.trust);
}

const session = new NodeSession({
  host: values.host,
  port,
  username: values.user,
  auth: { kind: "privateKey", privateKey: readFileSync(values.key) },
  knownHosts: store,
  term: { name: "xterm-256color", cols: 100, rows: 30 },
  readyTimeoutMs: 3000,
  ...(values.trust
    ? {}
    : {
        trustNewHost: async (fingerprint: string) => {
          console.log(`host fingerprint: ${fingerprint}`);
          console.log("refusing: pass --trust <fingerprint> after verifying it on the node");
          return false;
        },
      }),
});

let output = "";
session.on("data", (chunk: Buffer) => {
  output += chunk.toString("utf8");
});

const started = Date.now();
const state = await session.open();
console.log(`state after open: ${JSON.stringify(state)} (${Date.now() - started}ms)`);

if (state.kind === "ready") {
  session.write(values.command);
  await new Promise((resolve) => setTimeout(resolve, 3000));
  console.log("--- node output ---");
  console.log(output.trim());
  console.log("--- end ---");
  console.log(`pty round trip: ${output.includes("LEPONS_PTY_OK") ? "OK" : "NOT OBSERVED"}`);
  session.close();
}
process.exit(state.kind === "ready" ? 0 : 1);
