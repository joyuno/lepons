import { test } from "node:test";
import assert from "node:assert/strict";

import { isLanAddress, localNetworkSuspect } from "./local-network.ts";

test("only a Mac's no-route to a LAN address or .local name is suspected", () => {
  for (const host of ["192.168.1.58", "10.0.0.2", "172.16.0.9", "studio.local", "Studio.local."]) {
    assert.equal(localNetworkSuspect("no_route", host, "darwin"), true, host);
  }
  for (const host of ["100.64.0.2", "8.8.8.8", "build.example.com"]) {
    assert.equal(localNetworkSuspect("no_route", host, "darwin"), false, host);
  }
  assert.equal(localNetworkSuspect("no_route", "192.168.1.58", "win32"), false);
  assert.equal(localNetworkSuspect("connect_timeout", "192.168.1.58", "darwin"), false);
  assert.equal(localNetworkSuspect("refused", "192.168.1.58", "darwin"), false);
});

test("LAN addresses are the private IPv4 ranges only", () => {
  for (const host of ["10.0.0.1", "172.16.5.5", "172.31.0.1", "192.168.1.6"]) assert.equal(isLanAddress(host), true, host);
  for (const host of ["100.64.0.2", "172.32.0.1", "8.8.8.8", "nas", "nas.local", "192.168.1"]) assert.equal(isLanAddress(host), false, host);
});
