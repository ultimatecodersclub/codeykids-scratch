// Python that real Python runs once at start: input() and time.sleep() that
// wait for the page, plt.show() and Image.show() that draw into the output,
// and run_main(), which runs main.py and words an error the way the Skulpt
// runner does ("main.py, line 3: NameError: ...").
//
// Keep backslashes out of this string: the template literal would eat them.

export const PRELUDE = `
import builtins
import os
import sys
import time
import types

import js
from pyodide.ffi import JsException, to_js

os.environ.setdefault("MPLBACKEND", "Agg")

PROJECT = "/home/pyodide/project"

sys.path.append("/home/pyodide/.codeykids")


def _input(prompt=""):
    sys.stdout.flush()
    try:
        return str(js.codeykidsInput(str(prompt)))
    except JsException:
        raise RuntimeError("input() could not wait for an answer here. Reload the page and run again.") from None


def _sleep(seconds):
    sys.stdout.flush()
    js.codeykidsSleep(max(float(seconds), 0) * 1000)


def show_png(data):
    js.codeykidsImage(to_js(data))


def _patch_matplotlib():
    import io
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    if getattr(plt.show, "codeykids", False):
        plt.close("all")
        return

    def show(*args, **kwargs):
        import warnings

        for number in plt.get_fignums():
            buffer = io.BytesIO()
            # Pyodide's Agg build warns about its own float coordinates; the
            # kid's code is not at fault.
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", DeprecationWarning)
                plt.figure(number).savefig(buffer, format="png", dpi=96)
            show_png(buffer.getvalue())
        plt.close("all")

    show.codeykids = True
    plt.show = show


def _patch_pillow():
    import io
    from PIL import Image

    def show(self, title=None, **kwargs):
        buffer = io.BytesIO()
        image = self if self.mode in ("RGB", "RGBA", "L", "LA", "P") else self.convert("RGBA")
        image.save(buffer, format="PNG")
        show_png(buffer.getvalue())

    Image.Image.show = show


def _imports():
    from pyodide.code import find_imports

    names = set()
    for root, dirs, files in os.walk(PROJECT):
        for name in files:
            if name.endswith(".py"):
                with open(os.path.join(root, name), encoding="utf-8", errors="replace") as source:
                    try:
                        names.update(find_imports(source.read()))
                    except SyntaxError:
                        pass
    return names


def _forget_project_modules():
    for name, module in list(sys.modules.items()):
        path = getattr(module, "__file__", None) or ""
        if path.startswith(PROJECT + "/"):
            del sys.modules[name]


def _where(path):
    if not path:
        return None
    if path.startswith(PROJECT + "/"):
        path = path[len(PROJECT) + 1:]
    return None if path == "main.py" else path


# The browser's file system numbers errors its own way (a missing file is 44);
# the line under the program says them the way Python on a computer does.
_ERRNO = {"44": "2", "20": "17", "54": "20", "31": "21", "2": "13", "55": "39"}


def _usual_errno(message):
    marker = "[Errno "
    start = message.find(marker)
    if start < 0:
        return message
    end = message.find("]", start)
    code = message[start + len(marker):end]
    return message[:start] + marker + _ERRNO.get(code, code) + message[end:]


def _describe(error):
    import traceback

    if isinstance(error, SyntaxError):
        message = type(error).__name__ + ": " + str(error.msg)
        return {"file": _where(error.filename), "line": error.lineno, "message": message}

    message = _usual_errno("".join(traceback.format_exception_only(type(error), error)).strip())
    frames = [
        frame
        for frame in traceback.extract_tb(error.__traceback__)
        if frame.filename.startswith(PROJECT + "/")
    ]
    if not frames:
        return {"message": message}
    return {"file": _where(frames[-1].filename), "line": frames[-1].lineno, "message": message}


def run_main():
    import importlib
    import json
    import runpy

    _forget_project_modules()
    os.chdir(PROJECT)
    if PROJECT in sys.path:
        sys.path.remove(PROJECT)
    sys.path.insert(0, PROJECT)
    importlib.invalidate_caches()

    imports = _imports()
    if "matplotlib" in imports:
        _patch_matplotlib()
    if "PIL" in imports:
        _patch_pillow()

    try:
        runpy.run_path(PROJECT + "/main.py", run_name="__main__")
    except SystemExit as exit:
        if isinstance(exit.code, str) and exit.code:
            print(exit.code)
    except BaseException as error:
        return json.dumps(_describe(error))
    finally:
        sys.stdout.flush()
        sys.stderr.flush()
    return None


builtins.input = _input
time.sleep = _sleep

_codeykids = types.SimpleNamespace(run_main=run_main, show_png=show_png)
`;
