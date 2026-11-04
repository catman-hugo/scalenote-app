import test from "node:test";
import assert from "node:assert/strict";
import { checkPicture, pathForVault, MAX_PICTURE_BYTES } from "../web/images.js";

test("only png, jpg, gif and webp pictures of a sensible size pass the quick check", () => {
  assert.equal(checkPicture({ name: "a.png", type: "image/png", size: 10 }), null);
  assert.equal(checkPicture({ name: "A.JPG", type: "", size: 10 }), null);
  assert.equal(checkPicture({ name: "image.png", type: "image/webp", size: 10 }), null);
  assert.equal(checkPicture({ name: "a.svg", type: "image/svg+xml", size: 10 }), "unsupported_type");
  assert.equal(checkPicture({ name: "a.png", type: "image/svg+xml", size: 10 }), "unsupported_type");
  assert.equal(checkPicture({ name: "a.svg", type: "image/png", size: 10 }), "unsupported_type");
  assert.equal(checkPicture({ name: "a.pdf", type: "application/pdf", size: 10 }), "unsupported_type");
  assert.equal(checkPicture({ name: "a", type: "", size: 10 }), "unsupported_type");
  assert.equal(checkPicture({ name: "a.png", type: "image/png", size: 0 }), "unsupported_type");
  assert.equal(checkPicture({ name: "a.png", type: "image/png", size: MAX_PICTURE_BYTES + 1 }), "too_large_picture");
  assert.equal(checkPicture({ name: "a.png", type: "image/png", size: MAX_PICTURE_BYTES }), null);
});

test("escaped characters in a markdown path are turned back, bad escapes are left alone", () => {
  assert.equal(pathForVault("attachments/my%20pic.png"), "attachments/my pic.png");
  assert.equal(pathForVault("attachments/100%.png"), "attachments/100%.png");
});
