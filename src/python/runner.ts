// Runs a kid's program in Skulpt: prints go to `output`, input() asks the page
// for a line, turtle draws into the element named `turtleTarget`, and Stop
// cancels at the next loop iteration or turtle move.

import { pythonWording } from "./wording";

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

// The least of the turtle's world the panel shows, about what Python's own
// turtle window shows. A narrower panel shrinks the drawing to fit instead of
// cutting it off, by the same amount both ways so circles stay round.
const TURTLE_WORLD = { height: 500, width: 600 };

// Skulpt's turtle offers only a few of the screen's methods as plain functions
// (title, tracer, done...), where Python's offers them all, and the worksheets
// start with turtle.bgcolor("black"). Skulpt's module is served under another
// name and this one, imported as turtle, adds the rest, and makes the rest
// answer the way Python's do: input() stands in for the dialogs, colormode is
// the screen's (Skulpt keeps one per turtle), setup() and window_width() are
// about the world the panel shows rather than its pixels.
const TURTLE = `from _skulpt_turtle import *
import _skulpt_turtle

_state = {"colormode": 1.0, "world": (${TURTLE_WORLD.width}, ${TURTLE_WORLD.height})}


def _world_size():
    pixels = _skulpt_turtle.Screen()
    across, down = pixels.window_width(), pixels.window_height()
    wide, high = _state["world"]
    scale = max(wide / across, high / down, 1)
    return across * scale, down * scale


class Screen(_skulpt_turtle.Screen):
    def colormode(self, cmode=None):
        if cmode is None:
            return _state["colormode"]
        _state["colormode"] = 255 if cmode == 255 else 1.0
        for each in self.turtles():
            each.colormode(cmode)

    def numinput(self, title, prompt, default=None, minval=None, maxval=None):
        while True:
            answer = input(prompt)
            if answer == "" and default is not None:
                return float(default)
            try:
                number = float(answer)
            except ValueError:
                print("Not a number. Please try again.")
                continue
            if minval is not None and number < minval:
                print(f"The allowed minimum value is {minval}. Please try again.")
            elif maxval is not None and number > maxval:
                print(f"The allowed maximum value is {maxval}. Please try again.")
            else:
                return number

    def onkeypress(self, fun, key=None):
        return self.onkey(fun, key)

    def setup(self, width=0.5, height=0.75, startx=None, starty=None):
        if width > 1 and height > 1:
            _state["world"] = (width, height)
            across, down = _world_size()
            self.setworldcoordinates(-across / 2, -down / 2, across / 2, down / 2)

    def textinput(self, title, prompt):
        return input(prompt)

    def window_height(self):
        return int(_world_size()[1])

    def window_width(self):
        return int(_world_size()[0])


class Turtle(_skulpt_turtle.Turtle):
    def __init__(self, *args, **kwargs):
        _skulpt_turtle.Turtle.__init__(self, *args, **kwargs)
        if _state["colormode"] == 255:
            self.colormode(255)


def _screen_function(name):
    def function(*args, **kwargs):
        return getattr(Screen(), name)(*args, **kwargs)
    return function


def colormode(cmode=None):
    if cmode is not None:
        _skulpt_turtle.colormode(cmode)
    return Screen().colormode(cmode)


addshape = _screen_function("addshape")
bgcolor = _screen_function("bgcolor")
bgpic = _screen_function("bgpic")
clearscreen = _screen_function("clearscreen")
exitonclick = _screen_function("exitonclick")
getshapes = _screen_function("getshapes")
listen = _screen_function("listen")
numinput = _screen_function("numinput")
onkey = _screen_function("onkey")
onkeypress = _screen_function("onkeypress")
onscreenclick = _screen_function("onscreenclick")
ontimer = _screen_function("ontimer")
register_shape = _screen_function("register_shape")
resetscreen = _screen_function("resetscreen")
setup = _screen_function("setup")
setworldcoordinates = _screen_function("setworldcoordinates")
textinput = _screen_function("textinput")
turtles = _screen_function("turtles")
window_height = _screen_function("window_height")
window_width = _screen_function("window_width")
`;

const LIBRARY = "src/lib/";

const reader = (project: Record<string, string>) => (name: string) => {
  const own = ownName(name);

  if (project[own] !== undefined) return project[own];

  const files = Sk.builtinFiles?.files;

  if (name === `${LIBRARY}turtle.py`) return TURTLE;
  if (name === `${LIBRARY}_skulpt_turtle.js`) return files?.[`${LIBRARY}turtle.js`];
  if (files && files[name] !== undefined && name !== `${LIBRARY}turtle.js`) return files[name];

  // What Python says, so `except IOError` (and OSError) in the kid's code
  // works; a missing module import is swallowed by Skulpt's own search.
  throw new Sk.builtin.IOError(`[Errno 2] No such file or directory: '${own}'`);
};

type SkError = {
  args?: { v?: { v?: string }[] };
  traceback?: { filename?: string; lineno?: number }[];
  tp$name?: string;
};

// Said the way Python 3.14 says it (see wording.ts), from the file the error
// is in: `main` for main.py, `project` for the others.
const describe = (error: unknown, main: string, project: Record<string, string>): RunError => {
  const e = error as SkError;
  const argument = e.args?.v?.[0];
  // Python shows a missing key as written, quotes and all: KeyError: 'x'.
  const detail = e.tp$name === "KeyError" && argument ? Sk.misceval.objectRepr(argument) : argument?.v;
  const message = e.tp$name && detail !== undefined ? `${e.tp$name}: ${detail}` : String(error);
  // The kid's own line, not one in the turtle module above.
  const frame = e.traceback?.find((place) => !place.filename?.startsWith(LIBRARY)) ?? e.traceback?.[0];
  // main.py runs as "<stdin>" (Skulpt adds ".py"); only a module gets named.
  const file = frame?.filename && !frame.filename.startsWith("<stdin>") ? ownName(frame.filename) : undefined;

  return { file, ...pythonWording({ line: frame?.lineno, message }, file ? project[file] : main) };
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

// A panel not laid out yet (0 px) leaves the world to Skulpt's own measure.
const turtleGraphics = (target: string, { height, width }: RunHandlers["turtleSize"]) => {
  if (!height || !width) return { height, target, width };

  const scale = Math.max(TURTLE_WORLD.width / width, TURTLE_WORLD.height / height, 1);

  return { height, target, width, worldHeight: height * scale, worldWidth: width * scale };
};

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
  Sk.TurtleGraphics = turtleGraphics(handlers.turtleTarget, handlers.turtleSize);
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

        return describe(error, code, handlers.files);
      },
    );
};
