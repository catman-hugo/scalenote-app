import test from "node:test";
import assert from "node:assert/strict";
import { placeOf, scrollFor } from "../web/pageplace.js";

test("the place is the first block still on screen and its distance from the top", () => {
  const tops = [0, 100, 200, 300];
  const bottoms = [90, 190, 290, 390];
  assert.deepEqual(placeOf(tops, bottoms, 150), { block: 1, offset: -50 }, "half of the second block is above the window");
  assert.deepEqual(placeOf(tops, bottoms, 195), { block: 2, offset: 5 }, "in the gap: the next block");
  assert.deepEqual(placeOf(tops, bottoms, 1000), { block: 3, offset: -700 }, "below everything: the last block");
  assert.equal(placeOf([], [], 0), null);
});

test("a place is put back against the blocks as they are now, also when the page grew above it", () => {
  const place = { block: 2, offset: 10 };
  // Window top at 50, not scrolled; block 2 is now at 650 (a picture above it loaded).
  assert.equal(scrollFor(place, [50, 300, 650], 50, 0), 590);
  // Already scrolled by 100: block 2 is 100 higher on screen, the result is the same.
  assert.equal(scrollFor(place, [-50, 200, 550], 50, 100), 590);
  assert.equal(scrollFor({ block: 9, offset: 0 }, [50, 300], 50, 0), 250, "a block that is gone: the last one");
  assert.equal(scrollFor({ block: 0, offset: 500 }, [50], 50, 0), 0, "never above the top");
  assert.equal(scrollFor(null, [50], 50, 0), null);
  assert.equal(scrollFor(place, [], 50, 0), null);
});
