import type { PythonFiles } from "./project";

// Skulpt runs a program whose imports it has: it starts at once and draws
// turtle. Anything else (matplotlib, PIL, os, requests, json…) needs real
// Python, which loads a few seconds the first time.
const SKULPT_MODULES = new Set([
  "__future__",
  "collections",
  "copy",
  "datetime",
  "itertools",
  "keyword",
  "math",
  "operator",
  "random",
  "re",
  "string",
  "textwrap",
  "time",
  "turtle",
]);

const IMPORT = /^[ \t]*(?:from[ \t]+([\w.]+)[ \t]+import|import[ \t]+([\w., \t]+))/gm;

// The top-level modules a file imports, e.g. "matplotlib" for
// `import matplotlib.pyplot as plt`.
export const importsOf = (code: string) =>
  [...code.matchAll(IMPORT)].flatMap(([, from, names]) =>
    (from ?? names ?? "")
      .split(",")
      .map((name) => name.trim().split(/[ \t]/)[0].split(".")[0])
      .filter(Boolean),
  );

// Pygame Zero games run on the page's own thread, where pygame can draw.
const GAME_MODULES = new Set(["pgzero", "pgzrun"]);

export type Engine = "skulpt" | "full" | "game" | "pygame";

// Which Python runs the project: "pygame" is a plain pygame program, whose
// own endless loop a browser page cannot run.
export const engineFor = (files: PythonFiles): Engine => {
  const own = new Set(
    Object.keys(files)
      .filter((name) => name.endsWith(".py"))
      .map((name) => name.slice(name.lastIndexOf("/") + 1, -3)),
  );
  const imports = Object.entries(files)
    .filter(([name, file]) => name.endsWith(".py") && file.text !== undefined)
    .flatMap(([, file]) => importsOf(file.text ?? ""))
    .filter((name) => !own.has(name));

  if (imports.some((name) => GAME_MODULES.has(name))) return "game";
  if (imports.includes("pygame")) return "pygame";
  // Turtle draws only in Skulpt, so a turtle program stays there.
  if (imports.includes("turtle")) return "skulpt";

  return imports.some((name) => !SKULPT_MODULES.has(name)) ? "full" : "skulpt";
};
