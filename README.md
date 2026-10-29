# codeykids-scratch

The editors CodeyKids embeds beside a lesson's steps, one static site:

- `/` — Scratch 3 (`@scratch/scratch-gui`)
- `/web/` — the web design editor: a file list, CodeMirror, and a sandboxed
  live preview; projects save as a zip
- `/python/` — the Python editor. `main.py` runs; other `.py` files are
  imported as modules, and the project's other files (data, images, sounds,
  folders) are its working folder. A project of `main.py` alone saves as
  `main.py`, anything more as a zip. Three engines, picked from what the
  project imports (`src/python/engine.ts`):
  - **Skulpt** for turtle and plain programs (starts at once).
  - **Real Python** (Pyodide, in a worker) for anything Skulpt lacks:
    matplotlib, PIL, numpy, pandas, os, json, csv, requests… Packages load on
    first use from the Pyodide CDN. `plt.show()` and `Image.show()` draw into
    the output; files the program writes save with the project. `input()` and
    `time.sleep()` block through a small service worker (`public/editor-sw.js`),
    so the page embedding the editor needs no cross-origin isolation headers.
    Stand-ins for libraries a browser cannot run live in
    `src/python/full/modules.ts`: `ollama` asks CodeyKids' hosted model
    through the `aiChat` mutation, with a token the lesson page hands over
    in a `setAi` message; `mediapipe` (the legacy `mp.solutions.hands`)
    finds hands with Google's hand tracker for the browser. Real OpenCV runs,
    with its camera, windows and keys answered by the page
    (`src/python/full/camera.ts`): `cv2.VideoCapture` reads the webcam,
    `cv2.imshow` draws above the output, `cv2.waitKey` reads keys pressed
    on it.
  - **Pygame Zero** (pygame-ce in Pyodide, on the page's thread) for programs
    that import `pgzrun`: Pygame Zero's game loop is replaced by one that gives
    the browser a turn every frame. Pygame Zero 1.2.1 ships in
    `public/python/` (LGPL-3.0, https://pygame-zero.readthedocs.io).

The Scratch 3 editor that CodeyKids embeds next to a lesson's steps. It wraps
the Scratch Foundation's `@scratch/scratch-gui` with a tiny `postMessage`
bridge, so the lesson page can load a kid's project into it and ask for the
current project back as an `.sb3` file. The editor never holds a CodeyKids
session; the lesson page does the saving.

Based on Scratch, which is developed by the Scratch Foundation
(https://scratch.mit.edu). `@scratch/scratch-gui` is AGPL-3.0, which is why
this repository is public and carries the same licence.

## Running

```sh
npm install
npm run dev
```

Open http://localhost:8601/host.html (or `host.html?editor=web`, `?editor=python`) for a
stand-in lesson page that drives an editor through the bridge: load a blank or saved project, load an `.sb3`
from disk, ask for a save, toggle read-only. The editor on its own is at
http://localhost:8601/.

`npm run build` writes a static site to `dist/`. Serve it from the root of its
own origin: the Scratch bundle resolves `static/…` and `chunks/…` relative to
the page and to its own script, so it cannot live under a sub-path.

## The bridge

Messages the lesson page sends to the editor (`window.postMessage` to the
iframe):

| Message | Meaning |
| --- | --- |
| `{ type: "load", file?, url?, extras?, readOnly? }` | Load the project given as a Blob in `file`, or fetched from `url` (`.sb3` for Scratch, a zip for the web editor, `.py` or a zip holding one for Python). With neither, each editor starts a new project (Scratch's cat, the web editor's three-file site, Python's starter file), never what was open before. `extras` (web and Python) is a zip, or a `.py`, whose files are added where the project has none of the same path: today's starter over a kid's project from the lesson before. The kid's own files always win. |
| `{ type: "save", requestId }` | Ask for the current project as a Blob (`.sb3`, a zip of the site, or `main.py` or a zip for Python). The Blob is a `File` with a name when the extension matters. |
| `{ type: "snapshot", requestId }` | Ask for a picture of the work as it stands, for the project card: the Scratch stage, the turtle drawing (or the first lines of `main.py` when nothing was drawn), the site's first page as written. |
| `{ type: "setReadOnly", value }` | Switch between the editor and player-only mode. |
| `{ type: "menu", action, value? }` | Scratch only. A pick from the menu the page draws in place of Scratch's menubar: `new`, `tutorials`, `debug`, `restore`, `turbo` (value: on), `language` (value: a code), `colorMode` (`default` or `high-contrast`), `theme` (`default` or `cat-blocks`). |

Messages the editor sends to the lesson page:

| Message | Meaning |
| --- | --- |
| `{ type: "ready" }` | The editor booted and its default project loaded. Send `load` now. |
| `{ type: "loaded" }` / `{ type: "loadFailed", message }` | Result of a `load`. |
| `{ type: "changed" }` | The project changed since the last message, at most once a second. |
| `{ type: "saved", requestId, file }` / `{ type: "saveFailed", requestId, message }` | Result of a `save`. `file` is a Blob. |
| `{ type: "snapshot", requestId, image }` / `{ type: "snapshotFailed", requestId, message }` | Result of a `snapshot`. `image` is a 480 by 360 JPEG Blob, under 512 KB. A save never waits on it. |
| `{ type: "menuState", state }` | Scratch only, at boot and whenever it changes: what the menubar would show. `restorable` ("Sprite", "Costume", "Sound" or ""), `turbo`, `locale` and `languages`, `colorMode` and `colorModes`, `theme` and `themes`. |

Set `VITE_ALLOWED_ORIGINS` to the comma-separated origins allowed to drive the
editor (see `.env.example`). `*` is for local development only.

## The web editor's preview host

The web editor shows a kid's site in a frame on a host of its own, a
different origin from CodeyKids and the editor (`VITE_PREVIEW_URL`, for
example `https://preview.codeykids.com/`). There the site runs at real
addresses, as a web server would serve it: folders, `../` links, images in
CSS, fonts, audio, `fetch()` of the site's own files and module imports all
work, and a page that isn't there gets "Page not found".

`public/preview/` is the whole host and is served at its root:

- `index.html`, the bridge. The editor opens it in the preview frame for every
  run (`index.html?build=N#session=…&editor=…`) and sends it the site's files
  (only those that changed since the last run). It writes them to Cache
  Storage and opens the page the kid was on.
- `sw.js`, a service worker over the whole origin. It serves each editor's
  site from `/p/<session>/`, a root-relative address (`/style.css`) from the
  site that asked, and puts `prelude.js` first in every page.
- `prelude.js`, which gives the editor its console (output, errors with the
  kid's own line numbers, a line typed there runs in the page), keeps
  localStorage per project (the editor saves it with the site) and reports
  the page's address for the editor's address bar.

The host must allow only the editor to frame it, and serve all three files
uncached. `frame-ancestors` is checked against every page above the frame, so
it lists the studio and every app that frames the studio (CodeyKids and the
portal), for example
`Content-Security-Policy: frame-ancestors https://studio.codeykids.com https://www.codeykids.com https://code.ultimatecoders.com`.

Kids' code runs on this origin, so the host keeps as little as it can: an
editor forgets its site when it closes, and a site not run for two hours is
dropped by the next run of any other.

If the host fails or doesn't answer a run within 15 seconds (a browser that
blocks it, say), the editor shows the site the old way for the rest of the
session and says so in its console.

Without `VITE_PREVIEW_URL` the site is built into one page instead
(`buildPreview`, a sandboxed `srcdoc` frame). In development (`npm run dev`)
the editor at `localhost` uses `127.0.0.1` as its preview host (the dev
server listens there and allows the service worker the whole origin). Open
the editors at `localhost`: `127.0.0.1` belongs to the preview, and the
Python editor's own service worker would take its place there.

## The Scratch menubar

The GUI's menubar is hidden (`menuBarHidden`), so the 48px it took go to the
blocks: on a laptop the lesson page's own bar already sits above the frame.
Nothing it offered is gone. `src/menuBridge.tsx` sits inside the GUI's store
and answers the `menu` message with the GUI's own actions (File > New,
Tutorials, Debug, Edit > Restore and Turbo mode, the language, the colour
mode and the block theme), and reports `menuState` so the page can draw the
menu truthfully. Loading and saving a file on the kid's computer are the
page's: it already holds the bytes (`load` with a `file`, `save`).

A GUI-driven New reports the fresh project through `onProjectLoaded`, like
the default project at boot; only the first is announced as `ready`, or the
page would load the saved project straight back over the new one.

## What the spike proved

- The published `@scratch/scratch-gui` bundle drops into a Vite app with
  React 18, Redux 4 and react-redux 8, no fork needed.
- `onVmInit` hands over the VM, `onProjectLoaded` fires once the default
  project is in, and `PROJECT_CHANGED` on the runtime reports edits.
- `vm.saveProjectSb3()` returns a complete `.sb3` (blocks, costumes, sounds),
  and `vm.loadProject(arrayBuffer)` restores it.
- `isPlayerOnly` gives a read-only view with just the stage.
- The sprite, backdrop and sound library thumbnails are bundled under
  `static/`; the full assets come from `cdn.assets.scratch.mit.edu`.
- A production build is about 100 MB on disk, 17 MB of JavaScript (6 MB
  gzipped) plus 68 MB of static assets.

Still to check on real hardware: Scratch Link pairing a micro:bit and a LEGO
hub from this origin.
