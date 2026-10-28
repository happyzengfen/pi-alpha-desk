import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const routeUrl = new URL("./[...path]/route.ts", import.meta.url).href;

test("missing native PDF renderer preserves file routes and returns a usable fallback status", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-file-preview-"));
  try {
    await writeFile(path.join(root, "report.pdf"), "%PDF-1.4\nfixture");
    await writeFile(path.join(root, "note.txt"), "Text remains readable");
    await writeFile(path.join(root, "audio.wav"), "RIFF audio fixture");
    await run(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { registerHooks } from "node:module";
      import { createJiti } from "jiti";
      registerHooks({ resolve(specifier, context, next) {
        if (specifier.includes("@napi-rs/canvas")) throw new Error("native canvas unavailable");
        return next(specifier, context);
      } });
      const jiti = createJiti(${JSON.stringify(import.meta.url)}, { tsconfigPaths: true });
      const { GET } = await jiti.import(${JSON.stringify(routeUrl)});
      const { NextRequest } = await jiti.import("next/server");
      const root = process.argv[1];
      globalThis.__piAllowedRootsCache = { roots: new Set([root]), expiresAt: Infinity };
      async function get(file, query, headers = {}) {
        const segments = (root + "/" + file).split("/").filter(Boolean);
        const url = "http://localhost/api/files/" + segments.map(encodeURIComponent).join("/") + "?" + query;
        return GET(new NextRequest(url, { headers }), { params: Promise.resolve({ path: segments }) });
      }
      const unsupported = await get("report.pdf", "type=pdfpage&page=1");
      assert.equal(unsupported.status, 501);
      assert.match((await unsupported.json()).error, /Native PDF rendering is unavailable/);
      const text = await get("note.txt", "type=read");
      assert.equal(text.status, 200);
      assert.equal((await text.json()).content, "Text remains readable");
      const pdf = await get("report.pdf", "type=read", { range: "bytes=0-3" });
      assert.equal(pdf.status, 206);
      assert.equal(pdf.headers.get("content-type"), "application/pdf");
      assert.equal(await pdf.text(), "%PDF");
      const audio = await get("audio.wav", "type=read", { range: "bytes=0-3" });
      assert.equal(audio.status, 206);
      assert.equal(audio.headers.get("content-type"), "audio/wav");
      assert.equal(await audio.text(), "RIFF");
      for (const page of ["0", "-1", "NaN", "1oops", "1.2", "Infinity"]) {
        const result = await get("report.pdf", "type=pdfpage&page=" + page);
        assert.equal(result.status, 400, page);
      }
    `, root], {
      env: { ...process.env, PDF_PAGE_CACHE_DIR: path.join(root, "cache") },
      timeout: 30_000,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
