// The page's side of OpenCV's camera and windows for real Python, which runs
// in a worker that can reach neither: cv2.VideoCapture reads pictures from the
// webcam here, cv2.imshow draws into the editor's output, cv2.waitKey reads
// the keys pressed on it, and the mediapipe stand-in finds hands with
// Google's hand tracker for the browser. Pictures travel as BGR bytes, the
// way OpenCV holds them.

const VISION_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.0/";
const HAND_MODEL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

type Landmark = { x: number; y: number; z: number };
type Category = { categoryName: string; score: number };
type HandLandmarker = {
  detectForVideo: (image: ImageData, timestamp: number) => { handedness: Category[][]; landmarks: Landmark[][] };
  setOptions: (options: { numHands: number }) => Promise<void>;
};

let stream: MediaStream | undefined;
let video: HTMLVideoElement | undefined;
let grab: CanvasRenderingContext2D | undefined;
let landmarker: Promise<HandLandmarker> | undefined;
let hands = 0;
let timestamp = 0;
let lastKey = -1;
let keyWaiter: (() => void) | undefined;
let keyTimer: number | undefined;

export const cameraOpen = async () => {
  try {
    stream ??= await navigator.mediaDevices.getUserMedia({ audio: false, video: { height: 480, width: 640 } });
    video ??= document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();

    const canvas = document.createElement("canvas");

    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    grab = canvas.getContext("2d", { willReadFrequently: true }) ?? undefined;

    return { height: canvas.height, open: true, width: canvas.width };
  } catch (error) {
    return {
      message: `The camera did not start (${error instanceof Error ? error.name : String(error)}). Allow the camera for this page and run again.`,
      open: false,
    };
  }
};

// The current picture as BGR bytes, row by row.
export const cameraRead = () => {
  if (!video || !grab) return undefined;

  const { height, width } = grab.canvas;

  grab.drawImage(video, 0, 0, width, height);

  const rgba = grab.getImageData(0, 0, width, height).data;
  const bgr = new Uint8Array(width * height * 3);

  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    bgr[j] = rgba[i + 2];
    bgr[j + 1] = rgba[i + 1];
    bgr[j + 2] = rgba[i];
  }

  return bgr;
};

// Also forgets keys, so a q pressed to end one run does not end the next.
export const cameraClose = () => {
  stream?.getTracks().forEach((track) => track.stop());
  stream = undefined;
  video = undefined;
  grab = undefined;
  lastKey = -1;
  keyWaiter = undefined;
  window.clearTimeout(keyTimer);
  keyTimer = undefined;
};

// RGB or BGR bytes to a picture the browser can draw.
const toImageData = (bytes: Uint8Array, width: number, height: number, bgr: boolean) => {
  const image = new ImageData(width, height);
  const channels = bytes.length / (width * height);

  for (let i = 0, j = 0; j < bytes.length; i += 4, j += channels) {
    image.data[i] = bgr ? bytes[j + 2] : bytes[j];
    image.data[i + 1] = bytes[j + 1];
    image.data[i + 2] = bgr ? bytes[j] : bytes[j + 2];
    image.data[i + 3] = 255;
  }

  return image;
};

export const showWindow = (canvas: HTMLCanvasElement, bytes: Uint8Array, width: number, height: number) => {
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")?.putImageData(toImageData(bytes, width, height, true), 0, 0);
};

const loadLandmarker = () => {
  landmarker ??= (async () => {
    const { FilesetResolver, HandLandmarker } = await import(/* @vite-ignore */ `${VISION_URL}vision_bundle.mjs`);
    const files = await FilesetResolver.forVisionTasks(`${VISION_URL}wasm`);

    return (await HandLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: HAND_MODEL },
      numHands: 2,
      runningMode: "VIDEO",
    })) as HandLandmarker;
  })().catch((error: unknown) => {
    // Not kept: the next frame tries the download again.
    landmarker = undefined;
    throw error;
  });

  return landmarker;
};

// Finds hands in an RGB picture the program passed to Hands.process(),
// answering the way mediapipe's results do: 21 landmarks a hand, 0 to 1
// across and down the picture, and which hand it is.
export const detectHands = async (bytes: Uint8Array, width: number, height: number, maxHands: number) => {
  const tracker = await loadLandmarker();

  if (maxHands !== hands) {
    await tracker.setOptions({ numHands: maxHands });
    hands = maxHands;
  }

  timestamp = Math.max(timestamp + 1, Math.round(performance.now()));

  const result = tracker.detectForVideo(toImageData(bytes, width, height, false), timestamp);

  return result.landmarks.map((points, i) => ({
    handedness: result.handedness[i]?.[0]?.categoryName ?? "",
    landmarks: points.map(({ x, y, z }) => [x, y, z]),
    score: result.handedness[i]?.[0]?.score ?? 0,
  }));
};

export const pressKey = (key: string) => {
  if (key.length !== 1 && key !== "Escape" && key !== "Enter") return;

  lastKey = key === "Escape" ? 27 : key === "Enter" ? 13 : key.charCodeAt(0);
  keyWaiter?.();
};

// cv2.waitKey: waits the milliseconds given (0 waits for a key), then
// answers the key pressed since the last call, or -1.
export const waitKey = (delay: number) =>
  new Promise<number>((resolve) => {
    const finish = () => {
      keyWaiter = undefined;
      keyTimer = undefined;

      const key = lastKey;

      lastKey = -1;
      resolve(key);
    };

    if (delay > 0) {
      // Closing the camera clears it, so it can't end the next run's wait.
      keyTimer = window.setTimeout(finish, delay);
    } else if (lastKey >= 0) {
      finish();
    } else {
      keyWaiter = finish;
    }
  });
