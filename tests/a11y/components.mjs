// Lib component coverage of a front (MAIR-318), report-only. Each @mairie360/lib-components component
// marks its root element with `data-m360-component` (outermost first, space-separated); run.mjs keeps
// the names each captured state shows (`states[].components`). This script lists the lib components
// the front renders (JSX of a name imported from the lib) and reports those that no captured state
// shows, so that rgaa.yaml gets a state for them. It never changes the exit code of the gate.
//
//   node components.mjs <front src dir> <report dir>
//
// Runs after the stack, on the runner (no dependency): adds `lib_components` to report.json and a
// section to summary.md.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const LIB = /^@mairie360\/lib-components(?:\/(?:primitives|shell))?$/;
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
// Tests and stories render components that the pages never show.
const SKIPPED_FILE = /(?:\.test|\.spec|\.stories)\.[cm]?[jt]sx?$/;
const SKIPPED_DIR = new Set(["node_modules", "__tests__", "__mocks__", ".next", "dist", "coverage"]);
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIR.has(entry.name)) out.push(...sourceFiles(join(dir, entry.name)));
    } else if (SOURCE.test(entry.name) && !SKIPPED_FILE.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
  return out.sort();
}

// Lib components a source file renders: { name, local } of each named import from the lib that the
// file uses as a JSX element (`<Name`), so types, helpers, hooks and constants never count. A preset
// object (`ButtonPresets.save`) is skipped: the element it renders carries the preset's own name
// (`SaveButton`), import that one. A namespace import (`import * as Lib`) counts `<Lib.Name`.
export function renderedComponents(source) {
  const found = new Map();
  const jsx = (local) => new RegExp(`<${escape(local)}(?=[\\s/>])`).test(source);
  const named = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  for (const [, typeOnly, list, from] of source.matchAll(named)) {
    if (typeOnly || !LIB.test(from)) continue;
    for (const raw of list.split(",")) {
      const spec = raw.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "").trim();
      if (!spec || spec.startsWith("type ")) continue;
      const [name, local = name] = spec.split(/\s+as\s+/).map((s) => s.trim());
      if (/^[A-Z]/.test(name) && !name.endsWith("Presets") && jsx(local)) found.set(name, local);
    }
  }
  const namespace = /import\s+\*\s+as\s+(\w+)\s+from\s*["']([^"']+)["']/g;
  for (const [, ns, from] of source.matchAll(namespace)) {
    if (!LIB.test(from)) continue;
    for (const [, name] of source.matchAll(new RegExp(`<${escape(ns)}\\.([A-Z]\\w*)(?=[\\s/>])`, "g"))) {
      if (!name.endsWith("Presets")) found.set(name, `${ns}.${name}`);
    }
  }
  return [...found.keys()];
}

// { used: { name: [files] }, seen: [names], missing: [names], marked } where `marked` is false when no
// state shows any marker at all (a front still on a lib release without markers): nothing can be
// called missing then.
export function coverage(srcDir, states) {
  const used = {};
  for (const file of sourceFiles(srcDir)) {
    for (const name of renderedComponents(readFileSync(file, "utf8"))) (used[name] ??= []).push(relative(srcDir, file));
  }
  const seen = [...new Set(states.flatMap((s) => s.components ?? []))].sort();
  const marked = seen.length > 0;
  const shown = new Set(seen);
  const missing = marked ? Object.keys(used).filter((name) => !shown.has(name)).sort() : [];
  return { used: Object.fromEntries(Object.entries(used).sort(([a], [b]) => a.localeCompare(b))), seen, missing, marked };
}

export function summarizeCoverage(cov) {
  const total = Object.keys(cov.used).length;
  const lines = ["", "### Lib components (report only)", ""];
  if (total === 0) {
    lines.push("The front renders no component of `@mairie360/lib-components`.");
  } else if (!cov.marked) {
    lines.push(
      `The front renders ${total} lib components, but no captured state shows a \`data-m360-component\` marker: ` +
        "the front is on a `@mairie360/lib-components` release older than the markers (MAIR-318), coverage is not measured.",
    );
  } else if (cov.missing.length === 0) {
    lines.push(`Every lib component the front renders (${total}) is shown by at least one captured state.`);
  } else {
    lines.push(
      `${total - cov.missing.length} of the ${total} lib components the front renders are shown by a captured state. ` +
        "Add a state to rgaa.yaml for the others:",
      "",
      "| Component | Rendered in |",
      "| --- | --- |",
    );
    for (const name of cov.missing) {
      const files = cov.used[name];
      lines.push(`| ${name} | ${files.slice(0, 3).map((f) => `\`${f}\``).join(", ")}${files.length > 3 ? `, … ${files.length - 3} more` : ""} |`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function main([srcDir, reportDir] = []) {
  if (!srcDir || !reportDir) {
    console.error("usage: node components.mjs <front src dir> <report dir>");
    return 2;
  }
  const reportFile = join(reportDir, "report.json");
  if (!existsSync(srcDir) || !existsSync(reportFile)) {
    console.log(`lib component coverage skipped: ${existsSync(srcDir) ? reportFile : srcDir} is missing`);
    return 0;
  }
  const report = JSON.parse(readFileSync(reportFile, "utf8"));
  const cov = coverage(srcDir, report.states ?? []);
  report.lib_components = cov;
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  const summary = join(reportDir, "summary.md");
  writeFileSync(summary, `${existsSync(summary) ? readFileSync(summary, "utf8") : ""}${summarizeCoverage(cov)}`);
  for (const name of cov.missing) console.log(`::warning title=RGAA::lib component ${name} is rendered by the front but shown by no state of rgaa.yaml (${cov.used[name][0]})`);
  return 0;
}

if (process.argv[1]?.endsWith("components.mjs")) process.exit(main(process.argv.slice(2)));
