// Runs a kid's program in Skulpt: prints go to `output`, input() asks the page
// for a line, turtle draws into the element named `turtleTarget`, and Stop
// cancels at the next loop iteration or turtle move.

export type RunHandlers = {
  input: (prompt: string) => Promise<string>;
  output: (text: string) => void;
  turtleTarget: string;
  turtleSize: { height: number; width: number };
};

export type RunError = { line?: number; message: string };

const builtinRead = (name: string) => {
  const files = Sk.builtinFiles?.files;

  if (!files || files[name] === undefined) throw new Error(`File not found: '${name}'`);

  return files[name];
};

// Skulpt's wording differs from CPython's, which the worksheets quote; the
// commonest messages are said the way Python 3 says them.
const REWORDINGS: [RegExp, string][] = [
  [/^SyntaxError: bad input/, "SyntaxError: invalid syntax"],
  [/^TypeError: cannot concatenate 'str' and '(\w+)' objects/, 'TypeError: can only concatenate str (not "$1") to str'],
  [/^TypeError: unsupported operand type\(s\) for (\S+): '(\w+)' and '(\w+)'/, "TypeError: unsupported operand type(s) for $1: '$2' and '$3'"],
];

const reword = (message: string) =>
  REWORDINGS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), message);

const describe = (error: unknown): RunError => {
  const e = error as { args?: { v?: { v?: string }[] }; traceback?: { lineno?: number }[]; tp$name?: string };
  const message = e.tp$name && e.args?.v?.[0]?.v !== undefined ? `${e.tp$name}: ${e.args.v[0].v}` : String(error);

  return { line: e.traceback?.[0]?.lineno, message: reword(message) };
};

// exit() and quit() are a normal end of the program, not an error.
const isSystemExit = (error: unknown) => (error as { tp$name?: string })?.tp$name === "SystemExit";

export const runPython = (code: string, handlers: RunHandlers, stopped: () => boolean) => {
  Sk.configure({
    __future__: Sk.python3,
    inputfun: handlers.input,
    inputfunTakesPrompt: true,
    killableFor: true,
    killableWhile: true,
    output: handlers.output,
    read: builtinRead,
    yieldLimit: 100,
  });
  Sk.TurtleGraphics = { target: handlers.turtleTarget, ...handlers.turtleSize };

  return Sk.misceval
    .asyncToPromise(() => Sk.importMainWithBody("<stdin>", false, code, true), {
      // Every suspension passes here: loops, sleeps, turtle moves, input.
      "*": () => {
        if (stopped()) throw new Error("Stopped");
      },
    })
    .then(
      () => undefined,
      (error: unknown) =>
        error instanceof Error && error.message === "Stopped"
          ? { message: "Stopped" }
          : isSystemExit(error)
            ? undefined
            : describe(error),
    );
};
