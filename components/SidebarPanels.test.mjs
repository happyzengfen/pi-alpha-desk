import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("workspace information panels are visible by default", async () => {
  const [sidebarSource, quickChangesSource] = await Promise.all([
    readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8"),
    readFile(new URL("./QuickChangesPanel.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(sidebarSource, /useState\(true\);\n\s*const \[explorerOpen/);
  assert.match(sidebarSource, /const \[explorerOpen, setExplorerOpen\] = useState\(true\)/);
  assert.match(sidebarSource, /if \(!selectedCwd\) return;\s*setSessionsOpen\(true\);\s*setExplorerOpen\(true\);\s*}, \[selectedCwd\]\);/);
  assert.match(quickChangesSource, /const \[open, setOpen\] = useState\(true\)/);
  assert.match(quickChangesSource, /setOpen\(true\);\s*}, \[cwd\]\);/);
});
