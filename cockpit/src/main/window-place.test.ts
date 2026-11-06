import { test } from "node:test";
import assert from "node:assert/strict";

import { onSomeScreen } from "./window-place.ts";

const laptop = { x: 0, y: 0, width: 1920, height: 1040 };
const right = { x: 1920, y: 0, width: 2560, height: 1400 };

test("a window is put back only where its header can still be grabbed", () => {
  assert.equal(onSomeScreen({ x: 100, y: 100, width: 1200, height: 800 }, [laptop]), true);
  // Straddling two monitors, header middle on the second one.
  assert.equal(onSomeScreen({ x: 1500, y: 50, width: 1600, height: 900 }, [laptop, right]), true);
  // That second monitor is gone.
  assert.equal(onSomeScreen({ x: 2200, y: 50, width: 1600, height: 900 }, [laptop]), false);
  // Header above the top of the screen.
  assert.equal(onSomeScreen({ x: 100, y: -40, width: 1200, height: 800 }, [laptop]), false);
});
