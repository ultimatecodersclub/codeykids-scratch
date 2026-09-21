import GUI, { AppStateHOC, setAppElement } from "@scratch/scratch-gui";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { postToPage } from "./bridge";
import { useEditorBridge } from "./useEditorBridge";

// Minimal shape of the parts of scratch-vm this wrapper touches.
export type ScratchVM = {
  loadProject: (input: ArrayBuffer | string | object) => Promise<void>;
  saveProjectSb3: () => Promise<Blob>;
  // scratch-render: the callback gets the stage as a data URL at its next
  // draw.
  renderer?: {
    draw: () => void;
    requestSnapshot: (callback: (dataURL: string) => void) => void;
  };
  runtime: {
    on: (event: string, listener: () => void) => void;
    off: (event: string, listener: () => void) => void;
  };
  stopAll: () => void;
};

const WrappedGui = AppStateHOC(GUI);

const LOGO = "/codeykids-logo.png";

// The published GUI picks the menubar image from its `platform` and ignores
// the `logo` prop, so the image is swapped in the DOM instead: once when the
// menubar is there, and again if the GUI ever sets it back or renders the
// menubar afresh (which only player mode toggling does). Scratch's trademark
// guidance: say "based on Scratch", never show its logo.
const useCodeyKidsLogo = (isPlayerOnly: boolean) => {
  useEffect(() => {
    let watched: HTMLImageElement | undefined;
    const imageObserver = new MutationObserver(() => swap());
    const swap = () => {
      const img = document.getElementById("logo_img");

      if (!(img instanceof HTMLImageElement)) return false;
      if (!img.src.endsWith(LOGO)) {
        img.src = LOGO;
        img.alt = "CodeyKids";
      }
      if (watched !== img) {
        imageObserver.disconnect();
        imageObserver.observe(img, { attributeFilter: ["src"], attributes: true });
        watched = img;
      }

      return true;
    };

    // The menubar mounts after the GUI's first render; watch only until it is
    // there, so block editing is not taxed for the rest of the session.
    const bodyObserver = new MutationObserver(() => {
      if (swap()) bodyObserver.disconnect();
    });

    if (!swap()) bodyObserver.observe(document.body, { childList: true, subtree: true });

    return () => {
      bodyObserver.disconnect();
      imageObserver.disconnect();
    };
  }, [isPlayerOnly]);
};

const App = () => {
  const [isPlayerOnly, setIsPlayerOnly] = useState(false);

  const { onVmInit } = useEditorBridge({ setIsPlayerOnly });

  useCodeyKidsLogo(isPlayerOnly);

  return (
    <WrappedGui
      canEditTitle={false}
      canManageFiles
      isPlayerOnly={isPlayerOnly}
      onProjectLoaded={() => postToPage({ type: "ready" })}
      onVmInit={onVmInit}
      // "0" is the GUI's bundled default project (the cat). Without a project
      // id nothing loads and onProjectLoaded never fires.
      projectId="0"
    />
  );
};

const target = document.getElementById("app")!;

setAppElement(target);
createRoot(target).render(<App />);
