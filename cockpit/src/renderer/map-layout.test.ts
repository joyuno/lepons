import { test } from "node:test";
import assert from "node:assert/strict";

import { connectedFirst, firstFreeSlot, placeClear, lineCrossings, type Occupied } from "./map.ts";

const CARD_W = 224;

/** The grid renderMap generates: reading order, fixed pitch. */
function slots(columns: number, rows: number, height: number): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      out.push({ x: 28 + col * (CARD_W + 64), y: 26 + row * (height + 48) });
    }
  }
  return out;
}

function overlaps(a: Occupied, b: Occupied): boolean {
  return a.x < b.x + CARD_W && a.x + CARD_W > b.x && a.y < b.y + b.h && a.y + b.h > b.y;
}

// The bug this exists for: a machine was added, got a slot by index, and
// landed on top of a card already sitting there -- so the operator saw a
// stack and read it as "the machine was never added".
test("a new card never lands on one that is already there", () => {
  const grid = slots(3, 4, 120);
  const taken: Occupied[] = [{ ...grid[0]!, h: 120 }, { ...grid[1]!, h: 120 }];

  const spot = firstFreeSlot(grid, 120, taken);

  assert.deepEqual(spot, grid[2], "the first two slots are occupied, so the third is the answer");
  for (const other of taken) {
    assert.ok(!overlaps({ ...spot, h: 120 }, other), "placed card overlaps an existing one");
  }
});

test("placing every machine one after another leaves no two overlapping", () => {
  const grid = slots(3, 9, 120);
  const placed: Occupied[] = [];
  for (let i = 0; i < 9; i++) {
    const spot = firstFreeSlot(grid, 120, placed);
    placed.push({ ...spot, h: 120 });
  }
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      assert.ok(!overlaps(placed[i]!, placed[j]!), `cards ${i} and ${j} overlap at ${JSON.stringify(placed[i])}`);
    }
  }
});

// A card the operator dragged keeps its pixels, and the grid re-centres
// around it on the next render. The new card has to route around it rather
// than take the slot the grid nominally hands it.
test("a dragged card still blocks the slot it covers", () => {
  const grid = slots(3, 4, 120);
  const dragged: Occupied = { x: grid[0]!.x, y: grid[0]!.y, h: 300 };

  const spot = firstFreeSlot(grid, 120, [dragged]);

  assert.ok(!overlaps({ ...spot, h: 120 }, dragged), "took a slot the tall dragged card covers");
});

test("with every slot spoken for a card goes below the board, never on top", () => {
  const grid = slots(1, 2, 120);
  const taken: Occupied[] = grid.map((slot) => ({ ...slot, h: 120 }));

  const spot = firstFreeSlot(grid, 120, taken);

  for (const other of taken) {
    assert.ok(!overlaps({ ...spot, h: 120 }, other), "overflow card overlaps an existing one");
  }
  assert.ok(spot.y > taken[taken.length - 1]!.y, "overflow should go below, not above");
});

// The map filled the grid in list order, so two PCs sharing with each other
// could sit at opposite corners with their line drawn across every card in
// between. Linked PCs now come first and next to each other.
test("linked PCs are laid out first and next to each other; unlinked ones after", () => {
  const ids = ["local", "a", "b", "c", "d", "e"];
  // c <-> e share, local -> c; a, b and d share with nobody.
  const order = connectedFirst(ids, [["local", "c"], ["c", "e"], ["e", "c"]]);

  assert.deepEqual(order.slice(0, 3).sort(), ["c", "e", "local"], "the linked group fills the first slots");
  assert.equal(order[1], "c", "the busiest member sits between two of its neighbours");
  assert.deepEqual(order.slice(3), ["a", "b", "d"], "unlinked PCs follow in list order");
  assert.equal(new Set(order).size, ids.length, "every PC once");
});

test("a bigger linked group goes before a smaller one; no links keeps the list order", () => {
  const order = connectedFirst(["a", "b", "c", "d", "e"], [["a", "b"], ["c", "d"], ["d", "e"]]);
  assert.deepEqual(order.slice(0, 3).sort(), ["c", "d", "e"]);
  assert.deepEqual(order.slice(3).sort(), ["a", "b"]);
  assert.deepEqual(connectedFirst(["x", "y", "z"], []), ["x", "y", "z"]);
  assert.deepEqual(connectedFirst(["x", "y"], [["x", "gone"]]), ["x", "y"], "a line to a removed PC is ignored");
});

// Three PCs that all share with one another were laid out in one row, and the
// line between the two ends ran straight through the card in the middle.
test("lines between PCs never run through another PC's card", () => {
  const ids = ["gpu", "local", "staging"];
  const links: Array<[string, string]> = [["local", "gpu"], ["gpu", "local"], ["staging", "gpu"], ["local", "staging"]];
  const heights = new Map([["gpu", 290], ["local", 330], ["staging", 290]]);
  const placed = placeClear(ids, heights, slots(3, 3, 330), [], links);
  assert.ok(placed, "three cards is within the search");
  const boxes = new Map([...placed!].map(([id, at]) => [id, { ...at, h: heights.get(id)! }]));
  assert.equal(lineCrossings(boxes, links), 0);
});

test("a chain stays in one row, in the order of its links", () => {
  const heights = new Map([["a", 120], ["b", 120], ["c", 120]]);
  const placed = placeClear(["a", "b", "c"], heights, slots(3, 3, 120), [], [["a", "b"], ["b", "c"]])!;
  const ys = new Set([...placed.values()].map((at) => at.y));
  assert.equal(ys.size, 1, "no second row for a chain that fits in one");
  assert.ok(placed.get("a")!.x < placed.get("b")!.x === placed.get("b")!.x < placed.get("c")!.x, "b sits between a and c");
});

test("a card the operator placed is never covered, and its lines count too", () => {
  const grid = slots(3, 3, 120);
  const fixed: Occupied[] = [{ ...grid[1]!, h: 120 }];
  const heights = new Map([["a", 120], ["b", 120]]);
  const placed = placeClear(["a", "b"], heights, grid, fixed, [["a", "b"]])!;
  for (const at of placed.values()) assert.ok(!overlaps({ ...at, h: 120 }, fixed[0]!), "landed on the placed card");
});
