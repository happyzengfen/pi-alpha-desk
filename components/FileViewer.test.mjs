import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as fileTypes from "../lib/file-types.ts";
import * as filePaths from "../lib/file-paths.ts";

// Execute component effects and event handlers with controlled network results.
// DOM geometry is supplied only by the PDF scrolling test.
async function mount(file, name, props, fetch) {
  const slots = [];
  const watchers = [];
  let index = 0;
  let effects = [];
  const hook = (create) => {
    const position = index++;
    if (!(position in slots)) slots[position] = create();
    return slots[position];
  };
  const useEffect = (run, deps) => {
    const slot = hook(() => ({}));
    if (!slot.deps || !deps || deps.some((dep, i) => !Object.is(dep, slot.deps[i]))) {
      slot.deps = deps;
      effects.push(() => { slot.cleanup?.(); slot.cleanup = run(); });
    }
  };
  const memoize = (run, deps) => {
    const slot = hook(() => ({}));
    if (!slot.deps || deps.some((dep, i) => !Object.is(dep, slot.deps[i]))) {
      slot.deps = deps;
      slot.value = run();
    }
    return slot.value;
  };
  const React = {
    useState(initial) {
      const slot = hook(() => ({ value: typeof initial === "function" ? initial() : initial }));
      return [slot.value, (next) => { slot.value = typeof next === "function" ? next(slot.value) : next; }];
    },
    useRef: (value) => hook(() => ({ current: value })),
    useEffect,
    useLayoutEffect: useEffect,
    useMemo: memoize,
    useCallback: (run, deps) => memoize(() => run, deps),
    useContext: () => ({}),
  };
  const t = (key, params = {}) => `${key}${Object.keys(params).length ? ` ${JSON.stringify(params)}` : ""}`;
  const jsx = (type, props) => ({ type, props });
  const source = await readFile(new URL(file, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source + (name !== "PdfViewer" ? `\nexport { ${name} };` : ""), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const exports = {};
  runInNewContext(compiled, {
    exports,
    require(id) {
      if (id === "react") return React;
      if (id === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (id === "@/hooks/useI18n") return { useI18n: () => ({ t }) };
      if (id === "@/hooks/use-file-change-indicator") return { useFileChangeIndicator: () => false };
      if (id === "@/lib/file-types") return fileTypes;
      if (id === "@/lib/file-paths") return filePaths;
      if (id === "@/lib/markdown") return { normalizeDisplayMath: (text) => text };
      if (id === "./PdfViewer") return { PdfViewer: "PdfViewer" };
      if (id === "./PreviewToolbar") return { PreviewToolbar: "PreviewToolbar" };
      return {};
    },
    fetch,
    URL,
    URLSearchParams,
    window: { location: { origin: "http://localhost:30141" } },
    ResizeObserver: class { observe() {} disconnect() {} },
    setTimeout: (callback) => { callback(); return 0; },
    EventSource: class {
      constructor() { this.listeners = {}; watchers.push(this); }
      addEventListener(name, run) { this.listeners[name] = run; }
      close() {}
    },
  });
  const render = () => {
    index = 0;
    const tree = exports[name](props);
    const pending = effects;
    effects = [];
    for (const run of pending) run();
    return tree;
  };
  const flush = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
    return render();
  };
  render();
  return { render, flush, watchers };
}

function elements(tree, predicate) {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap((child) => elements(child, predicate));
  return [...(predicate(tree) ? [tree] : []), ...elements(tree.props?.children, predicate)];
}

const response = (data = {}, status = 200) => ({ ok: status < 400, status, json: async () => data });

test("PPTX conversion unavailable falls back to the existing HTML preview and keeps session authorization", async () => {
  const viewer = await mount("./FileViewer.tsx", "DocumentViewer", {
    filePath: "/tmp/slides.pptx", sourceSessionId: "session-123",
  }, async () => response({ size: 120 }));
  let tree = await viewer.flush();
  const pdf = elements(tree, (node) => node.type === "PdfViewer")[0];
  assert.ok(pdf);
  pdf.props.onUnsupported();
  tree = viewer.render();
  const frame = elements(tree, (node) => node.type === "iframe")[0];
  assert.ok(frame);
  assert.match(frame.props.src, /type=preview&sessionId=session-123/);
  assert.equal(frame.props.sandbox, "allow-same-origin");
});

test("PDF renderer unavailable falls back to the browser PDF reader without attachment downloads", async () => {
  const props = {
    filePath: "/tmp/report.pdf", sourceSessionId: "session-123",
  };
  const viewer = await mount("./FileViewer.tsx", "DocumentViewer", props,
    async () => response({ size: fileTypes.OFFICE_PREVIEW_MAX_BYTES + 1 }));
  let tree = await viewer.flush();
  elements(tree, (node) => node.type === "PdfViewer")[0].props.onUnsupported();
  await viewer.flush();
  tree = await viewer.flush();
  const frame = elements(tree, (node) => node.type === "iframe")[0];
  assert.ok(frame);
  assert.match(frame.props.src, /type=read&sessionId=session-123/);
  assert.equal(frame.props.sandbox, undefined);
  elements(tree, (node) => node.type === "button" && node.props.title === "desktop.refreshPreviewTitle")[0].props.onClick();
  tree = viewer.render();
  assert.match(elements(tree, (node) => node.type === "iframe")[0].props.src, /v=1/);
  props.sourceSessionId = "session-456";
  tree = viewer.render();
  assert.match(elements(tree, (node) => node.type === "iframe")[0].props.src, /sessionId=session-456/);
  props.filePath = "/tmp/another.pdf";
  await viewer.flush();
  tree = viewer.render();
  assert.equal(elements(tree, (node) => node.type === "iframe").length, 0);
  assert.ok(elements(tree, (node) => node.type === "PdfViewer")[0]);
});

test("Office preview API errors are readable in the viewer and manual refresh retries", async () => {
  const viewer = await mount("./FileViewer.tsx", "DocumentViewer", { filePath: "/tmp/budget.xlsx" },
    async () => response({ size: 120 }));
  let tree = await viewer.flush();
  elements(tree, (node) => node.type === "iframe")[0].props.onLoad({
    currentTarget: { contentDocument: { contentType: "application/json", body: { textContent: '{"error":"Invalid workbook"}' } } },
  });
  tree = viewer.render();
  assert.match(JSON.stringify(tree), /Invalid workbook/);
  assert.equal(elements(tree, (node) => node.type === "iframe").length, 0);
  elements(tree, (node) => node.type === "PreviewToolbar")[0].props.onRefresh();
  tree = viewer.render();
  const frame = elements(tree, (node) => node.type === "iframe")[0];
  assert.ok(frame);
  assert.match(frame.props.src, /v=1/);
  assert.equal(frame.props.sandbox, "allow-same-origin");
});

test("an image that failed to load recovers when the watched file changes", async () => {
  const viewer = await mount("./FileViewer.tsx", "ImageViewer", { filePath: "/tmp/image.png" }, async () => response());
  elements(viewer.render(), (node) => node.type === "img")[0].props.onError();
  assert.equal(elements(viewer.render(), (node) => node.type === "img").length, 0);
  viewer.watchers[0].listeners.change({ data: '{"size":100}' });
  const image = elements(viewer.render(), (node) => node.type === "img")[0];
  assert.ok(image);
  assert.match(image.props.src, /v=1/);
});

test("a failed text preview recovers when a subsequent read succeeds", async () => {
  let failed = true;
  const viewer = await mount("./FileViewer.tsx", "TextFileViewer", { filePath: "/tmp/note.txt" },
    async () => response(failed ? { error: "read failed" } : { content: "restored", language: "text", size: 8 }));
  let tree = await viewer.flush();
  assert.match(JSON.stringify(tree), /read failed/);
  failed = false;
  viewer.watchers[0].listeners.change();
  tree = await viewer.flush();
  assert.doesNotMatch(JSON.stringify(tree), /read failed/);
  assert.match(JSON.stringify(tree), /restored/);
});

test("PDF pages keep their own aspect ratios and mixed page heights determine the current page", async () => {
  const viewer = await mount("./PdfViewer.tsx", "PdfViewer", { url: "/api/files/report.pdf?type=read", fileName: "report.pdf" },
    async () => ({ ...response(), headers: new Headers({ "X-PDF-PageCount": "3", "X-PDF-Width": "800", "X-PDF-Height": "400" }) }));
  let tree = await viewer.flush();
  let images = elements(tree, (node) => node.type === "img");
  images[1].props.onLoad({ currentTarget: { naturalWidth: 400, naturalHeight: 800 } });
  tree = viewer.render();
  images = elements(tree, (node) => node.type === "img");
  assert.equal(images[0].props.style.height, 384);
  assert.equal(images[1].props.style.height, 1536);
  const container = elements(tree, (node) => typeof node.props?.onScroll === "function")[0];
  const scrollContainer = {
    scrollTop: 1200, clientHeight: 100, scrollHeight: 2336,
    scrollTo(target) { this.scrollTop = typeof target === "number" ? target : target.top; },
  };
  container.props.ref.current = scrollContainer;
  container.props.onScroll();
  tree = viewer.render();
  assert.equal(elements(tree, (node) => node.type === "input")[0].props.value, "2");
  elements(tree, (node) => node.type === "button" && node.props.title === "desktop.refreshPreviewTitle")[0].props.onClick();
  tree = await viewer.flush();
  tree = await viewer.flush();
  assert.equal(elements(tree, (node) => node.type === "img")[1].props.style.height, 1536);
  assert.equal(scrollContainer.scrollTop, 1200);
});

test("a failed PDF page shows a localized retry hint while the other pages remain available", async () => {
  const viewer = await mount("./PdfViewer.tsx", "PdfViewer", { url: "/api/files/report.pdf?type=read", fileName: "report.pdf" },
    async () => ({ ...response(), headers: new Headers({ "X-PDF-PageCount": "2", "X-PDF-Width": "800", "X-PDF-Height": "400" }) }));
  let tree = await viewer.flush();
  elements(tree, (node) => node.type === "img")[1].props.onError();
  tree = viewer.render();
  assert.equal(elements(tree, (node) => node.type === "img").length, 1);
  assert.match(JSON.stringify(tree), /desktop.previewPageFailed/);
  elements(tree, (node) => node.type === "button" && node.props.title === "desktop.refreshPreviewTitle")[0].props.onClick();
  tree = await viewer.flush();
  tree = await viewer.flush();
  assert.equal(elements(tree, (node) => node.type === "img").length, 2);
});

test("the PDF probe forwards unavailable-renderer responses to the document fallback", async () => {
  let unsupported = 0;
  const viewer = await mount("./PdfViewer.tsx", "PdfViewer", {
    url: "/api/files/report.pdf?type=read", fileName: "report.pdf", onUnsupported: () => { unsupported++; },
  }, async () => response({ error: "renderer unavailable" }, 501));
  await viewer.flush();
  assert.equal(unsupported, 1);
});
