import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coverage, main, renderedComponents, summarizeCoverage } from "./components.mjs";

test("MAIR-318: only lib components rendered as JSX count, under their exported name", () => {
  const source = `
    import { Button, ButtonPresets, Modal as Dialog, useToast, TOAST_DEFAULT_DURATION, formatDateTime, type ButtonProps, SaveButton } from '@mairie360/lib-components';
    import type { Status } from "@mairie360/lib-components/primitives";
    import { Header } from "@mairie360/lib-components/shell";
    import { Sidebar } from "@mairie360/lib-components/next";
    import { Card } from "./local-card";
    import * as Lib from "@mairie360/lib-components/primitives";
    export function Page(props: ButtonProps) {
      const toast = useToast();
      return (<><Header/><Dialog open>{formatDateTime(1)}</Dialog><Button onClick={toast}>ok</Button>
        <ButtonPresets.save /><Card /><Sidebar /><Lib.Spinner size="sm" /><ButtonGroup /></>);
    }`;
  assert.deepEqual(renderedComponents(source).sort(), ["Button", "Header", "Modal", "Spinner"]);
});

test("MAIR-318: an imported component that is never rendered does not count", () => {
  assert.deepEqual(renderedComponents(`import { Button, Alert } from "@mairie360/lib-components";\nconst x = Button; <Alert>hi</Alert>`), ["Alert"]);
});

function front(files) {
  const dir = mkdtempSync(join(tmpdir(), "rgaa-components-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

const FRONT = {
  "app/page.tsx": `import { Button, Modal } from "@mairie360/lib-components";\nexport default () => <><Button/><Modal/></>;`,
  "components/Empty.tsx": `import { DataState } from "@mairie360/lib-components/primitives";\nexport const E = () => <DataState kind="empty" />;`,
  "components/Empty.test.tsx": `import { Drawer } from "@mairie360/lib-components";\n<Drawer />`,
  "components/Card.stories.tsx": `import { Tabs } from "@mairie360/lib-components";\n<Tabs />`,
  "node_modules/x/index.js": `import { Slider } from "@mairie360/lib-components";\n<Slider />`,
};

test("MAIR-318: components rendered by the front but shown by no state are missing; tests and stories are ignored", () => {
  const cov = coverage(front(FRONT), [{ components: ["Button", "ConfirmModal", "Modal"] }, { components: [] }, {}]);
  assert.deepEqual(Object.keys(cov.used), ["Button", "DataState", "Modal"]);
  assert.deepEqual(cov.used.DataState, [join("components", "Empty.tsx")]);
  assert.deepEqual(cov.seen, ["Button", "ConfirmModal", "Modal"]);
  assert.deepEqual(cov.missing, ["DataState"]);
  assert.equal(cov.marked, true);
  const summary = summarizeCoverage(cov);
  assert.match(summary, /2 of the 3 lib components/);
  assert.match(summary, /\| DataState \| `components\/Empty.tsx` \|/);
});

test("MAIR-318: without any marker (lib older than MAIR-318) nothing is reported missing", () => {
  const cov = coverage(front(FRONT), [{ components: [] }]);
  assert.equal(cov.marked, false);
  assert.deepEqual(cov.missing, []);
  assert.match(summarizeCoverage(cov), /older than the markers/);
});

test("MAIR-318: main adds lib_components to report.json and the summary, and never fails", () => {
  const src = front(FRONT);
  const report = mkdtempSync(join(tmpdir(), "rgaa-report-"));
  writeFileSync(join(report, "report.json"), JSON.stringify({ rate: { value: 80 }, states: [{ id: "home", components: ["Button"] }] }));
  writeFileSync(join(report, "summary.md"), "## RGAA\n");
  assert.equal(main([src, report]), 0);
  const written = JSON.parse(readFileSync(join(report, "report.json"), "utf8"));
  assert.equal(written.rate.value, 80);
  assert.deepEqual(written.lib_components.missing, ["DataState", "Modal"]);
  const summary = readFileSync(join(report, "summary.md"), "utf8");
  assert.ok(summary.startsWith("## RGAA\n"));
  assert.match(summary, /### Lib components \(report only\)/);
  // No report (the stack never ran): skipped, still exit 0.
  assert.equal(main([src, join(report, "nothing")]), 0);
  assert.equal(main([]), 2);
});
