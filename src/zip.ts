import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

// A project file as both editors keep it: text edited in place, anything
// else as bytes that come back out unchanged.
export type ProjectFile = { bytes?: Uint8Array; text?: string };
export type ProjectFiles = Record<string, ProjectFile>;

export const textMatcher = (extensions: string[]) => (name: string) =>
  extensions.some((extension) => name.toLowerCase().endsWith(extension));

// Zips made in Finder or Explorer wrap everything in one top folder and add
// resource forks; Python leaves caches. None of that is the kid's project.
const isNoise = (path: string) =>
  path.endsWith("/") || path.startsWith("__MACOSX/") || path.includes("__pycache__/") || path.endsWith(".DS_Store");

// When every entry sits under the same top folder, that folder goes, so
// `site/index.html` and `site/images/cat.png` become `index.html` and
// `images/cat.png`.
const stripTopFolder = (paths: string[]) => {
  const tops = new Set(paths.map((path) => path.split("/")[0]));
  const top = tops.size === 1 && paths.every((path) => path.includes("/")) ? `${[...tops][0]}/` : "";

  return (path: string) => (top ? path.slice(top.length) : path);
};

// `stripTop` is for a whole project; files added to one keep their folders.
export const unpackZip = (
  bytes: Uint8Array,
  {
    isText,
    keep = () => true,
    stripTop = true,
  }: { isText: (name: string) => boolean; keep?: (name: string) => boolean; stripTop?: boolean },
): ProjectFiles => {
  const entries = Object.entries(unzipSync(bytes)).filter(([path]) => !isNoise(path));
  const strip = stripTop ? stripTopFolder(entries.map(([path]) => path)) : (path: string) => path;
  const files: ProjectFiles = {};

  for (const [path, data] of entries) {
    const name = strip(path);

    if (!keep(name)) continue;

    files[name] = isText(name) ? { text: strFromU8(data) } : { bytes: data };
  }

  return files;
};

export const packZip = (files: ProjectFiles, extra: Record<string, string> = {}) => {
  const entries: Record<string, Uint8Array> = {};

  for (const [name, file] of Object.entries(files)) {
    entries[name] = file.bytes ?? strToU8(file.text ?? "");
  }
  for (const [name, text] of Object.entries(extra)) {
    entries[name] = strToU8(text);
  }

  return zipSync(entries, { level: 6 });
};

// Size as saved, so a project full of emoji is not undercounted.
// The folders a path is in: "a/b/c.png" is in "a" and "a/b".
const foldersOf = (path: string) =>
  path
    .split("/")
    .slice(0, -1)
    .map((_, i, parts) => parts.slice(0, i + 1).join("/"));

// A project with another's files added where it has none of the same path:
// today's starter over a kid's project from the lesson before. The kid's own
// files always win, and an extra that would clash with them (a file where the
// kid has a folder of that name, or one inside what the kid has as a file)
// stays out.
export const withExtras = (files: ProjectFiles, extras: ProjectFiles): ProjectFiles => {
  const next = { ...files };
  const folders = new Set(Object.keys(files).flatMap(foldersOf));

  for (const [path, file] of Object.entries(extras)) {
    if (path in next || folders.has(path) || foldersOf(path).some((folder) => folder in files)) continue;
    next[path] = file;
  }

  return next;
};

export const bytesOf = (files: ProjectFiles) =>
  Object.values(files).reduce(
    (total, file) => total + (file.bytes?.byteLength ?? (file.text ? strToU8(file.text).byteLength : 0)),
    0,
  );
