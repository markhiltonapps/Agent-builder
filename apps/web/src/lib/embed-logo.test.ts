import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_LOGO_BYTES, logoKind, logoProblem } from "./embed-logo.ts";

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const jpg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);

test("pictures are recognised by their bytes", () => {
  assert.deepEqual(logoKind(png), { ext: "png", type: "image/png" });
  assert.deepEqual(logoKind(jpg), { ext: "jpg", type: "image/jpeg" });
  assert.deepEqual(logoKind(webp), { ext: "webp", type: "image/webp" });
});

test("SVG, scripts, GIFs and other files are refused", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  assert.equal(logoKind(enc('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>')), null);
  assert.equal(logoKind(enc("GIF89a....")), null);
  assert.equal(logoKind(enc("RIFF....WAVE")), null);
  assert.match(logoProblem(enc("<svg/>")) ?? "", /PNG, JPG or WebP/);
});

test("empty and oversized files are refused with a plain message", () => {
  assert.match(logoProblem(new Uint8Array(0)) ?? "", /empty/);
  const big = new Uint8Array(MAX_LOGO_BYTES + 1);
  big.set(png);
  assert.match(logoProblem(big) ?? "", /512 KB/);
  assert.equal(logoProblem(png), null);
});
