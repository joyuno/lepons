import { test } from "node:test";
import assert from "node:assert/strict";

import { grepRemote } from "./grep.ts";
import { runRemoteStatus } from "../ssh/capabilities.ts";
import { generateHostKey, startFakeNode } from "../ssh/fake-node.ts";

// A Korean line arrives over SSH in packets that need not end on a character
// boundary. Decoding each packet alone turned the split character into two
// U+FFFDs -- in search results, transcripts and delegated output alike.
test("a character split across two SSH packets arrives whole", async () => {
  const node = await startFakeNode(generateHostKey());
  try {
    const line = Buffer.from("./문서/메모.md:1:한글 검색어\n", "utf8");
    const cut = line.indexOf(Buffer.from("검", "utf8")) + 1; // inside a 3-byte character
    node.faults.execChunks = [line.subarray(0, cut), line.subarray(cut)];

    const found = await grepRemote(node.options, { root: "/srv/repo", pattern: "검색", salt: "s" });
    assert.ok(found.ok);
    assert.deepEqual(found.matches.map((match) => [match.path, match.text]), [["문서/메모.md", "한글 검색어"]]);

    const ran = await runRemoteStatus(node.options, "true");
    assert.equal(ran?.output, line.toString("utf8"));
  } finally {
    await node.close();
  }
});
