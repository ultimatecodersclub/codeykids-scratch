// Pygame Zero games, in real Python on the page's own thread: pygame-ce
// draws into the canvas given, keys reach it from the page, and sounds play
// through the browser. One Python is kept between runs; each run forgets the
// project's modules and Pygame Zero's, so it starts clean.

import { GAME_PRELUDE } from "./prelude";

const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/";
const PGZERO_WHEEL = "/python/pgzero-1.2.1-py3-none-any.whl";
const PROJECT = "/home/pyodide/project";

type FS = {
  isDir: (mode: number) => boolean;
  mkdirTree: (path: string) => void;
  readdir: (path: string) => string[];
  rmdir: (path: string) => void;
  stat: (path: string) => { mode: number };
  unlink: (path: string) => void;
  writeFile: (path: string, data: Uint8Array) => void;
};

type Pyodide = {
  FS: FS;
  canvas: { setCanvas2D: (canvas: HTMLCanvasElement) => void };
  loadPackage: (names: string[], options?: { messageCallback?: (message: string) => void }) => Promise<unknown>;
  registerJsModule: (name: string, module: Record<string, unknown>) => void;
  runPython: (code: string) => unknown;
  runPythonAsync: (code: string) => Promise<unknown>;
  setStderr: (options: { batched: (text: string) => void }) => void;
  setStdin: (options: { stdin: () => string | null }) => void;
  setStdout: (options: { batched: (text: string) => void }) => void;
  unpackArchive: (buffer: ArrayBuffer, format: string, options?: { extractDir?: string }) => void;
};

export type GameError = { file?: string; line?: number; message: string };

export type GameHandlers = {
  // An error the game survives: one in a function the clock calls.
  error: (error: GameError) => void;
  output: (text: string, kind: "info" | "out") => void;
};

export type GameResult = { error?: GameError };

let python: Promise<Pyodide> | undefined;
let handlers: GameHandlers | undefined;
let loaded = false;

const load = () => {
  python ??= (async () => {
    const { loadPyodide } = await import(/* @vite-ignore */ `${PYODIDE_URL}pyodide.mjs`);
    const instance = (await loadPyodide({ indexURL: PYODIDE_URL })) as Pyodide;

    instance.setStdout({ batched: (text) => handlers?.output(`${text}\n`, "out") });
    instance.setStderr({ batched: (text) => handlers?.output(`${text}\n`, "info") });
    // input() in a game asks with the browser's own box: the page cannot wait
    // on its own thread any other way.
    instance.setStdin({ stdin: () => window.prompt("Your program is asking:") });

    // Pygame Zero's tone module imports pygame.sndarray, which needs numpy.
    // Pyodide's own "Loaded …" lines stay out of the kid's output.
    await instance.loadPackage(["numpy", "pygame-ce"], { messageCallback: () => undefined });

    const sitePackages = instance.runPython("import site; site.getsitepackages()[0]") as string;
    const wheel = await (await fetch(PGZERO_WHEEL)).arrayBuffer();

    instance.unpackArchive(wheel, "zip", { extractDir: sitePackages });
    instance.registerJsModule("codeykids_page", { error: (error: string) => handlers?.error(JSON.parse(error)) });
    instance.runPython(GAME_PRELUDE);
    loaded = true;

    return instance;
  })().catch((error: unknown) => {
    // Not kept: the next Run tries again.
    python = undefined;
    throw error;
  });

  return python;
};

const removeTree = (fs: FS, path: string) => {
  for (const name of fs.readdir(path)) {
    if (name === "." || name === "..") continue;

    const child = `${path}/${name}`;

    if (fs.isDir(fs.stat(child).mode)) {
      removeTree(fs, child);
      fs.rmdir(child);
    } else {
      fs.unlink(child);
    }
  }
};

export const warmUpGame = () => void load();

export const runGame = async (
  files: Record<string, Uint8Array>,
  canvas: HTMLCanvasElement,
  gameHandlers: GameHandlers,
): Promise<GameResult> => {
  // pygame names its window after the game, which in a browser is the tab.
  const title = document.title;

  handlers = gameHandlers;
  if (!loaded) gameHandlers.output("Starting Python and Pygame Zero…\n", "info");

  try {
    const instance = await load();
    const fs = instance.FS;

    instance.canvas.setCanvas2D(canvas);
    fs.mkdirTree(PROJECT);
    removeTree(fs, PROJECT);

    for (const [name, bytes] of Object.entries(files)) {
      const slash = name.lastIndexOf("/");

      if (slash > 0) fs.mkdirTree(`${PROJECT}/${name.slice(0, slash)}`);
      fs.writeFile(`${PROJECT}/${name}`, bytes);
    }

    canvas.focus();

    const result = (await instance.runPythonAsync("await _codeykids_game.run_game()")) as string | undefined;

    return result ? { error: JSON.parse(result) } : {};
  } catch (error) {
    return { error: { message: String(error) } };
  } finally {
    handlers = undefined;
    document.title = title;
  }
};

export const stopGame = () => {
  void python?.then((instance) => instance.runPython("_codeykids_game.stop()"));
};
