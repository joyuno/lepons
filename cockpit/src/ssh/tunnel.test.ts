import { test } from "node:test";
import assert from "node:assert/strict";

import { openReverseTunnel } from "./tunnel.ts";
import { generateHostKey, startFakeNode } from "./fake-node.ts";

// A node that takes the connection but never answers the forward request
// held the share's attempt open for good, and every grant joined to it.
test("a forward request the node never answers gives up instead of hanging", async () => {
  const node = await startFakeNode(generateHostKey());
  try {
    node.faults.ignoreRequests = true;
    let lost = false;
    const result = await openReverseTunnel(node.options, 1, 0, () => { lost = true; }, 300);
    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.reason, "connect_timeout", "silence stays retryable");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(lost, false, "giving up is not an outage to retry from onLost");

    node.faults.ignoreRequests = false;
    const refused = await openReverseTunnel(node.options, 1, 0, undefined, 5_000);
    assert.equal(refused.ok, false, "a refusal still answers at once");
  } finally {
    await node.close();
  }
});
