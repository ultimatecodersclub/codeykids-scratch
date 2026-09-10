import { useEffect, useRef } from "react";

import { listenToPage, PageToEditor, postToPage } from "./bridge";
import type { ScratchVM } from "./main";

const PROJECT_CHANGED = "PROJECT_CHANGED";
const CHANGED_THROTTLE_MS = 1000;

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

  const onProjectChanged = () => {
    // loadProject fires PROJECT_CHANGED itself; that is not a kid's edit.
    if (loadingProjectRef.current) return;

    const now = Date.now();
    if (now - lastChangedAtRef.current < CHANGED_THROTTLE_MS) return;

    lastChangedAtRef.current = now;
    postToPage({ type: "changed" });
  };

  const onVmInit = (vm: ScratchVM) => {
    vmRef.current?.runtime.off(PROJECT_CHANGED, onProjectChanged);
    vmRef.current = vm;
    vm.runtime.on(PROJECT_CHANGED, onProjectChanged);

    // Lets the spike host page poke the VM from devtools.
    if (import.meta.env.DEV) (window as Window & { vm?: ScratchVM }).vm = vm;
  };

  useEffect(() => {
    const load = async (message: Extract<PageToEditor, { type: "load" }>) => {
      const vm = vmRef.current;
      if (!vm) return postToPage({ type: "loadFailed", message: "VM not ready" });

      loadingProjectRef.current = true;

      try {
        if (message.url) {
          const response = await fetch(message.url);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);

          await vm.loadProject(await response.arrayBuffer());
        }

        if (message.readOnly !== undefined) setIsPlayerOnly(message.readOnly);

        postToPage({ type: "loaded" });
      } catch (error) {
        postToPage({ type: "loadFailed", message: String(error) });
      } finally {
        // The VM emits PROJECT_CHANGED asynchronously after load; wait a tick.
        setTimeout(() => {
          loadingProjectRef.current = false;
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
        case "setReadOnly":
          setIsPlayerOnly(message.value);
          break;
      }
    });
  }, [setIsPlayerOnly]);

  return { onVmInit };
};
