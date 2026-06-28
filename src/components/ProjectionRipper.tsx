import {
  type ChangeEvent,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Check, ImagePlus, Move, RotateCcw, Scissors, SlidersHorizontal } from "lucide-react";
import type { PreparedProjection } from "../types/texture";

interface ProjectionRipperProps {
  preparedProjections: PreparedProjection[];
  onPreparedProjectionAdd: (projection: PreparedProjection) => void;
}

interface RipperPoint {
  x: number;
  y: number;
}

interface AtlasTransform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
}

interface RipperSourceImage {
  id: string;
  name: string;
  objectUrl: string;
  width: number;
  height: number;
  createdAt: string;
}

interface RipperRegion {
  id: string;
  imageId: string;
  name: string;
  points: RipperPoint[];
  bevels: number[];
  bevelMode: "straight" | "round";
  atlasTransform: AtlasTransform;
  brightness: number;
  contrast: number;
  opacity: number;
}

type AtlasShortcutMode = "move" | "scale" | "rotate" | null;

const ATLAS_CANVAS_SIZE = 1024;
const POINT_MIN = -60;
const POINT_MAX = 160;
const DEFAULT_POINTS: RipperPoint[] = [
  { x: 18, y: 18 },
  { x: 82, y: 18 },
  { x: 82, y: 82 },
  { x: 18, y: 82 },
];
const DEFAULT_POINT_BEVELS = [0, 0, 0, 0];
const DEFAULT_ATLAS_TRANSFORM: AtlasTransform = {
  x: 50,
  y: 50,
  scale: 0.62,
  rotation: 0,
};
const POINT_LOUPE_SIZE = 260;
const POINT_LOUPE_ZOOM = 4.25;
const POINT_FINE_DRAG_SPEED = 0.22;

function cloneDefaultPoints(): RipperPoint[] {
  return DEFAULT_POINTS.map((point) => ({ ...point }));
}

function cloneDefaultBevels() {
  return [...DEFAULT_POINT_BEVELS];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getImageSize(objectUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth || image.width, height: image.naturalHeight || image.height });
    image.onerror = () => reject(new Error("Unable to read image size"));
    image.src = objectUrl;
  });
}

function loadImage(objectUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Unable to load projection image"));
    image.src = objectUrl;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Unable to create prepared projection"));
        return;
      }

      resolve(blob);
    }, "image/png");
  });
}

function formatResolution(width: number, height: number) {
  return width > 0 && height > 0 ? `${width} x ${height}` : "Pending";
}

function formatPreparedDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Pending";
  }

  return date.toLocaleDateString(undefined, {
    day: "2-digit",
    month: "short",
    year: "2-digit",
  });
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function getPixelPoint(point: RipperPoint, imageWidth: number, imageHeight: number): RipperPoint {
  return {
    x: (point.x / 100) * imageWidth,
    y: (point.y / 100) * imageHeight,
  };
}

function getDistance(start: RipperPoint, end: RipperPoint): number {
  return Math.hypot(end.x - start.x, end.y - start.y);
}

function getSelectionMetrics(points: RipperPoint[], imageWidth = 1, imageHeight = 1) {
  const safeImageWidth = Math.max(1, imageWidth);
  const safeImageHeight = Math.max(1, imageHeight);
  const pixelPoints = points.map((point) => getPixelPoint(point, safeImageWidth, safeImageHeight));
  const topWidth = getDistance(pixelPoints[0], pixelPoints[1]);
  const bottomWidth = getDistance(pixelPoints[3], pixelPoints[2]);
  const leftHeight = getDistance(pixelPoints[0], pixelPoints[3]);
  const rightHeight = getDistance(pixelPoints[1], pixelPoints[2]);
  const width = Math.max(1, (topWidth + bottomWidth) / 2);
  const height = Math.max(1, (leftHeight + rightHeight) / 2);

  return {
    width,
    height,
    aspect: width / height,
  };
}

function getAtlasPlacement(points: RipperPoint[], transform: AtlasTransform, imageWidth = 1, imageHeight = 1) {
  const bounds = getSelectionMetrics(points, imageWidth, imageHeight);
  const baseSize = 58 * transform.scale;
  const width = bounds.aspect >= 1 ? baseSize : baseSize * bounds.aspect;
  const height = bounds.aspect >= 1 ? baseSize / bounds.aspect : baseSize;

  return {
    width: clamp(width, 8, 135),
    height: clamp(height, 8, 135),
  };
}

function lerp(a: number, b: number, amount: number): number {
  return a + (b - a) * amount;
}

function bilinearPoint(points: RipperPoint[], u: number, v: number, image: HTMLImageElement): RipperPoint {
  const topX = lerp(points[0].x, points[1].x, u);
  const topY = lerp(points[0].y, points[1].y, u);
  const bottomX = lerp(points[3].x, points[2].x, u);
  const bottomY = lerp(points[3].y, points[2].y, u);

  return {
    x: (lerp(topX, bottomX, v) / 100) * image.naturalWidth,
    y: (lerp(topY, bottomY, v) / 100) * image.naturalHeight,
  };
}

function solveLinearSystem(matrix: number[][], values: number[]): number[] | null {
  const size = values.length;
  const augmented = matrix.map((row, index) => [...row, values[index]]);

  for (let pivot = 0; pivot < size; pivot += 1) {
    let pivotRow = pivot;
    for (let row = pivot + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][pivot]) > Math.abs(augmented[pivotRow][pivot])) {
        pivotRow = row;
      }
    }

    if (Math.abs(augmented[pivotRow][pivot]) < 0.000001) {
      return null;
    }

    if (pivotRow !== pivot) {
      [augmented[pivot], augmented[pivotRow]] = [augmented[pivotRow], augmented[pivot]];
    }

    const pivotValue = augmented[pivot][pivot];
    for (let column = pivot; column <= size; column += 1) {
      augmented[pivot][column] /= pivotValue;
    }

    for (let row = 0; row < size; row += 1) {
      if (row === pivot) {
        continue;
      }

      const factor = augmented[row][pivot];
      for (let column = pivot; column <= size; column += 1) {
        augmented[row][column] -= factor * augmented[pivot][column];
      }
    }
  }

  return augmented.map((row) => row[size]);
}

function getSquareToQuadHomography(points: RipperPoint[], image: HTMLImageElement): number[] | null {
  const imageWidth = image.naturalWidth || image.width || 1;
  const imageHeight = image.naturalHeight || image.height || 1;
  const destination = points.map((point) => getPixelPoint(point, imageWidth, imageHeight));
  const source = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];
  const matrix: number[][] = [];
  const values: number[] = [];

  source.forEach((sourcePoint, index) => {
    const targetPoint = destination[index];
    const { x: u, y: v } = sourcePoint;
    const { x, y } = targetPoint;
    matrix.push([u, v, 1, 0, 0, 0, -x * u, -x * v]);
    values.push(x);
    matrix.push([0, 0, 0, u, v, 1, -y * u, -y * v]);
    values.push(y);
  });

  const solution = solveLinearSystem(matrix, values);
  return solution ? [...solution, 1] : null;
}

function projectHomography(homography: number[], u: number, v: number): RipperPoint {
  const denominator = homography[6] * u + homography[7] * v + homography[8];
  if (Math.abs(denominator) < 0.000001) {
    return { x: 0, y: 0 };
  }

  return {
    x: (homography[0] * u + homography[1] * v + homography[2]) / denominator,
    y: (homography[3] * u + homography[4] * v + homography[5]) / denominator,
  };
}

function getDestinationPoint(
  u: number,
  v: number,
  transform: AtlasTransform,
  width: number,
  height: number,
): RipperPoint {
  const centerX = (transform.x / 100) * ATLAS_CANVAS_SIZE;
  const centerY = (transform.y / 100) * ATLAS_CANVAS_SIZE;
  const localX = (u - 0.5) * width;
  const localY = (v - 0.5) * height;
  const angle = (transform.rotation * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  return {
    x: centerX + localX * cos - localY * sin,
    y: centerY + localX * sin + localY * cos,
  };
}

function getAffineTransform(source: RipperPoint[], destination: RipperPoint[]) {
  const [s0, s1, s2] = source;
  const [d0, d1, d2] = destination;
  const denominator = s0.x * (s1.y - s2.y) + s1.x * (s2.y - s0.y) + s2.x * (s0.y - s1.y);
  if (Math.abs(denominator) < 0.000001) {
    return null;
  }

  const a = (d0.x * (s1.y - s2.y) + d1.x * (s2.y - s0.y) + d2.x * (s0.y - s1.y)) / denominator;
  const c = (d0.x * (s2.x - s1.x) + d1.x * (s0.x - s2.x) + d2.x * (s1.x - s0.x)) / denominator;
  const e = (
    d0.x * (s1.x * s2.y - s2.x * s1.y) +
    d1.x * (s2.x * s0.y - s0.x * s2.y) +
    d2.x * (s0.x * s1.y - s1.x * s0.y)
  ) / denominator;
  const b = (d0.y * (s1.y - s2.y) + d1.y * (s2.y - s0.y) + d2.y * (s0.y - s1.y)) / denominator;
  const d = (d0.y * (s2.x - s1.x) + d1.y * (s0.x - s2.x) + d2.y * (s1.x - s0.x)) / denominator;
  const f = (
    d0.y * (s1.x * s2.y - s2.x * s1.y) +
    d1.y * (s2.x * s0.y - s0.x * s2.y) +
    d2.y * (s0.x * s1.y - s1.x * s0.y)
  ) / denominator;

  return { a, b, c, d, e, f };
}

function drawTriangleProjection(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  source: RipperPoint[],
  destination: RipperPoint[],
) {
  const transform = getAffineTransform(source, destination);
  if (!transform) {
    return;
  }

  context.save();
  context.beginPath();
  context.moveTo(destination[0].x, destination[0].y);
  context.lineTo(destination[1].x, destination[1].y);
  context.lineTo(destination[2].x, destination[2].y);
  context.closePath();
  context.clip();
  context.transform(transform.a, transform.b, transform.c, transform.d, transform.e, transform.f);
  context.drawImage(image, 0, 0);
  context.restore();
}

function getBeveledPolygonPath(corners: RipperPoint[], bevels: number[], bevelMode: RipperRegion["bevelMode"]) {
  const path = new Path2D();
  if (corners.length < 3) {
    return path;
  }

  const beveledCorners = corners.map((corner, index) => {
    const previous = corners[(index - 1 + corners.length) % corners.length];
    const next = corners[(index + 1) % corners.length];
    const ratio = clamp((bevels[index] ?? 0) / 100, 0, 0.45);
    const previousLength = Math.max(0.0001, getDistance(previous, corner));
    const nextLength = Math.max(0.0001, getDistance(next, corner));
    const distance = Math.min(previousLength, nextLength) * ratio;
    const before = {
      x: corner.x + ((previous.x - corner.x) / previousLength) * distance,
      y: corner.y + ((previous.y - corner.y) / previousLength) * distance,
    };
    const after = {
      x: corner.x + ((next.x - corner.x) / nextLength) * distance,
      y: corner.y + ((next.y - corner.y) / nextLength) * distance,
    };

    return { before, after };
  });

  path.moveTo(beveledCorners[0].after.x, beveledCorners[0].after.y);
  for (let index = 1; index < beveledCorners.length; index += 1) {
    path.lineTo(beveledCorners[index].before.x, beveledCorners[index].before.y);
    if (bevelMode === "round" && (bevels[index] ?? 0) > 0) {
      path.quadraticCurveTo(corners[index].x, corners[index].y, beveledCorners[index].after.x, beveledCorners[index].after.y);
    } else {
      path.lineTo(beveledCorners[index].after.x, beveledCorners[index].after.y);
    }
  }
  path.lineTo(beveledCorners[0].before.x, beveledCorners[0].before.y);
  if (bevelMode === "round" && (bevels[0] ?? 0) > 0) {
    path.quadraticCurveTo(corners[0].x, corners[0].y, beveledCorners[0].after.x, beveledCorners[0].after.y);
  }
  path.closePath();
  return path;
}

function drawRegionProjection(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  region: RipperRegion,
  quality: "draft" | "final" = "final",
) {
  const { atlasTransform, bevelMode, bevels, brightness, contrast, opacity, points } = region;
  const placement = getAtlasPlacement(points, atlasTransform, image.naturalWidth || image.width, image.naturalHeight || image.height);
  const destinationWidth = (placement.width / 100) * ATLAS_CANVAS_SIZE;
  const destinationHeight = (placement.height / 100) * ATLAS_CANVAS_SIZE;
  const subdivisions = quality === "draft" ? 8 : 22;
  const homography = getSquareToQuadHomography(points, image);
  const destinationCorners = [
    getDestinationPoint(0, 0, atlasTransform, destinationWidth, destinationHeight),
    getDestinationPoint(1, 0, atlasTransform, destinationWidth, destinationHeight),
    getDestinationPoint(1, 1, atlasTransform, destinationWidth, destinationHeight),
    getDestinationPoint(0, 1, atlasTransform, destinationWidth, destinationHeight),
  ];

  context.save();
  context.clip(getBeveledPolygonPath(destinationCorners, bevels ?? DEFAULT_POINT_BEVELS, bevelMode ?? "straight"));
  context.globalAlpha = opacity / 100;
  context.filter = `brightness(${brightness}%) contrast(${contrast}%)`;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = quality === "draft" ? "medium" : "high";

  for (let row = 0; row < subdivisions; row += 1) {
    for (let column = 0; column < subdivisions; column += 1) {
      const u0 = column / subdivisions;
      const u1 = (column + 1) / subdivisions;
      const v0 = row / subdivisions;
      const v1 = (row + 1) / subdivisions;
      const sourceA = homography ? projectHomography(homography, u0, v0) : bilinearPoint(points, u0, v0, image);
      const sourceB = homography ? projectHomography(homography, u1, v0) : bilinearPoint(points, u1, v0, image);
      const sourceC = homography ? projectHomography(homography, u1, v1) : bilinearPoint(points, u1, v1, image);
      const sourceD = homography ? projectHomography(homography, u0, v1) : bilinearPoint(points, u0, v1, image);
      const destinationA = getDestinationPoint(u0, v0, atlasTransform, destinationWidth, destinationHeight);
      const destinationB = getDestinationPoint(u1, v0, atlasTransform, destinationWidth, destinationHeight);
      const destinationC = getDestinationPoint(u1, v1, atlasTransform, destinationWidth, destinationHeight);
      const destinationD = getDestinationPoint(u0, v1, atlasTransform, destinationWidth, destinationHeight);

      drawTriangleProjection(context, image, [sourceA, sourceB, sourceC], [destinationA, destinationB, destinationC]);
      drawTriangleProjection(context, image, [sourceA, sourceC, sourceD], [destinationA, destinationC, destinationD]);
    }
  }

  context.restore();
}

function createRipperRegion(image: RipperSourceImage, index: number): RipperRegion {
  const offset = index % 5;
  return {
    id: crypto.randomUUID(),
    imageId: image.id,
    name: image.name || `Ripper_${index + 1}`,
    points: cloneDefaultPoints(),
    bevels: cloneDefaultBevels(),
    bevelMode: "straight",
    atlasTransform: {
      ...DEFAULT_ATLAS_TRANSFORM,
      x: clamp(36 + offset * 7, 18, 82),
      y: clamp(42 + offset * 7, 18, 82),
    },
    brightness: 100,
    contrast: 100,
    opacity: 100,
  };
}

export function ProjectionRipper({ preparedProjections, onPreparedProjectionAdd }: ProjectionRipperProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const ripperFrameRef = useRef<HTMLDivElement | null>(null);
  const atlasSurfaceRef = useRef<HTMLDivElement | null>(null);
  const atlasCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const loadedImageCacheRef = useRef(new Map<string, HTMLImageElement>());
  const activePointDragRef = useRef<number | null>(null);
  const atlasShortcutRef = useRef<{
    mode: Exclude<AtlasShortcutMode, null>;
    startX: number;
    startY: number;
    startTransform: AtlasTransform;
  } | null>(null);
  const lastAtlasPointerRef = useRef({ x: 0, y: 0 });
  const atlasMoveFrameRef = useRef<number | null>(null);
  const pendingAtlasMoveRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const pointMoveFrameRef = useRef<number | null>(null);
  const pendingPointMoveRef = useRef<{ index: number; clientX: number; clientY: number; fine: boolean } | null>(null);
  const activePointDragStartRef = useRef<{
    index: number;
    clientX: number;
    clientY: number;
    point: RipperPoint;
    lastClientX: number;
    lastClientY: number;
    lastPoint: RipperPoint;
    hasMoved: boolean;
  } | null>(null);
  const inactiveAtlasCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const inactiveAtlasCacheKeyRef = useRef("");
  const [sourceImages, setSourceImages] = useState<RipperSourceImage[]>([]);
  const [regions, setRegions] = useState<RipperRegion[]>([]);
  const [activeRegionId, setActiveRegionId] = useState("");
  const [activeSourceImageId, setActiveSourceImageId] = useState("");
  const [activePointIndex, setActivePointIndex] = useState<number | null>(null);
  const [selectedPointIndex, setSelectedPointIndex] = useState(0);
  const [atlasShortcutMode, setAtlasShortcutMode] = useState<AtlasShortcutMode>(null);
  const [isConfirming, setIsConfirming] = useState(false);
  const [ripperFrameSize, setRipperFrameSize] = useState({ width: 1, height: 1 });
  const activeRegion = regions.find((region) => region.id === activeRegionId) ?? null;
  const activeSource = activeRegion
    ? sourceImages.find((image) => image.id === activeRegion.imageId) ?? null
    : sourceImages.find((image) => image.id === activeSourceImageId) ?? sourceImages[0] ?? null;
  const imageUrl = activeSource?.objectUrl ?? null;
  const imageSize = activeSource ? { width: activeSource.width, height: activeSource.height } : { width: 0, height: 0 };
  const points = activeRegion?.points ?? DEFAULT_POINTS;
  const bevels = activeRegion?.bevels ?? DEFAULT_POINT_BEVELS;
  const atlasTransform = activeRegion?.atlasTransform ?? DEFAULT_ATLAS_TRANSFORM;
  const brightness = activeRegion?.brightness ?? 100;
  const contrast = activeRegion?.contrast ?? 100;
  const opacity = activeRegion?.opacity ?? 100;
  const polygonPoints = useMemo(() => points.map((point) => `${point.x},${point.y}`).join(" "), [points]);
  const imageAspectRatio = imageSize.width > 0 && imageSize.height > 0 ? `${imageSize.width} / ${imageSize.height}` : "1 / 1";
  const atlasPlacement = useMemo(
    () => getAtlasPlacement(points, atlasTransform, imageSize.width || 1, imageSize.height || 1),
    [atlasTransform, imageSize.height, imageSize.width, points],
  );
  const atlasPlacementStyle = {
    left: `${atlasTransform.x}%`,
    top: `${atlasTransform.y}%`,
    width: `${atlasPlacement.width}%`,
    height: `${atlasPlacement.height}%`,
    transform: `translate(-50%, -50%) rotate(${atlasTransform.rotation}deg)`,
  } as CSSProperties;
  const atlasCornerHandles = useMemo(() => {
    const destinationWidth = (atlasPlacement.width / 100) * ATLAS_CANVAS_SIZE;
    const destinationHeight = (atlasPlacement.height / 100) * ATLAS_CANVAS_SIZE;
    return [
      getDestinationPoint(0, 0, atlasTransform, destinationWidth, destinationHeight),
      getDestinationPoint(1, 0, atlasTransform, destinationWidth, destinationHeight),
      getDestinationPoint(1, 1, atlasTransform, destinationWidth, destinationHeight),
      getDestinationPoint(0, 1, atlasTransform, destinationWidth, destinationHeight),
    ].map((point, index) => ({
      index,
      left: `${(point.x / ATLAS_CANVAS_SIZE) * 100}%`,
      top: `${(point.y / ATLAS_CANVAS_SIZE) * 100}%`,
    }));
  }, [atlasPlacement.height, atlasPlacement.width, atlasTransform]);
  const activePoint = activePointIndex !== null ? points[activePointIndex] : null;
  const selectedPointBevel = bevels[selectedPointIndex] ?? 0;
  const activePointPixel = activePoint ? {
    x: (activePoint.x / 100) * ripperFrameSize.width,
    y: (activePoint.y / 100) * ripperFrameSize.height,
  } : null;
  const loupeOffset = activePoint ? {
    x: activePoint.x > 58 ? -POINT_LOUPE_SIZE - 32 : 32,
    y: activePoint.y > 58 ? -POINT_LOUPE_SIZE - 32 : 32,
  } : { x: 32, y: 32 };
  const loupeStyle = activeSource && activePoint ? {
    left: `${activePoint.x}%`,
    top: `${activePoint.y}%`,
    width: POINT_LOUPE_SIZE,
    height: POINT_LOUPE_SIZE,
    backgroundImage: `url(${activeSource.objectUrl})`,
    backgroundSize: `${ripperFrameSize.width * POINT_LOUPE_ZOOM}px ${ripperFrameSize.height * POINT_LOUPE_ZOOM}px`,
    backgroundPosition: activePointPixel
      ? `${POINT_LOUPE_SIZE / 2 - activePointPixel.x * POINT_LOUPE_ZOOM}px ${POINT_LOUPE_SIZE / 2 - activePointPixel.y * POINT_LOUPE_ZOOM}px`
      : "50% 50%",
    filter: `brightness(${brightness}%) contrast(${contrast}%)`,
    transform: `translate(${loupeOffset.x}px, ${loupeOffset.y}px)`,
  } as CSSProperties : undefined;
  const loupePoints = activePointPixel
    ? points.map((point) => {
      const pointPixel = {
        x: (point.x / 100) * ripperFrameSize.width,
        y: (point.y / 100) * ripperFrameSize.height,
      };

      return {
        x: POINT_LOUPE_SIZE / 2 + (pointPixel.x - activePointPixel.x) * POINT_LOUPE_ZOOM,
        y: POINT_LOUPE_SIZE / 2 + (pointPixel.y - activePointPixel.y) * POINT_LOUPE_ZOOM,
      };
    })
    : [];
  const loupePolygonPoints = loupePoints.map((point) => `${point.x},${point.y}`).join(" ");

  function updateActiveRegion(updater: (region: RipperRegion) => RipperRegion) {
    if (!activeRegion) {
      return;
    }

    setRegions((currentRegions) =>
      currentRegions.map((region) => (region.id === activeRegion.id ? updater(region) : region)),
    );
  }

  useEffect(() => {
    const frame = ripperFrameRef.current;
    if (!frame) {
      return undefined;
    }
    const activeFrame = frame;

    function updateFrameSize() {
      const bounds = activeFrame.getBoundingClientRect();
      setRipperFrameSize({
        width: Math.max(1, bounds.width),
        height: Math.max(1, bounds.height),
      });
    }

    updateFrameSize();
    const resizeObserver = new ResizeObserver(updateFrameSize);
    resizeObserver.observe(activeFrame);

    return () => {
      resizeObserver.disconnect();
    };
  }, [activeSource?.id]);

  useEffect(() => {
    const canvas = atlasCanvasRef.current;
    if (!canvas) {
      return undefined;
    }

    const context = canvas.getContext("2d");
    if (!context) {
      return undefined;
    }

    canvas.width = ATLAS_CANVAS_SIZE;
    canvas.height = ATLAS_CANVAS_SIZE;
    context.clearRect(0, 0, canvas.width, canvas.height);

    if (!inactiveAtlasCanvasRef.current) {
      const inactiveCanvas = document.createElement("canvas");
      inactiveCanvas.width = ATLAS_CANVAS_SIZE;
      inactiveCanvas.height = ATLAS_CANVAS_SIZE;
      inactiveAtlasCanvasRef.current = inactiveCanvas;
    }

    if (regions.length === 0) {
      return undefined;
    }

    let canceled = false;
    Promise.all(sourceImages.map(async (sourceImage) => {
      const cachedImage = loadedImageCacheRef.current.get(sourceImage.id);
      if (cachedImage) {
        return [sourceImage.id, cachedImage] as const;
      }

      const loadedImage = await loadImage(sourceImage.objectUrl);
      loadedImageCacheRef.current.set(sourceImage.id, loadedImage);
      return [sourceImage.id, loadedImage] as const;
    }))
      .then((loadedImages) => {
        if (canceled) {
          return;
        }

        context.clearRect(0, 0, canvas.width, canvas.height);
        const imageMap = new Map(loadedImages);
        const activeRegionForRender = regions.find((region) => region.id === activeRegionId) ?? null;
        const inactiveRegions = activeRegionForRender
          ? regions.filter((region) => region.id !== activeRegionForRender.id)
          : regions;
        const inactiveCacheKey = JSON.stringify(inactiveRegions.map((region) => ({
          id: region.id,
          imageId: region.imageId,
          points: region.points,
          bevels: region.bevels,
          bevelMode: region.bevelMode,
          atlasTransform: region.atlasTransform,
          brightness: region.brightness,
          contrast: region.contrast,
          opacity: region.opacity,
        })));
        const inactiveCanvas = inactiveAtlasCanvasRef.current;
        const inactiveContext = inactiveCanvas?.getContext("2d");

        if (inactiveCanvas && inactiveContext && inactiveAtlasCacheKeyRef.current !== inactiveCacheKey) {
          inactiveContext.clearRect(0, 0, inactiveCanvas.width, inactiveCanvas.height);
          inactiveRegions.forEach((region) => {
            const image = imageMap.get(region.imageId);
            if (image) {
              drawRegionProjection(inactiveContext, image, region, "final");
            }
          });
          inactiveAtlasCacheKeyRef.current = inactiveCacheKey;
        }

        if (inactiveCanvas) {
          context.drawImage(inactiveCanvas, 0, 0);
        }

        if (activeRegionForRender) {
          const image = imageMap.get(activeRegionForRender.imageId);
          if (image) {
            const quality = activePointIndex !== null || atlasShortcutMode ? "draft" : "final";
            drawRegionProjection(context, image, activeRegionForRender, quality);
          }
        }
      })
      .catch(() => {
        context.clearRect(0, 0, canvas.width, canvas.height);
      });

    return () => {
      canceled = true;
    };
  }, [activePointIndex, activeRegionId, atlasShortcutMode, regions, sourceImages]);

  async function importImageFiles(files: File[]) {
    if (files.length === 0) {
      return;
    }

    const loadedImages = await Promise.all(files.map(async (file) => {
      const objectUrl = URL.createObjectURL(file);
      const name = file.name.replace(/\.[^.]+$/, "") || `Image_${Date.now()}`;
      try {
        const size = await getImageSize(objectUrl);
        return {
          id: crypto.randomUUID(),
          name,
          objectUrl,
          width: size.width,
          height: size.height,
          createdAt: new Date().toISOString(),
        };
      } catch {
        return {
          id: crypto.randomUUID(),
          name,
          objectUrl,
          width: 0,
          height: 0,
          createdAt: new Date().toISOString(),
        };
      }
    }));

    setSourceImages((currentImages) => [...currentImages, ...loadedImages]);
    setActiveSourceImageId(loadedImages[0]?.id ?? "");
    setActiveRegionId("");
  }

  async function handleImageImport(event: ChangeEvent<HTMLInputElement>) {
    await importImageFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  }

  function handleImageDrop(event: ReactDragEvent<HTMLElement>) {
    const files = Array.from(event.dataTransfer.files).filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    void importImageFiles(files);
  }

  function handleImageDragOver(event: ReactDragEvent<HTMLElement>) {
    const hasImage = Array.from(event.dataTransfer.items).some((item) => item.type.startsWith("image/"));
    if (!hasImage) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function updatePointFromClient(index: number, clientX: number, clientY: number, fine = false) {
    const bounds = ripperFrameRef.current?.getBoundingClientRect();
    if (!bounds) {
      return;
    }

    const dragStart = activePointDragStartRef.current;
    const dragSpeed = fine ? POINT_FINE_DRAG_SPEED : 1;
    const x = dragStart?.index === index
      ? dragStart.lastPoint.x + ((clientX - dragStart.lastClientX) / bounds.width) * 100 * dragSpeed
      : ((clientX - bounds.left) / bounds.width) * 100;
    const y = dragStart?.index === index
      ? dragStart.lastPoint.y + ((clientY - dragStart.lastClientY) / bounds.height) * 100 * dragSpeed
      : ((clientY - bounds.top) / bounds.height) * 100;
    const nextPoint = {
      x: clamp(x, POINT_MIN, POINT_MAX),
      y: clamp(y, POINT_MIN, POINT_MAX),
    };

    if (dragStart?.index === index) {
      dragStart.lastClientX = clientX;
      dragStart.lastClientY = clientY;
      dragStart.lastPoint = nextPoint;
      dragStart.hasMoved = true;
    }

    updateActiveRegion((region) => ({
      ...region,
      points: region.points.map((point, pointIndex) =>
        pointIndex === index ? nextPoint : point,
      ),
    }));
  }

  function schedulePointUpdate(index: number, clientX: number, clientY: number, fine: boolean) {
    pendingPointMoveRef.current = { index, clientX, clientY, fine };

    if (pointMoveFrameRef.current !== null) {
      return;
    }

    pointMoveFrameRef.current = window.requestAnimationFrame(() => {
      pointMoveFrameRef.current = null;
      const pendingPointMove = pendingPointMoveRef.current;
      pendingPointMoveRef.current = null;
      if (pendingPointMove) {
        updatePointFromClient(pendingPointMove.index, pendingPointMove.clientX, pendingPointMove.clientY, pendingPointMove.fine);
      }
    });
  }

  function handlePointPointerDown(index: number, event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // The global pointer listeners keep dragging reliable when capture is unavailable.
    }

    activePointDragRef.current = index;
    activePointDragStartRef.current = {
      index,
      clientX: event.clientX,
      clientY: event.clientY,
      point: { ...points[index] },
      lastClientX: event.clientX,
      lastClientY: event.clientY,
      lastPoint: { ...points[index] },
      hasMoved: false,
    };
    setActivePointIndex(index);
  }

  function finishPointDrag(clientX: number, clientY: number, fine = false) {
    const pointIndex = activePointDragRef.current;
    const dragState = activePointDragStartRef.current;
    const pendingPointMove = pendingPointMoveRef.current;
    if (pointMoveFrameRef.current !== null) {
      window.cancelAnimationFrame(pointMoveFrameRef.current);
      pointMoveFrameRef.current = null;
    }
    pendingPointMoveRef.current = null;

    if (pointIndex !== null && pendingPointMove?.index === pointIndex) {
      updatePointFromClient(pendingPointMove.index, pendingPointMove.clientX, pendingPointMove.clientY, pendingPointMove.fine);
    } else if (pointIndex !== null && dragState?.hasMoved) {
      updatePointFromClient(pointIndex, clientX, clientY, fine);
    }

    activePointDragRef.current = null;
    activePointDragStartRef.current = null;
    setActivePointIndex(null);
  }

  function updateAtlasPositionFromClient(clientX: number, clientY: number) {
    const bounds = atlasSurfaceRef.current?.getBoundingClientRect();
    if (!bounds || !activeRegion) {
      return;
    }

    const rawX = ((clientX - bounds.left) / bounds.width) * 100;
    const rawY = ((clientY - bounds.top) / bounds.height) * 100;
    const { x, y } = normalizeAtlasPosition(activeRegion, rawX, rawY);
    updateActiveRegion((region) => ({
      ...region,
      atlasTransform: {
        ...region.atlasTransform,
        x: clamp(x, 0, 100),
        y: clamp(y, 0, 100),
      },
    }));
  }

  function getRegionAtlasPlacement(region: RipperRegion) {
    const regionSource = sourceImages.find((sourceImage) => sourceImage.id === region.imageId);
    return getAtlasPlacement(
      region.points,
      region.atlasTransform,
      regionSource?.width || 1,
      regionSource?.height || 1,
    );
  }

  function getRegionBox(region: RipperRegion, x = region.atlasTransform.x, y = region.atlasTransform.y) {
    const placement = getRegionAtlasPlacement(region);
    return {
      left: x - placement.width / 2,
      right: x + placement.width / 2,
      top: y - placement.height / 2,
      bottom: y + placement.height / 2,
      width: placement.width,
      height: placement.height,
      centerX: x,
      centerY: y,
    };
  }

  function boxesOverlap(
    first: ReturnType<typeof getRegionBox>,
    second: ReturnType<typeof getRegionBox>,
    margin = 0.35,
  ) {
    return (
      first.left < second.right + margin &&
      first.right > second.left - margin &&
      first.top < second.bottom + margin &&
      first.bottom > second.top - margin
    );
  }

  function normalizeAtlasPosition(region: RipperRegion, rawX: number, rawY: number) {
    const snapThreshold = 1.8;
    const activeBox = getRegionBox(region, rawX, rawY);
    let x = clamp(rawX, activeBox.width / 2, 100 - activeBox.width / 2);
    let y = clamp(rawY, activeBox.height / 2, 100 - activeBox.height / 2);
    const otherRegions = regions.filter((item) => item.id !== region.id);

    otherRegions.forEach((otherRegion) => {
      const otherBox = getRegionBox(otherRegion);
      const candidateBox = getRegionBox(region, x, y);

      if (Math.abs(candidateBox.left - otherBox.right) <= snapThreshold) {
        x = otherBox.right + candidateBox.width / 2;
      } else if (Math.abs(candidateBox.right - otherBox.left) <= snapThreshold) {
        x = otherBox.left - candidateBox.width / 2;
      } else if (Math.abs(candidateBox.left - otherBox.left) <= snapThreshold) {
        x = otherBox.left + candidateBox.width / 2;
      } else if (Math.abs(candidateBox.right - otherBox.right) <= snapThreshold) {
        x = otherBox.right - candidateBox.width / 2;
      } else if (Math.abs(candidateBox.centerX - otherBox.centerX) <= snapThreshold) {
        x = otherBox.centerX;
      }

      if (Math.abs(candidateBox.top - otherBox.bottom) <= snapThreshold) {
        y = otherBox.bottom + candidateBox.height / 2;
      } else if (Math.abs(candidateBox.bottom - otherBox.top) <= snapThreshold) {
        y = otherBox.top - candidateBox.height / 2;
      } else if (Math.abs(candidateBox.top - otherBox.top) <= snapThreshold) {
        y = otherBox.top + candidateBox.height / 2;
      } else if (Math.abs(candidateBox.bottom - otherBox.bottom) <= snapThreshold) {
        y = otherBox.bottom - candidateBox.height / 2;
      } else if (Math.abs(candidateBox.centerY - otherBox.centerY) <= snapThreshold) {
        y = otherBox.centerY;
      }
    });

    otherRegions.forEach((otherRegion) => {
      const otherBox = getRegionBox(otherRegion);
      const candidateBox = getRegionBox(region, x, y);
      if (!boxesOverlap(candidateBox, otherBox)) {
        return;
      }

      const pushLeft = Math.abs(candidateBox.right - otherBox.left);
      const pushRight = Math.abs(otherBox.right - candidateBox.left);
      const pushTop = Math.abs(candidateBox.bottom - otherBox.top);
      const pushBottom = Math.abs(otherBox.bottom - candidateBox.top);
      const smallestPush = Math.min(pushLeft, pushRight, pushTop, pushBottom);

      if (smallestPush === pushLeft) {
        x = otherBox.left - candidateBox.width / 2 - 0.45;
      } else if (smallestPush === pushRight) {
        x = otherBox.right + candidateBox.width / 2 + 0.45;
      } else if (smallestPush === pushTop) {
        y = otherBox.top - candidateBox.height / 2 - 0.45;
      } else {
        y = otherBox.bottom + candidateBox.height / 2 + 0.45;
      }
    });

    return {
      x: clamp(x, activeBox.width / 2, 100 - activeBox.width / 2),
      y: clamp(y, activeBox.height / 2, 100 - activeBox.height / 2),
    };
  }

  function getAtlasPointFromClient(clientX: number, clientY: number): RipperPoint | null {
    const bounds = atlasSurfaceRef.current?.getBoundingClientRect();
    if (!bounds) {
      return null;
    }

    return {
      x: ((clientX - bounds.left) / bounds.width) * 100,
      y: ((clientY - bounds.top) / bounds.height) * 100,
    };
  }

  function isAtlasPointInsideRegion(region: RipperRegion, point: RipperPoint): boolean {
    const regionSource = sourceImages.find((sourceImage) => sourceImage.id === region.imageId);
    const placement = getAtlasPlacement(
      region.points,
      region.atlasTransform,
      regionSource?.width || 1,
      regionSource?.height || 1,
    );
    const deltaX = point.x - region.atlasTransform.x;
    const deltaY = point.y - region.atlasTransform.y;
    const angle = (-region.atlasTransform.rotation * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const localX = deltaX * cos - deltaY * sin;
    const localY = deltaX * sin + deltaY * cos;

    return Math.abs(localX) <= placement.width / 2 && Math.abs(localY) <= placement.height / 2;
  }

  function pickAtlasRegion(clientX: number, clientY: number): RipperRegion | null {
    const point = getAtlasPointFromClient(clientX, clientY);
    if (!point) {
      return null;
    }

    const pickRegions = activeRegionId
      ? [
        ...regions.filter((region) => region.id !== activeRegionId),
        ...regions.filter((region) => region.id === activeRegionId),
      ]
      : regions;

    for (let index = pickRegions.length - 1; index >= 0; index -= 1) {
      const region = pickRegions[index];
      if (isAtlasPointInsideRegion(region, point)) {
        return region;
      }
    }

    return null;
  }

  function handleAtlasPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!activeRegion) {
      return;
    }

    lastAtlasPointerRef.current = { x: event.clientX, y: event.clientY };
    if (atlasShortcutRef.current) {
      event.preventDefault();
      atlasShortcutRef.current = null;
      setAtlasShortcutMode(null);
      return;
    }

    const pickedRegion = pickAtlasRegion(event.clientX, event.clientY);
    if (pickedRegion) {
      event.preventDefault();
      setActiveRegionId(pickedRegion.id);
      setActiveSourceImageId(pickedRegion.imageId);
    }
  }

  function handleAtlasPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    lastAtlasPointerRef.current = { x: event.clientX, y: event.clientY };
  }

  function addRipperRegion() {
    const source = activeSource ?? sourceImages[0];
    if (!source) {
      return;
    }

    const nextRegion = createRipperRegion(source, regions.length);
    setRegions((currentRegions) => [...currentRegions, nextRegion]);
    setActiveRegionId(nextRegion.id);
    setActiveSourceImageId(source.id);
  }

  function deleteActiveRipperRegion() {
    if (!activeRegion) {
      return;
    }

    setRegions((currentRegions) => {
      const nextRegions = currentRegions.filter((region) => region.id !== activeRegion.id);
      const nextActiveRegion = nextRegions[0] ?? null;
      setActiveRegionId(nextActiveRegion?.id ?? "");
      setActiveSourceImageId(nextActiveRegion?.imageId ?? activeRegion.imageId);
      return nextRegions;
    });
  }

  useEffect(() => {
    if (activePointIndex === null) {
      return undefined;
    }

    function handleWindowPointerMove(event: PointerEvent) {
      if (activePointDragRef.current === null) {
        return;
      }

      schedulePointUpdate(activePointDragRef.current, event.clientX, event.clientY, event.shiftKey);
    }

    function handleWindowPointerUp(event: PointerEvent) {
      finishPointDrag(event.clientX, event.clientY, event.shiftKey);
    }

    window.addEventListener("pointermove", handleWindowPointerMove, { capture: true });
    window.addEventListener("pointerup", handleWindowPointerUp, { capture: true });
    window.addEventListener("pointercancel", handleWindowPointerUp, { capture: true });

    return () => {
      window.removeEventListener("pointermove", handleWindowPointerMove, { capture: true });
      window.removeEventListener("pointerup", handleWindowPointerUp, { capture: true });
      window.removeEventListener("pointercancel", handleWindowPointerUp, { capture: true });
    };
  }, [activePointIndex, activeRegion?.id]);

  useEffect(() => {
    function startShortcut(mode: Exclude<AtlasShortcutMode, null>) {
      if (!activeRegion) {
        return;
      }

      atlasShortcutRef.current = {
        mode,
        startX: lastAtlasPointerRef.current.x,
        startY: lastAtlasPointerRef.current.y,
        startTransform: { ...activeRegion.atlasTransform },
      };
      setAtlasShortcutMode(mode);
    }

    function finishShortcut() {
      pendingAtlasMoveRef.current = null;
      if (atlasMoveFrameRef.current !== null) {
        window.cancelAnimationFrame(atlasMoveFrameRef.current);
        atlasMoveFrameRef.current = null;
      }
      atlasShortcutRef.current = null;
      setAtlasShortcutMode(null);
    }

    function cancelShortcut() {
      const shortcut = atlasShortcutRef.current;
      if (!shortcut) {
        return;
      }

      updateActiveRegion((region) => ({
        ...region,
        atlasTransform: shortcut.startTransform,
      }));
      finishShortcut();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (isTextEntryTarget(event.target)) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === "escape") {
        event.preventDefault();
        cancelShortcut();
        return;
      }

      if (key === "enter" && atlasShortcutRef.current) {
        event.preventDefault();
        finishShortcut();
        return;
      }

      if (key === "g" || key === "s" || key === "r") {
        event.preventDefault();
        startShortcut(key === "g" ? "move" : key === "s" ? "scale" : "rotate");
      }
    }

    function applyAtlasShortcutMove(clientX: number, clientY: number) {
      const shortcut = atlasShortcutRef.current;
      if (!shortcut || !activeRegion) {
        return;
      }

      if (shortcut.mode === "move") {
        updateAtlasPositionFromClient(clientX, clientY);
        return;
      }

      if (shortcut.mode === "scale") {
        const delta = (clientX - shortcut.startX + shortcut.startY - clientY) * 0.004;
        updateActiveRegion((region) => ({
          ...region,
          atlasTransform: {
            ...region.atlasTransform,
            scale: clamp(shortcut.startTransform.scale + delta, 0.08, 2.4),
          },
        }));
        return;
      }

      const bounds = atlasSurfaceRef.current?.getBoundingClientRect();
      if (!bounds) {
        return;
      }

      const centerX = bounds.left + (shortcut.startTransform.x / 100) * bounds.width;
      const centerY = bounds.top + (shortcut.startTransform.y / 100) * bounds.height;
      const startAngle = Math.atan2(shortcut.startY - centerY, shortcut.startX - centerX);
      const currentAngle = Math.atan2(clientY - centerY, clientX - centerX);
      updateActiveRegion((region) => ({
        ...region,
        atlasTransform: {
          ...region.atlasTransform,
          rotation: Math.round(shortcut.startTransform.rotation + ((currentAngle - startAngle) * 180) / Math.PI),
        },
      }));
    }

    function scheduleAtlasShortcutMove(clientX: number, clientY: number) {
      pendingAtlasMoveRef.current = { clientX, clientY };

      if (atlasMoveFrameRef.current !== null) {
        return;
      }

      atlasMoveFrameRef.current = window.requestAnimationFrame(() => {
        atlasMoveFrameRef.current = null;
        const pendingMove = pendingAtlasMoveRef.current;
        pendingAtlasMoveRef.current = null;
        if (pendingMove) {
          applyAtlasShortcutMove(pendingMove.clientX, pendingMove.clientY);
        }
      });
    }

    function handlePointerMove(event: PointerEvent) {
      lastAtlasPointerRef.current = { x: event.clientX, y: event.clientY };
      if (atlasShortcutRef.current) {
        scheduleAtlasShortcutMove(event.clientX, event.clientY);
      }
    }

    function handlePointerDown(event: PointerEvent) {
      if (!atlasShortcutRef.current) {
        return;
      }

      const bounds = atlasSurfaceRef.current?.getBoundingClientRect();
      if (
        bounds &&
        event.clientX >= bounds.left &&
        event.clientX <= bounds.right &&
        event.clientY >= bounds.top &&
        event.clientY <= bounds.bottom
      ) {
        event.preventDefault();
        const pendingMove = pendingAtlasMoveRef.current;
        if (pendingMove) {
          pendingAtlasMoveRef.current = null;
          applyAtlasShortcutMove(pendingMove.clientX, pendingMove.clientY);
        }
        finishShortcut();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("pointermove", handlePointerMove, { capture: true });
    window.addEventListener("pointerdown", handlePointerDown, { capture: true });

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("pointermove", handlePointerMove, { capture: true });
      window.removeEventListener("pointerdown", handlePointerDown, { capture: true });
      if (atlasMoveFrameRef.current !== null) {
        window.cancelAnimationFrame(atlasMoveFrameRef.current);
        atlasMoveFrameRef.current = null;
      }
    };
  }, [activeRegion?.id]);

  async function handleConfirmPreparedProjection() {
    if (regions.length === 0 || !atlasCanvasRef.current || isConfirming) {
      return;
    }

    setIsConfirming(true);
    try {
      const blob = await canvasToBlob(atlasCanvasRef.current);
      const preparedUrl = URL.createObjectURL(blob);
      const name = activeRegion?.name.trim() || `Projection_${preparedProjections.length + 1}`;
      onPreparedProjectionAdd({
        id: crypto.randomUUID(),
        name,
        objectUrl: preparedUrl,
        thumbnailUrl: preparedUrl,
        width: ATLAS_CANVAS_SIZE,
        height: ATLAS_CANVAS_SIZE,
        createdAt: new Date().toISOString(),
        status: "prepared",
      });
    } finally {
      setIsConfirming(false);
    }
  }

  return (
    <section className="projection-ripper-workspace">
      <header className="projection-ripper-header">
        <div>
          <strong>Texture Projection / Image Ripper</strong>
          <span>Prepare images only. Nothing is applied to the model here.</span>
        </div>
        <button type="button" onClick={() => inputRef.current?.click()}>
          <ImagePlus aria-hidden="true" size={15} />
          Load Image
        </button>
        <button type="button" disabled={sourceImages.length === 0} onClick={addRipperRegion}>
          <Move aria-hidden="true" size={15} />
          Add Ripper
        </button>
        <input ref={inputRef} className="hidden-input" type="file" accept="image/*" multiple onChange={handleImageImport} />
      </header>

      <div className="projection-ripper-grid">
        <section className="projection-atlas-panel">
          <header>
            <Move aria-hidden="true" size={15} />
            <strong>Texture Atlas</strong>
            <span>1001 square</span>
          </header>
          <div
            ref={atlasSurfaceRef}
            className={`projection-atlas-surface${imageUrl ? " has-image" : ""}${atlasShortcutMode ? " is-shortcut-active" : ""}`}
            onPointerDown={handleAtlasPointerDown}
            onPointerMove={handleAtlasPointerMove}
          >
            <canvas ref={atlasCanvasRef} width={ATLAS_CANVAS_SIZE} height={ATLAS_CANVAS_SIZE} />
            <div className="projection-atlas-udim-frame" />
            {activeRegion ? <div className="projection-atlas-placement" style={atlasPlacementStyle} /> : null}
            {activeRegion ? atlasCornerHandles.map((corner) => (
              <button
                aria-label={`Atlas bevel corner ${corner.index + 1}`}
                className={`projection-atlas-bevel-point${selectedPointIndex === corner.index ? " is-active" : ""}`}
                key={corner.index}
                type="button"
                style={{ left: corner.left, top: corner.top }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setSelectedPointIndex(corner.index);
                }}
                onPointerDown={(event) => {
                  event.stopPropagation();
                }}
              >
                {Math.round(bevels[corner.index] ?? 0)}
              </button>
            )) : null}
            {atlasShortcutMode ? (
              <div className="projection-atlas-hint">
                {atlasShortcutMode === "move" ? "G Move" : atlasShortcutMode === "scale" ? "S Scale" : "R Rotate"}
                <span>Click confirm - Esc cancel</span>
              </div>
            ) : null}
          </div>
        </section>

        <section className="projection-stage-panel">
          <header>
            <Scissors aria-hidden="true" size={15} />
            <strong>Image Ripper</strong>
            <span>Select and deform region</span>
          </header>
          <div className="projection-stage" onDragOver={handleImageDragOver} onDrop={handleImageDrop}>
            {activeSource ? (
              <div ref={ripperFrameRef} className="projection-image-frame" style={{ aspectRatio: imageAspectRatio }}>
                <img
                  src={activeSource.objectUrl}
                  alt=""
                  draggable={false}
                  style={{
                    filter: `brightness(${brightness}%) contrast(${contrast}%)`,
                    opacity: opacity / 100,
                  }}
                />
                {activeRegion ? (
                  <>
                    <svg className="projection-polygon" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                      <polygon points={polygonPoints} />
                      <polyline points={`${polygonPoints} ${points[0].x},${points[0].y}`} />
                    </svg>
                    {points.map((point, index) => (
                      <div
                        aria-label={`Perspective point ${index + 1}`}
                        className={`projection-point${activePointIndex === index ? " is-active" : ""}`}
                        key={index}
                        role="slider"
                        style={{ left: `${point.x}%`, top: `${point.y}%` }}
                        tabIndex={0}
                        onPointerDown={(event) => handlePointPointerDown(index, event)}
                        onPointerUp={(event) => {
                          finishPointDrag(event.clientX, event.clientY, event.shiftKey);
                        }}
                        onPointerCancel={(event) => {
                          finishPointDrag(event.clientX, event.clientY, event.shiftKey);
                        }}
                      />
                    ))}
                    {loupeStyle ? (
                      <div className="projection-point-loupe" style={loupeStyle}>
                        <svg
                          className="projection-point-loupe-overlay"
                          viewBox={`0 0 ${POINT_LOUPE_SIZE} ${POINT_LOUPE_SIZE}`}
                          aria-hidden="true"
                        >
                          <polygon points={loupePolygonPoints} />
                          <polyline points={`${loupePolygonPoints} ${loupePoints[0]?.x ?? 0},${loupePoints[0]?.y ?? 0}`} />
                          {loupePoints.map((point, index) => (
                            <circle
                              key={index}
                              className={activePointIndex === index ? "is-active" : ""}
                              cx={point.x}
                              cy={point.y}
                              r={activePointIndex === index ? 8 : 5}
                            />
                          ))}
                        </svg>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div className="projection-add-ripper-hint">Add Ripper to select a region.</div>
                )}
              </div>
            ) : (
              <div className="projection-empty-state">
                <ImagePlus aria-hidden="true" size={34} />
                <span>Import an image to prepare a projection.</span>
              </div>
            )}
          </div>
        </section>

        <aside className="projection-settings-panel">
          <section>
            <header>
              <Move aria-hidden="true" size={14} />
              <strong>Prepared Image</strong>
            </header>
            <label>
              <span>Name</span>
              <input
                value={activeRegion?.name ?? ""}
                disabled={!activeRegion}
                onChange={(event) => updateActiveRegion((region) => ({ ...region, name: event.target.value }))}
              />
            </label>
            <output>{formatResolution(imageSize.width, imageSize.height)}</output>
          </section>

          <section className="ripper-source-list">
            <header>
              <ImagePlus aria-hidden="true" size={14} />
              <strong>Loaded Images</strong>
            </header>
            {sourceImages.length === 0 ? (
              <div className="prepared-projection-empty">No source images loaded.</div>
            ) : (
              sourceImages.map((sourceImage) => {
                const imageRegion = regions.find((region) => region.imageId === sourceImage.id);
                return (
                  <button
                    className={activeSource?.id === sourceImage.id ? "is-active" : ""}
                    key={sourceImage.id}
                    type="button"
                    onClick={() => {
                      setActiveSourceImageId(sourceImage.id);
                      if (imageRegion) {
                        setActiveRegionId(imageRegion.id);
                      } else {
                        setActiveRegionId("");
                      }
                    }}
                  >
                    <img src={sourceImage.objectUrl} alt="" />
                    <span>{sourceImage.name}</span>
                  </button>
                );
              })
            )}
          </section>

          <section className="ripper-region-list">
            <header>
              <Scissors aria-hidden="true" size={14} />
              <strong>Rippers</strong>
            </header>
            {regions.length === 0 ? (
              <div className="prepared-projection-empty">No rippers yet.</div>
            ) : (
              regions.map((region, index) => (
                <button
                  className={activeRegion?.id === region.id ? "is-active" : ""}
                  key={region.id}
                  type="button"
                  onClick={() => {
                    setActiveRegionId(region.id);
                    setActiveSourceImageId(region.imageId);
                  }}
                >
                  <span>{index + 1}</span>
                  <strong>{region.name}</strong>
                </button>
              ))
            )}
            <div className="ripper-region-actions">
              <button type="button" disabled={sourceImages.length === 0} onClick={addRipperRegion}>Add Ripper</button>
              <button type="button" disabled={!activeRegion} onClick={deleteActiveRipperRegion}>Delete</button>
            </div>
          </section>

          <section>
            <header>
              <Move aria-hidden="true" size={14} />
              <strong>Atlas Placement</strong>
            </header>
            <label>
              <span>Scale</span>
              <input
                max="1.4"
                min="0.12"
                step="0.01"
                type="range"
                value={atlasTransform.scale}
                onChange={(event) =>
                  updateActiveRegion((region) => ({
                    ...region,
                    atlasTransform: { ...region.atlasTransform, scale: Number(event.target.value) },
                  }))
                }
              />
              <output>{Math.round(atlasTransform.scale * 100)}%</output>
            </label>
            <label>
              <span>Rotation</span>
              <input
                max="180"
                min="-180"
                step="1"
                type="range"
                value={atlasTransform.rotation}
                onChange={(event) =>
                  updateActiveRegion((region) => ({
                    ...region,
                    atlasTransform: { ...region.atlasTransform, rotation: Number(event.target.value) },
                  }))
                }
              />
              <output>{atlasTransform.rotation} deg</output>
            </label>
            <label>
              <span>Corner Bevel {selectedPointIndex + 1}</span>
              <input
                max="45"
                min="0"
                step="1"
                type="range"
                value={selectedPointBevel}
                disabled={!activeRegion}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  updateActiveRegion((region) => ({
                    ...region,
                    bevels: cloneDefaultBevels().map((defaultValue, index) => (
                      index === selectedPointIndex ? value : region.bevels?.[index] ?? defaultValue
                    )),
                  }));
                }}
              />
              <output>{Math.round(selectedPointBevel)}%</output>
            </label>
            <label>
              <span>Bevel Type</span>
              <select
                value={activeRegion?.bevelMode ?? "straight"}
                disabled={!activeRegion}
                onChange={(event) =>
                  updateActiveRegion((region) => ({
                    ...region,
                    bevelMode: event.target.value === "round" ? "round" : "straight",
                  }))
                }
              >
                <option value="straight">Straight cut</option>
                <option value="round">Round curve</option>
              </select>
            </label>
            <button
              type="button"
              disabled={!activeRegion}
              onClick={() =>
                updateActiveRegion((region) => ({
                  ...region,
                  atlasTransform: DEFAULT_ATLAS_TRANSFORM,
                }))
              }
            >
              <RotateCcw aria-hidden="true" size={14} />
              Reset Atlas
            </button>
            <button
              type="button"
              disabled={!activeRegion}
              onClick={() => updateActiveRegion((region) => ({ ...region, bevels: cloneDefaultBevels() }))}
            >
              <RotateCcw aria-hidden="true" size={14} />
              Reset Bevel
            </button>
          </section>

          <section>
            <header>
              <SlidersHorizontal aria-hidden="true" size={14} />
              <strong>Adjust</strong>
            </header>
            <label>
              <span>Brightness</span>
              <input
                max="160"
                min="40"
                type="range"
                value={brightness}
                onChange={(event) => updateActiveRegion((region) => ({ ...region, brightness: Number(event.target.value) }))}
              />
              <output>{brightness}%</output>
            </label>
            <label>
              <span>Contrast</span>
              <input
                max="180"
                min="40"
                type="range"
                value={contrast}
                onChange={(event) => updateActiveRegion((region) => ({ ...region, contrast: Number(event.target.value) }))}
              />
              <output>{contrast}%</output>
            </label>
            <label>
              <span>Opacity</span>
              <input
                max="100"
                min="0"
                type="range"
                value={opacity}
                onChange={(event) => updateActiveRegion((region) => ({ ...region, opacity: Number(event.target.value) }))}
              />
              <output>{opacity}%</output>
            </label>
            <button
              type="button"
              disabled={!activeRegion}
              onClick={() => updateActiveRegion((region) => ({ ...region, points: cloneDefaultPoints() }))}
            >
              <RotateCcw aria-hidden="true" size={14} />
              Reset Points
            </button>
          </section>

          <button className="projection-confirm-button" type="button" disabled={regions.length === 0 || isConfirming} onClick={handleConfirmPreparedProjection}>
            <Check aria-hidden="true" size={15} />
            {isConfirming ? "Preparing..." : "Confirm Prepared Image"}
          </button>

          <section className="prepared-projection-list">
            <header>
              <ImagePlus aria-hidden="true" size={14} />
              <strong>Prepared Projections</strong>
            </header>
            {preparedProjections.length === 0 ? (
              <div className="prepared-projection-empty">No prepared images yet.</div>
            ) : (
              preparedProjections.map((projection) => (
                <article key={projection.id}>
                  <img src={projection.thumbnailUrl} alt="" />
                  <div>
                    <strong>{projection.name}</strong>
                    <span>{formatResolution(projection.width, projection.height)}</span>
                    <small>{formatPreparedDate(projection.createdAt)} - {projection.status}</small>
                  </div>
                </article>
              ))
            )}
          </section>
        </aside>
      </div>
    </section>
  );
}
