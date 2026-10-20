import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { answerSnapshot, listenToPage, postToPage } from "../bridge";
import { useImageUrl } from "../python/useImageUrl";
import { codeCard, pictureOfPage } from "../snapshot";
import { unpackZip } from "../zip";
import { CodeEditor } from "./CodeEditor";
import { FileTree } from "./FileTree";
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
// A page that saves state on every frame must not push the autosave back for
// ever: its writes count as one change a minute at most.
const STORAGE_CHANGED_THROTTLE_MS = 60_000;
const CONSOLE_CAP = 500;

type ConsoleLine = { id: number; level: string; text: string };

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
  const [consoleLines, setConsoleLines] = useState<ConsoleLine[]>([]);
  const [command, setCommand] = useState("");

  const filesRef = useRef(files);
  const readOnlyRef = useRef(readOnly);
  const previewPageRef = useRef(previewPage);
  // What the page keeps in localStorage; saved with the site. A ref, not
  // state: a write must not rebuild (and so reload) the preview.
  const storageRef = useRef<Storage>({});
  // Each build gets an epoch; messages from an older page are dropped.
  const epochRef = useRef(0);
  const lastChangedAt = useRef(0);
  const lastStorageChangedAt = useRef(0);
  const previewRef = useRef<HTMLIFrameElement>(null);
  const consoleRef = useRef<HTMLDivElement>(null);
  // The preview host keeps the site's files between runs of this editor's
  // session; only what changed since is sent again.
  const session = useMemo(() => crypto.randomUUID(), []);
  const servedRef = useRef(served);
  const hostTimer = useRef<number>();
  // Said in the console once the next run has cleared it.
  const noticesRef = useRef<{ level: string; text: string }[]>([]);
  // Console output arrives one message per line; lines are batched into one
  // render a frame or so.
  const pendingLines = useRef<ConsoleLine[]>([]);
  const flushTimer = useRef<number>();
  const lineId = useRef(0);

  filesRef.current = files;
  readOnlyRef.current = readOnly;
  previewPageRef.current = previewPage;
  servedRef.current = served;

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

  const pushLine = useCallback((level: string, text: string) => {
    pendingLines.current.push({ id: (lineId.current += 1), level, text });

    if (flushTimer.current !== undefined) return;

    flushTimer.current = window.setTimeout(() => {
      flushTimer.current = undefined;

      const batch = pendingLines.current;

      pendingLines.current = [];
      setConsoleLines((current) => [...current, ...batch].slice(-CONSOLE_CAP));
    }, 16);
  }, []);

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
            storageRef.current = project.storage;
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
        storage: storageRef.current,
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
        pushLine(String(event.data.level), String(event.data.text));
      } else if (event.data.type === "preview:storage") {
        const data = event.data.data as Storage;

        if (JSON.stringify(data) === JSON.stringify(storageRef.current)) return;

        storageRef.current = { ...data };

        const now = Date.now();

        if (readOnlyRef.current || now - lastStorageChangedAt.current < STORAGE_CHANGED_THROTTLE_MS) return;

        lastStorageChangedAt.current = now;
        changed();
      }
    };

    window.addEventListener("message", listener);

    return () => window.removeEventListener("message", listener);
  }, [changed, giveUpHost, pushLine, reload, sendFiles]);

  // On the preview host the page the preview is on moves with the kid's
  // clicks, which must not start a new run.
  const runPage = served ? "" : previewPage;

  // The preview follows the files, a moment after the last keystroke; the
  // console starts over with it. On the preview host each run opens the
  // bridge page afresh, which then opens the page the kid was on.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      epochRef.current += 1;
      pendingLines.current = [];
      setConsoleLines([]);
      for (const notice of noticesRef.current) pushLine(notice.level, notice.text);
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
        setSrcdoc(buildPreview(files, runPage, storageRef.current, epochRef.current));
      }
    }, PREVIEW_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [files, giveUpHost, pushLine, runPage, reloads, served, session]);

  // The preview host forgets this editor's site when the editor goes away,
  // so the next kid on this computer can't read it there.
  useEffect(() => {
    const forget = () => previewRef.current?.contentWindow?.postMessage({ type: "preview:dispose" }, previewOrigin);

    window.addEventListener("pagehide", forget);

    return () => {
      window.removeEventListener("pagehide", forget);
      window.clearTimeout(hostTimer.current);
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

  useEffect(() => () => window.clearTimeout(flushTimer.current), []);

  useEffect(() => {
    consoleRef.current?.scrollTo({ top: consoleRef.current.scrollHeight });
  }, [consoleLines]);

  // Replaces DevTools > Application for a kid: forgets what the page saved
  // and shows it again from scratch.
  const clearStorage = () => {
    if (!window.confirm("Forget everything this site saved in localStorage?")) return;

    storageRef.current = {};
    reload();
    if (!readOnly) changed();
  };

  // A line typed into the console runs in the page, like a browser's own.
  const runCommand = () => {
    const code = command.trim();

    if (!code) return;

    pushLine("input", code);
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

  // Whatever the files of a site now are, the preview leaves a page that is
  // gone for the site's first page.
  const leaveGonePage = (next: WebFiles) => {
    if (next[previewPageRef.current]) return;

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

    if (badName(path)) return;
    if (files[path]) {
      window.alert(`There is already a file called ${path}.`);
      return;
    }
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

    if (badName(path)) return;
    if (emptyFolders.includes(path) || Object.keys(files).some((file) => file.startsWith(`${path}/`))) {
      window.alert(`There is already a folder called ${path}.`);
      return;
    }

    setEmptyFolders([...emptyFolders, path]);
    setFolder(path);
  };

  // Files from the kid's computer go into the folder picked. A .zip can be
  // unpacked there instead (a lesson's pictures, a model exported from
  // Teachable Machine).
  const addFromComputer = async (picked: FileList | null) => {
    if (!picked?.length) return;

    const next = { ...filesRef.current };

    for (const file of [...picked]) {
      const bytes = new Uint8Array(await file.arrayBuffer());

      if (/\.zip$/i.test(file.name) && window.confirm(`Unpack ${file.name} into ${folder || "your site"}? (Cancel adds the .zip itself.)`)) {
        let unpacked: WebFiles;

        try {
          unpacked = unpackZip(bytes, { isText, keep: (name) => isSitePath(inFolder(folder, name)) });
        } catch {
          window.alert(`${file.name} isn't a zip that can be opened.`);
          continue;
        }

        const paths = Object.keys(unpacked).map((name) => inFolder(folder, name));
        const clashes = paths.filter((path) => next[path]);

        if (clashes.length > 0 && !window.confirm(`Replace ${clashes.length === 1 ? clashes[0] : `${clashes.length} files already there`}?`)) {
          continue;
        }
        for (const [name, unpackedFile] of Object.entries(unpacked)) next[inFolder(folder, name)] = unpackedFile;
        continue;
      }

      const path = inFolder(folder, file.name);

      if (badName(path)) continue;
      if (next[path] && !window.confirm(`Replace ${path}?`)) continue;

      next[path] = asSiteFile(path, bytes);
    }

    if (tooBig(next)) return;

    update(next);
    setEmptyFolders(emptyFolders.filter((empty) => !Object.keys(next).some((path) => path.startsWith(`${empty}/`))));
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
  const warnLinks = (oldPath: string, next: WebFiles) => {
    const oldName = oldPath.slice(oldPath.lastIndexOf("/") + 1);
    const naming = Object.keys(next).filter((path) => next[path].text?.includes(oldName));

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
    if (files[next]) {
      window.alert(`There is already a file called ${next}.`);
      return;
    }
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
    warnLinks(path, renamed);
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
    if (Object.keys(renamed).length !== Object.keys(files).length || emptyFolders.includes(next)) {
      window.alert(`There is already a folder called ${next}.`);
      return;
    }

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
    if (moving.length > 0) warnLinks(`${path}/`, renamed);
  };

  const deleteFile = (path: string) => {
    if (!window.confirm(`Delete ${path}?`)) return;

    const { [path]: _removed, ...rest } = files;

    update(rest);
    if (active === path) setActive(Object.keys(rest)[0] ?? "");
    leaveGonePage(rest);
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
    leaveGonePage(rest);
  };

  const uploadRef = useRef<HTMLInputElement>(null);

  const activeFile = files[active];
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
            <button onClick={download} title="Download your site" type="button">⤓</button>
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
        {served ? (
          // On the preview host's own origin, never the editor's or
          // CodeyKids', so the page can have one (same-origin) without
          // reaching either; it cannot navigate the lesson away.
          <iframe
            ref={previewRef}
            sandbox="allow-scripts allow-same-origin allow-modals allow-forms allow-downloads allow-popups allow-popups-to-escape-sandbox"
            src={previewSrc || "about:blank"}
            title="Preview"
          />
        ) : (
          // Forms, downloads and new tabs are the kid's page's to use;
          // without allow-same-origin the page stays walled off from the
          // editor.
          <iframe
            ref={previewRef}
            sandbox="allow-scripts allow-modals allow-forms allow-downloads allow-popups allow-popups-to-escape-sandbox"
            srcDoc={srcdoc}
            title="Preview"
          />
        )}
        <div className="console-pane">
          <div className="console-header">
            <span>Console</span>
            <span>
              <button onClick={reload} title="Show the page again from the start" type="button">
                Reload
              </button>
              <button onClick={clearStorage} title="Forget what the page saved in localStorage" type="button">
                Clear saved data
              </button>
              <button onClick={() => setConsoleLines([])} type="button">Clear</button>
            </span>
          </div>
          <div className="console-lines" ref={consoleRef}>
            {consoleLines.length === 0 && <span className="console-hint">console.log and errors from your page show here.</span>}
            {consoleLines.map((line) => (
              <div className={`console-line ${line.level}`} key={line.id}>
                {line.text}
              </div>
            ))}
          </div>
          <form
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
