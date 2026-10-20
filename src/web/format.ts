import type { Plugin } from "prettier";

import { extensionOf } from "./files";

// Prettier is big, so it is fetched the first time a kid formats, never with
// the editor. Each language brings only the plugins it needs; a page also
// needs the CSS and JavaScript ones for its <style> and <script>.
// Each plugin module's default export is the whole plugin (its types only
// describe the parts).
const pluginOf = (module: { default: unknown }) => module.default as Plugin;

const postcss = () => import("prettier/plugins/postcss").then(pluginOf);
const babel = () => import("prettier/plugins/babel").then(pluginOf);
const estree = () => import("prettier/plugins/estree").then(pluginOf);
const htmlPlugin = () => import("prettier/plugins/html").then(pluginOf);

const PARSERS: Record<string, { parser: string; plugins: () => Promise<Plugin>[] }> = {
  css: { parser: "css", plugins: () => [postcss()] },
  htm: { parser: "html", plugins: () => [htmlPlugin(), postcss(), babel(), estree()] },
  html: { parser: "html", plugins: () => [htmlPlugin(), postcss(), babel(), estree()] },
  js: { parser: "babel", plugins: () => [babel(), estree()] },
};

export const canFormat = (name: string) => extensionOf(name) in PARSERS;

// The text tidied as Prettier would in VS Code, and where the cursor lands in
// it. 120 columns like VS Code's own HTML formatter, so a line of a kid's
// page is not split up sooner than they are used to.
export const formatCode = async (text: string, name: string, cursorOffset: number) => {
  const { parser, plugins } = PARSERS[extensionOf(name)];
  const [prettier, ...loaded] = await Promise.all([import("prettier/standalone"), ...plugins()]);

  return prettier.formatWithCursor(text, { cursorOffset, parser, plugins: loaded, printWidth: 120 });
};

// What a kid is told when the code can't be formatted: a mistake in it
// (Prettier says where), or the formatter not loading.
export const formatProblem = (error: unknown) => {
  const line = (error as { loc?: { start?: { line?: number } } })?.loc?.start?.line;

  return line
    ? `Can't format yet: something near line ${line} looks unfinished (a missing bracket, quote or tag?).`
    : "Can't format this file right now. Try again in a moment.";
};
