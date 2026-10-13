// Python for Pygame Zero games, run on the page's own thread (pygame draws to
// a canvas there). Pygame Zero's game loop is a `while True` that would
// freeze the page, so PGZeroGame.run is replaced by the same loop written to
// give the browser a turn every frame. run_game() runs main.py as Pygame
// Zero's runner does and returns once the game ends or Stop is pressed.
//
// Keep backslashes out of this string: the template literal would eat them.

export const GAME_PRELUDE = `
import asyncio
import json
import os
import sys
import time
import traceback
import types

PROJECT = "/home/pyodide/project"
FRAME = 1 / 60

# pygame greets with its version on import; a kid's output should not start
# with it.
os.environ["PYGAME_HIDE_SUPPORT_PROMPT"] = "1"
# pygame's browser layer listens for keys on the whole page by default and
# swallows every letter, so once a game had run the code could not be typed
# into until the page was reloaded. It listens on the game's canvas instead:
# the game gets the keys while it has the focus, the code the rest of the time.
os.environ["SDL_EMSCRIPTEN_KEYBOARD_ELEMENT"] = "#canvas"

_state = types.SimpleNamespace(stopped=False)
_print_exc = traceback.print_exc


def _forget_modules():
    for name, module in list(sys.modules.items()):
        path = getattr(module, "__file__", None) or ""
        if name == "pgzrun" or name.startswith("pgzero") or path.startswith(PROJECT + "/"):
            del sys.modules[name]


async def _mainloop(self):
    import pygame
    import pgzero.clock

    self.reinit_screen()
    update = self.get_update_func()
    draw = self.get_draw_func()
    self.load_handlers()

    pgzclock = pgzero.clock.clock
    self.need_redraw = True
    last = time.perf_counter()

    while not _state.stopped:
        await asyncio.sleep(max(0, FRAME - (time.perf_counter() - last)))
        now = time.perf_counter()
        dt = min(now - last, 0.1)
        last = now

        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                return
            if event.type == pygame.KEYDOWN:
                self.keyboard._press(event.key)
            elif event.type == pygame.KEYUP:
                self.keyboard._release(event.key)
            self.dispatch_event(event)

        # Pygame Zero prints an error in a function the clock calls as a
        # traceback through its own files and carries on without that
        # function. It carries on here too, the page showing the error in one
        # line like any other.
        traceback.print_exc = _print_error
        try:
            pgzclock.tick(dt)
        finally:
            traceback.print_exc = _print_exc

        if update:
            update(dt)

        screen_change = self.reinit_screen()
        if screen_change or update or pgzclock.fired or self.need_redraw:
            draw()
            pygame.display.flip()
            self.need_redraw = False


def _patch_pgzero():
    import pygame
    import pgzero.game

    # A browser tab has no window icon. Pygame Zero's default one is read from
    # memory, which pygame-ce cannot do in the browser, so neither is tried.
    def set_icon(surface):
        pass

    pygame.display.set_icon = set_icon
    pgzero.game.PGZeroGame.show_default_icon = staticmethod(lambda: None)


    games = []

    def run(self):
        games.append(self)

    pgzero.game.PGZeroGame.run = run
    return games


def stop():
    _state.stopped = True


def _where(path):
    if not path:
        return None
    if path.startswith(PROJECT + "/"):
        path = path[len(PROJECT) + 1:]
    return None if path == "main.py" else path


def _describe(error):
    if isinstance(error, SyntaxError):
        message = type(error).__name__ + ": " + str(error.msg)
        return {"file": _where(error.filename), "line": error.lineno, "message": message}

    message = "".join(traceback.format_exception_only(type(error), error)).strip()
    frames = [
        frame
        for frame in traceback.extract_tb(error.__traceback__)
        if frame.filename.startswith(PROJECT + "/")
    ]
    if not frames:
        return {"message": message}
    return {"file": _where(frames[-1].filename), "line": frames[-1].lineno, "message": message}


def _print_error(*args, **kwargs):
    import codeykids_page

    error = sys.exc_info()[1]
    if error is None:
        return _print_exc(*args, **kwargs)
    codeykids_page.error(json.dumps(_describe(error)))


async def run_game():
    import pygame

    _state.stopped = False
    _forget_modules()
    os.chdir(PROJECT)
    if PROJECT in sys.path:
        sys.path.remove(PROJECT)
    sys.path.insert(0, PROJECT)

    games = _patch_pgzero()
    path = PROJECT + "/main.py"
    module = types.ModuleType("__main__")
    module.__file__ = path
    main = sys.modules.get("__main__")
    sys.modules["__main__"] = module

    try:
        with open(path, encoding="utf-8") as source:
            code = compile(source.read(), path, "exec", dont_inherit=True)
        exec(code, module.__dict__)
        for game in games:
            await _mainloop(game)
        if _state.stopped:
            return json.dumps({"message": "Stopped"})
    except SystemExit:
        pass
    except BaseException as error:
        return json.dumps(_describe(error))
    finally:
        sys.modules["__main__"] = main
        sys.stdout.flush()
        try:
            pygame.mixer.stop()
            pygame.mixer.music.stop()
        except Exception:
            pass
    return None


_codeykids_game = types.SimpleNamespace(run_game=run_game, stop=stop)
`;
