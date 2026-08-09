import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const nextConfig = await createJiti(import.meta.url).import("../next.config.ts", { default: true });

test("Webpack server compilation keeps Undici external for instrumentation", () => {
  const serverConfig = { externals: [] };
  const clientConfig = { externals: [] };

  assert.equal(nextConfig.webpack(serverConfig, { isServer: true }), serverConfig);
  assert.deepEqual(serverConfig.externals, ["undici"]);

  assert.equal(nextConfig.webpack(clientConfig, { isServer: false }), clientConfig);
  assert.deepEqual(clientConfig.externals, []);
});
