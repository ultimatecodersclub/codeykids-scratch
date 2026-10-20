import { CSSProperties, KeyboardEvent, PointerEvent, useCallback, useRef, useState } from "react";

// How much of the room beside the file list the code takes; the preview has
// the rest. Remembered in this browser, so the kid's layout comes back.
const STORAGE_KEY = "codeykids.web.codeShare";
const DEFAULT_SHARE = 0.5;
// Neither side gets narrower than this while there is room for both.
const MIN_SIDE_PX = 240;
// One arrow key press moves the divider this much of the room; with Shift, more.
const STEP = 0.02;
const BIG_STEP = 0.1;

const savedShare = () => {
  try {
    const value = Number(window.localStorage.getItem(STORAGE_KEY));

    return value > 0 && value < 1 ? value : DEFAULT_SHARE;
  } catch {
    // Storage can be blocked (a private window, an embedding page's rules):
    // the layout still works, it is just not remembered.
    return DEFAULT_SHARE;
  }
};

const saveShare = (share: number) => {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(share));
  } catch {
    // Not remembered; see savedShare.
  }
};

export type Split = {
  share: number;
  // Moves the divider; `done` saves where it ended up.
  setShare: (share: number, done: boolean) => void;
  // The grid's column sizes for the code and the preview (see web.css).
  style: CSSProperties;
};

export const useSplit = (): Split => {
  const [share, setShareState] = useState(savedShare);

  const setShare = useCallback((next: number, done: boolean) => {
    setShareState(next);
    if (done) saveShare(next);
  }, []);

  return {
    setShare,
    share,
    style: { "--code-share": `${share}fr`, "--preview-share": `${1 - share}fr` } as CSSProperties,
  };
};

// The bar between the code and the preview: dragged with the mouse (or a
// finger), or moved with the arrow keys once it has the focus. It sits
// between the two panes in the grid and measures them to know the room.
export const Divider = ({ split }: { split: Split }) => {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  // The room the two panes share, and the narrowest share either may have.
  const room = () => {
    const divider = ref.current;
    const code = divider?.previousElementSibling?.getBoundingClientRect();
    const preview = divider?.nextElementSibling?.getBoundingClientRect();

    if (!divider || !code || !preview) return undefined;

    const width = preview.right - code.left - divider.offsetWidth;
    const min = width > 0 ? Math.min(MIN_SIDE_PX / width, 0.5) : 0.5;

    return { left: code.left, min, width };
  };

  const within = (share: number) => {
    const min = room()?.min ?? 0;

    return Math.min(Math.max(share, min), 1 - min);
  };

  const shareAt = (clientX: number) => {
    const space = room();

    if (!space || space.width <= 0) return split.share;

    const share = (clientX - space.left - (ref.current?.offsetWidth ?? 0) / 2) / space.width;

    return Math.min(Math.max(share, space.min), 1 - space.min);
  };

  // The preview is a page of its own, which would take the pointer from the
  // divider as it passes over; while dragging, nothing but the divider takes it.
  const setDragging = (on: boolean) => {
    dragging.current = on;
    document.body.classList.toggle("resizing-split", on);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    setDragging(true);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragging.current) split.setShare(shareAt(event.clientX), false);
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;

    setDragging(false);
    split.setShare(shareAt(event.clientX), true);
  };

  // A drag the browser broke off (the pointer cancelled) keeps where it got to.
  const onLostPointerCapture = () => {
    if (!dragging.current) return;

    setDragging(false);
    split.setShare(split.share, true);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? BIG_STEP : STEP;
    const moves: Record<string, number> = {
      ArrowLeft: split.share - step,
      ArrowRight: split.share + step,
      End: 1,
      Home: 0,
    };

    if (!(event.key in moves)) return;

    event.preventDefault();
    split.setShare(within(moves[event.key]), true);
  };

  return (
    <div
      aria-label="Resize the code and the preview"
      aria-orientation="vertical"
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={Math.round(split.share * 100)}
      className="divider"
      onDoubleClick={() => split.setShare(within(DEFAULT_SHARE), true)}
      onKeyDown={onKeyDown}
      onLostPointerCapture={onLostPointerCapture}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      ref={ref}
      role="separator"
      tabIndex={0}
      title="Drag to resize (double-click to share evenly)"
    />
  );
};
