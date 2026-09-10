import GUI, { AppStateHOC, setAppElement } from "@scratch/scratch-gui";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { postToPage } from "./bridge";
import { useEditorBridge } from "./useEditorBridge";

// Minimal shape of the parts of scratch-vm this wrapper touches.
export type ScratchVM = {
  loadProject: (input: ArrayBuffer | string | object) => Promise<void>;
  saveProjectSb3: () => Promise<Blob>;
  runtime: {
    on: (event: string, listener: () => void) => void;
    off: (event: string, listener: () => void) => void;
  };
  stopAll: () => void;
};

const WrappedGui = AppStateHOC(GUI);

const LOGO = "/codeykids-logo.png";

// The published GUI picks the menubar image from its `platform` and ignores
// the `logo` prop, so the image is swapped in the DOM instead, and again
// whenever the menubar is rendered afresh. Scratch's trademark guidance: say
// "based on Scratch", never show its logo.
const useCodeyKidsLogo = () => {
  useEffect(() => {
    const swap = () => {
      const img = document.getElementById("logo_img");

      if (img instanceof HTMLImageElement && !img.src.endsWith(LOGO)) {
        img.src = LOGO;
        img.alt = "CodeyKids";
      }
    };
    const observer = new MutationObserver(swap);

    swap();
    observer.observe(document.body, { childList: true, subtree: true });

    return () => observer.disconnect();
  }, []);
};

const App = () => {
  const [isPlayerOnly, setIsPlayerOnly] = useState(false);

  const { onVmInit } = useEditorBridge({ setIsPlayerOnly });

  useCodeyKidsLogo();

  return (
    <WrappedGui
      canEditTitle={false}
      canManageFiles
      isPlayerOnly={isPlayerOnly}
      logo={LOGO}
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
