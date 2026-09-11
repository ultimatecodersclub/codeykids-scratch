// Runs a kid's program in Skulpt: prints go to `output`, input() asks the page
// for a line, turtle draws into the element named `turtleTarget`, and Stop
// cancels at the next loop iteration or turtle move.

export type RunHandlers = {
  // The project's text files: `import helpers` reads `./helpers.py`,
  // `open("data.txt")` reads `data.txt`, and a write lands back here.
  files: Record<string, string>;
  input: (prompt: string) => Promise<string>;
  onFileWrite: (name: string, text: string) => void;
  output: (text: string) => void;
  turtleTarget: string;
  turtleSize: { height: number; width: number };
};

export type RunError = { file?: string; line?: number; message: string };

const ownName = (name: string) => (name.startsWith("./") ? name.slice(2) : name);

const reader = (project: Record<string, string>) => (name: string) => {
  const own = ownName(name);

  if (project[own] !== undefined) return project[own];

  const files = Sk.builtinFiles?.files;

  if (files && files[name] !== undefined) return files[name];

  // What Python says, so `except IOError` (and OSError) in the kid's code
  // works; a missing module import is swallowed by Skulpt's own search.
  throw new Sk.builtin.IOError(`[Errno 2] No such file or directory: '${own}'`);
};

// Skulpt's wording differs from CPython's, which the worksheets quote; the
// commonest messages are said the way Python 3 says them.
const REWORDINGS: [RegExp, string][] = [
  [/^SyntaxError: bad input/, "SyntaxError: invalid syntax"],
  [/^TypeError: cannot concatenate 'str' and '(\w+)' objects/, 'TypeError: can only concatenate str (not "$1") to str'],
  [/^ZeroDivisionError: integer division or modulo by zero/, "ZeroDivisionError: division by zero"],
];

const reword = (message: string) =>
  REWORDINGS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), message);

type SkError = {
  args?: { v?: { v?: string }[] };
  traceback?: { filename?: string; lineno?: number }[];
  tp$name?: string;
};

const describe = (error: unknown): RunError => {
  const e = error as SkError;
  const message = e.tp$name && e.args?.v?.[0]?.v !== undefined ? `${e.tp$name}: ${e.args.v[0].v}` : String(error);
  const frame = e.traceback?.[0];
  // main.py runs as "<stdin>" (Skulpt adds ".py"); only a module gets named.
  const file = frame?.filename && !frame.filename.startsWith("<stdin>") ? ownName(frame.filename) : undefined;

  return { file, line: frame?.lineno, message: reword(message) };
};

// exit() and quit() are a normal end of the program, not an error; their
// argument, if any, is printed like Python does.
const systemExitMessage = (error: unknown) => {
  const e = error as SkError;

  if (e?.tp$name !== "SystemExit") return undefined;

  const argument = e.args?.v?.[0]?.v;

  return typeof argument === "string" && argument ? `${argument}\n` : "";
};

let openWrapped = false;

// open() in "w" or "a" mode starts or extends a project file, so a program
// can save what it made; the page keeps the result. Wrapped once: Skulpt
// looks the builtin up by reference at each call.
const wrapOpen = () => {
  if (openWrapped) return;

  const original = Sk.builtin.open;
  const wrapped = (filename: { v: string }, mode?: { v: string }, bufsize?: unknown) => {
    const name = ownName(filename.v);
    const m = mode?.v ?? "r";

    if (m.startsWith("w")) currentProject[name] = "";
    else if (m.startsWith("a") && currentProject[name] === undefined) currentProject[name] = "";

    return original(filename, mode, bufsize);
  };

  Sk.builtin.open = wrapped;
  Sk.builtins.open = wrapped;
  // Python 3 names Skulpt 1.2 lacks, pointed at the error it does raise.
  Sk.builtins.FileNotFoundError ??= Sk.builtin.IOError;
  Sk.builtins.OSError ??= Sk.builtin.IOError;
  openWrapped = true;
};

let currentProject: Record<string, string> = {};

export const runPython = (code: string, handlers: RunHandlers, stopped: () => boolean) => {
  currentProject = handlers.files;
  wrapOpen();

  Sk.configure({
    __future__: Sk.python3,
    filewrite: (file: { name: string }, str: { v: string }) => {
      const name = ownName(file.name);

      currentProject[name] = (currentProject[name] ?? "") + str.v;
      handlers.onFileWrite(name, currentProject[name]);
    },
    inputfun: handlers.input,
    inputfunTakesPrompt: true,
    killableFor: true,
    killableWhile: true,
    nonreadopen: true,
    output: handlers.output,
    read: reader(currentProject),
    yieldLimit: 100,
  });
  Sk.TurtleGraphics = { target: handlers.turtleTarget, ...handlers.turtleSize };
  // In "browser" mode open() looks for a DOM element named after the file;
  // off, it goes through the reader above, which serves the project's files.
  // Skulpt uses the flag nowhere else.
  Sk.inBrowser = false;

  return Sk.misceval
    .asyncToPromise(() => Sk.importMainWithBody("<stdin>", false, code, true), {
      // Every suspension passes here: loops, sleeps, turtle moves, input.
      "*": () => {
        if (stopped()) throw new Error("Stopped");
      },
    })
    .then(
      () => undefined,
      (error: unknown): RunError | undefined => {
        if (error instanceof Error && error.message === "Stopped") return { message: "Stopped" };

        const exitMessage = systemExitMessage(error);

        if (exitMessage !== undefined) {
          if (exitMessage) handlers.output(exitMessage);

          return undefined;
        }

        return describe(error);
      },
    );
};
