// Pictures of a kid's work for the project card on CodeyKids. The page asks
// with `snapshot` at every save and uploads what comes back, so a picture is
// small (a 4:3 JPEG, well under the page's 512 KB limit) and never worth
// failing a save over: an editor that cannot take one says snapshotFailed.

const WIDTH = 480;
const HEIGHT = 360;
const QUALITY = 0.85;

const INK = "#2A2A2A";
const PAPER = "#FFF9EC";

const card = () => {
  const canvas = document.createElement("canvas");

  canvas.width = WIDTH;
  canvas.height = HEIGHT;

  const context = canvas.getContext("2d");

  if (!context) throw new Error("No 2D canvas here");

  return { canvas, context };
};

const toJpeg = (canvas: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) => {
    // Throws when something drawn on the canvas tainted it.
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The picture came out empty"))), "image/jpeg", QUALITY);
  });

export const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();

    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The picture could not be read"));
    image.src = src;
  });

type Layer = { height: number; source: CanvasImageSource; width: number };

// The layers, one over the other, fitted whole into the card on a plain
// ground: a stage or a turtle canvas may be transparent where nothing is drawn.
export const pictureOf = (layers: Layer[], ground = "#FFFFFF") => {
  const { canvas, context } = card();

  context.fillStyle = ground;
  context.fillRect(0, 0, WIDTH, HEIGHT);

  for (const { height, source, width } of layers) {
    if (!width || !height) continue;

    const scale = Math.min(WIDTH / width, HEIGHT / height);
    const w = width * scale;
    const h = height * scale;

    context.drawImage(source, (WIDTH - w) / 2, (HEIGHT - h) / 2, w, h);
  }

  return toJpeg(canvas);
};

// For work with nothing to photograph (a program that prints, a page that
// could not be drawn): its name and its first lines, as a kid would
// recognise them in the editor.
export const codeCard = ({ accent, lines, title }: { accent: string; lines: string[]; title: string }) => {
  const { canvas, context } = card();

  context.fillStyle = PAPER;
  context.fillRect(0, 0, WIDTH, HEIGHT);
  context.fillStyle = accent;
  context.fillRect(0, 0, WIDTH, 54);
  context.fillStyle = INK;
  context.fillRect(0, 54, WIDTH, 4);

  context.textBaseline = "middle";
  context.font = "700 22px ui-monospace, Menlo, Consolas, monospace";
  context.fillText(title.slice(0, 30), 20, 28);

  context.font = "16px ui-monospace, Menlo, Consolas, monospace";

  lines
    .filter((line) => line.trim() !== "")
    .slice(0, 12)
    .forEach((line, index) => {
      context.fillStyle = index % 2 ? "#4A4A4A" : INK;
      context.fillText(line.replace(/\t/g, "  ").slice(0, 46), 20, 84 + index * 23);
    });

  return toJpeg(canvas);
};

const PAGE_WIDTH = 640;
const PAGE_HEIGHT = 480;

// A page of the kid's site, drawn by the browser from its own markup inside
// an SVG. Scripts do not run in there and nothing outside the markup is
// fetched, so this is the page as written, which is what a cover should be.
// Browsers that refuse to read such a canvas back make this throw.
export const pictureOfPage = async (html: string) => {
  const page = new DOMParser().parseFromString(html, "text/html");

  page.querySelectorAll("script, iframe, object, embed").forEach((node) => node.remove());

  const markup = new XMLSerializer().serializeToString(page.documentElement);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_WIDTH}" height="${PAGE_HEIGHT}">` +
    `<foreignObject width="100%" height="100%">${markup}</foreignObject></svg>`;
  const image = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);

  return pictureOf([{ height: PAGE_HEIGHT, source: image, width: PAGE_WIDTH }]);
};
