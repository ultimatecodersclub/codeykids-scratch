import { useEffect, useRef } from "react";

import { answerSnapshot, listenToPage, PageToEditor, postToPage } from "./bridge";
import type { ScratchVM } from "./main";
import { loadImage, pictureOf } from "./snapshot";
import { setTranslateAccess } from "./translate";

const PROJECT_CHANGED = "PROJECT_CHANGED";
const PROJECT_RUN_START = "PROJECT_RUN_START";
const PROJECT_RUN_STOP = "PROJECT_RUN_STOP";
const CHANGED_THROTTLE_MS = 1000;
// The GUI's own new project, the cat.
const DEFAULT_PROJECT_ID = "0";
const SNAPSHOT_TIMEOUT_MS = 3000;
// How often a run's values are looked at while it goes on.
const VALUES_CHECK_MS = 5000;

// What a run changes without Scratch calling it an edit: the values in the
// variables and lists of the stage and each sprite (a clone's go with it).
const valuesOf = (vm: ScratchVM) =>
  JSON.stringify(
    vm.runtime.targets
      .filter((target) => target.isOriginal)
      .map((target) => Object.values(target.variables).map((variable) => [variable.id, variable.value])),
  );

// The stage as the renderer draws it now, sprites and backdrop and pen, but
// never the camera: with Video Sensing on, the stage shows the kid's face,
// and this picture goes on the project card. Scratch's own thumbnail hides
// the video the same way.
const pictureOfStage = async (vm: ScratchVM | null) => {
  const renderer = vm?.renderer;

  if (!vm || !renderer) throw new Error("The stage is not ready");

  const dataURL = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The stage did not draw")), SNAPSHOT_TIMEOUT_MS);

    renderer.requestSnapshot((url) => {
      clearTimeout(timer);
      resolve(url);
    });
    // A project that is not running draws nothing on its own. The picture
    // is taken inside this draw, so the camera is hidden for it alone.
    vm.postIOData("video", { forceTransparentPreview: true });
    renderer.draw();
    vm.postIOData("video", { forceTransparentPreview: false });
  });
  const image = await loadImage(dataURL);

  return pictureOf([{ height: image.naturalHeight, source: image, width: image.naturalWidth }]);
};

// Owns the page-facing side of the editor: it takes the VM from the GUI's
// onVmInit, reports edits, and answers the page's load/save messages.
export const useEditorBridge = ({
  setIsPlayerOnly,
}: {
  setIsPlayerOnly: (value: boolean) => void;
}) => {
  const vmRef = useRef<ScratchVM | null>(null);
  const lastChangedAtRef = useRef(0);
  const loadingProjectRef = useRef(false);
  const valuesCheckRef = useRef<number>(undefined);
  const valuesRef = useRef("");

  const onProjectChanged = () => {
    // loadProject fires PROJECT_CHANGED itself; that is not a kid's edit.
    if (loadingProjectRef.current) return;

    const now = Date.now();
    if (now - lastChangedAtRef.current < CHANGED_THROTTLE_MS) return;

    lastChangedAtRef.current = now;
    postToPage({ type: "changed" });
  };

  // A score a game keeps is a value, which Scratch never reports as an edit,
  // so it would be lost on close. Values unlike the last ones seen count as
  // one: when a run stops, and every few seconds while it goes on.
  const checkValues = () => {
    const vm = vmRef.current;

    if (!vm || loadingProjectRef.current) return;

    const values = valuesOf(vm);

    if (values === valuesRef.current) return;

    valuesRef.current = values;
    postToPage({ byRun: true, type: "changed" });
  };

  const onRunStart = () => {
    window.clearInterval(valuesCheckRef.current);
    valuesCheckRef.current = window.setInterval(checkValues, VALUES_CHECK_MS);
  };

  const onRunStop = () => {
    window.clearInterval(valuesCheckRef.current);
    checkValues();
  };

  const onVmInit = (vm: ScratchVM) => {
    vmRef.current?.runtime.off(PROJECT_CHANGED, onProjectChanged);
    vmRef.current?.runtime.off(PROJECT_RUN_START, onRunStart);
    vmRef.current?.runtime.off(PROJECT_RUN_STOP, onRunStop);
    vmRef.current = vm;
    vm.runtime.on(PROJECT_CHANGED, onProjectChanged);
    vm.runtime.on(PROJECT_RUN_START, onRunStart);
    vm.runtime.on(PROJECT_RUN_STOP, onRunStop);

    // Lets the spike host page poke the VM from devtools.
    if (import.meta.env.DEV) (window as Window & { vm?: ScratchVM }).vm = vm;
  };

  useEffect(() => {
    const load = async (message: Extract<PageToEditor, { type: "load" }>) => {
      const vm = vmRef.current;
      if (!vm) return postToPage({ type: "loadFailed", message: "VM not ready" });

      loadingProjectRef.current = true;
      if (message.ai) setTranslateAccess(message.ai);

      try {
        if (message.file) {
          await vm.loadProject(await message.file.arrayBuffer());
        } else if (message.url) {
          const response = await fetch(message.url);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);

          await vm.loadProject(await response.arrayBuffer());
        } else {
          // No project: the cat, as File > New gives, never what the last
          // worksheet left open.
          const { storage } = vm.runtime;
          const project = await storage.load(storage.AssetType.Project, DEFAULT_PROJECT_ID, storage.DataFormat.JSON);

          if (!project) throw new Error("The new project is missing");

          await vm.loadProject(project.data);
        }

        valuesRef.current = valuesOf(vm);
        if (message.readOnly !== undefined) setIsPlayerOnly(message.readOnly);

        postToPage({ type: "loaded" });
      } catch (error) {
        postToPage({ type: "loadFailed", message: String(error) });
      } finally {
        // The VM emits PROJECT_CHANGED asynchronously after load; wait a tick.
        // A run started meanwhile is held to the values the project came with.
        setTimeout(() => {
          loadingProjectRef.current = false;
          checkValues();
        }, CHANGED_THROTTLE_MS);
      }
    };

    const save = async (message: Extract<PageToEditor, { type: "save" }>) => {
      const vm = vmRef.current;
      if (!vm) {
        return postToPage({
          message: "VM not ready",
          requestId: message.requestId,
          type: "saveFailed",
        });
      }

      try {
        const file = await vm.saveProjectSb3();

        postToPage({ file, requestId: message.requestId, type: "saved" });
      } catch (error) {
        postToPage({
          message: String(error),
          requestId: message.requestId,
          type: "saveFailed",
        });
      }
    };

    return listenToPage((message) => {
      switch (message.type) {
        case "load":
          void load(message);
          break;
        case "save":
          void save(message);
          break;
        case "snapshot":
          void answerSnapshot(message.requestId, () => pictureOfStage(vmRef.current));
          break;
        case "setAi":
          setTranslateAccess(message.ai);
          break;
        case "setReadOnly":
          setIsPlayerOnly(message.value);
          break;
      }
    });
  }, [setIsPlayerOnly]);

  return { onVmInit };
};
