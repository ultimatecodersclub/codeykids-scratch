# codeykids-scratch

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

Open http://localhost:8601/host.html for a stand-in lesson page that drives
the editor through the bridge: load a blank or saved project, load an `.sb3`
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
| `{ type: "load", url, readOnly? }` | Fetch the `.sb3` at `url` and load it. `url: null` keeps the current project. |
| `{ type: "save", requestId }` | Ask for the current project as an `.sb3` Blob. |
| `{ type: "setReadOnly", value }` | Switch between the editor and player-only mode. |

Messages the editor sends to the lesson page:

| Message | Meaning |
| --- | --- |
| `{ type: "ready" }` | The editor booted and its default project loaded. Send `load` now. |
| `{ type: "loaded" }` / `{ type: "loadFailed", message }` | Result of a `load`. |
| `{ type: "changed" }` | The project changed since the last message, at most once a second. |
| `{ type: "saved", requestId, file }` / `{ type: "saveFailed", requestId, message }` | Result of a `save`. `file` is a Blob. |

Set `VITE_ALLOWED_ORIGINS` to the comma-separated origins allowed to drive the
editor (see `.env.example`). `*` is for local development only.

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
