import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const nextConfig = await createJiti(import.meta.url).import("../next.config.ts", { default: true });

test("keeps the packaged PDF reader as a server runtime dependency", () => {
  assert.ok(nextConfig.serverExternalPackages.includes("unpdf"));
  assert.ok(nextConfig.serverExternalPackages.includes("@e965/xlsx"));
  assert.ok(nextConfig.serverExternalPackages.includes("word-extractor"));
});

test("Webpack server compilation keeps Undici external for instrumentation", () => {
  const serverConfig = { externals: [] };
  const clientConfig = { externals: [] };

  assert.equal(nextConfig.webpack(serverConfig, { isServer: true }), serverConfig);
  assert.deepEqual(serverConfig.externals, ["undici"]);

  assert.equal(nextConfig.webpack(clientConfig, { isServer: false }), clientConfig);
  assert.deepEqual(clientConfig.externals, []);
});
