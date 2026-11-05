import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "automation-hub");
const output = path.join(root, "dist", "automation-hub");
const hash = createHash("sha256");

async function visit(directory, relative = "") {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) { await visit(path.join(directory, entry.name), name); continue; }
    if (/\.test\.|tsconfig|package-lock/.test(name)) continue;
    const input = path.join(source, name);
    if (entry.name.endsWith(".ts")) {
      const original = await readFile(input, "utf8");
      hash.update(name).update(original);
      const compiled = ts.transpileModule(original, {
        fileName: input,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, isolatedModules: true },
        reportDiagnostics: true,
      });
      const errors = compiled.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error) ?? [];
      if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
        getCanonicalFileName: (file) => file, getCurrentDirectory: () => root, getNewLine: () => "\n",
      }));
      const destination = path.join(output, name.replace(/\.ts$/, ".mjs"));
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, compiled.outputText.replace(/(["'])(\.\.?\/[^"']+)\.ts\1/g, "$1$2.mjs$1"));
    } else if (/\.(json|sql|md)$/.test(entry.name) || entry.name === "LICENSE") {
      await mkdir(path.dirname(path.join(output, name)), { recursive: true });
      await copyFile(input, path.join(output, name));
      hash.update(name).update(await readFile(input));
    }
  }
}

await rm(output, { recursive: true, force: true });
await visit(source);
await writeFile(path.join(output, "build.json"), JSON.stringify({ version: 1, sourceHash: hash.digest("hex") }, null, 2) + "\n");
console.log("Automation hub compiled to dist/automation-hub");
