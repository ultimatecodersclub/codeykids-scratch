import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createRoot } from "react-dom/client";

import { answerSnapshot, listenToPage, postToPage } from "../bridge";
import { useImageUrl } from "../python/useImageUrl";
import { codeCard, pictureOfPage } from "../snapshot";
import { unpackZip } from "../zip";
import { CodeEditor } from "./CodeEditor";
import { ConsoleLines, useConsole } from "./Console";
import { FileTree } from "./FileTree";
import { DEVICES, Device, PreviewToolbar, SavedData, useFit } from "./PreviewTools";
import {
  asSiteFile,
  buildPreview,
  bytesOf,
  folderOf,
  fromZip,
  imageType,
  inFolder,
  isHtml,
  isSitePath,
  isText,
  PreviewTools,
  STARTER_FILES,
  Storage,
  storageBytes,
  toZip,
  WebFiles,
} from "./files";
import "./web.css";

const SIZE_LIMIT = 20 * 1024 * 1024;
const PREVIEW_DELAY_MS = 400;

// The preview host (public/preview): the site runs there at real addresses,
// on an origin of its own, so its folders, links, images in CSS, fetch() of
// its files and module imports work as on a web server. Without one the site
// is shown as a single built page (buildPreview), as before.
const previewBase = (() => {
  const configured = import.meta.env.VITE_PREVIEW_URL;

  if (configured) return new URL(configured.endsWith("/") ? configured : `${configured}/`, window.location.href).href;
  // In development the editor runs on localhost, and 127.0.0.1 is another
  // origin serving the same files.
  if (import.meta.env.DEV && window.location.hostname === "localhost") {
    return `${window.location.protocol}//127.0.0.1:${window.location.port}/preview/`;
  }

  return "";
})();
const previewOrigin = previewBase ? new URL(previewBase).origin : "null";
// How long the preview host has to answer a run before the editor shows the
// site the old way instead (a browser that blocks it, say).
const HOST_TIMEOUT_MS = 15_000;

// A version for each file object. An edit replaces only the edited file, so
// a file keeps its version until it changes. The preview host reports the
// versions it holds once they are all written; anything else is sent again.
const versions = new WeakMap<WebFiles[string], number>();
let lastVersion = 0;

const versionOf = (file: WebFiles[string]) => {
  let version = versions.get(file);

  if (version === undefined) {
    lastVersion += 1;
    version = lastVersion;
    versions.set(file, version);
  }

  return version;
};

const CHANGED_THROTTLE_MS = 1000;
// What the site saves while it runs reaches the page within this, however
// often the site writes. It is a change by the run (the page saves it a
// little later than an edit, and never for staff trying a kid's site).
const STORAGE_REPORT_MS = 2000;

// The page a site opens on: index.html, else its first page.
const entryPage = (files: WebFiles) =>
  files["index.html"] ? "index.html" : (Object.keys(files).find(isHtml) ?? "index.html");

const WebEditor = () => {
  const [files, setFiles] = useState<WebFiles>(() => structuredClone(STARTER_FILES));
  const [active, setActive] = useState("index.html");
  // The folder new and uploaded files go into ("" is the top of the site),
  // and folders the kid made that have nothing in them yet (not saved).
  const [folder, setFolder] = useState("");
  const [emptyFolders, setEmptyFolders] = useState<string[]>([]);
  const [readOnly, setReadOnly] = useState(false);
  const [previewPage, setPreviewPage] = useState("index.html");
  const [srcdoc, setSrcdoc] = useState("");
  // On the preview host: the page the preview frame opens for the current
  // run, and the address the kid can type into.
  const [previewSrc, setPreviewSrc] = useState("");
  const [address, setAddress] = useState("index.html");
  // The preview host failed or never answered: the site is shown the old way
  // until the editor is opened again.
  const [hostFailed, setHostFailed] = useState(false);
  const served = previewBase !== "" && !hostFailed;
  // Bumped on every load so the code editor takes the new document even when
  // the active file keeps its name.
  const [generation, setGeneration] = useState(0);
  const [reloads, setReloads] = useState(0);
  const devConsole = useConsole();
  // A line of a file to show once that file is in the code editor (a click
  // on where a console line came from).
  const [jump, setJump] = useState<{ file: string; line: number }>();
  const [command, setCommand] = useState("");
  // The preview's DevTools stand-ins: the size it is shown at, its network
  // and motion settings (kept for the whole time the editor is open, not
  // saved), and which tab is under it: the console or the saved data.
  const [device, setDevice] = useState<Device>("desktop");
  const [tools, setToolsState] = useState<PreviewTools>({ network: "online", reducedMotion: false });
  const [paneTab, setPaneTab] = useState<"console" | "saved">("console");
  // What the page has saved, shown in the Saved data tab. Kept up to date
  // only while that tab is open: a game that saves every frame mustn't
  // re-render the editor every frame.
  const [savedView, setSavedView] = useState<Storage>({});
  const { scale, stageRef } = useFit(device);

  const filesRef = useRef(files);
  const readOnlyRef = useRef(readOnly);
  const previewPageRef = useRef(previewPage);
  // What the page keeps in localStorage; saved with the site. A ref, not
  // state: a write must not rebuild (and so reload) the preview.
  const storageRef = useRef<Storage>({});
  // Each build gets an epoch; messages from an older page are dropped.
  const epochRef = useRef(0);
  const lastChangedAt = useRef(0);
  const storageTimer = useRef<number>();
  const toolsRef = useRef(tools);
  const savedOpenRef = useRef(false);
  // Counts the projects loaded: the page's sessionStorage lasts across runs
  // of one project, not into the next.
  const projectRef = useRef(0);
  const previewRef = useRef<HTMLIFrameElement>(null);
  // The preview host keeps the site's files between runs of this editor's
  // session; only what changed since is sent again.
  const session = useMemo(() => crypto.randomUUID(), []);
  const servedRef = useRef(served);
  const hostTimer = useRef<number>();
  // Said in the console once the next run has cleared it.
  const noticesRef = useRef<{ level: string; text: string }[]>([]);

  filesRef.current = files;
  readOnlyRef.current = readOnly;
  previewPageRef.current = previewPage;
  servedRef.current = served;
  toolsRef.current = tools;
  savedOpenRef.current = paneTab === "saved";

  const names = useMemo(() => Object.keys(files).sort(), [files]);

  const changed = useCallback(() => {
    const now = Date.now();
    if (now - lastChangedAt.current < CHANGED_THROTTLE_MS) return;

    lastChangedAt.current = now;
    postToPage({ type: "changed" });
  }, []);

  const update = useCallback(
    (next: WebFiles) => {
      setFiles(next);
      changed();
    },
    [changed],
  );

  const { clear: clearConsole, receive: receiveConsole, say } = devConsole;

  // The page is shown again from the start: blank first, so the old page is
  // gone and the rebuilt document is a change even when nothing else moved.
  // The epoch moves on at once, so nothing the old page still says (what it
  // saved, a moment after "Clear saved data") counts for the next run.
  const reload = useCallback(() => {
    epochRef.current += 1;
    setSrcdoc("");
    setPreviewSrc("");
    setReloads((i) => i + 1);
  }, []);

  // The page drives loading and saving over postMessage.
  useEffect(() => {
    postToPage({ type: "ready" });

    return listenToPage(async (message) => {
      switch (message.type) {
        case "load":
          try {
            const blob = message.file ?? (message.url ? await (await fetch(message.url)).blob() : undefined);
            const project = blob ? await fromZip(blob) : { files: structuredClone(STARTER_FILES), storage: {} };
            const next = project.files;

            // The old page goes away before the new project is in, so
            // nothing it still does lands on the new one.
            setSrcdoc("");
            setPreviewSrc("");
            // A report the old project's run had waiting is not this one's.
            window.clearTimeout(storageTimer.current);
            storageTimer.current = undefined;
            projectRef.current += 1;
            // New files go to the top of this site, and the last site's
            // empty folders aren't this one's.
            setFolder("");
            setEmptyFolders([]);
            storageRef.current = project.storage;
            setSavedView(project.storage);
            setFiles(next);
            setActive(next["index.html"] ? "index.html" : Object.keys(next)[0]);

            const entry = entryPage(next);

            previewPageRef.current = entry;
            setPreviewPage(entry);
            setAddress(entry);
            if (message.readOnly !== undefined) setReadOnly(message.readOnly);
            setGeneration((i) => i + 1);
            postToPage({ type: "loaded" });
          } catch (error) {
            postToPage({ message: String(error), type: "loadFailed" });
          }
          break;
        case "save": {
          const size = bytesOf(filesRef.current) + storageBytes(storageRef.current);

          if (size > SIZE_LIMIT) {
            postToPage({
              message: `The site is ${Math.round(size / 1024 / 1024)} MB with what it saved; the limit is 20 MB.`,
              requestId: message.requestId,
              type: "saveFailed",
            });
            break;
          }

          postToPage({
            file: toZip({ files: filesRef.current, storage: storageRef.current }),
            requestId: message.requestId,
            type: "saved",
          });
          break;
        }
        case "snapshot":
          void answerSnapshot(message.requestId, async () => {
            const files = filesRef.current;
            const page = entryPage(files);

            try {
              return await pictureOfPage(buildPreview(files, page));
            } catch {
              // A browser that will not read the drawn page back still gets a
              // cover: the page's markup, as the kid sees it in the editor.
              return codeCard({ accent: "#4EAEDA", lines: (files[page]?.text ?? "").split("\n"), title: page });
            }
          });
          break;
        case "setReadOnly":
          setReadOnly(message.value);
          break;
      }
    });
  }, []);

  // On the preview host, the run's files go to its bridge page once it is
  // ready: those whose version it doesn't hold, and every file's version so
  // it can drop the rest and report what it holds next time.
  const sendFiles = useCallback((have: Record<string, unknown>) => {
    const files = filesRef.current;
    const changedFiles: Record<string, { bytes?: Uint8Array; text?: string }> = {};
    const fileVersions: Record<string, number> = {};

    for (const [path, file] of Object.entries(files)) {
      fileVersions[path] = versionOf(file);
      if (have[path] === fileVersions[path]) continue;
      changedFiles[path] = file.bytes ? { bytes: file.bytes } : { text: file.text ?? "" };
    }
    previewRef.current?.contentWindow?.postMessage(
      {
        build: String(epochRef.current),
        epoch: epochRef.current,
        files: changedFiles,
        page: previewPageRef.current,
        project: projectRef.current,
        storage: storageRef.current,
        tools: toolsRef.current,
        type: "preview:files",
        versions: fileVersions,
      },
      previewOrigin,
    );
  }, []);

  // The site is shown the old way from here on, with a word in the console.
  const giveUpHost = useCallback(
    (reason: string) => {
      window.clearTimeout(hostTimer.current);
      noticesRef.current.push({
        level: "info",
        text: `${reason} Showing your site the simple way: links between pages work, some other files may not.`,
      });
      setHostFailed(true);
    },
    [],
  );

  // The prelude in the preview forwards console output and errors and reports
  // what the page saved. Without the preview host it also asks for another
  // page of the site when a link to it is clicked or a form is sent; on the
  // host the page goes there itself and reports where it is.
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.source !== previewRef.current?.contentWindow) return;
      if (event.origin !== (servedRef.current ? previewOrigin : "null")) return;

      // The preview host's bridge page, which knows the run by its build.
      if (event.data?.type === "preview:ready" || event.data?.type === "preview:failed") {
        if (event.data.build !== String(epochRef.current)) return;
        if (event.data.type === "preview:ready") {
          window.clearTimeout(hostTimer.current);
          sendFiles(event.data.have && typeof event.data.have === "object" ? event.data.have : {});
        } else {
          giveUpHost(String(event.data.message));
        }
        return;
      }

      if (event.data?.epoch !== epochRef.current) return;

      if (event.data.type === "preview:location") {
        const page = String(event.data.page);

        previewPageRef.current = page;
        setPreviewPage(page);
        setAddress(page);
      } else if (event.data.type === "preview:navigate") {
        const page = String(event.data.page);

        if (!isHtml(page) || !filesRef.current[page]) return;
        if (page === previewPageRef.current) reload();
        else setPreviewPage(page);
      } else if (event.data.type === "preview:console") {
        receiveConsole(event.data);
      } else if (event.data.type === "preview:storage") {
        const data = event.data.data as Storage;

        if (JSON.stringify(data) === JSON.stringify(storageRef.current)) return;

        storageRef.current = { ...data };
        if (savedOpenRef.current) setSavedView(storageRef.current);

        if (readOnlyRef.current || storageTimer.current !== undefined) return;

        storageTimer.current = window.setTimeout(() => {
          storageTimer.current = undefined;
          if (!readOnlyRef.current) postToPage({ byRun: true, type: "changed" });
        }, STORAGE_REPORT_MS);
      }
    };

    window.addEventListener("message", listener);

    return () => window.removeEventListener("message", listener);
  }, [changed, giveUpHost, receiveConsole, reload, sendFiles]);

  // On the preview host the page the preview is on moves with the kid's
  // clicks, which must not start a new run.
  const runPage = served ? "" : previewPage;

  // The preview follows the files, a moment after the last keystroke; the
  // console starts over with it. On the preview host each run opens the
  // bridge page afresh, which then opens the page the kid was on.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      epochRef.current += 1;
      clearConsole();
      for (const notice of noticesRef.current) say(notice.level, notice.text);
      noticesRef.current = [];
      if (served) {
        const editor = encodeURIComponent(window.location.origin);
        const build = epochRef.current;

        setPreviewSrc(`${previewBase}index.html?build=${build}#session=${session}&editor=${editor}`);
        window.clearTimeout(hostTimer.current);
        hostTimer.current = window.setTimeout(() => {
          if (epochRef.current === build) giveUpHost("The preview didn't start.");
        }, HOST_TIMEOUT_MS);
      } else {
        setSrcdoc(buildPreview(files, runPage, storageRef.current, epochRef.current, toolsRef.current));
      }
    }, PREVIEW_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [clearConsole, files, giveUpHost, runPage, reloads, say, served, session]);

  // The preview host forgets this editor's site when the editor goes away,
  // so the next kid on this computer can't read it there.
  useEffect(() => {
    const forget = () => {
      // What the page saved in its last moments still reaches the lesson
      // page, which saves it as it closes.
      if (storageTimer.current !== undefined) {
        window.clearTimeout(storageTimer.current);
        storageTimer.current = undefined;
        if (!readOnlyRef.current) postToPage({ byRun: true, type: "changed" });
      }
      previewRef.current?.contentWindow?.postMessage({ type: "preview:dispose" }, previewOrigin);
    };

    window.addEventListener("pagehide", forget);

    return () => {
      window.removeEventListener("pagehide", forget);
      window.clearTimeout(hostTimer.current);
      window.clearTimeout(storageTimer.current);
    };
  }, []);

  // Another page of the site, picked or typed by the kid. Like a server, the
  // site has no page for a ?query or #part, so those are left off.
  const openPage = (page: string) => {
    const path = page.trim().split(/[?#]/)[0].replace(/^\/+/, "") || "index.html";

    previewPageRef.current = path;
    setPreviewPage(path);
    setAddress(path);
    if (served) reload();
  };

  // The code editor shows the file first (its own effect runs before this
  // one), then the line, as DevTools does for a click on where a message came
  // from.
  useEffect(() => {
    if (!jump || jump.file !== active) return;

    const host = document.querySelector(".code .cm-editor");
    const view = host instanceof HTMLElement ? EditorView.findFromDOM(host) : null;

    if (!view) return;

    const line = view.state.doc.line(Math.min(Math.max(jump.line, 1), view.state.doc.lines));

    view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: "center" }), selection: EditorSelection.range(line.from, line.to) });
    view.focus();
    setJump(undefined);
  }, [active, generation, jump]);

  const jumpTo = (file: string, line: number) => {
    setActive(file);
    setJump({ file, line });
  };

  // Replaces DevTools > Application for a kid: what the page saved, changed
  // by hand, and the page shown again from the start with it.
  const editStorage = (next: Storage) => {
    storageRef.current = next;
    setSavedView(next);
    reload();
    if (!readOnly) changed();
  };

  // A setting changes for the page that is open, at once, and for the pages
  // after it.
  const setTools = (next: PreviewTools) => {
    toolsRef.current = next;
    setToolsState(next);
    previewRef.current?.contentWindow?.postMessage({ tools: next, type: "preview:tools" }, served ? previewOrigin : "*");
  };

  const fullScreen = () => {
    const frame = previewRef.current;

    if (!frame?.requestFullscreen) {
      say("info", "This browser can't show the site on the whole screen.");
      return;
    }
    frame.requestFullscreen().catch(() => say("info", "Full screen isn't allowed here."));
  };

  // A line typed into the console runs in the page, like a browser's own.
  const runCommand = () => {
    const code = command.trim();

    if (!code) return;

    say("input", code);
    // A srcdoc page has no origin to name.
    previewRef.current?.contentWindow?.postMessage({ code, type: "preview:eval" }, served ? previewOrigin : "*");
    setCommand("");
  };

  const tooBig = (next: WebFiles) => {
    if (bytesOf(next) + storageBytes(storageRef.current) <= SIZE_LIMIT) return false;

    window.alert("That would make your site bigger than 20 MB, the most a site can be.");
    return true;
  };

  const badName = (name: string) => {
    if (isSitePath(name)) return false;

    window.alert(
      `"${name}" can't be a file name in a website. Use letters, numbers, - and _, with / between folders (for example images/cat.png).`,
    );
    return true;
  };

  // Why a new file or folder can't have this path: a file or a folder has it
  // already, or a folder on the way to it is a file. Undefined when it can.
  const takenBecause = (path: string, all: WebFiles) => {
    if (all[path]) return `There is already a file called ${path}.`;
    if (emptyFolders.includes(path) || Object.keys(all).some((file) => file.startsWith(`${path}/`))) {
      return `There is already a folder called ${path}.`;
    }

    const parts = path.split("/");

    for (let i = 1; i < parts.length; i += 1) {
      const above = parts.slice(0, i).join("/");

      if (all[above]) return `${above} is a file, so nothing can go inside it.`;
    }

    return undefined;
  };

  const refuseTaken = (path: string, all: WebFiles) => {
    const reason = takenBecause(path, all);

    if (reason) window.alert(reason);
    return reason !== undefined;
  };

  // The preview leaves a page that was just deleted for the site's first
  // page (a typed address that was never there stays).
  const leaveGonePage = (next: WebFiles, deleted: string[]) => {
    if (!deleted.includes(previewPageRef.current)) return;

    const entry = entryPage(next);

    previewPageRef.current = entry;
    setPreviewPage(entry);
    setAddress(entry);
  };

  const addFile = () => {
    const name = window.prompt(
      `New file${folder ? ` in ${folder}` : ""}, for example about.html, style.css or script.js`,
    )?.trim();

    if (!name) return;

    const path = inFolder(folder, name);

    if (badName(path) || refuseTaken(path, files)) return;
    if (!isText(path)) {
      window.alert("Pictures, sounds and other files come from your computer: use ⇪ to add one.");
      return;
    }

    update({ ...files, [path]: { text: "" } });
    setActive(path);
  };

  const addFolder = () => {
    const name = window.prompt(`New folder${folder ? ` in ${folder}` : ""}, for example images`)?.trim().replace(/\/+$/, "");

    if (!name) return;

    const path = inFolder(folder, name);

    if (badName(path) || refuseTaken(path, files)) return;

    setEmptyFolders([...emptyFolders, path]);
    setFolder(path);
  };

  // Files from the kid's computer go into the folder picked. A .zip can be
  // unpacked there instead (a lesson's pictures, a model exported from
  // Teachable Machine).
  const addFromComputer = async (picked: FileList | null) => {
    if (!picked?.length) return;

    // What this pick adds, put into the site as it is once everything is
    // read, so edits made meanwhile (or another pick) aren't undone.
    const added: WebFiles = {};
    const now = () => ({ ...filesRef.current, ...added });

    for (const file of [...picked]) {
      const bytes = new Uint8Array(await file.arrayBuffer());

      if (/\.zip$/i.test(file.name) && window.confirm(`Unpack ${file.name} into ${folder || "your site"}? (Cancel adds the .zip itself.)`)) {
        let unpacked: WebFiles;

        try {
          unpacked = unpackZip(bytes, { isText, keep: (name) => isSitePath(inFolder(folder, name)), stripTop: false });
        } catch {
          window.alert(`${file.name} isn't a zip that can be opened.`);
          continue;
        }

        const paths = Object.keys(unpacked).map((name) => inFolder(folder, name));
        const current = now();
        const blocked = paths.find((path) => !current[path] && takenBecause(path, current));

        if (blocked) {
          window.alert(`${file.name} can't be unpacked here: ${takenBecause(blocked, current)}`);
          continue;
        }

        const clashes = paths.filter((path) => current[path]);

        if (clashes.length > 0 && !window.confirm(`Replace ${clashes.length === 1 ? clashes[0] : `${clashes.length} files already there`}?`)) {
          continue;
        }
        for (const [name, unpackedFile] of Object.entries(unpacked)) added[inFolder(folder, name)] = unpackedFile;
        continue;
      }

      const path = inFolder(folder, file.name);

      const current = now();

      if (badName(path)) continue;
      if (current[path]) {
        if (!window.confirm(`Replace ${path}?`)) continue;
      } else if (refuseTaken(path, current)) {
        continue;
      }

      added[path] = asSiteFile(path, bytes);
    }

    const next = now();

    if (Object.keys(added).length === 0 || tooBig(next)) return;

    update(next);
    setEmptyFolders((empties) => empties.filter((empty) => !Object.keys(next).some((path) => path.startsWith(`${empty}/`))));
  };

  // A copy of the site to keep on the kid's computer.
  const download = () => {
    const link = document.createElement("a");

    link.href = URL.createObjectURL(toZip({ files: filesRef.current, storage: {} }));
    link.download = "my-site.zip";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
  };

  // Links still naming a file's old name are pointed out, since a site's
  // pages find each other by name.
  const warnLinks = (oldPath: string, newPath: string, next: WebFiles) => {
    const oldName = oldPath.replace(/\/$/, "").split("/").pop() ?? oldPath;
    // As a link would spell it: after a quote, a slash or url(.
    const linking = new RegExp(`["'/(]${oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(["'/)#?]|$)`, "m");
    const naming = Object.keys(next).filter((path) => path !== newPath && linking.test(next[path].text ?? ""));

    if (naming.length > 0) {
      noticesRef.current.push({
        level: "warn",
        text: `Renamed ${oldPath}. Links to it in ${naming.join(", ")} may still use the old name.`,
      });
    }
  };

  const renameFile = (path: string) => {
    const next = window.prompt("New name. Add a folder to move it, for example images/cat.png", path)?.trim();

    if (!next || next === path) return;
    if (badName(next)) return;

    const { [path]: _moving, ...others } = files;

    if (refuseTaken(next, others)) return;
    // A text file stays a kind the editor can open.
    if (files[path].text !== undefined && !isText(next)) {
      window.alert("Keep the ending: .html, .css, .js, .json, .md, .svg or .txt.");
      return;
    }

    const { [path]: file, ...rest } = files;
    const renamed = { ...rest, [next]: file };

    update(renamed);
    if (active === path) setActive(next);
    if (previewPageRef.current === path) {
      previewPageRef.current = next;
      setPreviewPage(next);
      setAddress(next);
    }
    setEmptyFolders(emptyFolders.filter((empty) => !next.startsWith(`${empty}/`)));
    warnLinks(path, next, renamed);
  };

  const renameFolder = (path: string) => {
    const next = window.prompt("New folder name (or path)", path)?.trim().replace(/\/+$/, "");

    if (!next || next === path) return;
    if (badName(next)) return;
    if (next.startsWith(`${path}/`)) {
      window.alert("A folder can't go inside itself.");
      return;
    }

    const moving = Object.keys(files).filter((file) => file.startsWith(`${path}/`));
    const renamed: WebFiles = {};

    for (const [file, content] of Object.entries(files)) {
      renamed[moving.includes(file) ? `${next}${file.slice(path.length)}` : file] = content;
    }
    const others = Object.fromEntries(Object.entries(files).filter(([file]) => !moving.includes(file)));

    if (refuseTaken(next, others)) return;

    update(renamed);
    setEmptyFolders(emptyFolders.map((empty) => (empty === path || empty.startsWith(`${path}/`) ? `${next}${empty.slice(path.length)}` : empty)));
    if (folder === path || folder.startsWith(`${path}/`)) setFolder(`${next}${folder.slice(path.length)}`);
    if (moving.includes(active)) setActive(`${next}${active.slice(path.length)}`);
    if (moving.includes(previewPageRef.current)) {
      const page = `${next}${previewPageRef.current.slice(path.length)}`;

      previewPageRef.current = page;
      setPreviewPage(page);
      setAddress(page);
    }
    if (moving.length > 0) warnLinks(`${path}/`, "", renamed);
  };

  const deleteFile = (path: string) => {
    if (!window.confirm(`Delete ${path}?`)) return;

    const { [path]: _removed, ...rest } = files;

    update(rest);
    if (active === path) setActive(Object.keys(rest)[0] ?? "");
    leaveGonePage(rest, [path]);
  };

  const deleteFolder = (path: string) => {
    const inside = Object.keys(files).filter((file) => file.startsWith(`${path}/`));

    if (!window.confirm(inside.length > 0 ? `Delete ${path} and the ${inside.length} file${inside.length === 1 ? "" : "s"} in it?` : `Delete ${path}?`)) {
      return;
    }

    const rest = Object.fromEntries(Object.entries(files).filter(([file]) => !inside.includes(file)));

    if (inside.length > 0) update(rest);
    setEmptyFolders(emptyFolders.filter((empty) => empty !== path && !empty.startsWith(`${path}/`)));
    if (folder === path || folder.startsWith(`${path}/`)) setFolder(folderOf(path));
    if (inside.includes(active)) setActive(Object.keys(rest)[0] ?? "");
    leaveGonePage(rest, inside);
  };

  const uploadRef = useRef<HTMLInputElement>(null);

  const activeFile = files[active];
  // A phone or tablet: the site at that size, shrunk to fit if need be.
  const { height: deviceHeight, width: deviceWidth } = DEVICES[device];
  const frameBox = device === "desktop" ? undefined : { height: deviceHeight * scale, width: deviceWidth * scale };
  const frameSize =
    device === "desktop" ? undefined : { height: deviceHeight, transform: `scale(${scale})`, width: deviceWidth };

  const activePicture = useImageUrl(activeFile?.bytes, imageType(active));

  return (
    <div className="layout">
      <aside className="files">
        <div className="files-header">
          <span>Files</span>
          <span className="files-actions">
            {!readOnly && (
              <>
                <button onClick={addFile} title="New file" type="button">+</button>
                <button onClick={addFolder} title="New folder" type="button">📁</button>
                <button onClick={() => uploadRef.current?.click()} title="Add files from your computer" type="button">⇪</button>
                <input
                  hidden
                  multiple
                  onChange={(e) => {
                    void addFromComputer(e.target.files);
                    e.target.value = "";
                  }}
                  ref={uploadRef}
                  type="file"
                />
              </>
            )}
            {/* Not someone else's site, shown read-only. */}
            {!readOnly && (
              <button onClick={download} title="Download your site" type="button">⤓</button>
            )}
          </span>
        </div>
        <FileTree
          active={active}
          current={folder}
          emptyFolders={emptyFolders}
          onDelete={(path, isFolder) => (isFolder ? deleteFolder(path) : deleteFile(path))}
          onOpen={(path) => {
            setActive(path);
            setFolder(folderOf(path));
          }}
          onPickFolder={setFolder}
          onRename={(path, isFolder) => (isFolder ? renameFolder(path) : renameFile(path))}
          paths={names}
          readOnly={readOnly}
        />
      </aside>

      <main className="code">
        {activeFile?.text !== undefined ? (
          <CodeEditor
            key={generation}
            name={active}
            onChange={(text) => update({ ...filesRef.current, [active]: { text } })}
            readOnly={readOnly}
            value={activeFile.text}
          />
        ) : activeFile ? (
          <div className="binary">
            {activePicture && <img alt={active} src={activePicture} />}
            <p>
              {active} · {Math.round((activeFile.bytes?.byteLength ?? 0) / 1024)} KB
              {!activePicture && ", kept with your site"}
            </p>
          </div>
        ) : (
          <div className="binary">No file selected.</div>
        )}
      </main>

      <section className="preview">
        <div className="preview-header">
          <span>Preview</span>
          {served ? (
            // The page's address in the site, as a browser's address bar
            // shows it; a typed address that isn't there shows "Page not
            // found", as a server would.
            <form
              className="address"
              onSubmit={(e) => {
                e.preventDefault();
                openPage(address);
              }}
            >
              <span>/</span>
              <input
                aria-label="Page address"
                list="site-pages"
                onChange={(e) => setAddress(e.target.value)}
                spellCheck={false}
                value={address}
              />
              <datalist id="site-pages">
                {names.filter(isHtml).map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </form>
          ) : (
            <select onChange={(e) => openPage(e.target.value)} value={previewPage}>
              {names.filter(isHtml).map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          )}
        </div>
        <PreviewToolbar device={device} onDevice={setDevice} onFullScreen={fullScreen} onTools={setTools} tools={tools} />
        {/* The frame keeps its place in the page whatever the size, so a
            change of size never reloads the site. */}
        <div className={device === "desktop" ? "preview-stage" : "preview-stage device"} ref={stageRef}>
          <div className="preview-frame" style={frameBox}>
            {served ? (
              // On the preview host's own origin, never the editor's or
              // CodeyKids', so the page can have one (same-origin) without
              // reaching either; it cannot navigate the lesson away.
              // Camera, microphone and full screen pass on to the kid's page
              // (CodeyKids passes them to this editor): a site asks, and the
              // browser asks the kid once.
              <iframe
                allow="camera; microphone; fullscreen"
                ref={previewRef}
                sandbox="allow-scripts allow-same-origin allow-modals allow-forms allow-downloads allow-popups allow-popups-to-escape-sandbox"
                src={previewSrc || "about:blank"}
                style={frameSize}
                title="Preview"
              />
            ) : (
              // Forms, downloads and new tabs are the kid's page's to use;
              // without allow-same-origin the page stays walled off from the
              // editor.
              // A srcdoc page has no origin to name, hence "*": it is the
              // only page this frame ever shows.
              <iframe
                allow="camera *; microphone *; fullscreen *"
                ref={previewRef}
                sandbox="allow-scripts allow-modals allow-forms allow-downloads allow-popups allow-popups-to-escape-sandbox"
                srcDoc={srcdoc}
                style={frameSize}
                title="Preview"
              />
            )}
          </div>
        </div>
        <div className="console-pane">
          <div className="console-header">
            <span className="pane-tabs" role="tablist">
              <button aria-selected={paneTab === "console"} onClick={() => setPaneTab("console")} role="tab" type="button">
                Console
              </button>
              <button
                aria-selected={paneTab === "saved"}
                onClick={() => {
                  setSavedView(storageRef.current);
                  setPaneTab("saved");
                }}
                role="tab"
                title="What your site keeps with localStorage"
                type="button"
              >
                Saved data
              </button>
            </span>
            <span>
              <button onClick={reload} title="Show the page again from the start" type="button">
                Reload
              </button>
              {paneTab === "console" && (
                <button onClick={clearConsole} type="button">
                  Clear
                </button>
              )}
            </span>
          </div>
          {paneTab === "saved" ? (
            <SavedData data={savedView} onChange={editStorage} readOnly={readOnly} />
          ) : (
            <ConsoleLines hasFile={(file) => files[file]?.text !== undefined} lines={devConsole.lines} onJump={jumpTo} />
          )}
          <form
            hidden={paneTab !== "console"}
            className="console-input"
            onSubmit={(e) => {
              e.preventDefault();
              runCommand();
            }}
          >
            <span>›</span>
            <input
              aria-label="Run JavaScript in the page"
              onChange={(e) => setCommand(e.target.value)}
              placeholder="Type JavaScript and press Enter"
              value={command}
            />
          </form>
        </div>
      </section>
    </div>
  );
};

createRoot(document.getElementById("app")!).render(<WebEditor />);
