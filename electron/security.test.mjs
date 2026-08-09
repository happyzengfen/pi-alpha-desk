import assert from "node:assert/strict";
import test from "node:test";
import security from "./security.js";

const { encodeFilePathForApi, isSafeExternalUrl, isTrustedRendererUrl } = security;

test("renderer URLs must remain on the exact application origin", () => {
  const applicationUrl = "http://127.0.0.1:30141";
  assert.equal(isTrustedRendererUrl("http://127.0.0.1:30141/session", applicationUrl), true);
  assert.equal(isTrustedRendererUrl("http://127.0.0.1:30142/session", applicationUrl), false);
  assert.equal(isTrustedRendererUrl("https://example.com", applicationUrl), false);
  assert.equal(isTrustedRendererUrl("javascript:alert(1)", applicationUrl), false);
});

test("external navigation accepts only HTTP(S)", () => {
  assert.equal(isSafeExternalUrl("https://pi.dev/docs"), true);
  assert.equal(isSafeExternalUrl("http://example.test"), true);
  assert.equal(isSafeExternalUrl("file:///etc/passwd"), false);
  assert.equal(isSafeExternalUrl("javascript:alert(1)"), false);
});

test("file paths use the same segment encoding as the files API", () => {
  assert.equal(encodeFilePathForApi("/tmp/a b/file.md"), "tmp/a%20b/file.md");
  assert.equal(encodeFilePathForApi("C:\\repo\\file.ts"), "C%3A/repo/file.ts");
});
