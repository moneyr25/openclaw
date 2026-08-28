/**
 * Guard the Workers build.
 *
 * The Worker shares almost all of its code with the Node server, and it is very
 * easy to add an import to a shared module that quietly pulls in `node:fs` —
 * which fails at deploy time, or worse, at the first request. This walks the
 * import graph from the Worker entry point and fails if it reaches a `node:`
 * builtin or a module known to be Node-only.
 *
 *   npm run check:worker
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const ENTRY = path.join(APP_ROOT, "worker", "index.ts");

/** Modules that legitimately use node: APIs and must stay out of the Worker. */
const NODE_ONLY = new Set(
  ["src/server.ts", "src/config.ts"].map((relative) =>
    path.join(APP_ROOT, relative),
  ),
);

/**
 * Matches value imports only. `import type` / `export type` are erased before
 * anything reaches the runtime, so they cannot drag a Node builtin into the
 * bundle and must not be reported as if they could.
 */
const IMPORT_PATTERN =
  /(?:^|\n)\s*(?:import|export)\s+(?!type\s)([\s\S]*?)from\s+["']([^"']+)["']/gu;

const visited = new Set<string>();
const problems: string[] = [];

const walk = async (file: string, importedBy: string[]): Promise<void> => {
  if (visited.has(file)) return;
  visited.add(file);

  if (NODE_ONLY.has(file)) {
    problems.push(
      `${path.relative(APP_ROOT, file)} is Node-only but is reachable from the Worker\n` +
        `    via ${importedBy.map((f) => path.relative(APP_ROOT, f)).join(" -> ")}`,
    );
    return;
  }

  const source = await readFile(file, "utf8");
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const clause = match[1] ?? "";
    const specifier = match[2];
    if (!specifier) continue;
    // `import { type A, type B } from ...` is also fully erased.
    const bindings = clause.match(/\{([\s\S]*)\}/u)?.[1];
    if (
      bindings !== undefined &&
      bindings
        .split(",")
        .filter((entry) => entry.trim() !== "")
        .every((entry) => entry.trim().startsWith("type "))
    ) {
      continue;
    }

    if (specifier.startsWith("node:")) {
      problems.push(
        `${path.relative(APP_ROOT, file)} imports ${specifier}\n` +
          `    via ${[...importedBy, file]
            .map((f) => path.relative(APP_ROOT, f))
            .join(" -> ")}`,
      );
      continue;
    }
    // Bare specifiers would be a dependency, and this app has none.
    if (!specifier.startsWith(".")) {
      problems.push(
        `${path.relative(APP_ROOT, file)} imports the bare specifier ${specifier}; ` +
          "the app is meant to have no dependencies",
      );
      continue;
    }

    await walk(path.resolve(path.dirname(file), specifier), [
      ...importedBy,
      file,
    ]);
  }
};

await walk(ENTRY, []);

console.log(`Walked ${visited.size} modules from worker/index.ts`);

if (problems.length === 0) {
  console.log("Worker graph is runtime-clean: no node: builtins, no dependencies.");
  process.exit(0);
}

console.log(`\n${problems.length} problem(s):\n`);
for (const problem of problems) console.log(`  - ${problem}`);
process.exit(1);
