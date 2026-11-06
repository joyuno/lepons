import { test } from "node:test";
import assert from "node:assert/strict";

import { renderMarkdown } from "./markdown.ts";

/** Every block's data-md-start/end, as the source slices they point at. */
function slices(html: string, source: string): string[] {
  return [...html.matchAll(/data-md-start="(\d+)" data-md-end="(\d+)"/g)].map((m) => source.slice(+m[1]!, +m[2]!));
}

// What makes copying hand back markdown: each block carries the exact span
// of source it came from, so a selection of blocks maps to a source slice.
test("each top-level block and top-level list item points at its own source", () => {
  const src = "# 제목\r\n\r\n본문 **굵게**\r\n\r\n### 소제목\r\n\r\n- 하나\r\n- 둘\r\n\r\n```py\r\nprint(1)\r\n```\r\n";
  const { html, source } = renderMarkdown(src);
  assert.equal(source, src.replace(/\r\n/g, "\n"), "offsets index the LF-normalised text");
  // Trailing newlines belong to whichever token marked gives them, and a
  // copy trims them anyway; the block's own text is what has to be exact.
  const found = slices(html, source).map((slice) => slice.trimEnd());
  for (const expected of ["# 제목", "본문 **굵게**", "### 소제목", "- 하나", "- 둘", "```py\nprint(1)\n```"]) {
    assert.ok(found.includes(expected), `no block points at ${JSON.stringify(expected)}; got ${JSON.stringify(found)}`);
  }
  assert.match(html, /<h3 data-md-start="\d+" data-md-end="\d+"[^>]*>소제목<\/h3>/);
});

test("front matter becomes a properties table that copies back as itself", () => {
  const src = "---\ntags: [a, b]\nstatus: draft\n---\n# 본문\n";
  const { html, source } = renderMarkdown(src);
  assert.match(html, /class="properties"/);
  assert.match(html, /<th>status<\/th><td>draft<\/td>/);
  assert.ok(slices(html, source).includes("---\ntags: [a, b]\nstatus: draft\n---\n"));
  assert.ok(slices(html, source).map((slice) => slice.trimEnd()).includes("# 본문"), "blocks after it keep exact offsets");
  assert.doesNotMatch(html, /<hr/, "the fence is not drawn as a rule");
});

test("Obsidian's callouts, highlights, comments, tags and wikilinks render", () => {
  const { html } = renderMarkdown(
    "> [!warning] 조심\n> 내용 ==강조== 끝\n\n" +
      "보이는 %%숨김%% 글 #태그 and [[노트|별칭]] ![[그림.png]]\n\n" +
      "%%\n여러 줄\n주석\n%%\n\n" +
      "> [!tip]- 접힘\n> 안쪽\n",
  );
  assert.match(html, /<div class="callout" data-callout="warning"[^>]*><div class="callout-title">조심<\/div>/);
  assert.match(html, /<mark>강조<\/mark>/);
  assert.doesNotMatch(html, /숨김|여러 줄/, "comments never reach the page");
  assert.match(html, /<span class="tag">#태그<\/span>/);
  assert.match(html, /<span class="wikilink"[^>]*>별칭<\/span>/);
  assert.match(html, /<span class="wikilink embed"[^>]*>그림\.png<\/span>/);
  assert.match(html, /<details class="callout" data-callout="tip"[^>]*><summary class="callout-title">접힘<\/summary>/);
});

test("what only looks like a tag is left alone", () => {
  const { html } = renderMarkdown("issue#12, `#code`, <https://x.io/#frag>, &#39; and #123\n");
  assert.doesNotMatch(html, /class="tag"/);
});
