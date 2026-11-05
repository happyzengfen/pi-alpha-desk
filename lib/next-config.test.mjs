import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const configUrl = new URL("../next.config.ts", import.meta.url);
const nextConfig = await createJiti(import.meta.url).import(configUrl.href, { default: true });

async function configBehavior(config) {
  const server = { externals: [] };
  const client = { externals: [] };
  return {
    keys: Object.keys(config).sort(),
    serverExternalPackages: config.serverExternalPackages,
    headers: await config.headers(),
    env: config.env,
    serverWebpackReturnsInput: config.webpack(server, { isServer: true }) === server,
    clientWebpackReturnsInput: config.webpack(client, { isServer: false }) === client,
    serverExternals: server.externals,
    clientExternals: client.externals,
  };
}

test("native ESM loads the same complete configuration from another working directory", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-next-config-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const script = `
    const config = (await import(${JSON.stringify(configUrl.href)})).default;
    const configBehavior = ${configBehavior.toString()};
    console.log(JSON.stringify(await configBehavior(config)));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), await configBehavior(nextConfig));
});

test("publishes versions from the configuration's own project directory", () => {
  const appPackage = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const piPackage = JSON.parse(readFileSync(new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url), "utf8"));
  assert.deepEqual(nextConfig.env, {
    NEXT_PUBLIC_APP_VERSION: appPackage.version,
    NEXT_PUBLIC_PI_VERSION: piPackage.version,
  });
});

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
