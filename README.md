# codeykids-scratch

The editors CodeyKids embeds beside a lesson's steps, one static site:

- `/` — Scratch 3 (`@scratch/scratch-gui`)
- `/web/` — the web design editor: a file list, CodeMirror, and a sandboxed
  live preview; projects save as a zip
- `/python/` — the Python editor: CodeMirror and Skulpt, so turtle and
  `input()` programs run in the browser. `main.py` runs; other `.py` files
  are imported as modules and `.txt`/`.csv`/`.json`/`.md` files are read
  with `open()`. A project of `main.py` alone saves as `main.py`, anything
  more as a zip

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
| `{ type: "load", file?, url?, readOnly? }` | Load the project given as a Blob in `file`, or fetched from `url` (`.sb3` for Scratch, a zip for the web editor, `.py` or a zip holding one for Python). With neither, the current project stays. |
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
