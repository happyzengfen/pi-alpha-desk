import path from "node:path";
import { definePDFJSModule } from "unpdf";

let runtimeReady: Promise<{
  pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs");
  options: { standardFontDataUrl: string; cMapUrl: string; cMapPacked: boolean; useSystemFonts: boolean };
}> | undefined;

export function getPdfRuntime() {
  return runtimeReady ??= (async () => {
    // Import first so native canvas globals initialize before unpdf's stubs.
    // Both readers must use the same worker in the shared server process.
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    await definePDFJSModule(() => Promise.resolve(pdfjs));
    // CLI and Electron launch Next with the application directory as cwd.
    // Access through Node so Webpack does not rewrite a dynamic createRequire.
    const nodeRequire = process.getBuiltinModule("module").createRequire(path.join(process.cwd(), "package.json"));
    const root = path.dirname(nodeRequire.resolve("pdfjs-dist/package.json"));
    return {
      pdfjs,
      options: {
        // PDF.js 4's Node factories require paths, rather than file: URLs.
        standardFontDataUrl: path.join(root, "standard_fonts") + path.sep,
        cMapUrl: path.join(root, "cmaps") + path.sep,
        cMapPacked: true,
        useSystemFonts: false,
      },
    };
  })();
}
