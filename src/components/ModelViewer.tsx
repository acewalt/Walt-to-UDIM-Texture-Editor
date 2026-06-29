import {
  ChangeEvent,
  Component,
  type CSSProperties,
  type ElementRef,
  type RefObject,
  type ReactNode,
  Suspense,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Canvas, type ThreeEvent, useLoader } from "@react-three/fiber";
import { Bounds, Center, Environment, GizmoHelper, GizmoViewport, OrbitControls } from "@react-three/drei";
import {
  Box,
  ChevronDown,
  Circle,
  CircleDashed,
  FlipVertical,
  Grid3X3,
  ImagePlus,
  Lasso,
  MousePointer2,
  Paintbrush,
  Palette,
  RotateCcw,
  Settings2,
  SlidersHorizontal,
  SquareDashedMousePointer,
  SunMedium,
  Waves,
} from "lucide-react";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { OBJExporter } from "three/examples/jsm/exporters/OBJExporter.js";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { ModelOutlinerNode, PaintExportLayer, TextureAsset, TextureChannel, UvEditCommand, UvSegment } from "../types/texture";
import { canPreviewInBrowser, getTileForChannel } from "../utils/textureLoader";

interface ModelViewerProps {
  textures: TextureAsset[];
  fbxInputRef?: RefObject<HTMLInputElement | null>;
  hiddenModelNodeIds?: Set<string>;
  onModelNodesChange?: (nodes: ModelOutlinerNode[]) => void;
  onModelLoaded?: (loaded: boolean) => void;
  onModelUvLayout?: (segments: UvSegment[]) => void;
  onViewportModeChange?: (mode: ViewportMode) => void;
  editSelectionMode?: EditSelectionMode;
  onEditSelectionModeChange?: (mode: EditSelectionMode) => void;
  onSelectedUvSegmentsChange?: (segments: UvSegment[]) => void;
  onSelectedFaceCountChange?: (count: number) => void;
  uvEditCommand?: UvEditCommand | null;
  onPaintLayerChange?: (paintLayer: PaintExportLayer | null) => void;
  modelExportRequest?: number;
}

interface MaterialMaps {
  colorMap: THREE.Texture | null;
  atlasMap: THREE.Texture | null;
  paintMap: THREE.Texture | null;
  atlasColumns: number;
  atlasRows: number;
  atlasTileCount: number;
  normalMap: THREE.Texture | null;
  roughnessMap: THREE.Texture | null;
  metalnessMap: THREE.Texture | null;
  aoMap: THREE.Texture | null;
}

type ModelFileType = "fbx" | "obj";
type PreviewMode = "lit" | "flat" | "clay" | "normals" | "coverage";
type ViewportMode = "object" | "edit" | "texture-paint";
type EditTool = "tweak" | "select-box" | "select-circle" | "select-lasso";
type EditSelectionMode = "vertices" | "edges" | "faces" | "island";
type BrushAdjustMode = "size" | "strength" | null;

interface SelectedFaceMarker {
  key: string;
  faceIndex: number;
  meshUuid: string;
  points: Array<[number, number, number]>;
  selectionMode: EditSelectionMode;
}

interface UvEditTarget {
  meshUuid: string;
  triangleIndices: number[];
  vertexIndices?: number[];
}

interface UvHistorySnapshot {
  meshUuid: string;
  uvValues: Float32Array;
}

interface UvHistoryEntry {
  groupId?: number;
  snapshots: UvHistorySnapshot[];
}

interface EditSelectionItem {
  key: string;
  markers: SelectedFaceMarker[];
  editTarget: UvEditTarget;
  uvSegments: UvSegment[];
}

const MAX_UDIM_PREVIEW_TILES = 20;
const MAX_UV_PREVIEW_SEGMENTS = 120000;
const UV_HISTORY_LIMIT = 30;
const UDIM_ATLAS_COLUMNS = 10;
const UDIM_ATLAS_TILE_SIZE = 512;
const PAINT_HISTORY_LIMIT = 14;
const PAINT_UV_BLEED_PX = 6;
const COLOR_PREVIEW_CHANNELS: TextureChannel[] = ["BaseColor", "Custom"];
const EMPTY_HIDDEN_MODEL_NODE_IDS = new Set<string>();
const BRUSH_PRESETS = [
  "Paint Hard",
  "Paint Soft",
  "Erase",
  "Pixel Art",
  "Smear",
  "Fill",
  "Mask",
  "Clone",
  "Sticker",
] as const;

interface PaintLayer {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  exportLayer: PaintExportLayer;
  rows: number;
}

interface PaintHistoryFrame {
  imageData: ImageData;
  hasPaint: boolean;
}

interface HsvColor {
  h: number;
  s: number;
  v: number;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "No se pudo cargar el modelo.";
}

function getViewportModeLabel(mode: ViewportMode): string {
  if (mode === "texture-paint") {
    return "Texture Paint";
  }

  return mode === "edit" ? "Edit Mode" : "Object Mode";
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function hexToRgb(hex: string) {
  const normalized = hex.replace("#", "");
  const value = Number.parseInt(normalized.length === 3 ? normalized.split("").map((char) => char + char).join("") : normalized, 16);
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0")).join("")}`;
}

function hexToHsv(hex: string): HsvColor {
  const { r, g, b } = hexToRgb(hex);
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  let hue = 0;

  if (delta !== 0) {
    if (max === red) {
      hue = 60 * (((green - blue) / delta) % 6);
    } else if (max === green) {
      hue = 60 * ((blue - red) / delta + 2);
    } else {
      hue = 60 * ((red - green) / delta + 4);
    }
  }

  return {
    h: (hue + 360) % 360,
    s: max === 0 ? 0 : delta / max,
    v: max,
  };
}

function hsvToHex({ h, s, v }: HsvColor): string {
  const chroma = v * s;
  const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - chroma;
  let red = 0;
  let green = 0;
  let blue = 0;

  if (h < 60) {
    red = chroma;
    green = x;
  } else if (h < 120) {
    red = x;
    green = chroma;
  } else if (h < 180) {
    green = chroma;
    blue = x;
  } else if (h < 240) {
    green = x;
    blue = chroma;
  } else if (h < 300) {
    red = x;
    blue = chroma;
  } else {
    red = chroma;
    blue = x;
  }

  return rgbToHex((red + m) * 255, (green + m) * 255, (blue + m) * 255);
}

function getReadableHsl(hue: number) {
  return `hsl(${Math.round(hue)} 100% 50%)`;
}

function HsvTrianglePicker({
  color,
  compact = false,
  label,
  onChange,
}: {
  color: string;
  compact?: boolean;
  label: string;
  onChange: (color: string) => void;
}) {
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const hsv = useMemo(() => hexToHsv(color), [color]);
  const hueWeight = hsv.v * hsv.s;
  const whiteWeight = hsv.v * (1 - hsv.s);
  const blackWeight = 1 - hsv.v;
  const handlePosition = {
    x: hueWeight * 50 + whiteWeight * 26 + blackWeight * 74,
    y: hueWeight * 24 + whiteWeight * 76 + blackWeight * 76,
  };
  const hueHandleAngle = THREE.MathUtils.degToRad(hsv.h - 90);
  const hueHandleRadius = compact ? 39 : 42;
  const hueHandlePosition = {
    x: 50 + Math.cos(hueHandleAngle) * hueHandleRadius,
    y: 50 + Math.sin(hueHandleAngle) * hueHandleRadius,
  };

  function pickColor(clientX: number, clientY: number) {
    const bounds = pickerRef.current?.getBoundingClientRect();
    if (!bounds) {
      return;
    }

    const x = clientX - bounds.left;
    const y = clientY - bounds.top;
    const centerX = bounds.width / 2;
    const centerY = bounds.height / 2;
    const deltaX = x - centerX;
    const deltaY = y - centerY;
    const distance = Math.hypot(deltaX, deltaY);
    const outerRadius = bounds.width * 0.47;
    const innerRadius = bounds.width * 0.34;

    if (distance > innerRadius && distance <= outerRadius + 8) {
      const hue = ((Math.atan2(deltaY, deltaX) * 180) / Math.PI + 90 + 360) % 360;
      onChange(hsvToHex({ ...hsv, h: hue }));
      return;
    }

    const topX = bounds.width * 0.5;
    const topY = bounds.height * 0.24;
    const whiteX = bounds.width * 0.26;
    const whiteY = bounds.height * 0.76;
    const blackX = bounds.width * 0.74;
    const blackY = bounds.height * 0.76;
    const barycentric = getBarycentric2D(x, y, topX, topY, whiteX, whiteY, blackX, blackY);
    if (!barycentric) {
      return;
    }

    const nextValue = clamp(barycentric.x + barycentric.y, 0, 1);
    const nextSaturation = nextValue <= 0.0001 ? 0 : clamp(barycentric.x / nextValue, 0, 1);
    onChange(hsvToHex({ h: hsv.h, s: nextSaturation, v: nextValue }));
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    pickColor(event.clientX, event.clientY);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
      return;
    }

    pickColor(event.clientX, event.clientY);
  }

  return (
    <div
      ref={pickerRef}
      className={`hsv-triangle-picker${compact ? " is-compact" : ""}`}
      role="slider"
      aria-label={label}
      aria-valuetext={color}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
    >
      <div className="hsv-hue-ring" />
      <div className="hsv-triangle" style={{ "--picker-hue": getReadableHsl(hsv.h) } as CSSProperties} />
      <span
        className="hsv-hue-handle"
        style={{
          left: `${hueHandlePosition.x}%`,
          top: `${hueHandlePosition.y}%`,
        }}
      />
      <span
        className="hsv-sv-handle"
        style={{
          left: `${handlePosition.x}%`,
          top: `${handlePosition.y}%`,
        }}
      />
    </div>
  );
}

function getUvFromAttribute(
  uvAttribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  index: number,
): THREE.Vector2 {
  return new THREE.Vector2(uvAttribute.getX(index), uvAttribute.getY(index));
}

function getBarycentricPaintUv(intersection: THREE.Intersection<THREE.Object3D>): THREE.Vector2 | null {
  if (intersection.uv) {
    return intersection.uv.clone();
  }

  if (!(intersection.object instanceof THREE.Mesh) || !intersection.face) {
    return null;
  }

  const geometry = intersection.object.geometry;
  const positionAttribute = geometry.attributes.position as THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined;
  const uvAttribute = geometry.attributes.uv as THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined;
  if (!positionAttribute || !uvAttribute) {
    return null;
  }

  const { a, b, c } = intersection.face;
  const vertexA = new THREE.Vector3().fromBufferAttribute(positionAttribute, a);
  const vertexB = new THREE.Vector3().fromBufferAttribute(positionAttribute, b);
  const vertexC = new THREE.Vector3().fromBufferAttribute(positionAttribute, c);
  const localHitPoint = intersection.object.worldToLocal(intersection.point.clone());
  const barycentric = new THREE.Vector3();
  THREE.Triangle.getBarycoord(localHitPoint, vertexA, vertexB, vertexC, barycentric);

  if (![barycentric.x, barycentric.y, barycentric.z].every(Number.isFinite)) {
    return null;
  }

  const uvA = getUvFromAttribute(uvAttribute, a);
  const uvB = getUvFromAttribute(uvAttribute, b);
  const uvC = getUvFromAttribute(uvAttribute, c);
  return new THREE.Vector2()
    .addScaledVector(uvA, barycentric.x)
    .addScaledVector(uvB, barycentric.y)
    .addScaledVector(uvC, barycentric.z);
}

function getPaintUvFromEvent(event: ThreeEvent<PointerEvent>): THREE.Vector2 | null {
  const intersections = event.intersections?.length
    ? event.intersections
    : [event as unknown as THREE.Intersection<THREE.Object3D>];

  for (const intersection of intersections) {
    const uv = getBarycentricPaintUv(intersection);
    if (uv) {
      return uv;
    }
  }

  return null;
}

interface PaintUvHit {
  clientX: number;
  clientY: number;
  faceIndex: number | null;
  mesh: THREE.Mesh;
  point: THREE.Vector3;
  uv: THREE.Vector2;
}

interface PaintAtlasPoint {
  tileIndex: number;
  x: number;
  y: number;
}

interface PaintUvIslandCache {
  islandIdsByTriangle: number[];
  pathsByFlipY: Map<boolean, Path2D[]>;
  triangleIndicesByIsland: number[][];
  triangleUvs: Array<[THREE.Vector2, THREE.Vector2, THREE.Vector2]>;
  triangleVertexIndices: Array<[number, number, number]>;
}

const paintUvIslandCache = new WeakMap<THREE.BufferGeometry, PaintUvIslandCache>();

function getPaintUvHitFromIntersection(
  intersection: THREE.Intersection<THREE.Object3D>,
  clientX: number,
  clientY: number,
): PaintUvHit | null {
  if (!(intersection.object instanceof THREE.Mesh)) {
    return null;
  }

  const uv = getBarycentricPaintUv(intersection);
  if (!uv) {
    return null;
  }

  return {
    clientX,
    clientY,
    faceIndex: Number.isFinite(intersection.faceIndex) ? intersection.faceIndex ?? null : null,
    mesh: intersection.object,
    point: intersection.point.clone(),
    uv,
  };
}

function getPaintUvHitFromEvent(event: ThreeEvent<PointerEvent>): PaintUvHit | null {
  const intersections = event.intersections?.length
    ? event.intersections
    : [event as unknown as THREE.Intersection<THREE.Object3D>];

  for (const intersection of intersections) {
    const hit = getPaintUvHitFromIntersection(intersection, event.nativeEvent.clientX, event.nativeEvent.clientY);
    if (hit) {
      return hit;
    }
  }

  return null;
}

function getPaintUvHitAtClientPoint(
  event: ThreeEvent<PointerEvent>,
  raycaster: THREE.Raycaster,
  canvasBounds: DOMRect,
  clientX: number,
  clientY: number,
): PaintUvHit | null {
  const pointer = new THREE.Vector2(
    ((clientX - canvasBounds.left) / canvasBounds.width) * 2 - 1,
    -(((clientY - canvasBounds.top) / canvasBounds.height) * 2 - 1),
  );
  raycaster.setFromCamera(pointer, event.camera);

  const intersections = raycaster.intersectObject(event.eventObject, true);
  for (const intersection of intersections) {
    const hit = getPaintUvHitFromIntersection(intersection, clientX, clientY);
    if (hit) {
      return hit;
    }
  }

  return null;
}

function getPaintAtlasPoint(uv: THREE.Vector2, tileCount: number, flipY: boolean): PaintAtlasPoint | null {
  if (![uv.x, uv.y].every(Number.isFinite)) {
    return null;
  }

  const tileU = Math.floor(uv.x);
  const tileV = Math.floor(uv.y);
  if (tileU < 0 || tileV < 0) {
    return null;
  }

  const tileIndex = tileU + tileV * UDIM_ATLAS_COLUMNS;
  if (tileIndex < 0 || tileIndex >= tileCount) {
    return null;
  }

  const localU = clamp(uv.x - tileU, 0, 1);
  const localV = clamp(uv.y - tileV, 0, 1);
  const tileColumn = tileIndex % UDIM_ATLAS_COLUMNS;
  const tileRow = Math.floor(tileIndex / UDIM_ATLAS_COLUMNS);

  return {
    tileIndex,
    x: (tileColumn + localU) * UDIM_ATLAS_TILE_SIZE,
    y: (tileRow + (flipY ? 1 - localV : localV)) * UDIM_ATLAS_TILE_SIZE,
  };
}

function getTriangleVertexIndices(geometry: THREE.BufferGeometry, triangleIndex: number): [number, number, number] {
  const baseIndex = triangleIndex * 3;
  if (geometry.index) {
    return [
      geometry.index.getX(baseIndex),
      geometry.index.getX(baseIndex + 1),
      geometry.index.getX(baseIndex + 2),
    ];
  }

  return [baseIndex, baseIndex + 1, baseIndex + 2];
}

function getPaintAtlasPointUnchecked(uv: THREE.Vector2, flipY: boolean): { x: number; y: number } | null {
  if (![uv.x, uv.y].every(Number.isFinite) || uv.x < 0 || uv.y < 0) {
    return null;
  }

  const tileU = Math.floor(uv.x);
  const tileV = Math.floor(uv.y);
  const tileIndex = tileU + tileV * UDIM_ATLAS_COLUMNS;
  const tileColumn = tileIndex % UDIM_ATLAS_COLUMNS;
  const tileRow = Math.floor(tileIndex / UDIM_ATLAS_COLUMNS);
  const localU = clamp(uv.x - tileU, 0, 1);
  const localV = clamp(uv.y - tileV, 0, 1);

  return {
    x: (tileColumn + localU) * UDIM_ATLAS_TILE_SIZE,
    y: (tileRow + (flipY ? 1 - localV : localV)) * UDIM_ATLAS_TILE_SIZE,
  };
}

function getUvEdgeKey(start: THREE.Vector2, end: THREE.Vector2): string {
  const a = `${Math.round(start.x * 100000)},${Math.round(start.y * 100000)}`;
  const b = `${Math.round(end.x * 100000)},${Math.round(end.y * 100000)}`;
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function buildPaintUvIslandCache(geometry: THREE.BufferGeometry): PaintUvIslandCache {
  const uvAttribute = geometry.getAttribute("uv") as THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined;
  const positionAttribute = geometry.getAttribute("position") as THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined;
  const triangleCount = Math.floor((geometry.index?.count ?? positionAttribute?.count ?? 0) / 3);
  const edgeTriangles = new Map<string, number[]>();
  const triangleUvs: Array<[THREE.Vector2, THREE.Vector2, THREE.Vector2]> = [];
  const triangleVertexIndices: Array<[number, number, number]> = [];

  if (!uvAttribute || triangleCount <= 0) {
    return {
      islandIdsByTriangle: [],
      pathsByFlipY: new Map(),
      triangleIndicesByIsland: [],
      triangleUvs: [],
      triangleVertexIndices: [],
    };
  }

  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
    const [indexA, indexB, indexC] = getTriangleVertexIndices(geometry, triangleIndex);
    triangleVertexIndices.push([indexA, indexB, indexC]);
    const uvA = getUvFromAttribute(uvAttribute, indexA);
    const uvB = getUvFromAttribute(uvAttribute, indexB);
    const uvC = getUvFromAttribute(uvAttribute, indexC);
    triangleUvs.push([uvA, uvB, uvC]);

    [
      getUvEdgeKey(uvA, uvB),
      getUvEdgeKey(uvB, uvC),
      getUvEdgeKey(uvC, uvA),
    ].forEach((edgeKey) => {
      const triangles = edgeTriangles.get(edgeKey) ?? [];
      triangles.push(triangleIndex);
      edgeTriangles.set(edgeKey, triangles);
    });
  }

  const neighbors = Array.from({ length: triangleCount }, () => new Set<number>());
  edgeTriangles.forEach((triangles) => {
    for (let outer = 0; outer < triangles.length; outer += 1) {
      for (let inner = outer + 1; inner < triangles.length; inner += 1) {
        neighbors[triangles[outer]].add(triangles[inner]);
        neighbors[triangles[inner]].add(triangles[outer]);
      }
    }
  });

  const islandIdsByTriangle = Array<number>(triangleCount).fill(-1);
  let islandCount = 0;
  for (let startTriangle = 0; startTriangle < triangleCount; startTriangle += 1) {
    if (islandIdsByTriangle[startTriangle] !== -1) {
      continue;
    }

    const stack = [startTriangle];
    islandIdsByTriangle[startTriangle] = islandCount;
    while (stack.length > 0) {
      const triangleIndex = stack.pop()!;
      neighbors[triangleIndex].forEach((neighborIndex) => {
        if (islandIdsByTriangle[neighborIndex] !== -1) {
          return;
        }
        islandIdsByTriangle[neighborIndex] = islandCount;
        stack.push(neighborIndex);
      });
    }
    islandCount += 1;
  }

  const triangleIndicesByIsland = Array.from({ length: islandCount }, () => [] as number[]);
  islandIdsByTriangle.forEach((islandId, triangleIndex) => {
    if (islandId >= 0) {
      triangleIndicesByIsland[islandId].push(triangleIndex);
    }
  });

  function buildPaths(flipY: boolean) {
    const paths = Array.from({ length: islandCount }, () => new Path2D());
    triangleUvs.forEach(([uvA, uvB, uvC], triangleIndex) => {
      const islandId = islandIdsByTriangle[triangleIndex];
      const pointA = getPaintAtlasPointUnchecked(uvA, flipY);
      const pointB = getPaintAtlasPointUnchecked(uvB, flipY);
      const pointC = getPaintAtlasPointUnchecked(uvC, flipY);
      if (islandId < 0 || !pointA || !pointB || !pointC) {
        return;
      }

      const path = paths[islandId];
      path.moveTo(pointA.x, pointA.y);
      path.lineTo(pointB.x, pointB.y);
      path.lineTo(pointC.x, pointC.y);
      path.closePath();
    });
    return paths;
  }

  return {
    islandIdsByTriangle,
    pathsByFlipY: new Map<boolean, Path2D[]>([
      [false, buildPaths(false)],
      [true, buildPaths(true)],
    ]),
    triangleIndicesByIsland,
    triangleUvs,
    triangleVertexIndices,
  };
}

function getPaintIslandClipPath(hit: PaintUvHit, flipY: boolean): Path2D | null {
  if (hit.faceIndex === null || hit.faceIndex < 0) {
    return null;
  }

  let cache = paintUvIslandCache.get(hit.mesh.geometry);
  if (!cache) {
    cache = buildPaintUvIslandCache(hit.mesh.geometry);
    paintUvIslandCache.set(hit.mesh.geometry, cache);
  }

  const islandId = cache.islandIdsByTriangle[hit.faceIndex];
  if (islandId === undefined || islandId < 0) {
    return null;
  }

  return cache.pathsByFlipY.get(flipY)?.[islandId] ?? null;
}

function getPaintIslandCache(geometry: THREE.BufferGeometry): PaintUvIslandCache {
  let cache = paintUvIslandCache.get(geometry);
  if (!cache) {
    cache = buildPaintUvIslandCache(geometry);
    paintUvIslandCache.set(geometry, cache);
  }
  return cache;
}

function getMeshVertexWorldPosition(mesh: THREE.Mesh, index: number, target: THREE.Vector3): THREE.Vector3 {
  const meshWithVertexPosition = mesh as THREE.Mesh & {
    getVertexPosition?: (vertexIndex: number, target: THREE.Vector3) => THREE.Vector3;
  };

  if (typeof meshWithVertexPosition.getVertexPosition === "function") {
    meshWithVertexPosition.getVertexPosition(index, target);
  } else {
    const positionAttribute = mesh.geometry.getAttribute("position") as THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined;
    if (positionAttribute) {
      target.fromBufferAttribute(positionAttribute, index);
    } else {
      target.set(0, 0, 0);
    }
  }

  return mesh.localToWorld(target);
}

function projectWorldToClient(
  point: THREE.Vector3,
  camera: THREE.Camera,
  bounds: DOMRect,
): { x: number; y: number; z: number } {
  const projected = point.clone().project(camera);
  return {
    x: bounds.left + (projected.x * 0.5 + 0.5) * bounds.width,
    y: bounds.top + (-projected.y * 0.5 + 0.5) * bounds.height,
    z: projected.z,
  };
}

function screenTriangleIntersectsBrush(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
  centerX: number,
  centerY: number,
  radius: number,
): boolean {
  const minX = Math.min(a.x, b.x, c.x);
  const maxX = Math.max(a.x, b.x, c.x);
  const minY = Math.min(a.y, b.y, c.y);
  const maxY = Math.max(a.y, b.y, c.y);
  const closestX = clamp(centerX, minX, maxX);
  const closestY = clamp(centerY, minY, maxY);
  return Math.hypot(closestX - centerX, closestY - centerY) <= radius;
}

function getBarycentric2D(
  pointX: number,
  pointY: number,
  aX: number,
  aY: number,
  bX: number,
  bY: number,
  cX: number,
  cY: number,
  epsilon = -0.01,
): THREE.Vector3 | null {
  const denominator = (bY - cY) * (aX - cX) + (cX - bX) * (aY - cY);
  if (Math.abs(denominator) < 0.000001) {
    return null;
  }

  const weightA = ((bY - cY) * (pointX - cX) + (cX - bX) * (pointY - cY)) / denominator;
  const weightB = ((cY - aY) * (pointX - cX) + (aX - cX) * (pointY - cY)) / denominator;
  const weightC = 1 - weightA - weightB;
  if (weightA < epsilon || weightB < epsilon || weightC < epsilon) {
    return null;
  }

  return new THREE.Vector3(weightA, weightB, weightC);
}

const PREVIEW_VERTEX_SHADER = /* glsl */ `
varying vec3 vPreviewNormal;

#ifdef USE_UV_COORDS
  varying vec2 vPreviewUv;
#endif

#include <common>
#include <batching_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>

void main() {
  #ifdef USE_UV_COORDS
    vPreviewUv = uv;
  #endif

  #include <batching_vertex>
  #include <beginnormal_vertex>
  #include <morphinstance_vertex>
  #include <morphnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <defaultnormal_vertex>

  vPreviewNormal = normalize(transformedNormal);

  #include <begin_vertex>
  #include <morphtarget_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
}
`;

const PREVIEW_FRAGMENT_SHADER = /* glsl */ `
uniform vec3 baseColor;
uniform float previewMode;
uniform float previewAlpha;

#ifdef USE_UV_COORDS
  varying vec2 vPreviewUv;

  float getUdimTileIndex(vec2 uv) {
    if (uv.x < 0.0 || uv.y < 0.0) {
      return 0.0;
    }

    return floor(uv.x) + floor(uv.y) * 10.0;
  }
#endif

#ifdef USE_COVERAGE
  vec3 getCoverageColor(float tileIndex) {
    float index = mod(tileIndex, 10.0);
    if (index < 0.5) return vec3(0.98, 0.12, 0.10);
    if (index < 1.5) return vec3(0.10, 0.78, 0.22);
    if (index < 2.5) return vec3(0.14, 0.35, 1.00);
    if (index < 3.5) return vec3(1.00, 0.82, 0.10);
    if (index < 4.5) return vec3(0.95, 0.18, 0.92);
    if (index < 5.5) return vec3(0.05, 0.86, 0.88);
    if (index < 6.5) return vec3(1.00, 0.48, 0.10);
    if (index < 7.5) return vec3(0.58, 0.28, 1.00);
    if (index < 8.5) return vec3(0.62, 0.90, 0.18);
    return vec3(1.00, 0.34, 0.45);
  }
#endif

#if defined(USE_TEXTURE_MAP) || defined(USE_PAINT_MAP)
  uniform float atlasColumns;
  uniform float atlasRows;
  uniform float atlasTileCount;
#endif

#ifdef USE_TEXTURE_MAP
  uniform sampler2D previewAtlas;

  vec3 sampleUdimColor(vec2 uv) {
    float tileIndex = getUdimTileIndex(uv);
    vec2 localUv = fract(uv);

    if (uv.x < 0.0 || uv.y < 0.0) {
      tileIndex = 0.0;
      localUv = fract(abs(uv));
    }

    if (tileIndex < 0.0 || tileIndex >= atlasTileCount) {
      tileIndex = 0.0;
    }

    float tileColumn = mod(tileIndex, atlasColumns);
    float tileRow = floor(tileIndex / atlasColumns);
    vec2 atlasUv = vec2((tileColumn + localUv.x) / atlasColumns, (tileRow + localUv.y) / atlasRows);
    return texture2D(previewAtlas, atlasUv).rgb;
  }
#endif

#ifdef USE_PAINT_MAP
  uniform sampler2D paintAtlas;

  vec4 sampleUdimPaint(vec2 uv) {
    float tileIndex = getUdimTileIndex(uv);
    vec2 localUv = fract(uv);

    if (tileIndex < 0.0 || tileIndex >= atlasTileCount) {
      return vec4(0.0);
    }

    float tileColumn = mod(tileIndex, atlasColumns);
    float tileRow = floor(tileIndex / atlasColumns);
    vec2 atlasUv = vec2((tileColumn + localUv.x) / atlasColumns, (tileRow + localUv.y) / atlasRows);
    return texture2D(paintAtlas, atlasUv);
  }
#endif

varying vec3 vPreviewNormal;

void main() {
  vec3 normalDirection = normalize(vPreviewNormal);
  vec3 color = baseColor;

  if (previewMode > 2.5) {
    #ifdef USE_COVERAGE
      color = getCoverageColor(getUdimTileIndex(vPreviewUv));
    #endif
    gl_FragColor = vec4(color, previewAlpha);
    return;
  }

  #ifdef USE_TEXTURE_MAP
    color *= sampleUdimColor(vPreviewUv);
  #endif

  #ifdef USE_PAINT_MAP
    vec4 paintColor = sampleUdimPaint(vPreviewUv);
    color = mix(color, paintColor.rgb, paintColor.a);
  #endif

  if (previewMode < 0.5) {
    float hemi = normalDirection.y * 0.5 + 0.5;
    float key = max(dot(normalDirection, normalize(vec3(-0.45, 0.62, 0.64))), 0.0);
    color *= 0.42 + hemi * 0.28 + key * 0.48;
  } else if (previewMode > 1.5) {
    float clayKey = max(dot(normalDirection, normalize(vec3(-0.35, 0.55, 0.76))), 0.0);
    color = vec3(0.62, 0.59, 0.54) * (0.46 + clayKey * 0.52);
  }

  gl_FragColor = vec4(color, previewAlpha);
}
`;

function hasPreviewMaps(textures: TextureAsset[]): boolean {
  return textures.some((texture) => canPreviewInBrowser(texture));
}

function getOrderedColorTiles(textures: TextureAsset[]): TextureAsset[] {
  for (const channel of COLOR_PREVIEW_CHANNELS) {
    const channelTextures = textures.filter((texture) => texture.channel === channel && canPreviewInBrowser(texture));
    if (channelTextures.length > 0) {
      return channelTextures.slice(0, MAX_UDIM_PREVIEW_TILES);
    }
  }

  return [];
}

function configureTextureMaps(maps: MaterialMaps, flipY: boolean) {
  if (maps.colorMap) {
    maps.colorMap.colorSpace = THREE.SRGBColorSpace;
  }

  if (maps.atlasMap) {
    maps.atlasMap.colorSpace = THREE.SRGBColorSpace;
  }

  if (maps.paintMap) {
    maps.paintMap.colorSpace = THREE.SRGBColorSpace;
  }

  if (maps.normalMap) {
    maps.normalMap.colorSpace = THREE.NoColorSpace;
  }

  if (maps.roughnessMap) {
    maps.roughnessMap.colorSpace = THREE.NoColorSpace;
  }

  if (maps.metalnessMap) {
    maps.metalnessMap.colorSpace = THREE.NoColorSpace;
  }

  if (maps.aoMap) {
    maps.aoMap.colorSpace = THREE.NoColorSpace;
  }

  const allMaps = new Set<THREE.Texture>();
  [
    maps.colorMap,
    maps.normalMap,
    maps.roughnessMap,
    maps.metalnessMap,
    maps.aoMap,
    maps.atlasMap,
    maps.paintMap,
  ].forEach((map) => {
    if (map) {
      allMaps.add(map);
    }
  });

  allMaps.forEach((map) => {
    map.flipY = flipY;
    map.wrapS = map === maps.atlasMap || map === maps.paintMap ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    map.wrapT = map === maps.atlasMap || map === maps.paintMap ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    map.anisotropy = 8;
    map.needsUpdate = true;
  });
}

function preparePreviewMesh(mesh: THREE.Mesh) {
  if (mesh.geometry) {
    if (!mesh.geometry.attributes.normal) {
      mesh.geometry.computeVertexNormals();
    }

    mesh.geometry.computeBoundingBox();
    mesh.geometry.computeBoundingSphere();
  }

  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
}

function preparePreviewMaterialForMesh(mesh: THREE.Mesh, material: THREE.Material, isXray = false) {
  material.side = THREE.DoubleSide;
  material.transparent = isXray;
  material.opacity = isXray ? 0.42 : 1;
  material.alphaTest = 0;
  material.depthTest = true;
  material.depthWrite = !isXray;
  material.visible = true;

  const compatibleMaterial = material as THREE.Material & {
    skinning?: boolean;
    morphTargets?: boolean;
    morphNormals?: boolean;
  };

  compatibleMaterial.skinning = "isSkinnedMesh" in mesh && Boolean(mesh.isSkinnedMesh);
  compatibleMaterial.morphTargets = Boolean(mesh.geometry?.morphAttributes?.position);
  compatibleMaterial.morphNormals = Boolean(mesh.geometry?.morphAttributes?.normal);
  material.needsUpdate = true;
}

function useEditWireframeOverlay(object: THREE.Object3D, enabled: boolean, isXray: boolean) {
  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    const overlays: Array<{
      parent: THREE.Object3D;
      line: THREE.LineSegments;
      geometry: THREE.WireframeGeometry;
      material: THREE.LineBasicMaterial;
    }> = [];

    object.traverse((child: THREE.Object3D) => {
      if (!(child instanceof THREE.Mesh) || !child.geometry) {
        return;
      }

      const position = child.geometry.getAttribute("position");
      const triangleCount = Math.floor((child.geometry.index?.count ?? position?.count ?? 0) / 3);
      if (triangleCount > 140000) {
        return;
      }

      const geometry = new THREE.WireframeGeometry(child.geometry);
      const material = new THREE.LineBasicMaterial({
        color: isXray ? "#f59e0b" : "#000000",
        depthTest: !isXray,
        depthWrite: false,
        opacity: isXray ? 0.78 : 0.88,
        transparent: true,
      });
      const line = new THREE.LineSegments(geometry, material);
      line.name = "__edit_wireframe_overlay";
      line.frustumCulled = false;
      line.raycast = () => null;
      line.renderOrder = 30;
      child.add(line);
      overlays.push({ parent: child, line, geometry, material });
    });

    return () => {
      overlays.forEach(({ parent, line, geometry, material }) => {
        parent.remove(line);
        geometry.dispose();
        material.dispose();
      });
    };
  }, [enabled, isXray, object]);
}

function createSelectedFaceMarker(
  mesh: THREE.Mesh,
  faceIndex: number,
  vertexIndices: [number, number, number],
  selectionMode: EditSelectionMode,
): SelectedFaceMarker | null {
  const position = mesh.geometry?.getAttribute("position");
  if (!position || vertexIndices.some((index) => index < 0 || index >= position.count)) {
    return null;
  }

  mesh.updateWorldMatrix(true, false);
  const points = vertexIndices.map((index) => getMeshVertexWorldPosition(mesh, index, new THREE.Vector3()));
  const normal = new THREE.Triangle(points[0], points[1], points[2]).getNormal(new THREE.Vector3());
  const offset = normal.multiplyScalar(0.014);

  return {
    key: `${mesh.uuid}:${faceIndex}`,
    faceIndex,
    meshUuid: mesh.uuid,
    points: points.map((point) => {
      point.add(offset);
      return [point.x, point.y, point.z] as [number, number, number];
    }),
    selectionMode,
  };
}

function createSelectedMarkerFromPoints(
  mesh: THREE.Mesh,
  faceIndex: number,
  points: THREE.Vector3[],
  selectionMode: EditSelectionMode,
  keySuffix = "",
): SelectedFaceMarker | null {
  if (points.length === 0) {
    return null;
  }

  return {
    key: `${mesh.uuid}:${selectionMode}:${faceIndex}:${keySuffix}`,
    faceIndex,
    meshUuid: mesh.uuid,
    points: points.map((point) => [point.x, point.y, point.z] as [number, number, number]),
    selectionMode,
  };
}

function getClosestVertexIndex(
  mesh: THREE.Mesh,
  vertexIndices: [number, number, number],
  hitPoint: THREE.Vector3,
) {
  return vertexIndices.reduce((closest, vertexIndex) => {
    const point = getMeshVertexWorldPosition(mesh, vertexIndex, new THREE.Vector3());
    const distance = point.distanceToSquared(hitPoint);
    return distance < closest.distance ? { vertexIndex, point, distance } : closest;
  }, {
    vertexIndex: vertexIndices[0],
    point: getMeshVertexWorldPosition(mesh, vertexIndices[0], new THREE.Vector3()),
    distance: Number.POSITIVE_INFINITY,
  });
}

function getClosestEdgeVertexIndices(
  mesh: THREE.Mesh,
  vertexIndices: [number, number, number],
  hitPoint: THREE.Vector3,
) {
  const edges: Array<[number, number]> = [
    [vertexIndices[0], vertexIndices[1]],
    [vertexIndices[1], vertexIndices[2]],
    [vertexIndices[2], vertexIndices[0]],
  ];
  const closestPoint = new THREE.Vector3();

  return edges.reduce((closest, edge) => {
    const pointA = getMeshVertexWorldPosition(mesh, edge[0], new THREE.Vector3());
    const pointB = getMeshVertexWorldPosition(mesh, edge[1], new THREE.Vector3());
    new THREE.Line3(pointA, pointB).closestPointToPoint(hitPoint, true, closestPoint);
    const distance = closestPoint.distanceToSquared(hitPoint);
    return distance < closest.distance
      ? { edge, points: [pointA, pointB], distance }
      : closest;
  }, {
    edge: edges[0],
    points: [
      getMeshVertexWorldPosition(mesh, edges[0][0], new THREE.Vector3()),
      getMeshVertexWorldPosition(mesh, edges[0][1], new THREE.Vector3()),
    ],
    distance: Number.POSITIVE_INFINITY,
  });
}

function getUvSegmentsForTriangles(cache: PaintUvIslandCache, triangleIndices: number[]): UvSegment[] {
  const segments: UvSegment[] = [];
  triangleIndices.forEach((triangleIndex) => {
    const triangleUvs = cache.triangleUvs[triangleIndex];
    if (!triangleUvs) {
      return;
    }

    const [uvA, uvB, uvC] = triangleUvs;
    segments.push(
      { x1: uvA.x, y1: uvA.y, x2: uvB.x, y2: uvB.y },
      { x1: uvB.x, y1: uvB.y, x2: uvC.x, y2: uvC.y },
      { x1: uvC.x, y1: uvC.y, x2: uvA.x, y2: uvA.y },
    );
  });
  return segments;
}

function getUvSegmentsForVertexIndices(geometry: THREE.BufferGeometry, vertexIndices: number[]): UvSegment[] {
  const uv = getUvAttribute(geometry);
  if (!uv) {
    return [];
  }

  if (vertexIndices.length >= 2) {
    const start = getUvFromAttribute(uv, vertexIndices[0]);
    const end = getUvFromAttribute(uv, vertexIndices[1]);
    return [{ x1: start.x, y1: start.y, x2: end.x, y2: end.y }];
  }

  const vertexIndex = vertexIndices[0];
  if (vertexIndex == null) {
    return [];
  }

  const point = getUvFromAttribute(uv, vertexIndex);
  const size = 0.012;
  return [
    { x1: point.x - size, y1: point.y, x2: point.x + size, y2: point.y },
    { x1: point.x, y1: point.y - size, x2: point.x, y2: point.y + size },
  ];
}

function getSelectedFaceMarkers(event: ThreeEvent<PointerEvent>, selectionMode: EditSelectionMode): {
  markers: SelectedFaceMarker[];
  editTarget: UvEditTarget;
  uvSegments: UvSegment[];
} | null {
  if (!(event.object instanceof THREE.Mesh) || !event.face || typeof event.faceIndex !== "number") {
    return null;
  }

  const mesh = event.object;
  const faceIndex = event.faceIndex;
  const cache = getPaintIslandCache(mesh.geometry);
  const hitVertexIndices = cache.triangleVertexIndices[faceIndex];
  if (!hitVertexIndices) {
    return null;
  }

  if (selectionMode === "vertices") {
    const closestVertex = getClosestVertexIndex(mesh, hitVertexIndices, event.point);
    const marker = createSelectedMarkerFromPoints(
      mesh,
      faceIndex,
      [closestVertex.point],
      selectionMode,
      String(closestVertex.vertexIndex),
    );

    return marker ? {
      markers: [marker],
      editTarget: {
        meshUuid: mesh.uuid,
        triangleIndices: [faceIndex],
        vertexIndices: [closestVertex.vertexIndex],
      },
      uvSegments: getUvSegmentsForVertexIndices(mesh.geometry, [closestVertex.vertexIndex]),
    } : null;
  }

  if (selectionMode === "edges") {
    const closestEdge = getClosestEdgeVertexIndices(mesh, hitVertexIndices, event.point);
    const marker = createSelectedMarkerFromPoints(
      mesh,
      faceIndex,
      closestEdge.points,
      selectionMode,
      closestEdge.edge.join(":"),
    );

    return marker ? {
      markers: [marker],
      editTarget: {
        meshUuid: mesh.uuid,
        triangleIndices: [faceIndex],
        vertexIndices: closestEdge.edge,
      },
      uvSegments: getUvSegmentsForVertexIndices(mesh.geometry, closestEdge.edge),
    } : null;
  }

  const triangleIndices = selectionMode === "island"
    ? cache.triangleIndicesByIsland[cache.islandIdsByTriangle[faceIndex]] ?? [faceIndex]
    : [faceIndex];

  if (triangleIndices.length === 0) {
    return null;
  }

  const maxMarkers = selectionMode === "island" ? 50000 : 2500;
  return {
    markers: triangleIndices.slice(0, maxMarkers).flatMap((triangleIndex) => {
      const vertexIndices = cache.triangleVertexIndices[triangleIndex];
      const marker = vertexIndices ? createSelectedFaceMarker(mesh, triangleIndex, vertexIndices, selectionMode) : null;
      return marker ? [marker] : [];
    }),
    editTarget: {
      meshUuid: mesh.uuid,
      triangleIndices,
    },
    uvSegments: getUvSegmentsForTriangles(cache, triangleIndices),
  };
}

function getFaceSelectionKey(meshUuid: string, triangleIndex: number) {
  return `${meshUuid}:face:${triangleIndex}`;
}

function getIslandSelectionKey(meshUuid: string, islandIndex: number) {
  return `${meshUuid}:island:${islandIndex}`;
}

function getVertexSelectionKey(meshUuid: string, vertexIndex: number) {
  return `${meshUuid}:vertex:${vertexIndex}`;
}

function getEdgeSelectionKey(meshUuid: string, startIndex: number, endIndex: number) {
  const [start, end] = [startIndex, endIndex].sort((left, right) => left - right);
  return `${meshUuid}:edge:${start}:${end}`;
}

function getEditableMeshes(root: THREE.Object3D | null) {
  const meshes: THREE.Mesh[] = [];
  root?.traverse((child) => {
    if (!(child instanceof THREE.Mesh) || !child.geometry || !getUvAttribute(child.geometry)) {
      return;
    }

    meshes.push(child);
  });
  return meshes;
}

function getSelectionKeysForTargets(root: THREE.Object3D | null, selectionMode: EditSelectionMode, targets: UvEditTarget[]) {
  const keys = new Set<string>();
  targets.forEach((target) => {
    const mesh = findMeshByUuid(root, target.meshUuid);
    if (!mesh?.geometry) {
      return;
    }

    const cache = getPaintIslandCache(mesh.geometry);
    if (selectionMode === "vertices") {
      getUniqueUvVertexIndices(cache, target.triangleIndices, target.vertexIndices).forEach((vertexIndex) => {
        keys.add(getVertexSelectionKey(target.meshUuid, vertexIndex));
      });
      return;
    }

    if (selectionMode === "edges") {
      if (target.vertexIndices && target.vertexIndices.length >= 2) {
        keys.add(getEdgeSelectionKey(target.meshUuid, target.vertexIndices[0], target.vertexIndices[1]));
      }
      return;
    }

    if (selectionMode === "island") {
      target.triangleIndices.forEach((triangleIndex) => {
        const islandId = cache.islandIdsByTriangle[triangleIndex];
        if (islandId >= 0) {
          keys.add(getIslandSelectionKey(target.meshUuid, islandId));
        }
      });
      return;
    }

    target.triangleIndices.forEach((triangleIndex) => {
      keys.add(getFaceSelectionKey(target.meshUuid, triangleIndex));
    });
  });
  return keys;
}

function getAllEditSelectionItems(root: THREE.Object3D | null, selectionMode: EditSelectionMode): EditSelectionItem[] {
  const items: EditSelectionItem[] = [];

  getEditableMeshes(root).forEach((mesh) => {
    const cache = getPaintIslandCache(mesh.geometry);
    const meshUuid = mesh.uuid;

    if (selectionMode === "vertices") {
      const seenVertices = new Set<number>();
      cache.triangleVertexIndices.forEach((vertexIndices, triangleIndex) => {
        vertexIndices.forEach((vertexIndex) => {
          if (seenVertices.has(vertexIndex)) {
            return;
          }
          seenVertices.add(vertexIndex);
          const point = getMeshVertexWorldPosition(mesh, vertexIndex, new THREE.Vector3());
          const marker = createSelectedMarkerFromPoints(mesh, triangleIndex, [point], "vertices", `invert-${vertexIndex}`);
          if (!marker) {
            return;
          }
          items.push({
            key: getVertexSelectionKey(meshUuid, vertexIndex),
            markers: [marker],
            editTarget: {
              meshUuid,
              triangleIndices: [triangleIndex],
              vertexIndices: [vertexIndex],
            },
            uvSegments: getUvSegmentsForVertexIndices(mesh.geometry, [vertexIndex]),
          });
        });
      });
      return;
    }

    if (selectionMode === "edges") {
      const seenEdges = new Set<string>();
      cache.triangleVertexIndices.forEach((vertexIndices, triangleIndex) => {
        const edges: Array<[number, number]> = [
          [vertexIndices[0], vertexIndices[1]],
          [vertexIndices[1], vertexIndices[2]],
          [vertexIndices[2], vertexIndices[0]],
        ];
        edges.forEach((edge) => {
          const key = getEdgeSelectionKey(meshUuid, edge[0], edge[1]);
          if (seenEdges.has(key)) {
            return;
          }
          seenEdges.add(key);
          const points = edge.map((vertexIndex) => getMeshVertexWorldPosition(mesh, vertexIndex, new THREE.Vector3()));
          const marker = createSelectedMarkerFromPoints(mesh, triangleIndex, points, "edges", `invert-${edge.join(":")}`);
          if (!marker) {
            return;
          }
          items.push({
            key,
            markers: [marker],
            editTarget: {
              meshUuid,
              triangleIndices: [triangleIndex],
              vertexIndices: edge,
            },
            uvSegments: getUvSegmentsForVertexIndices(mesh.geometry, edge),
          });
        });
      });
      return;
    }

    if (selectionMode === "island") {
      cache.triangleIndicesByIsland.forEach((triangleIndices, islandIndex) => {
        if (triangleIndices.length === 0) {
          return;
        }
        items.push({
          key: getIslandSelectionKey(meshUuid, islandIndex),
          markers: triangleIndices.slice(0, 50000).flatMap((triangleIndex) => {
            const vertexIndices = cache.triangleVertexIndices[triangleIndex];
            const marker = vertexIndices ? createSelectedFaceMarker(mesh, triangleIndex, vertexIndices, "island") : null;
            return marker ? [marker] : [];
          }),
          editTarget: {
            meshUuid,
            triangleIndices,
          },
          uvSegments: getUvSegmentsForTriangles(cache, triangleIndices),
        });
      });
      return;
    }

    cache.triangleVertexIndices.forEach((vertexIndices, triangleIndex) => {
      const marker = createSelectedFaceMarker(mesh, triangleIndex, vertexIndices, "faces");
      if (!marker) {
        return;
      }
      items.push({
        key: getFaceSelectionKey(meshUuid, triangleIndex),
        markers: [marker],
        editTarget: {
          meshUuid,
          triangleIndices: [triangleIndex],
        },
        uvSegments: getUvSegmentsForTriangles(cache, [triangleIndex]),
      });
    });
  });

  return items;
}

function getUdimTileOffset(udim = "1001") {
  const value = Number.parseInt(udim, 10);
  const zeroBasedIndex = Number.isFinite(value) && value >= 1001 ? value - 1001 : 0;
  return {
    x: zeroBasedIndex % UDIM_ATLAS_COLUMNS,
    y: Math.floor(zeroBasedIndex / UDIM_ATLAS_COLUMNS),
  };
}

function findMeshByUuid(root: THREE.Object3D | null, meshUuid: string): THREE.Mesh | null {
  if (!root) {
    return null;
  }

  const found = root.getObjectByProperty("uuid", meshUuid);
  return found instanceof THREE.Mesh ? found : null;
}

function getUvAttribute(geometry: THREE.BufferGeometry) {
  return geometry.getAttribute("uv") as THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined;
}

function ensureEditableUvGeometry(mesh: THREE.Mesh) {
  return mesh.geometry;
}

function prepareModelCloneForExport(object: THREE.Object3D) {
  object.updateMatrixWorld(true);
  const removableObjects: THREE.Object3D[] = [];

  object.traverse((child) => {
    if (child.name.startsWith("__") || child instanceof THREE.Line || child instanceof THREE.LineSegments) {
      removableObjects.push(child);
    }
  });

  removableObjects.forEach((child) => {
    child.parent?.remove(child);
  });

  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh) || !child.geometry) {
      return;
    }

    child.updateMatrixWorld(true);
    try {
      child.geometry = mergeVertices(child.geometry.clone(), 0.00001);
    } catch {
      child.geometry = child.geometry.clone();
    }
    if (!child.geometry.attributes.normal) {
      child.geometry.computeVertexNormals();
    }
    child.geometry.computeBoundingBox();
    child.geometry.computeBoundingSphere();
  });

  return object;
}

function captureUvSnapshots(root: THREE.Object3D | null, meshUuids: Iterable<string>): UvHistorySnapshot[] {
  const snapshots: UvHistorySnapshot[] = [];

  Array.from(new Set(meshUuids)).forEach((meshUuid) => {
    const mesh = findMeshByUuid(root, meshUuid);
    const uvAttribute = mesh?.geometry ? getUvAttribute(mesh.geometry) : undefined;
    if (!mesh || !uvAttribute) {
      return;
    }

    const uvValues = new Float32Array(uvAttribute.count * 2);
    for (let index = 0; index < uvAttribute.count; index += 1) {
      uvValues[index * 2] = uvAttribute.getX(index);
      uvValues[index * 2 + 1] = uvAttribute.getY(index);
    }

    snapshots.push({ meshUuid, uvValues });
  });

  return snapshots;
}

function prepareEditableUvTargets(root: THREE.Object3D | null, targets: UvEditTarget[]) {
  const meshUuids = new Set<string>();
  if (!root) {
    return meshUuids;
  }

  targets.forEach((target) => {
    const mesh = findMeshByUuid(root, target.meshUuid);
    if (!mesh?.geometry) {
      return;
    }

    ensureEditableUvGeometry(mesh);
    meshUuids.add(target.meshUuid);
  });

  return meshUuids;
}

function restoreUvSnapshots(root: THREE.Object3D | null, snapshots: UvHistorySnapshot[]) {
  let changed = false;

  snapshots.forEach((snapshot) => {
    const mesh = findMeshByUuid(root, snapshot.meshUuid);
    const geometry = mesh?.geometry;
    const uvAttribute = geometry ? getUvAttribute(geometry) : undefined;
    if (!mesh || !geometry || !uvAttribute || uvAttribute.count * 2 !== snapshot.uvValues.length) {
      return;
    }

    for (let index = 0; index < uvAttribute.count; index += 1) {
      uvAttribute.setXY(index, snapshot.uvValues[index * 2], snapshot.uvValues[index * 2 + 1]);
    }

    uvAttribute.needsUpdate = true;
    paintUvIslandCache.delete(geometry);
    changed = true;
  });

  return changed;
}

function getUvBoundsFromPoints(points: THREE.Vector2[]) {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  points.forEach((point) => {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  });

  return {
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
    minX,
    minY,
    maxX,
    maxY,
  };
}

function getTileOffsetForCommand(command: UvEditCommand, bounds: ReturnType<typeof getUvBoundsFromPoints>) {
  if (command.currentUdim) {
    return getUdimTileOffset(command.currentUdim);
  }

  return {
    x: Math.floor(bounds.minX),
    y: Math.floor(bounds.minY),
  };
}

function fitUvMapInsideTile(uvMap: Map<number, THREE.Vector2>, tileOffset: { x: number; y: number }, padding = 0.004) {
  const entries = [...uvMap.entries()];
  if (entries.length === 0) {
    return uvMap;
  }

  let points = entries.map(([, point]) => point.clone());
  let bounds = getUvBoundsFromPoints(points);
  const targetMinX = tileOffset.x + padding;
  const targetMinY = tileOffset.y + padding;
  const targetMaxX = tileOffset.x + 1 - padding;
  const targetMaxY = tileOffset.y + 1 - padding;
  const width = Math.max(0.00001, bounds.maxX - bounds.minX);
  const height = Math.max(0.00001, bounds.maxY - bounds.minY);
  const maxWidth = targetMaxX - targetMinX;
  const maxHeight = targetMaxY - targetMinY;

  if (width > maxWidth || height > maxHeight) {
    const scale = Math.min(maxWidth / width, maxHeight / height);
    points = points.map((point) => new THREE.Vector2(
      bounds.centerX + (point.x - bounds.centerX) * scale,
      bounds.centerY + (point.y - bounds.centerY) * scale,
    ));
    bounds = getUvBoundsFromPoints(points);
  }

  let shiftX = 0;
  let shiftY = 0;
  if (bounds.minX < targetMinX) {
    shiftX = targetMinX - bounds.minX;
  } else if (bounds.maxX > targetMaxX) {
    shiftX = targetMaxX - bounds.maxX;
  }

  if (bounds.minY < targetMinY) {
    shiftY = targetMinY - bounds.minY;
  } else if (bounds.maxY > targetMaxY) {
    shiftY = targetMaxY - bounds.maxY;
  }

  entries.forEach(([vertexIndex], index) => {
    uvMap.set(vertexIndex, new THREE.Vector2(points[index].x + shiftX, points[index].y + shiftY));
  });

  return uvMap;
}

function normalizeUvMapToTile(
  vertexUvs: Array<[number, THREE.Vector2]>,
  bounds: ReturnType<typeof getUvBoundsFromPoints>,
  tileOffset: { x: number; y: number },
) {
  const padding = 0.055;
  const sourceWidth = Math.max(0.00001, bounds.maxX - bounds.minX);
  const sourceHeight = Math.max(0.00001, bounds.maxY - bounds.minY);
  const targetWidth = 1 - padding * 2;
  const targetHeight = 1 - padding * 2;
  const uvMap = new Map<number, THREE.Vector2>();

  vertexUvs.forEach(([vertexIndex, uv]) => {
    uvMap.set(vertexIndex, new THREE.Vector2(
      tileOffset.x + padding + ((uv.x - bounds.minX) / sourceWidth) * targetWidth,
      tileOffset.y + padding + ((uv.y - bounds.minY) / sourceHeight) * targetHeight,
    ));
  });

  return uvMap;
}

function getUniqueUvVertexIndices(cache: PaintUvIslandCache, triangleIndices: number[], explicitVertexIndices?: number[]) {
  if (explicitVertexIndices && explicitVertexIndices.length > 0) {
    return [...new Set(explicitVertexIndices)];
  }

  const vertexIndices = new Set<number>();
  triangleIndices.forEach((triangleIndex) => {
    cache.triangleVertexIndices[triangleIndex]?.forEach((vertexIndex) => {
      vertexIndices.add(vertexIndex);
    });
  });
  return [...vertexIndices];
}

function getUvSegmentsForEditTargets(root: THREE.Object3D | null, targets: UvEditTarget[]) {
  const segments: UvSegment[] = [];

  targets.forEach((target) => {
    const mesh = findMeshByUuid(root, target.meshUuid);
    if (!mesh?.geometry) {
      return;
    }

    const cache = getPaintIslandCache(mesh.geometry);
    if (target.vertexIndices && target.vertexIndices.length > 0) {
      segments.push(...getUvSegmentsForVertexIndices(mesh.geometry, target.vertexIndices));
    } else {
      segments.push(...getUvSegmentsForTriangles(cache, target.triangleIndices));
    }
  });

  return segments;
}

function applyUvEditToModel(root: THREE.Object3D | null, targets: UvEditTarget[], command: UvEditCommand): UvSegment[] | null {
  if (!root || targets.length === 0) {
    return null;
  }

  let changed = false;
  const groupedTargets = new Map<string, { triangleIndices: Set<number>; explicitVertexIndices: Set<number>; hasWholeTriangleTarget: boolean }>();
  targets.forEach((target) => {
    const group = groupedTargets.get(target.meshUuid) ?? {
      triangleIndices: new Set<number>(),
      explicitVertexIndices: new Set<number>(),
      hasWholeTriangleTarget: false,
    };
    target.triangleIndices.forEach((triangleIndex) => group.triangleIndices.add(triangleIndex));
    if (target.vertexIndices && target.vertexIndices.length > 0) {
      target.vertexIndices.forEach((vertexIndex) => group.explicitVertexIndices.add(vertexIndex));
    } else {
      group.hasWholeTriangleTarget = true;
    }
    groupedTargets.set(target.meshUuid, group);
  });

  groupedTargets.forEach((group, meshUuid) => {
    const mesh = findMeshByUuid(root, meshUuid);
    const geometry = mesh?.geometry ? ensureEditableUvGeometry(mesh) : undefined;
    const uvAttribute = geometry ? getUvAttribute(geometry) : undefined;
    if (!mesh || !geometry || !uvAttribute) {
      return;
    }

    const cache = getPaintIslandCache(geometry);
    const triangleIndices = [...group.triangleIndices];
    const vertexIndices = group.hasWholeTriangleTarget
      ? getUniqueUvVertexIndices(cache, triangleIndices)
      : getUniqueUvVertexIndices(cache, triangleIndices, [...group.explicitVertexIndices]);
    const uvPoints = vertexIndices.map((vertexIndex) => getUvFromAttribute(uvAttribute, vertexIndex));
    if (uvPoints.length === 0) {
      return;
    }

    const vertexUvs = vertexIndices.map((vertexIndex) => [vertexIndex, getUvFromAttribute(uvAttribute, vertexIndex)] as [number, THREE.Vector2]);
    const bounds = getUvBoundsFromPoints(uvPoints);
    const currentTile = getTileOffsetForCommand(command, bounds);
    const destination = getUdimTileOffset(command.targetUdim);
    const deltaForTile = {
      x: destination.x - currentTile.x,
      y: destination.y - currentTile.y,
    };
    const angle = THREE.MathUtils.degToRad(command.rotationDeg ?? 0);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    let nextUvs = new Map<number, THREE.Vector2>();

    if (
      command.type === "normalize" ||
      command.type === "project-from-view" ||
      command.type === "planar" ||
      command.type === "box" ||
      command.type === "cylindrical" ||
      command.type === "spherical"
    ) {
      nextUvs = normalizeUvMapToTile(vertexUvs, bounds, currentTile);
    } else {
      vertexUvs.forEach(([vertexIndex, uv]) => {
        let nextX = uv.x;
        let nextY = uv.y;

        if (command.type === "move") {
          nextX += command.deltaU ?? 0;
          nextY += command.deltaV ?? 0;
        } else if (command.type === "scale") {
          const scaleFactor = command.scaleFactor ?? 1;
          nextX = bounds.centerX + (uv.x - bounds.centerX) * scaleFactor;
          nextY = bounds.centerY + (uv.y - bounds.centerY) * scaleFactor;
        } else if (command.type === "rotate") {
          const localX = uv.x - bounds.centerX;
          const localY = uv.y - bounds.centerY;
          nextX = bounds.centerX + localX * cos - localY * sin;
          nextY = bounds.centerY + localX * sin + localY * cos;
        } else if (command.type === "move-to-udim") {
          nextX += deltaForTile.x;
          nextY += deltaForTile.y;
        } else if (command.type === "straight") {
          if (bounds.maxX - bounds.minX >= bounds.maxY - bounds.minY) {
            nextY = bounds.centerY;
          } else {
            nextX = bounds.centerX;
          }
        } else if (command.type === "gridify") {
          nextX = currentTile.x + Math.round((uv.x - currentTile.x) * 8) / 8;
          nextY = currentTile.y + Math.round((uv.y - currentTile.y) * 8) / 8;
        } else if (command.type === "rectify") {
          const localX = (uv.x - bounds.minX) / Math.max(0.00001, bounds.maxX - bounds.minX);
          const localY = (uv.y - bounds.minY) / Math.max(0.00001, bounds.maxY - bounds.minY);
          nextX = localX < 0.33 ? bounds.minX : localX > 0.66 ? bounds.maxX : bounds.centerX;
          nextY = localY < 0.33 ? bounds.minY : localY > 0.66 ? bounds.maxY : bounds.centerY;
        }

        nextUvs.set(vertexIndex, new THREE.Vector2(nextX, nextY));
      });

      fitUvMapInsideTile(nextUvs, command.type === "move-to-udim" ? destination : currentTile);
    }

    nextUvs.forEach((uv, vertexIndex) => {
      const currentUv = getUvFromAttribute(uvAttribute, vertexIndex);
      if (Math.abs(currentUv.x - uv.x) > 0.000001 || Math.abs(currentUv.y - uv.y) > 0.000001) {
        uvAttribute.setXY(vertexIndex, uv.x, uv.y);
        changed = true;
      }
    });

    uvAttribute.needsUpdate = true;
    geometry.computeBoundingSphere();
    paintUvIslandCache.delete(geometry);
  });

  return changed ? getUvSegmentsForEditTargets(root, targets) : null;
}

function EditSelectionOverlay({ markers, isXray }: { markers: SelectedFaceMarker[]; isXray: boolean }) {
  const geometryData = useMemo(() => {
    const trianglePositions: number[] = [];
    const edgePositions: number[] = [];
    const pointPositions: number[] = [];

    markers.forEach((marker) => {
      if (marker.points.length === 1) {
        pointPositions.push(...marker.points[0]);
        return;
      }

      if (marker.points.length === 2) {
        edgePositions.push(...marker.points[0], ...marker.points[1]);
        pointPositions.push(...marker.points[0], ...marker.points[1]);
        return;
      }

      const [a, b, c] = marker.points;
      trianglePositions.push(...a, ...b, ...c);
      edgePositions.push(...a, ...b, ...b, ...c, ...c, ...a);
    });

    return {
      edgePositions: new Float32Array(edgePositions),
      pointPositions: new Float32Array(pointPositions),
      trianglePositions: new Float32Array(trianglePositions),
    };
  }, [markers]);

  if (markers.length === 0) {
    return null;
  }

  const fillColor = "#f5a400";
  const hasEdges = geometryData.edgePositions.length > 0;
  const hasPoints = geometryData.pointPositions.length > 0;
  const hasTriangles = geometryData.trianglePositions.length > 0;

  return (
    <group>
      {hasTriangles ? (
        <mesh renderOrder={42}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[geometryData.trianglePositions, 3]} />
          </bufferGeometry>
          <meshBasicMaterial
            color={fillColor}
            depthTest={!isXray}
            depthWrite={false}
            fog={false}
            opacity={isXray ? 0.68 : 1}
            polygonOffset
            polygonOffsetFactor={-18}
            polygonOffsetUnits={-18}
            side={THREE.DoubleSide}
            toneMapped={false}
            transparent={isXray}
          />
        </mesh>
      ) : null}
      {hasEdges ? (
        <lineSegments renderOrder={43} raycast={() => null}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[geometryData.edgePositions, 3]} />
          </bufferGeometry>
          <lineBasicMaterial color="#fff6c8" depthTest={!isXray} depthWrite={false} fog={false} opacity={1} toneMapped={false} transparent />
        </lineSegments>
      ) : null}
      {hasPoints ? (
        <points renderOrder={44} raycast={() => null}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[geometryData.pointPositions, 3]} />
          </bufferGeometry>
          <pointsMaterial color="#f5a400" depthTest={!isXray} depthWrite={false} fog={false} size={8} sizeAttenuation={false} toneMapped={false} transparent />
        </points>
      ) : null}
    </group>
  );
}

function pushUvEdge(
  segments: UvSegment[],
  uv: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  startIndex: number,
  endIndex: number,
) {
  if (segments.length >= MAX_UV_PREVIEW_SEGMENTS) {
    return;
  }

  const x1 = uv.getX(startIndex);
  const y1 = uv.getY(startIndex);
  const x2 = uv.getX(endIndex);
  const y2 = uv.getY(endIndex);

  if (![x1, y1, x2, y2].every(Number.isFinite)) {
    return;
  }

  segments.push({ x1, y1, x2, y2 });
}

function extractUvSegments(object: THREE.Object3D): UvSegment[] {
  const segments: UvSegment[] = [];
  const meshes: Array<{
    id: number;
    uv: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
    index: THREE.BufferAttribute | null;
    triangleCount: number;
  }> = [];
  let meshId = 0;

  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) {
      return;
    }

    const geometry = child.geometry;
    const uv = geometry?.getAttribute("uv");
    if (!uv) {
      return;
    }

    const index = geometry.getIndex();
    meshes.push({
      id: meshId,
      uv,
      index,
      triangleCount: Math.floor((index?.count ?? uv.count) / 3),
    });
    meshId += 1;
  });

  const pushedEdges = new Set<string>();

  function pushUniqueEdge(
    mesh: {
      id: number;
      uv: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
    },
    startIndex: number,
    endIndex: number,
  ) {
    if (segments.length >= MAX_UV_PREVIEW_SEGMENTS) {
      return;
    }

    const edgeStart = Math.min(startIndex, endIndex);
    const edgeEnd = Math.max(startIndex, endIndex);
    const edgeKey = `${mesh.id}:${edgeStart}:${edgeEnd}`;
    if (pushedEdges.has(edgeKey)) {
      return;
    }

    pushedEdges.add(edgeKey);
    pushUvEdge(segments, mesh.uv, startIndex, endIndex);
  }

  meshes.forEach((mesh) => {
    for (let triangleIndex = 0; triangleIndex < mesh.triangleCount && segments.length < MAX_UV_PREVIEW_SEGMENTS; triangleIndex += 1) {
      const offset = triangleIndex * 3;
      const a = mesh.index ? mesh.index.getX(offset) : offset;
      const b = mesh.index ? mesh.index.getX(offset + 1) : offset + 1;
      const c = mesh.index ? mesh.index.getX(offset + 2) : offset + 2;
      pushUniqueEdge(mesh, a, b);
      pushUniqueEdge(mesh, b, c);
      pushUniqueEdge(mesh, c, a);
    }
  });

  return segments;
}

function hasRenderableDescendant(object: THREE.Object3D): boolean {
  if (object instanceof THREE.Mesh) {
    return true;
  }

  return object.children.some((child) => hasRenderableDescendant(child));
}

function isOutlinerObject(object: THREE.Object3D, isRoot: boolean): boolean {
  if (isRoot || object instanceof THREE.Mesh) {
    return true;
  }

  return object instanceof THREE.Group && hasRenderableDescendant(object);
}

function getOutlinerNodeType(object: THREE.Object3D, isRoot: boolean): ModelOutlinerNode["type"] {
  if (isRoot) {
    return "model";
  }

  return object instanceof THREE.Mesh ? "mesh" : "group";
}

function getOutlinerNodeName(object: THREE.Object3D, fallbackName: string, index: number): string {
  const name = object.name.trim();
  if (name) {
    return name;
  }

  return index === 0 ? fallbackName : `${object instanceof THREE.Mesh ? "Mesh" : "Group"} ${index}`;
}

function buildModelOutlinerNodes(model: THREE.Group, fallbackName: string): ModelOutlinerNode[] {
  const nodes: ModelOutlinerNode[] = [];

  function getRelevantChildCount(object: THREE.Object3D) {
    return object.children.filter((child) => child.type !== "Bone" && isOutlinerObject(child, false)).length;
  }

  function walk(object: THREE.Object3D, depth: number, parentId: string | null, isRoot = false) {
    if (object.type === "Bone") {
      return;
    }

    const includeObject = isOutlinerObject(object, isRoot);
    const nextParentId = includeObject ? object.uuid : parentId;
    const nextDepth = includeObject ? depth + 1 : depth;

    if (includeObject) {
      nodes.push({
        id: object.uuid,
        parentId,
        name: getOutlinerNodeName(object, fallbackName, nodes.length),
        type: getOutlinerNodeType(object, isRoot),
        depth,
        childCount: getRelevantChildCount(object),
      });
    }

    object.children.forEach((child) => walk(child, nextDepth, nextParentId));
  }

  walk(model, 0, null, true);
  return nodes;
}

function applyModelVisibility(model: THREE.Group, hiddenModelNodeIds: Set<string>) {
  model.traverse((child) => {
    child.visible = !hiddenModelNodeIds.has(child.uuid);
  });
}

function useLoadedTexture(url: string | null): THREE.Texture | null {
  const [texture, setTexture] = useState<THREE.Texture | null>(null);

  useEffect(() => {
    if (!url) {
      setTexture(null);
      return undefined;
    }

    let isActive = true;
    let loadedTexture: THREE.Texture | null = null;
    const loader = new THREE.TextureLoader();

    loader.load(
      url,
      (nextTexture) => {
        loadedTexture = nextTexture;
        if (isActive) {
          setTexture(nextTexture);
        } else {
          nextTexture.dispose();
        }
      },
      undefined,
      () => {
        if (isActive) {
          setTexture(null);
        }
      },
    );

    return () => {
      isActive = false;
      setTexture(null);
      loadedTexture?.dispose();
    };
  }, [url]);

  return texture;
}

function loadImageFromUrl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Unable to load texture ${url}`));
    image.src = url;
  });
}

function useUdimAtlasTexture(textures: TextureAsset[]) {
  const colorTiles = useMemo(() => getOrderedColorTiles(textures), [textures]);
  const colorTileKey = colorTiles.map((texture) => texture.id).join("|");
  const [atlasMap, setAtlasMap] = useState<THREE.Texture | null>(null);

  useEffect(() => {
    if (colorTiles.length === 0) {
      setAtlasMap(null);
      return undefined;
    }

    let isActive = true;
    let nextTexture: THREE.CanvasTexture | null = null;

    async function buildAtlas() {
      const rows = Math.max(1, Math.ceil(colorTiles.length / UDIM_ATLAS_COLUMNS));
      const canvas = document.createElement("canvas");
      canvas.width = UDIM_ATLAS_COLUMNS * UDIM_ATLAS_TILE_SIZE;
      canvas.height = rows * UDIM_ATLAS_TILE_SIZE;
      const context = canvas.getContext("2d");
      if (!context) {
        return;
      }

      context.clearRect(0, 0, canvas.width, canvas.height);
      const images = await Promise.all(colorTiles.map((texture) => loadImageFromUrl(texture.objectUrl).catch(() => null)));

      images.forEach((image, index) => {
        if (!image) {
          return;
        }

        const column = index % UDIM_ATLAS_COLUMNS;
        const row = Math.floor(index / UDIM_ATLAS_COLUMNS);
        context.drawImage(
          image,
          column * UDIM_ATLAS_TILE_SIZE,
          row * UDIM_ATLAS_TILE_SIZE,
          UDIM_ATLAS_TILE_SIZE,
          UDIM_ATLAS_TILE_SIZE,
        );
      });

      nextTexture = new THREE.CanvasTexture(canvas);
      nextTexture.colorSpace = THREE.SRGBColorSpace;
      nextTexture.wrapS = THREE.ClampToEdgeWrapping;
      nextTexture.wrapT = THREE.ClampToEdgeWrapping;
      nextTexture.anisotropy = 8;
      nextTexture.needsUpdate = true;

      if (isActive) {
        setAtlasMap(nextTexture);
      } else {
        nextTexture.dispose();
      }
    }

    buildAtlas();

    return () => {
      isActive = false;
      setAtlasMap(null);
      nextTexture?.dispose();
    };
  }, [colorTileKey, colorTiles]);

  return {
    atlasMap,
    colorMap: atlasMap,
    atlasColumns: UDIM_ATLAS_COLUMNS,
    atlasRows: Math.max(1, Math.ceil(colorTiles.length / UDIM_ATLAS_COLUMNS)),
    atlasTileCount: colorTiles.length,
  };
}

function usePaintLayerTexture(tileCount: number, tileTextureIds: string[]) {
  const rows = Math.max(1, Math.ceil(Math.max(1, tileCount) / UDIM_ATLAS_COLUMNS));
  const [paintLayer, setPaintLayer] = useState<PaintLayer | null>(null);

  useEffect(() => {
    const canvas = document.createElement("canvas");
    canvas.width = UDIM_ATLAS_COLUMNS * UDIM_ATLAS_TILE_SIZE;
    canvas.height = rows * UDIM_ATLAS_TILE_SIZE;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      setPaintLayer(null);
      return undefined;
    }

    context.clearRect(0, 0, canvas.width, canvas.height);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.anisotropy = 8;
    texture.needsUpdate = true;

    const exportLayer: PaintExportLayer = {
      canvas,
      columns: UDIM_ATLAS_COLUMNS,
      rows,
      tileSize: UDIM_ATLAS_TILE_SIZE,
      tileTextureIds,
      hasPaint: false,
      version: 0,
    };

    const nextPaintLayer = {
      canvas,
      context,
      exportLayer,
      texture,
      rows,
    };

    setPaintLayer(nextPaintLayer);

    return () => {
      texture.dispose();
      setPaintLayer(null);
    };
  }, [rows]);

  useEffect(() => {
    if (paintLayer) {
      paintLayer.exportLayer.tileTextureIds = tileTextureIds;
    }
  }, [paintLayer, tileTextureIds]);

  return paintLayer;
}

function useTextureMaps(textures: TextureAsset[], paintMap: THREE.Texture | null): MaterialMaps {
  const atlas = useUdimAtlasTexture(textures);
  const tile1001 = useMemo(
    () => ({
      normal: getTileForChannel(textures, "Normal", "1001"),
      roughness: getTileForChannel(textures, "Roughness", "1001"),
      metallic: getTileForChannel(textures, "Metallic", "1001"),
      ao: getTileForChannel(textures, "AO", "1001"),
    }),
    [textures],
  );

  const normalMap = useLoadedTexture(tile1001.normal?.objectUrl ?? null);
  const roughnessMap = useLoadedTexture(tile1001.roughness?.objectUrl ?? null);
  const metalnessMap = useLoadedTexture(tile1001.metallic?.objectUrl ?? null);
  const aoMap = useLoadedTexture(tile1001.ao?.objectUrl ?? null);

  return useMemo(
    () => ({
      colorMap: atlas.colorMap,
      atlasMap: atlas.atlasMap,
      paintMap,
      atlasColumns: atlas.atlasColumns,
      atlasRows: atlas.atlasRows,
      atlasTileCount: Math.max(atlas.atlasTileCount, paintMap ? 1 : 0),
      normalMap: tile1001.normal ? normalMap : null,
      roughnessMap: tile1001.roughness ? roughnessMap : null,
      metalnessMap: tile1001.metallic ? metalnessMap : null,
      aoMap: tile1001.ao ? aoMap : null,
    }),
    [
      aoMap,
      atlas.atlasColumns,
      atlas.atlasMap,
      atlas.atlasRows,
      atlas.atlasTileCount,
      atlas.colorMap,
      paintMap,
      metalnessMap,
      normalMap,
      roughnessMap,
      tile1001.ao,
      tile1001.metallic,
      tile1001.normal,
      tile1001.roughness,
    ],
  );
}

function PreviewMaterial({
  textures,
  mode,
  flipY,
  paintMap,
}: {
  textures: TextureAsset[];
  mode: PreviewMode;
  flipY: boolean;
  paintMap: THREE.Texture | null;
}) {
  const maps = useTextureMaps(textures, paintMap);
  const paintPreviewMaterial = useMemo(
    () => (maps.paintMap && mode !== "normals" ? createPreviewMaterial(mode, maps, true) : null),
    [maps, mode],
  );

  useEffect(() => {
    configureTextureMaps(maps, flipY);
  }, [flipY, maps]);

  useEffect(() => {
    return () => {
      paintPreviewMaterial?.dispose();
    };
  }, [paintPreviewMaterial]);

  if (mode === "normals") {
    return <meshNormalMaterial side={THREE.DoubleSide} />;
  }

  if (paintPreviewMaterial) {
    return <primitive attach="material" object={paintPreviewMaterial} />;
  }

  if (mode === "clay") {
    return <meshMatcapMaterial color="#b9b0a8" side={THREE.DoubleSide} />;
  }

  if (mode === "flat") {
    return (
      <meshMatcapMaterial
        map={maps.colorMap ?? undefined}
        color={maps.colorMap ? "#ffffff" : "#b9b0a8"}
        side={THREE.DoubleSide}
      />
    );
  }

  return (
    <meshMatcapMaterial
      map={maps.colorMap ?? undefined}
      normalMap={maps.normalMap ?? undefined}
      color={maps.colorMap ? "#ffffff" : "#f0f0ec"}
      side={THREE.DoubleSide}
    />
  );
}

function TexturedFbx({
  fbx,
  textures,
  mode,
  flipY,
  paintMap,
  showWireframe,
  showXray,
  onEditPointerDown,
  onPaintPointerDown,
  onPaintPointerMove,
  onPaintPointerUp,
}: {
  fbx: THREE.Group;
  textures: TextureAsset[];
  mode: PreviewMode;
  flipY: boolean;
  paintMap: THREE.Texture | null;
  showWireframe?: boolean;
  showXray?: boolean;
  onEditPointerDown?: (event: ThreeEvent<PointerEvent>) => void;
  onPaintPointerDown?: (event: ThreeEvent<PointerEvent>) => void;
  onPaintPointerMove?: (event: ThreeEvent<PointerEvent>) => void;
  onPaintPointerUp?: (event: ThreeEvent<PointerEvent>) => void;
}) {
  const maps = useTextureMaps(textures, paintMap);
  useEditWireframeOverlay(fbx, Boolean(showWireframe), Boolean(showXray));

  useEffect(() => {
    configureTextureMaps(maps, flipY);

    const originalMaterials = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
    const previewMaterials: THREE.Material[] = [];

    fbx.traverse((child: THREE.Object3D) => {
      if (child instanceof THREE.Mesh) {
        preparePreviewMesh(child);
        const material = createPreviewMaterial(mode, maps, Boolean(child.geometry?.attributes?.uv), showXray ? 0.42 : 1);
        preparePreviewMaterialForMesh(child, material, Boolean(showXray));
        previewMaterials.push(material);
        originalMaterials.set(child, child.material);
        child.material = material;
      }
    });

    return () => {
      originalMaterials.forEach((originalMaterial, mesh) => {
        if (previewMaterials.includes(mesh.material as THREE.Material)) {
          mesh.material = originalMaterial;
        }
      });
      previewMaterials.forEach((material) => material.dispose());
    };
  }, [fbx, flipY, maps, mode, showXray]);

  return (
    <primitive
      object={fbx}
      onPointerDown={onEditPointerDown ?? onPaintPointerDown}
      onPointerMove={onPaintPointerMove}
      onPointerUp={onPaintPointerUp}
      onPointerLeave={onPaintPointerUp}
    />
  );
}

function createPreviewMaterial(mode: PreviewMode, maps: MaterialMaps, canUseTextureMap = true, alpha = 1): THREE.Material {
  if (mode === "normals") {
    return new THREE.MeshNormalMaterial({
      opacity: alpha,
      side: THREE.DoubleSide,
      transparent: alpha < 0.999,
    });
  }

  const useTextureMap = Boolean(canUseTextureMap && maps.atlasMap && maps.atlasTileCount > 0 && mode !== "clay");
  const usePaintMap = Boolean(canUseTextureMap && maps.paintMap && maps.atlasTileCount > 0);
  const useCoverage = Boolean(canUseTextureMap && mode === "coverage");
  const defines: Record<string, string> = {};
  if (useTextureMap || usePaintMap || useCoverage) {
    defines.USE_UV_COORDS = "";
  }
  if (useTextureMap) {
    defines.USE_TEXTURE_MAP = "";
  }
  if (usePaintMap) {
    defines.USE_PAINT_MAP = "";
  }
  if (useCoverage) {
    defines.USE_COVERAGE = "";
  }

  return new THREE.ShaderMaterial({
    defines,
    uniforms: {
      baseColor: { value: new THREE.Color(useTextureMap || useCoverage ? "#ffffff" : "#f0f0ec") },
      previewMode: { value: mode === "lit" ? 0 : mode === "flat" ? 1 : mode === "clay" ? 2 : 3 },
      previewAlpha: { value: alpha },
      previewAtlas: { value: maps.atlasMap },
      paintAtlas: { value: maps.paintMap },
      atlasColumns: { value: maps.atlasColumns },
      atlasRows: { value: maps.atlasRows },
      atlasTileCount: { value: maps.atlasTileCount },
    },
    vertexShader: PREVIEW_VERTEX_SHADER,
    fragmentShader: PREVIEW_FRAGMENT_SHADER,
    side: THREE.DoubleSide,
    transparent: alpha < 0.999,
    depthWrite: alpha >= 0.999,
  });
}

function PlainFbx({
  fbx,
  mode,
  showWireframe,
  showXray,
  onEditPointerDown,
}: {
  fbx: THREE.Group;
  mode: PreviewMode;
  showWireframe?: boolean;
  showXray?: boolean;
  onEditPointerDown?: (event: ThreeEvent<PointerEvent>) => void;
}) {
  useEditWireframeOverlay(fbx, Boolean(showWireframe), Boolean(showXray));

  useEffect(() => {
    const originalMaterials = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
    const previewMaterials: THREE.Material[] = [];

    fbx.traverse((child: THREE.Object3D) => {
      if (child instanceof THREE.Mesh) {
        preparePreviewMesh(child);
        const material = createPreviewMaterial(
          mode,
          {
            colorMap: null,
            atlasMap: null,
            paintMap: null,
            atlasColumns: UDIM_ATLAS_COLUMNS,
            atlasRows: 1,
            atlasTileCount: 0,
            normalMap: null,
            roughnessMap: null,
            metalnessMap: null,
            aoMap: null,
          },
          mode === "coverage" ? Boolean(child.geometry?.attributes?.uv) : false,
          showXray ? 0.42 : 1,
        );
        preparePreviewMaterialForMesh(child, material, Boolean(showXray));
        previewMaterials.push(material);
        originalMaterials.set(child, child.material);
        child.material = material;
      }
    });

    return () => {
      originalMaterials.forEach((originalMaterial, mesh) => {
        if (previewMaterials.includes(mesh.material as THREE.Material)) {
          mesh.material = originalMaterial;
        }
      });
      previewMaterials.forEach((material) => material.dispose());
    };
  }, [fbx, mode, showXray]);

  return <primitive object={fbx} onPointerDown={onEditPointerDown} />;
}

interface LoadedModelContentProps {
  model: THREE.Group;
  modelName: string;
  textures: TextureAsset[];
  mode: PreviewMode;
  flipY: boolean;
  paintMap: THREE.Texture | null;
  hiddenModelNodeIds: Set<string>;
  showWireframe?: boolean;
  showXray?: boolean;
  onEditPointerDown?: (event: ThreeEvent<PointerEvent>) => void;
  onPaintPointerDown?: (event: ThreeEvent<PointerEvent>) => void;
  onPaintPointerMove?: (event: ThreeEvent<PointerEvent>) => void;
  onPaintPointerUp?: (event: ThreeEvent<PointerEvent>) => void;
  onModelNodesChange?: (nodes: ModelOutlinerNode[]) => void;
  onUvLayout?: (segments: UvSegment[]) => void;
  onModelSize?: (maxSize: number, height: number) => void;
  onModelObjectChange?: (model: THREE.Object3D | null) => void;
  onLoadError?: (message: string) => void;
}

interface LoadedModelProps extends Omit<LoadedModelContentProps, "model"> {
  url: string;
  fileType: ModelFileType;
}

class ModelErrorBoundary extends Component<
  {
    children: ReactNode;
    fallback: ReactNode;
    resetKey: string;
    onError?: (message: string) => void;
  },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    this.props.onError?.(getErrorMessage(error));
  }

  componentDidUpdate(previousProps: { resetKey: string }) {
    if (previousProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }

    return this.props.children;
  }
}

function LoadedModelContent({
  model,
  modelName,
  textures,
  mode,
  flipY,
  paintMap,
  hiddenModelNodeIds,
  showWireframe,
  showXray,
  onEditPointerDown,
  onPaintPointerDown,
  onPaintPointerMove,
  onPaintPointerUp,
  onModelNodesChange,
  onUvLayout,
  onModelSize,
  onModelObjectChange,
  onLoadError,
}: LoadedModelContentProps) {
  useEffect(() => {
    onModelObjectChange?.(model);
    return () => {
      onModelObjectChange?.(null);
    };
  }, [model, onModelObjectChange]);

  useEffect(() => {
    try {
      onModelNodesChange?.(buildModelOutlinerNodes(model, modelName));
      onUvLayout?.(extractUvSegments(model));
      const bounds = new THREE.Box3().setFromObject(model);
      const size = bounds.getSize(new THREE.Vector3());
      onModelSize?.(Math.max(size.x, size.y, size.z), size.y);
    } catch (error) {
      onModelNodesChange?.([]);
      onUvLayout?.([]);
      onLoadError?.(getErrorMessage(error));
    }
  }, [model, modelName, onLoadError, onModelNodesChange, onModelSize, onUvLayout]);

  useEffect(() => {
    applyModelVisibility(model, hiddenModelNodeIds);
  }, [hiddenModelNodeIds, model]);

  return hasPreviewMaps(textures) || paintMap ? (
    <TexturedFbx
      fbx={model}
      textures={textures}
      mode={mode}
      flipY={flipY}
      paintMap={paintMap}
      showWireframe={showWireframe}
      showXray={showXray}
      onEditPointerDown={onEditPointerDown}
      onPaintPointerDown={onPaintPointerDown}
      onPaintPointerMove={onPaintPointerMove}
      onPaintPointerUp={onPaintPointerUp}
    />
  ) : (
    <PlainFbx
      fbx={model}
      mode={mode}
      showWireframe={showWireframe}
      showXray={showXray}
      onEditPointerDown={onEditPointerDown}
    />
  );
}

function LoadedFbxModel(props: Omit<LoadedModelProps, "fileType">) {
  const model = useLoader(FBXLoader, props.url) as THREE.Group;
  return <LoadedModelContent {...props} model={model} />;
}

function LoadedObjModel(props: Omit<LoadedModelProps, "fileType">) {
  const model = useLoader(OBJLoader, props.url) as THREE.Group;
  return <LoadedModelContent {...props} model={model} />;
}

function LoadedModel({ fileType, ...props }: LoadedModelProps) {
  return fileType === "obj" ? <LoadedObjModel {...props} /> : <LoadedFbxModel {...props} />;
}

function createUniqueUvBoxGeometry(): THREE.BoxGeometry {
  const geometry = new THREE.BoxGeometry(2, 2, 2);
  const position = geometry.attributes.position as THREE.BufferAttribute;
  const normal = geometry.attributes.normal as THREE.BufferAttribute;
  const uv = geometry.attributes.uv as THREE.BufferAttribute;

  for (let index = 0; index < uv.count; index += 1) {
    const normalX = normal.getX(index);
    const normalY = normal.getY(index);
    const normalZ = normal.getZ(index);
    const positionX = position.getX(index);
    const positionY = position.getY(index);
    const positionZ = position.getZ(index);
    let faceSlot = 0;
    let localU = 0;
    let localV = 0;

    if (Math.abs(normalX) > 0.5) {
      faceSlot = normalX > 0 ? 0 : 1;
      localU = normalX > 0 ? (1 - (positionZ + 1) / 2) : (positionZ + 1) / 2;
      localV = (positionY + 1) / 2;
    } else if (Math.abs(normalY) > 0.5) {
      faceSlot = normalY > 0 ? 2 : 3;
      localU = (positionX + 1) / 2;
      localV = normalY > 0 ? (1 - (positionZ + 1) / 2) : (positionZ + 1) / 2;
    } else {
      faceSlot = normalZ > 0 ? 4 : 5;
      localU = normalZ > 0 ? (positionX + 1) / 2 : (1 - (positionX + 1) / 2);
      localV = (positionY + 1) / 2;
    }

    const column = faceSlot % 3;
    const row = Math.floor(faceSlot / 3);
    uv.setXY(index, (column + localU) / 3, (row + localV) / 2);
  }

  uv.needsUpdate = true;
  return geometry;
}

function FallbackObject({
  textures,
  mode,
  flipY,
  paintMap,
  showWireframe,
  showXray,
  onEditPointerDown,
  onPaintPointerDown,
  onPaintPointerMove,
  onPaintPointerUp,
  onFallbackObjectChange,
}: {
  textures: TextureAsset[];
  mode: PreviewMode;
  flipY: boolean;
  paintMap: THREE.Texture | null;
  showWireframe?: boolean;
  showXray?: boolean;
  onEditPointerDown?: (event: ThreeEvent<PointerEvent>) => void;
  onPaintPointerDown?: (event: ThreeEvent<PointerEvent>) => void;
  onPaintPointerMove?: (event: ThreeEvent<PointerEvent>) => void;
  onPaintPointerUp?: (event: ThreeEvent<PointerEvent>) => void;
  onFallbackObjectChange?: (object: THREE.Object3D | null) => void;
}) {
  const boxGeometry = useMemo(() => createUniqueUvBoxGeometry(), []);
  const meshRef = useRef<THREE.Mesh | null>(null);

  useEffect(() => {
    return () => {
      boxGeometry.dispose();
    };
  }, [boxGeometry]);

  useEffect(() => {
    onFallbackObjectChange?.(meshRef.current);
    return () => {
      onFallbackObjectChange?.(null);
    };
  }, [onFallbackObjectChange]);

  return (
    <mesh
      ref={meshRef}
      castShadow
      receiveShadow
      onPointerDown={onEditPointerDown ?? onPaintPointerDown}
      onPointerMove={onPaintPointerMove}
      onPointerUp={onPaintPointerUp}
      onPointerLeave={onPaintPointerUp}
    >
      <primitive attach="geometry" object={boxGeometry} />
      {hasPreviewMaps(textures) ? (
        <PreviewMaterial textures={textures} mode={mode} flipY={flipY} paintMap={paintMap} />
      ) : (
        <PreviewMaterial textures={[]} mode={mode} flipY={flipY} paintMap={paintMap} />
      )}
      {showWireframe ? (
        <lineSegments renderOrder={30} raycast={() => null}>
          <wireframeGeometry args={[boxGeometry]} />
          <lineBasicMaterial
            color={showXray ? "#f59e0b" : "#000000"}
            depthTest={!showXray}
            depthWrite={false}
            opacity={showXray ? 0.78 : 0.88}
            transparent
          />
        </lineSegments>
      ) : null}
    </mesh>
  );
}

function getGridDivisions(gridSize: number): number {
  return Math.max(16, Math.min(96, Math.round(gridSize)));
}

function ViewportGrid({ gridSize, y }: { gridSize: number; y: number }) {
  const gridRef = useRef<THREE.GridHelper>(null);

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) {
      return;
    }

    const materials = Array.isArray(grid.material) ? grid.material : [grid.material];
    materials.forEach((material) => {
      material.transparent = true;
      material.opacity = 0.42;
      material.depthWrite = false;
      material.needsUpdate = true;
    });
  }, [gridSize]);

  return (
    <gridHelper
      ref={gridRef}
      args={[gridSize, getGridDivisions(gridSize), "#747474", "#525252"]}
      position={[0, y, 0]}
    />
  );
}

function BlenderOrbitControls() {
  const controlsRef = useRef<ElementRef<typeof OrbitControls> | null>(null);
  const modifierKeysRef = useRef({ control: false, shift: false });
  const navigationDragRef = useRef<{
    mode: "pan" | "dolly";
    lastX: number;
    lastY: number;
  } | null>(null);

  useEffect(() => {
    const controls = controlsRef.current;
    const domElement = controls?.domElement;
    if (!controls || !domElement) {
      return undefined;
    }
    const activeControls = controls;
    const activeDomElement = domElement;

    function applyPan(deltaX: number, deltaY: number) {
      const camera = activeControls.object as THREE.PerspectiveCamera | THREE.OrthographicCamera;
      const elementHeight = Math.max(1, activeDomElement.clientHeight);
      const pan = new THREE.Vector3();
      const xAxis = new THREE.Vector3();
      const yAxis = new THREE.Vector3();
      xAxis.setFromMatrixColumn(camera.matrix, 0);
      yAxis.setFromMatrixColumn(camera.matrix, 1);

      if (camera instanceof THREE.PerspectiveCamera) {
        const offset = camera.position.clone().sub(activeControls.target);
        const targetDistance = offset.length() * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
        xAxis.multiplyScalar((-2 * deltaX * targetDistance) / elementHeight);
        yAxis.multiplyScalar((2 * deltaY * targetDistance) / elementHeight);
      } else {
        xAxis.multiplyScalar((-deltaX * (camera.right - camera.left)) / (camera.zoom * activeDomElement.clientWidth));
        yAxis.multiplyScalar((deltaY * (camera.top - camera.bottom)) / (camera.zoom * elementHeight));
      }

      pan.copy(xAxis).add(yAxis);
      camera.position.add(pan);
      activeControls.target.add(pan);
      activeControls.update();
    }

    function applyDolly(deltaY: number) {
      const camera = activeControls.object as THREE.PerspectiveCamera | THREE.OrthographicCamera;
      const scale = Math.exp(deltaY * 0.006);

      if (camera instanceof THREE.PerspectiveCamera) {
        const offset = camera.position.clone().sub(activeControls.target).multiplyScalar(scale);
        camera.position.copy(activeControls.target).add(offset);
      } else {
        camera.zoom = clamp(camera.zoom / scale, 0.05, 100);
        camera.updateProjectionMatrix();
      }

      activeControls.update();
    }

    function stopForManualNavigation(event: globalThis.MouseEvent | PointerEvent) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    }

    function startManualNavigation(event: globalThis.MouseEvent | PointerEvent) {
      if (event.button !== 1) {
        return false;
      }

      if (event.target !== activeDomElement) {
        return false;
      }

      const wantsDolly = event.ctrlKey || modifierKeysRef.current.control;
      const wantsPan = event.shiftKey || modifierKeysRef.current.shift;

      if (!wantsDolly && !wantsPan) {
        activeControls.mouseButtons.MIDDLE = THREE.MOUSE.ROTATE;
        return false;
      }

      navigationDragRef.current = {
        mode: wantsDolly ? "dolly" : "pan",
        lastX: event.clientX,
        lastY: event.clientY,
      };
      stopForManualNavigation(event);
      return true;
    }

    function handlePointerDown(event: PointerEvent) {
      startManualNavigation(event);
    }

    function handleMouseDown(event: globalThis.MouseEvent) {
      startManualNavigation(event);
    }

    function updateManualNavigation(event: globalThis.MouseEvent | PointerEvent) {
      const dragState = navigationDragRef.current;
      if (!dragState) {
        return false;
      }

      const deltaX = event.clientX - dragState.lastX;
      const deltaY = event.clientY - dragState.lastY;
      dragState.lastX = event.clientX;
      dragState.lastY = event.clientY;
      stopForManualNavigation(event);

      if (dragState.mode === "dolly") {
        applyDolly(deltaY);
        return;
      }

      applyPan(deltaX, deltaY);
      return true;
    }

    function handlePointerMove(event: PointerEvent) {
      updateManualNavigation(event);
    }

    function handleMouseMove(event: globalThis.MouseEvent) {
      updateManualNavigation(event);
    }

    function finishManualNavigation(event: globalThis.MouseEvent | PointerEvent) {
      if (event.button !== 1 || !navigationDragRef.current) {
        return false;
      }

      navigationDragRef.current = null;
      stopForManualNavigation(event);
      return true;
    }

    function handlePointerUp(event: PointerEvent) {
      finishManualNavigation(event);
    }

    function handleMouseUp(event: globalThis.MouseEvent) {
      finishManualNavigation(event);
    }

    function handleAuxClick(event: globalThis.MouseEvent | PointerEvent) {
      if (event.button === 1 && event.target === activeDomElement) {
        stopForManualNavigation(event);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Control") {
        modifierKeysRef.current.control = true;
      }
      if (event.key === "Shift") {
        modifierKeysRef.current.shift = true;
      }
    }

    function handleKeyUp(event: KeyboardEvent) {
      if (event.key === "Control") {
        modifierKeysRef.current.control = false;
      }
      if (event.key === "Shift") {
        modifierKeysRef.current.shift = false;
      }
    }

    function handleBlur() {
      modifierKeysRef.current.control = false;
      modifierKeysRef.current.shift = false;
      navigationDragRef.current = null;
    }

    window.addEventListener("pointerdown", handlePointerDown, { capture: true });
    window.addEventListener("pointermove", handlePointerMove, { capture: true });
    window.addEventListener("pointerup", handlePointerUp, { capture: true });
    window.addEventListener("pointercancel", handlePointerUp, { capture: true });
    window.addEventListener("mousedown", handleMouseDown, { capture: true });
    window.addEventListener("mousemove", handleMouseMove, { capture: true });
    window.addEventListener("mouseup", handleMouseUp, { capture: true });
    window.addEventListener("auxclick", handleAuxClick, { capture: true });
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, { capture: true });
      window.removeEventListener("pointermove", handlePointerMove, { capture: true });
      window.removeEventListener("pointerup", handlePointerUp, { capture: true });
      window.removeEventListener("pointercancel", handlePointerUp, { capture: true });
      window.removeEventListener("mousedown", handleMouseDown, { capture: true });
      window.removeEventListener("mousemove", handleMouseMove, { capture: true });
      window.removeEventListener("mouseup", handleMouseUp, { capture: true });
      window.removeEventListener("auxclick", handleAuxClick, { capture: true });
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, []);

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      enableDamping
      screenSpacePanning
      zoomToCursor
      mouseButtons={{
        LEFT: undefined,
        MIDDLE: THREE.MOUSE.ROTATE,
        RIGHT: undefined,
      }}
      touches={{
        ONE: THREE.TOUCH.ROTATE,
        TWO: THREE.TOUCH.DOLLY_PAN,
      }}
    />
  );
}

export function ModelViewer({
  textures,
  fbxInputRef,
  hiddenModelNodeIds = EMPTY_HIDDEN_MODEL_NODE_IDS,
  onModelNodesChange,
  onModelLoaded,
  onModelUvLayout,
  onViewportModeChange,
  editSelectionMode: controlledEditSelectionMode,
  onEditSelectionModeChange,
  onSelectedUvSegmentsChange,
  onSelectedFaceCountChange,
  uvEditCommand,
  onPaintLayerChange,
  modelExportRequest = 0,
}: ModelViewerProps) {
  const [modelUrl, setModelUrl] = useState<string | null>(null);
  const [modelName, setModelName] = useState("Imported Model");
  const [modelFileType, setModelFileType] = useState<ModelFileType>("fbx");
  const [previewMode, setPreviewMode] = useState<PreviewMode>("lit");
  const [viewportMode, setViewportMode] = useState<ViewportMode>("object");
  const [editTool, setEditTool] = useState<EditTool>("select-box");
  const [internalEditSelectionMode, setInternalEditSelectionMode] = useState<EditSelectionMode>("faces");
  const [selectedFaceMarkers, setSelectedFaceMarkers] = useState<SelectedFaceMarker[]>([]);
  const [selectedUvEditTargets, setSelectedUvEditTargets] = useState<UvEditTarget[]>([]);
  const [selectedUvSegments, setSelectedUvSegments] = useState<UvSegment[]>([]);
  const [isEditXrayEnabled, setIsEditXrayEnabled] = useState(false);
  const [isEditToolbarOpen, setIsEditToolbarOpen] = useState(true);
  const [isViewportModeMenuOpen, setIsViewportModeMenuOpen] = useState(false);
  const [isTexturePaintPanelOpen, setIsTexturePaintPanelOpen] = useState(false);
  const [activeBrush, setActiveBrush] = useState<(typeof BRUSH_PRESETS)[number]>("Paint Hard");
  const [brushSize, setBrushSize] = useState(80);
  const [brushStrength, setBrushStrength] = useState(1);
  const [primaryColor, setPrimaryColor] = useState("#ff3030");
  const [secondaryColor, setSecondaryColor] = useState("#000000");
  const [blendMode, setBlendMode] = useState("Mix");
  const [stickerUrl, setStickerUrl] = useState<string | null>(null);
  const [stickerImage, setStickerImage] = useState<HTMLImageElement | null>(null);
  const [symmetryEnabled, setSymmetryEnabled] = useState(false);
  const [pressureEnabled, setPressureEnabled] = useState(true);
  const [brushAdjustMode, setBrushAdjustMode] = useState<BrushAdjustMode>(null);
  const [brushAdjustOrigin, setBrushAdjustOrigin] = useState<{ x: number; value: number } | null>(null);
  const [brushAdjustHud, setBrushAdjustHud] = useState<{ x: number; y: number } | null>(null);
  const [paintContextMenu, setPaintContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [isPainting, setIsPainting] = useState(false);
  const [flipY, setFlipY] = useState(true);
  const [cameraResetVersion, setCameraResetVersion] = useState(0);
  const [gridSize, setGridSize] = useState(8);
  const [gridY, setGridY] = useState(-1.04);
  const [isModelFileOver, setIsModelFileOver] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [brushCursor, setBrushCursor] = useState({ x: 0, y: 0, visible: false });
  const localFbxInputRef = useRef<HTMLInputElement | null>(null);
  const stickerInputRef = useRef<HTMLInputElement | null>(null);
  const canvasShellRef = useRef<HTMLDivElement | null>(null);
  const paintLayerRef = useRef<PaintLayer | null>(null);
  const paintRaycasterRef = useRef(new THREE.Raycaster());
  const lastPaintHitRef = useRef<PaintUvHit | null>(null);
  const activePaintStrokeRef = useRef<{ before: PaintHistoryFrame; painted: boolean } | null>(null);
  const paintUndoStackRef = useRef<PaintHistoryFrame[]>([]);
  const paintRedoStackRef = useRef<PaintHistoryFrame[]>([]);
  const uvUndoStackRef = useRef<UvHistoryEntry[]>([]);
  const uvRedoStackRef = useRef<UvHistoryEntry[]>([]);
  const lastUvHistoryGroupRef = useRef<number | undefined>(undefined);
  const lastSelectAllKeyRef = useRef(0);
  const lastHandledUvEditCommandIdRef = useRef<number | null>(null);
  const currentModelObjectRef = useRef<THREE.Object3D | null>(null);
  const handleModelObjectChange = useCallback((object: THREE.Object3D | null) => {
    currentModelObjectRef.current = object;
  }, []);

  const boundsKey = `${modelUrl ?? "fallback"}-${cameraResetVersion}`;
  const activeFbxInputRef = fbxInputRef ?? localFbxInputRef;
  const paintColorTiles = useMemo(() => getOrderedColorTiles(textures), [textures]);
  const paintTileTextureIds = useMemo(() => paintColorTiles.map((texture) => texture.id), [paintColorTiles]);
  const paintTileCount = useMemo(() => Math.max(1, paintColorTiles.length), [paintColorTiles.length]);
  const paintLayer = usePaintLayerTexture(paintTileCount, paintTileTextureIds);
  const selectedFaceCount = selectedUvEditTargets.reduce((total, target) => total + (target.vertexIndices?.length ?? target.triangleIndices.length), 0);
  const editSelectionMode = controlledEditSelectionMode ?? internalEditSelectionMode;
  const setEditSelectionMode = useCallback(
    (mode: EditSelectionMode) => {
      setInternalEditSelectionMode(mode);
      onEditSelectionModeChange?.(mode);
    },
    [onEditSelectionModeChange],
  );
  const invertEditSelection = useCallback(() => {
    const root = currentModelObjectRef.current;
    if (!root) {
      return;
    }

    const selectedKeys = getSelectionKeysForTargets(root, editSelectionMode, selectedUvEditTargets);
    const invertedItems = getAllEditSelectionItems(root, editSelectionMode).filter((item) => !selectedKeys.has(item.key));

    setSelectedFaceMarkers(invertedItems.flatMap((item) => item.markers));
    setSelectedUvEditTargets(invertedItems.map((item) => item.editTarget));
    setSelectedUvSegments(invertedItems.flatMap((item) => item.uvSegments));
  }, [editSelectionMode, selectedUvEditTargets]);

  const clearEditSelection = useCallback(() => {
    setSelectedFaceMarkers([]);
    setSelectedUvEditTargets([]);
    setSelectedUvSegments([]);
  }, []);

  const selectAllEditSelection = useCallback(() => {
    const root = currentModelObjectRef.current;
    if (!root) {
      return;
    }

    const allItems = getAllEditSelectionItems(root, editSelectionMode);
    setSelectedFaceMarkers(allItems.flatMap((item) => item.markers));
    setSelectedUvEditTargets(allItems.map((item) => item.editTarget));
    setSelectedUvSegments(allItems.flatMap((item) => item.uvSegments));
  }, [editSelectionMode]);

  useEffect(() => {
    onSelectedUvSegmentsChange?.(selectedUvSegments);
  }, [onSelectedUvSegmentsChange, selectedUvSegments]);

  useEffect(() => {
    onSelectedFaceCountChange?.(selectedFaceCount);
  }, [onSelectedFaceCountChange, selectedFaceCount]);

  useEffect(() => {
    onViewportModeChange?.(viewportMode);
  }, [onViewportModeChange, viewportMode]);

  useEffect(() => {
    if (modelExportRequest <= 0 || !currentModelObjectRef.current) {
      return;
    }

    const exporter = new OBJExporter();
    currentModelObjectRef.current.updateMatrixWorld(true);
    const exportObject = prepareModelCloneForExport(currentModelObjectRef.current.clone(true));
    const output = exporter.parse(exportObject);
    const blob = new Blob([output], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${modelName.trim() || "model"}_uv.obj`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [modelExportRequest, modelName]);

  useEffect(() => {
    if (!uvEditCommand) {
      return;
    }

    if (lastHandledUvEditCommandIdRef.current === uvEditCommand.id) {
      return;
    }
    lastHandledUvEditCommandIdRef.current = uvEditCommand.id;

    function refreshUvViews() {
      const root = currentModelObjectRef.current;
      if (!root) {
        return;
      }

      setSelectedUvSegments(getUvSegmentsForEditTargets(root, selectedUvEditTargets));
      onModelUvLayout?.(extractUvSegments(root));
    }

    function restoreHistory(direction: "undo" | "redo") {
      const sourceStack = direction === "undo" ? uvUndoStackRef.current : uvRedoStackRef.current;
      const destinationStack = direction === "undo" ? uvRedoStackRef.current : uvUndoStackRef.current;
      const entry = sourceStack.pop();
      if (!entry) {
        return;
      }

      const redoSnapshots = captureUvSnapshots(currentModelObjectRef.current, entry.snapshots.map((snapshot) => snapshot.meshUuid));
      const restored = restoreUvSnapshots(currentModelObjectRef.current, entry.snapshots);
      if (!restored) {
        return;
      }

      destinationStack.push({ groupId: entry.groupId, snapshots: redoSnapshots });
      if (destinationStack.length > UV_HISTORY_LIMIT) {
        destinationStack.shift();
      }
      lastUvHistoryGroupRef.current = undefined;
      refreshUvViews();
    }

    if (uvEditCommand.type === "undo") {
      restoreHistory("undo");
      return;
    }

    if (uvEditCommand.type === "redo") {
      restoreHistory("redo");
      return;
    }

    if (selectedUvEditTargets.length === 0) {
      return;
    }

    const editedMeshUuids = prepareEditableUvTargets(currentModelObjectRef.current, selectedUvEditTargets);
    const shouldCaptureHistory =
      uvEditCommand.historyGroupId == null || uvEditCommand.historyGroupId !== lastUvHistoryGroupRef.current;
    if (shouldCaptureHistory) {
      const snapshots = captureUvSnapshots(currentModelObjectRef.current, editedMeshUuids);
      if (snapshots.length > 0) {
        uvUndoStackRef.current.push({ groupId: uvEditCommand.historyGroupId, snapshots });
        if (uvUndoStackRef.current.length > UV_HISTORY_LIMIT) {
          uvUndoStackRef.current.shift();
        }
        uvRedoStackRef.current = [];
      }
      lastUvHistoryGroupRef.current = uvEditCommand.historyGroupId;
    }

    const nextSelectedSegments = applyUvEditToModel(currentModelObjectRef.current, selectedUvEditTargets, uvEditCommand);
    if (!nextSelectedSegments) {
      return;
    }

    setSelectedUvSegments(nextSelectedSegments);
    if (currentModelObjectRef.current) {
      onModelUvLayout?.(extractUvSegments(currentModelObjectRef.current));
    }
  }, [onModelUvLayout, selectedUvEditTargets, uvEditCommand]);

  useEffect(() => {
    paintLayerRef.current = paintLayer;
    onPaintLayerChange?.(paintLayer?.exportLayer ?? null);
    return () => {
      if (paintLayerRef.current === paintLayer) {
        paintLayerRef.current = null;
        onPaintLayerChange?.(null);
      }
    };
  }, [onPaintLayerChange, paintLayer]);

  useEffect(() => {
    activePaintStrokeRef.current = null;
    paintUndoStackRef.current = [];
    paintRedoStackRef.current = [];
  }, [paintLayer]);

  const handleModelSize = useCallback((maxSize: number, height: number) => {
    if (!Number.isFinite(maxSize) || maxSize <= 0) {
      setGridSize(8);
      setGridY(-1.04);
      return;
    }

    const safeHeight = Number.isFinite(height) && height > 0 ? height : maxSize;
    const floorOffset = Math.max(0.025, Math.min(0.2, maxSize * 0.015));
    setGridSize(Math.max(8, Math.ceil(maxSize * 2)));
    setGridY(-(safeHeight / 2 + floorOffset));
  }, []);

  const handleModelError = useCallback(
    (message: string) => {
      setModelError(message);
      onModelNodesChange?.([]);
      onModelLoaded?.(false);
      onModelUvLayout?.([]);
    },
    [onModelLoaded, onModelNodesChange, onModelUvLayout],
  );

  function getModelFileType(file: File): ModelFileType | null {
    const lowerName = file.name.toLowerCase();
    if (lowerName.endsWith(".fbx")) {
      return "fbx";
    }
    if (lowerName.endsWith(".obj")) {
      return "obj";
    }
    return null;
  }

  function importModelFile(file: File) {
    const fileType = getModelFileType(file);
    if (!fileType) {
      setModelError("Formato no compatible. Usa FBX u OBJ.");
      return;
    }

    if (modelUrl) {
      URL.revokeObjectURL(modelUrl);
    }

    setModelError(null);
    setModelName(file.name.replace(/\.[^.]+$/, "") || "Imported Model");
    setModelFileType(fileType);
    currentModelObjectRef.current = null;
    setModelUrl(URL.createObjectURL(file));
    onModelNodesChange?.([]);
    onModelLoaded?.(true);
    onModelUvLayout?.([]);
    setSelectedFaceMarkers([]);
    setSelectedUvEditTargets([]);
    setSelectedUvSegments([]);
    uvUndoStackRef.current = [];
    uvRedoStackRef.current = [];
    lastUvHistoryGroupRef.current = undefined;
    setGridSize(8);
    setGridY(-1.04);
    setCameraResetVersion((version) => version + 1);
  }

  function handleFbxChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) {
      importModelFile(file);
      event.target.value = "";
    }
  }

  function handleStickerImageChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const nextUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      setStickerUrl((currentUrl) => {
        if (currentUrl) {
          URL.revokeObjectURL(currentUrl);
        }
        return nextUrl;
      });
      setStickerImage(image);
      setActiveBrush("Sticker");
    };
    image.onerror = () => {
      URL.revokeObjectURL(nextUrl);
    };
    image.src = nextUrl;
    event.target.value = "";
  }

  function hasModelFileDrag(event: DragEvent<HTMLDivElement>): boolean {
    return Array.from(event.dataTransfer.types).includes("Files");
  }

  function handleModelDragOver(event: DragEvent<HTMLDivElement>) {
    if (!hasModelFileDrag(event)) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsModelFileOver(true);
  }

  function handleModelDrop(event: DragEvent<HTMLDivElement>) {
    if (!hasModelFileDrag(event)) {
      return;
    }

    event.preventDefault();
    setIsModelFileOver(false);
    const file = Array.from(event.dataTransfer.files).find((item) => Boolean(getModelFileType(item)));
    if (file) {
      importModelFile(file);
    }
  }

  function stopMiddleMouseAutoscroll(event: ReactMouseEvent<HTMLDivElement>) {
    if (event.button !== 1) {
      return;
    }

    event.preventDefault();
  }

  function handleViewportModeSelect(mode: ViewportMode) {
    setViewportMode(mode);
    setIsViewportModeMenuOpen(false);
    setPaintContextMenu(null);
    setBrushAdjustMode(null);
    if (mode === "texture-paint") {
      setIsTexturePaintPanelOpen(true);
    } else {
      setIsTexturePaintPanelOpen(false);
    }

    if (mode !== "edit") {
      setIsEditXrayEnabled(false);
    }
  }

  const handleEditPointerDown = useCallback(
    (event: ThreeEvent<PointerEvent>) => {
      if (viewportMode !== "edit" || event.nativeEvent.button !== 0) {
        return;
      }

      event.stopPropagation();
      const selection = getSelectedFaceMarkers(event, editSelectionMode);
      if (!selection) {
        return;
      }

      const shouldAdd = event.nativeEvent.shiftKey;
      setSelectedFaceMarkers((currentSelection) => {
        const nextSelection = shouldAdd ? [...currentSelection] : [];

        selection.markers.forEach((marker) => {
          const existingIndex = nextSelection.findIndex((currentMarker) => currentMarker.key === marker.key);
          if (existingIndex >= 0 && shouldAdd) {
            nextSelection.splice(existingIndex, 1);
            return;
          }

          if (existingIndex >= 0) {
            nextSelection.splice(existingIndex, 1);
          }

          nextSelection.push(marker);
        });

        return nextSelection;
      });

      setSelectedUvSegments((currentSegments) => (
        shouldAdd ? [...currentSegments, ...selection.uvSegments] : selection.uvSegments
      ));
      setSelectedUvEditTargets((currentTargets) => (
        shouldAdd ? [...currentTargets, selection.editTarget] : [selection.editTarget]
      ));
    },
    [editSelectionMode, viewportMode],
  );

  function swapPaintColors() {
    setPrimaryColor(secondaryColor);
    setSecondaryColor(primaryColor);
  }

  function getViewportLocalPoint(clientX: number, clientY: number) {
    const viewportBounds = canvasShellRef.current?.getBoundingClientRect();
    if (!viewportBounds) {
      return { x: clientX, y: clientY };
    }

    return {
      x: clientX - viewportBounds.left,
      y: clientY - viewportBounds.top,
    };
  }

  function isViewportToolTarget(target: EventTarget | null): boolean {
    return target instanceof HTMLElement && Boolean(target.closest(
      ".texture-paint-panel, .paint-brush-shelf, .viewport-mode-menu, .paint-context-menu, .brush-adjust-hud, .edit-mode-toolbar, .edit-toolbar-tab, .edit-mode-status",
    ));
  }

  function updateBrushCursor(event: ReactPointerEvent<HTMLDivElement>) {
    if (viewportMode !== "texture-paint" || isViewportToolTarget(event.target)) {
      setBrushCursor((current) => (current.visible ? { ...current, visible: false } : current));
      return;
    }

    const point = getViewportLocalPoint(event.clientX, event.clientY);
    setBrushCursor({ ...point, visible: true });
  }

  function startBrushAdjust(mode: Exclude<BrushAdjustMode, null>, x: number, y: number) {
    const localPoint = getViewportLocalPoint(x, y);
    setBrushAdjustMode(mode);
    setBrushAdjustOrigin({ x, value: mode === "size" ? brushSize : brushStrength });
    setBrushAdjustHud(localPoint);
    setPaintContextMenu(null);
  }

  function handleViewportPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    updateBrushCursor(event);

    if (!brushAdjustMode || !brushAdjustOrigin) {
      return;
    }

    event.preventDefault();
    const delta = event.clientX - brushAdjustOrigin.x;
    setBrushAdjustHud(getViewportLocalPoint(event.clientX, event.clientY));

    if (brushAdjustMode === "size") {
      setBrushSize(Math.round(clamp(brushAdjustOrigin.value + delta, 1, 512)));
      return;
    }

    setBrushStrength(Number(clamp(brushAdjustOrigin.value + delta / 300, 0, 1).toFixed(3)));
  }

  function handleViewportPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (brushAdjustMode) {
      event.preventDefault();
      event.stopPropagation();
      setBrushAdjustMode(null);
      setBrushAdjustOrigin(null);
      setBrushAdjustHud(null);
      return;
    }

    if (paintContextMenu && !(event.target instanceof HTMLElement && event.target.closest(".paint-context-menu"))) {
      setPaintContextMenu(null);
    }
  }

  function handleViewportContextMenu(event: ReactMouseEvent<HTMLDivElement>) {
    event.preventDefault();

    if (viewportMode !== "texture-paint") {
      return;
    }

    const viewportBounds = canvasShellRef.current?.getBoundingClientRect();
    if (!viewportBounds) {
      return;
    }

    setPaintContextMenu({
      x: clamp(event.clientX - viewportBounds.left, 8, viewportBounds.width - 238),
      y: clamp(event.clientY - viewportBounds.top, 8, viewportBounds.height - 238),
    });
  }

  function getPointerPressure(event: ThreeEvent<PointerEvent>) {
    const pointerEvent = event.nativeEvent;
    if (!pressureEnabled || !pointerEvent || pointerEvent.pressure <= 0) {
      return 1;
    }

    return clamp(pointerEvent.pressure, 0.05, 1);
  }

  const paintAtSurface = useCallback(
    (event: ThreeEvent<PointerEvent>, pressure = 1) => {
      const layer = paintLayerRef.current;
      const canvasElement = canvasShellRef.current?.querySelector("canvas");
      const canvasBounds = canvasElement?.getBoundingClientRect();
      if (!layer || !canvasBounds) {
        return;
      }

      const activeLayer = layer;
      const activeCanvasBounds = canvasBounds;
      const alpha = clamp(brushStrength * pressure, 0, 1);
      const paintRgb = hexToRgb(primaryColor);
      const isEraser = activeBrush === "Erase" || blendMode === "Erase Alpha";
      const isHardBrush = activeBrush === "Paint Hard" || activeBrush === "Pixel Art" || activeBrush === "Erase";
      const isStickerBrush = activeBrush === "Sticker";
      if (isStickerBrush && !stickerImage) {
        return;
      }
      const raycaster = paintRaycasterRef.current;
      const centerHit = getPaintUvHitAtClientPoint(
        event,
        raycaster,
        activeCanvasBounds,
        event.nativeEvent.clientX,
        event.nativeEvent.clientY,
      ) ?? getPaintUvHitFromEvent(event);
      if (!centerHit) {
        return;
      }

      const previousHit = lastPaintHitRef.current;
      const screenDistance = previousHit ? Math.hypot(centerHit.clientX - previousHit.clientX, centerHit.clientY - previousHit.clientY) : 0;
      const sampleSpacing = clamp(brushSize * 0.45, 10, 34);
      const sampleCount = isStickerBrush || !previousHit ? 1 : Math.min(12, Math.max(1, Math.ceil(screenDistance / sampleSpacing)));
      const samples: PaintUvHit[] = [];
      let didPaint = false;

      if (isStickerBrush || !previousHit) {
        samples.push(centerHit);
      } else {
        for (let sampleIndex = 1; sampleIndex <= sampleCount; sampleIndex += 1) {
          const t = sampleIndex / sampleCount;
          const clientX = previousHit.clientX + (centerHit.clientX - previousHit.clientX) * t;
          const clientY = previousHit.clientY + (centerHit.clientY - previousHit.clientY) * t;
          const hit = sampleIndex === sampleCount ? centerHit : getPaintUvHitAtClientPoint(event, raycaster, activeCanvasBounds, clientX, clientY);
          if (hit) {
            samples.push(hit);
          }
        }
      }

      function blendPixel(data: Uint8ClampedArray, offset: number, opacity: number) {
        if (opacity <= 0) {
          return;
        }

        const destinationAlpha = data[offset + 3] / 255;
        if (isEraser) {
          data[offset + 3] = Math.round(destinationAlpha * (1 - opacity) * 255);
          return;
        }

        const outputAlpha = opacity + destinationAlpha * (1 - opacity);
        if (outputAlpha <= 0) {
          return;
        }

        data[offset] = Math.round((paintRgb.r * opacity + data[offset] * destinationAlpha * (1 - opacity)) / outputAlpha);
        data[offset + 1] = Math.round((paintRgb.g * opacity + data[offset + 1] * destinationAlpha * (1 - opacity)) / outputAlpha);
        data[offset + 2] = Math.round((paintRgb.b * opacity + data[offset + 2] * destinationAlpha * (1 - opacity)) / outputAlpha);
        data[offset + 3] = Math.round(outputAlpha * 255);
      }

      function drawStickerStamp(sample: PaintUvHit) {
        if (!stickerImage) {
          return;
        }

        const centerAtlasPoint = getPaintAtlasPoint(sample.uv, paintTileCount, flipY);
        const islandPath = getPaintIslandClipPath(sample, flipY);
        if (!centerAtlasPoint || !islandPath) {
          return;
        }

        const imageAspect = stickerImage.naturalWidth > 0 && stickerImage.naturalHeight > 0
          ? stickerImage.naturalWidth / stickerImage.naturalHeight
          : 1;
        const stampBaseSize = Math.max(8, brushSize);
        const stampWidth = imageAspect >= 1 ? stampBaseSize : stampBaseSize * imageAspect;
        const stampHeight = imageAspect >= 1 ? stampBaseSize / imageAspect : stampBaseSize;

        activeLayer.context.save();
        activeLayer.context.clip(islandPath);
        activeLayer.context.globalAlpha = alpha;
        activeLayer.context.globalCompositeOperation = "source-over";
        activeLayer.context.drawImage(
          stickerImage,
          centerAtlasPoint.x - stampWidth / 2,
          centerAtlasPoint.y - stampHeight / 2,
          stampWidth,
          stampHeight,
        );
        activeLayer.context.restore();
        didPaint = true;
      }

      function drawProjectedStamp(sample: PaintUvHit) {
        const centerAtlasPoint = getPaintAtlasPoint(sample.uv, paintTileCount, flipY);
        if (!centerAtlasPoint || sample.faceIndex === null) {
          return;
        }

        const cache = getPaintIslandCache(sample.mesh.geometry);
        const islandId = cache.islandIdsByTriangle[sample.faceIndex];
        const triangleIndices = islandId >= 0 ? cache.triangleIndicesByIsland[islandId] : [];
        if (triangleIndices.length === 0) {
          return;
        }

        const radiusScreen = Math.max(2, brushSize * 0.5);
        const centerScreen = projectWorldToClient(sample.point, event.camera, activeCanvasBounds);
        const tempA = new THREE.Vector3();
        const tempB = new THREE.Vector3();
        const tempC = new THREE.Vector3();

        for (const triangleIndex of triangleIndices) {
          const vertexIndices = cache.triangleVertexIndices[triangleIndex];
          const triangleUvs = cache.triangleUvs[triangleIndex];
          if (!vertexIndices || !triangleUvs) {
            continue;
          }

          const worldA = getMeshVertexWorldPosition(sample.mesh, vertexIndices[0], tempA);
          const worldB = getMeshVertexWorldPosition(sample.mesh, vertexIndices[1], tempB);
          const worldC = getMeshVertexWorldPosition(sample.mesh, vertexIndices[2], tempC);
          const screenA = projectWorldToClient(worldA, event.camera, activeCanvasBounds);
          const screenB = projectWorldToClient(worldB, event.camera, activeCanvasBounds);
          const screenC = projectWorldToClient(worldC, event.camera, activeCanvasBounds);
          if (![screenA.z, screenB.z, screenC.z].every(Number.isFinite)) {
            continue;
          }

          if (!screenTriangleIntersectsBrush(screenA, screenB, screenC, sample.clientX, sample.clientY, radiusScreen)) {
            continue;
          }

          const atlasA = getPaintAtlasPointUnchecked(triangleUvs[0], flipY);
          const atlasB = getPaintAtlasPointUnchecked(triangleUvs[1], flipY);
          const atlasC = getPaintAtlasPointUnchecked(triangleUvs[2], flipY);
          if (!atlasA || !atlasB || !atlasC) {
            continue;
          }

          const minX = Math.max(0, Math.floor(Math.min(atlasA.x, atlasB.x, atlasC.x) - PAINT_UV_BLEED_PX));
          const minY = Math.max(0, Math.floor(Math.min(atlasA.y, atlasB.y, atlasC.y) - PAINT_UV_BLEED_PX));
          const maxX = Math.min(activeLayer.canvas.width - 1, Math.ceil(Math.max(atlasA.x, atlasB.x, atlasC.x) + PAINT_UV_BLEED_PX));
          const maxY = Math.min(activeLayer.canvas.height - 1, Math.ceil(Math.max(atlasA.y, atlasB.y, atlasC.y) + PAINT_UV_BLEED_PX));
          const width = maxX - minX + 1;
          const height = maxY - minY + 1;
          if (width <= 0 || height <= 0) {
            continue;
          }

          const imageData = activeLayer.context.getImageData(minX, minY, width, height);
          let triangleChanged = false;

          for (let pixelY = 0; pixelY < height; pixelY += 1) {
            for (let pixelX = 0; pixelX < width; pixelX += 1) {
              const canvasX = minX + pixelX + 0.5;
              const canvasY = minY + pixelY + 0.5;
              const tileX = Math.floor(canvasX / UDIM_ATLAS_TILE_SIZE);
              const tileY = Math.floor(canvasY / UDIM_ATLAS_TILE_SIZE);
              const tileIndex = tileX + tileY * UDIM_ATLAS_COLUMNS;
              if (tileIndex < 0 || tileIndex >= paintTileCount) {
                continue;
              }

              const barycentric = getBarycentric2D(canvasX, canvasY, atlasA.x, atlasA.y, atlasB.x, atlasB.y, atlasC.x, atlasC.y, -0.075);
              if (!barycentric) {
                continue;
              }

              const screenX = screenA.x * barycentric.x + screenB.x * barycentric.y + screenC.x * barycentric.z;
              const screenY = screenA.y * barycentric.x + screenB.y * barycentric.y + screenC.y * barycentric.z;
              const screenZ = screenA.z * barycentric.x + screenB.z * barycentric.y + screenC.z * barycentric.z;
              if (screenZ > centerScreen.z + 0.045) {
                continue;
              }

              const distance = Math.hypot(screenX - sample.clientX, screenY - sample.clientY);
              if (distance > radiusScreen) {
                continue;
              }

              const falloff = isHardBrush ? 1 : Math.pow(1 - distance / radiusScreen, 1.35);
              blendPixel(imageData.data, (pixelY * width + pixelX) * 4, alpha * falloff);
              triangleChanged = true;
            }
          }

          if (triangleChanged) {
            activeLayer.context.putImageData(imageData, minX, minY);
            didPaint = true;
          }
        }
      }

      for (const sample of samples) {
        if (isStickerBrush) {
          drawStickerStamp(sample);
        } else {
          drawProjectedStamp(sample);
        }
        lastPaintHitRef.current = sample;
      }

      if (didPaint) {
        if (activePaintStrokeRef.current) {
          activePaintStrokeRef.current.painted = true;
        }
        activeLayer.texture.needsUpdate = true;
        activeLayer.exportLayer.hasPaint = true;
        activeLayer.exportLayer.version += 1;
      }
    },
    [activeBrush, blendMode, brushSize, brushStrength, flipY, paintTileCount, primaryColor, stickerImage],
  );

  const snapshotPaintLayer = useCallback((layer: PaintLayer): PaintHistoryFrame => ({
    imageData: layer.context.getImageData(0, 0, layer.canvas.width, layer.canvas.height),
    hasPaint: layer.exportLayer.hasPaint,
  }), []);

  const applyPaintHistoryFrame = useCallback((layer: PaintLayer, frame: PaintHistoryFrame) => {
    layer.context.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
    layer.context.putImageData(frame.imageData, 0, 0);
    layer.texture.needsUpdate = true;
    layer.exportLayer.hasPaint = frame.hasPaint;
    layer.exportLayer.version += 1;
  }, []);

  const finishPaintStroke = useCallback(() => {
    const stroke = activePaintStrokeRef.current;
    activePaintStrokeRef.current = null;
    if (!stroke?.painted) {
      return;
    }

    paintUndoStackRef.current.push(stroke.before);
    if (paintUndoStackRef.current.length > PAINT_HISTORY_LIMIT) {
      paintUndoStackRef.current.shift();
    }
    paintRedoStackRef.current = [];
  }, []);

  const undoPaintStroke = useCallback(() => {
    finishPaintStroke();
    const layer = paintLayerRef.current;
    const undoFrame = paintUndoStackRef.current.pop();
    if (!layer || !undoFrame) {
      return;
    }

    paintRedoStackRef.current.push(snapshotPaintLayer(layer));
    if (paintRedoStackRef.current.length > PAINT_HISTORY_LIMIT) {
      paintRedoStackRef.current.shift();
    }
    applyPaintHistoryFrame(layer, undoFrame);
  }, [applyPaintHistoryFrame, finishPaintStroke, snapshotPaintLayer]);

  const redoPaintStroke = useCallback(() => {
    finishPaintStroke();
    const layer = paintLayerRef.current;
    const redoFrame = paintRedoStackRef.current.pop();
    if (!layer || !redoFrame) {
      return;
    }

    paintUndoStackRef.current.push(snapshotPaintLayer(layer));
    if (paintUndoStackRef.current.length > PAINT_HISTORY_LIMIT) {
      paintUndoStackRef.current.shift();
    }
    applyPaintHistoryFrame(layer, redoFrame);
  }, [applyPaintHistoryFrame, finishPaintStroke, snapshotPaintLayer]);

  const clearPaintLayer = useCallback(() => {
    const layer = paintLayerRef.current;
    if (!layer) {
      return;
    }

    finishPaintStroke();
    paintUndoStackRef.current.push(snapshotPaintLayer(layer));
    if (paintUndoStackRef.current.length > PAINT_HISTORY_LIMIT) {
      paintUndoStackRef.current.shift();
    }
    paintRedoStackRef.current = [];
    layer.context.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
    layer.texture.needsUpdate = true;
    layer.exportLayer.hasPaint = false;
    layer.exportLayer.version += 1;
  }, [finishPaintStroke, snapshotPaintLayer]);

  const handlePaintPointerDown = useCallback(
    (event: ThreeEvent<PointerEvent>) => {
      const button = event.nativeEvent?.button ?? event.button ?? 0;
      if (viewportMode !== "texture-paint" || button !== 0) {
        return;
      }

      event.stopPropagation();
      event.nativeEvent?.preventDefault();
      setPaintContextMenu(null);
      setIsPainting(true);
      lastPaintHitRef.current = null;
      if (!activePaintStrokeRef.current && paintLayerRef.current) {
        activePaintStrokeRef.current = {
          before: snapshotPaintLayer(paintLayerRef.current),
          painted: false,
        };
      }
      paintAtSurface(event, getPointerPressure(event));
    },
    [paintAtSurface, snapshotPaintLayer, viewportMode],
  );

  const handlePaintPointerMove = useCallback(
    (event: ThreeEvent<PointerEvent>) => {
      if (viewportMode !== "texture-paint" || !isPainting || activeBrush === "Sticker") {
        return;
      }

      event.stopPropagation();
      event.nativeEvent?.preventDefault();
      paintAtSurface(event, getPointerPressure(event));
    },
    [activeBrush, isPainting, paintAtSurface, viewportMode],
  );

  const stopPainting = useCallback(() => {
    setIsPainting(false);
    lastPaintHitRef.current = null;
    finishPaintStroke();
  }, [finishPaintStroke]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (viewportMode !== "texture-paint" || isTextEntryTarget(event.target)) {
        return;
      }

      const key = event.key.toLowerCase();
      const isCommand = event.ctrlKey || event.metaKey;
      if (isCommand && key === "z") {
        event.preventDefault();
        if (event.shiftKey) {
          redoPaintStroke();
        } else {
          undoPaintStroke();
        }
        return;
      }

      if (isCommand && key === "y") {
        event.preventDefault();
        redoPaintStroke();
        return;
      }

      if (key === "n") {
        event.preventDefault();
        setIsTexturePaintPanelOpen((isOpen) => !isOpen);
        return;
      }

      if (key === "x") {
        event.preventDefault();
        swapPaintColors();
        return;
      }

      if (key === "f") {
        event.preventDefault();
        const viewportBounds = canvasShellRef.current?.getBoundingClientRect();
        const x = viewportBounds ? viewportBounds.left + viewportBounds.width / 2 : window.innerWidth / 2;
        const y = viewportBounds ? viewportBounds.top + viewportBounds.height / 2 : window.innerHeight / 2;
        startBrushAdjust(event.shiftKey ? "strength" : "size", x, y);
      }
    }

    function preventViewportMiddleMouse(event: globalThis.MouseEvent) {
      const target = event.target;
      if (!(target instanceof Element) || event.button !== 1 || !target.closest(".canvas-shell")) {
        return;
      }

      event.preventDefault();
    }

    window.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", preventViewportMiddleMouse, { capture: true });
    document.addEventListener("auxclick", preventViewportMiddleMouse, { capture: true });

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", preventViewportMiddleMouse, { capture: true });
      document.removeEventListener("auxclick", preventViewportMiddleMouse, { capture: true });
    };
  }, [brushSize, brushStrength, primaryColor, redoPaintStroke, secondaryColor, undoPaintStroke, viewportMode]);

  useEffect(() => {
    function handleViewportModeKeys(event: KeyboardEvent) {
      if (isTextEntryTarget(event.target)) {
        return;
      }

      if (event.key === "Tab") {
        event.preventDefault();
        handleViewportModeSelect(viewportMode === "edit" ? "object" : "edit");
        return;
      }

      if (event.key.toLowerCase() === "t" && viewportMode === "edit") {
        event.preventDefault();
        setIsEditToolbarOpen((isOpen) => !isOpen);
        return;
      }

      if (viewportMode === "edit") {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "i") {
          event.preventDefault();
          invertEditSelection();
          return;
        }

        if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === "a" && !event.repeat) {
          event.preventDefault();
          const now = performance.now();
          if (now - lastSelectAllKeyRef.current < 430) {
            clearEditSelection();
            lastSelectAllKeyRef.current = 0;
            return;
          }

          selectAllEditSelection();
          lastSelectAllKeyRef.current = now;
          return;
        }

        const modeByKey: Record<string, EditSelectionMode> = {
          "1": "vertices",
          "2": "edges",
          "3": "faces",
          "4": "island",
        };
        const nextMode = modeByKey[event.key];
        if (nextMode) {
          event.preventDefault();
          setEditSelectionMode(nextMode);
        }
      }
    }

    window.addEventListener("keydown", handleViewportModeKeys);
    return () => {
      window.removeEventListener("keydown", handleViewportModeKeys);
    };
  }, [clearEditSelection, invertEditSelection, selectAllEditSelection, setEditSelectionMode, viewportMode]);

  useEffect(() => {
    return () => {
      if (modelUrl) {
        URL.revokeObjectURL(modelUrl);
      }
    };
  }, [modelUrl]);

  useEffect(() => {
    return () => {
      if (stickerUrl) {
        URL.revokeObjectURL(stickerUrl);
      }
    };
  }, [stickerUrl]);

  return (
    <section className="model-viewer">
      <header className="model-header">
        <div className="section-title">
          <Box aria-hidden="true" size={18} />
          <h2>3D preview</h2>
        </div>
        <div className="viewport-toolbar">
          <div className="shader-mode-tabs" role="tablist" aria-label="3D shader preview mode">
            <button
              className={previewMode === "lit" ? "is-active" : ""}
              type="button"
              onClick={() => setPreviewMode("lit")}
              title="Lit"
            >
              <SunMedium aria-hidden="true" size={14} />
              <span>Lit</span>
            </button>
            <button
              className={previewMode === "flat" ? "is-active" : ""}
              type="button"
              onClick={() => setPreviewMode("flat")}
              title="Flat"
            >
              <Box aria-hidden="true" size={14} />
              <span>Flat</span>
            </button>
            <button
              className={previewMode === "clay" ? "is-active" : ""}
              type="button"
              onClick={() => setPreviewMode("clay")}
              title="Clay"
            >
              <Circle aria-hidden="true" size={14} />
              <span>Clay</span>
            </button>
            <button
              className={previewMode === "normals" ? "is-active" : ""}
              type="button"
              onClick={() => setPreviewMode("normals")}
              title="Normals"
            >
              <Waves aria-hidden="true" size={14} />
              <span>Normals</span>
            </button>
            <button
              className={previewMode === "coverage" ? "is-active" : ""}
              type="button"
              onClick={() => setPreviewMode("coverage")}
              title="Material Coverage"
            >
              <Grid3X3 aria-hidden="true" size={14} />
              <span>Coverage</span>
            </button>
            {viewportMode === "edit" ? (
              <button
                className={isEditXrayEnabled ? "is-active" : ""}
                type="button"
                onClick={() => setIsEditXrayEnabled((isEnabled) => !isEnabled)}
                title="X-Ray"
              >
                <Box aria-hidden="true" size={14} />
                <span>X-Ray</span>
              </button>
            ) : null}
          </div>
          {viewportMode === "texture-paint" ? (
            <button
              className={`texture-paint-toggle${symmetryEnabled ? " is-active" : ""}`}
              type="button"
              onClick={() => setSymmetryEnabled((isEnabled) => !isEnabled)}
              title="Mirror paint strokes on X"
            >
              <Grid3X3 aria-hidden="true" size={14} />
              <span>Symmetry</span>
            </button>
          ) : null}
          <div className="model-actions">
            <button
              className="secondary-button icon-only"
              type="button"
              aria-label="Reset camera"
              title="Reset camera"
              onClick={() => setCameraResetVersion((version) => version + 1)}
            >
              <RotateCcw aria-hidden="true" size={15} />
            </button>
            <button
              className={`secondary-button icon-only${flipY ? " is-active" : ""}`}
              type="button"
              aria-label="Flip texture vertically"
              title="Flip texture vertically"
              onClick={() => setFlipY((current) => !current)}
            >
              <FlipVertical aria-hidden="true" size={15} />
            </button>
            <input ref={activeFbxInputRef} className="hidden-input" type="file" accept=".fbx,.obj" onChange={handleFbxChange} />
          </div>
        </div>
      </header>

      <div
        ref={canvasShellRef}
        className={`canvas-shell${isModelFileOver ? " is-file-over" : ""}${viewportMode === "texture-paint" ? " is-texture-paint" : ""}${viewportMode === "edit" ? " is-edit-mode" : ""}`}
        onAuxClickCapture={stopMiddleMouseAutoscroll}
        onDragEnter={handleModelDragOver}
        onDragLeave={() => setIsModelFileOver(false)}
        onDragOver={handleModelDragOver}
        onDrop={handleModelDrop}
        onPointerDownCapture={handleViewportPointerDown}
        onPointerMove={handleViewportPointerMove}
        onPointerLeave={() => {
          setBrushCursor((current) => ({ ...current, visible: false }));
          stopPainting();
        }}
        onMouseDownCapture={stopMiddleMouseAutoscroll}
        onContextMenu={handleViewportContextMenu}
      >
        <ModelErrorBoundary
          resetKey={modelUrl ?? "fallback"}
          onError={handleModelError}
          fallback={
            <div className="canvas-crash-fallback">
              <span>No se pudo mostrar este modelo.</span>
            </div>
          }
        >
          <Canvas camera={{ position: [3, 2.4, 4], fov: 45 }} gl={{ preserveDrawingBuffer: true }} shadows>
            <color attach="background" args={["#444444"]} />
            <fog attach="fog" args={["#444444", 8, 24]} />
            <hemisphereLight args={["#f0f4ff", "#2b2b2b", 0.76]} />
            <ambientLight intensity={0.68} />
            <directionalLight castShadow position={[4, 6, 5]} intensity={modeLightIntensity(previewMode)} />
            <Suspense fallback={null}>
              <ModelErrorBoundary
                resetKey={modelUrl ?? "fallback"}
                onError={handleModelError}
                fallback={
                  <FallbackObject
                    textures={textures}
                    mode={previewMode}
                    flipY={flipY}
                    paintMap={paintLayer?.texture ?? null}
                    showWireframe={viewportMode === "edit"}
                    showXray={viewportMode === "edit" && isEditXrayEnabled}
                    onEditPointerDown={viewportMode === "edit" ? handleEditPointerDown : undefined}
                    onPaintPointerDown={handlePaintPointerDown}
                    onPaintPointerMove={handlePaintPointerMove}
                    onPaintPointerUp={stopPainting}
                    onFallbackObjectChange={handleModelObjectChange}
                  />
                }
              >
                <Bounds key={boundsKey} fit clip margin={1.22}>
                  <Center>
                    {modelUrl ? (
                      <LoadedModel
                        url={modelUrl}
                        modelName={modelName}
                        fileType={modelFileType}
                        textures={textures}
                        mode={previewMode}
                        flipY={flipY}
                        paintMap={paintLayer?.texture ?? null}
                        hiddenModelNodeIds={hiddenModelNodeIds}
                        showWireframe={viewportMode === "edit"}
                        showXray={viewportMode === "edit" && isEditXrayEnabled}
                        onEditPointerDown={viewportMode === "edit" ? handleEditPointerDown : undefined}
                        onPaintPointerDown={handlePaintPointerDown}
                        onPaintPointerMove={handlePaintPointerMove}
                        onPaintPointerUp={stopPainting}
                        onModelNodesChange={onModelNodesChange}
                        onUvLayout={onModelUvLayout}
                        onModelSize={handleModelSize}
                        onModelObjectChange={handleModelObjectChange}
                        onLoadError={handleModelError}
                      />
                    ) : (
                      <FallbackObject
                        textures={textures}
                        mode={previewMode}
                        flipY={flipY}
                        paintMap={paintLayer?.texture ?? null}
                        showWireframe={viewportMode === "edit"}
                        showXray={viewportMode === "edit" && isEditXrayEnabled}
                        onEditPointerDown={viewportMode === "edit" ? handleEditPointerDown : undefined}
                        onPaintPointerDown={handlePaintPointerDown}
                        onPaintPointerMove={handlePaintPointerMove}
                        onPaintPointerUp={stopPainting}
                        onFallbackObjectChange={handleModelObjectChange}
                      />
                    )}
                  </Center>
                </Bounds>
              </ModelErrorBoundary>
              {previewMode === "lit" ? <Environment preset="studio" /> : null}
            </Suspense>
            <EditSelectionOverlay markers={viewportMode === "edit" ? selectedFaceMarkers : []} isXray={isEditXrayEnabled} />
            <ViewportGrid gridSize={gridSize} y={gridY} />
            <GizmoHelper alignment="top-right" margin={[72, 76]}>
              <GizmoViewport axisColors={["#f04f5f", "#7ed321", "#3694ff"]} labelColor="#17181b" />
            </GizmoHelper>
            <BlenderOrbitControls />
          </Canvas>
        </ModelErrorBoundary>
        <div className="viewport-mode-menu" onMouseDown={(event) => event.stopPropagation()}>
          <button type="button" onClick={() => setIsViewportModeMenuOpen((isOpen) => !isOpen)}>
            {getViewportModeLabel(viewportMode)}
            <ChevronDown aria-hidden="true" size={13} />
          </button>
          {isViewportModeMenuOpen ? (
            <div className="viewport-mode-dropdown">
              {(["object", "edit", "texture-paint"] as ViewportMode[]).map((mode) => (
                <button
                  className={viewportMode === mode ? "is-active" : ""}
                  key={mode}
                  type="button"
                  onClick={() => {
                    handleViewportModeSelect(mode);
                  }}
                >
                  {getViewportModeLabel(mode)}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="viewport-label">User Perspective</div>
        {viewportMode === "edit" ? (
          <>
            {isEditToolbarOpen ? (
              <aside className="edit-mode-toolbar" onMouseDown={(event) => event.stopPropagation()}>
                <button
                  className={editTool === "tweak" ? "is-active" : ""}
                  type="button"
                  title="Tweak"
                  onClick={() => setEditTool("tweak")}
                >
                  <MousePointer2 aria-hidden="true" size={16} />
                  <span>Tweak</span>
                </button>
                <button
                  className={editTool === "select-box" ? "is-active" : ""}
                  type="button"
                  title="Select Box"
                  onClick={() => setEditTool("select-box")}
                >
                  <SquareDashedMousePointer aria-hidden="true" size={16} />
                  <span>Select Box</span>
                </button>
                <button
                  className={editTool === "select-circle" ? "is-active" : ""}
                  type="button"
                  title="Select Circle"
                  onClick={() => setEditTool("select-circle")}
                >
                  <CircleDashed aria-hidden="true" size={16} />
                  <span>Select Circle</span>
                </button>
                <button
                  className={editTool === "select-lasso" ? "is-active" : ""}
                  type="button"
                  title="Select Lasso"
                  onClick={() => setEditTool("select-lasso")}
                >
                  <Lasso aria-hidden="true" size={16} />
                  <span>Select Lasso</span>
                </button>
              </aside>
            ) : (
              <button
                className="edit-toolbar-tab"
                type="button"
                title="Show edit tools"
                onClick={() => setIsEditToolbarOpen(true)}
                onMouseDown={(event) => event.stopPropagation()}
              >
                T
              </button>
            )}
            <div className="edit-mode-status" onMouseDown={(event) => event.stopPropagation()}>
              <div className="edit-selection-switch">
                <button
                  className={editSelectionMode === "vertices" ? "is-active" : ""}
                  type="button"
                  onClick={() => setEditSelectionMode("vertices")}
                  title="1"
                >
                  Vertex
                </button>
                <button
                  className={editSelectionMode === "edges" ? "is-active" : ""}
                  type="button"
                  onClick={() => setEditSelectionMode("edges")}
                  title="2"
                >
                  Edge
                </button>
                <button
                  className={editSelectionMode === "faces" ? "is-active" : ""}
                  type="button"
                  onClick={() => setEditSelectionMode("faces")}
                  title="3"
                >
                  Face
                </button>
                <button
                  className={editSelectionMode === "island" ? "is-active" : ""}
                  type="button"
                  onClick={() => setEditSelectionMode("island")}
                  title="4"
                >
                  Island
                </button>
              </div>
              <span>{selectedFaceCount} selected</span>
              <span>Shift adds</span>
            </div>
          </>
        ) : null}
        {viewportMode === "texture-paint" && brushCursor.visible ? (
          <div
            className={`viewport-brush-cursor${activeBrush === "Sticker" && stickerUrl ? " is-sticker" : ""}`}
            style={{
              left: brushCursor.x,
              top: brushCursor.y,
              width: clamp(brushSize, 8, 220),
              height: clamp(brushSize, 8, 220),
              borderColor: primaryColor,
              backgroundImage: activeBrush === "Sticker" && stickerUrl ? `url("${stickerUrl}")` : undefined,
            }}
          />
        ) : null}
        {viewportMode === "texture-paint" ? (
          <>
            <input ref={stickerInputRef} className="hidden-input" type="file" accept="image/*" onChange={handleStickerImageChange} />
            {isTexturePaintPanelOpen ? (
              <aside className="texture-paint-panel" onMouseDown={(event) => event.stopPropagation()}>
                <header>
                  <Paintbrush aria-hidden="true" size={15} />
                  <strong>Brush Asset</strong>
                  <button type="button" title="Collapse tool panel" onClick={() => setIsTexturePaintPanelOpen(false)}>
                    N
                  </button>
                </header>
                <section className={`brush-asset-preview${activeBrush === "Sticker" ? " is-sticker" : ""}`}>
                  <div className="brush-preview-orb">
                    {activeBrush === "Sticker" && stickerUrl ? <img src={stickerUrl} alt="" /> : <span />}
                  </div>
                  <strong>{activeBrush}</strong>
                  {activeBrush === "Sticker" ? (
                    <button className="paint-clear-button" type="button" onClick={() => stickerInputRef.current?.click()}>
                      <ImagePlus aria-hidden="true" size={14} />
                      Load sticker image
                    </button>
                  ) : null}
                </section>
                <section className="paint-tool-section">
                  <header>
                    <SlidersHorizontal aria-hidden="true" size={14} />
                    <strong>Brush Settings</strong>
                  </header>
                  <label className="paint-field">
                    <span>Blend</span>
                    <select value={blendMode} onChange={(event) => setBlendMode(event.target.value)}>
                      <option>Mix</option>
                      <option>Add</option>
                      <option>Multiply</option>
                      <option>Overlay</option>
                      <option>Erase Alpha</option>
                    </select>
                  </label>
                  <label className="paint-field">
                    <span>Size</span>
                    <input
                      max="512"
                      min="1"
                      type="range"
                      value={brushSize}
                      onChange={(event) => setBrushSize(Number(event.target.value))}
                    />
                    <output>{brushSize}px</output>
                  </label>
                  <label className="paint-field">
                    <span>Strength</span>
                    <input
                      max="1"
                      min="0"
                      step="0.01"
                      type="range"
                      value={brushStrength}
                      onChange={(event) => setBrushStrength(Number(event.target.value))}
                    />
                    <output>{brushStrength.toFixed(2)}</output>
                  </label>
                  <button className="paint-clear-button" type="button" onClick={clearPaintLayer}>
                    Clear paint
                  </button>
                </section>
                <section className="paint-tool-section">
                  <header>
                    <Palette aria-hidden="true" size={14} />
                    <strong>Color Picker</strong>
                  </header>
                  <HsvTrianglePicker color={primaryColor} label="Primary color" onChange={setPrimaryColor} />
                  <div className="paint-color-picker">
                    <button
                      className="paint-color-swatch"
                      style={{ backgroundColor: primaryColor }}
                      type="button"
                      title="Primary color"
                    />
                    <button type="button" title="Swap primary and secondary colors" onClick={swapPaintColors}>
                      X
                    </button>
                    <button
                      className="paint-color-swatch"
                      style={{ backgroundColor: secondaryColor }}
                      type="button"
                      title="Secondary color"
                      onClick={() => setPrimaryColor(secondaryColor)}
                    />
                  </div>
                  <label className="paint-checkbox">
                    <input checked={pressureEnabled} type="checkbox" onChange={(event) => setPressureEnabled(event.target.checked)} />
                    <span>Pen pressure</span>
                  </label>
                  <label className="paint-checkbox">
                    <input checked={symmetryEnabled} type="checkbox" onChange={(event) => setSymmetryEnabled(event.target.checked)} />
                    <span>Symmetry</span>
                  </label>
                </section>
              </aside>
            ) : (
              <button
                className="texture-paint-panel-tab"
                type="button"
                title="Open texture paint tools"
                onMouseDown={(event) => event.stopPropagation()}
                onClick={() => setIsTexturePaintPanelOpen(true)}
              >
                <Settings2 aria-hidden="true" size={16} />
              </button>
            )}
            <div className="paint-brush-shelf" onMouseDown={(event) => event.stopPropagation()}>
              <nav aria-label="Brush preset groups">
                <button className="is-active" type="button">All</button>
                <button type="button">Basic</button>
                <button type="button">Erase</button>
                <button type="button">Pixel Art</button>
                <button type="button">Utilities</button>
              </nav>
              <div className="paint-brush-presets">
                {BRUSH_PRESETS.map((brush) => (
                  <button
                    className={activeBrush === brush ? "is-active" : ""}
                    key={brush}
                    type="button"
                    title={brush}
                    onClick={() => setActiveBrush(brush)}
                  >
                    <span />
                  </button>
                ))}
              </div>
            </div>
          </>
        ) : null}
        {viewportMode === "texture-paint" && paintContextMenu ? (
          <div
            className="paint-context-menu"
            style={{ left: paintContextMenu.x, top: paintContextMenu.y }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <HsvTrianglePicker compact color={primaryColor} label="Context primary color" onChange={setPrimaryColor} />
            <label>
              <span>Blend</span>
              <select value={blendMode} onChange={(event) => setBlendMode(event.target.value)}>
                <option>Mix</option>
                <option>Add</option>
                <option>Multiply</option>
                <option>Overlay</option>
                <option>Erase Alpha</option>
              </select>
            </label>
            <label>
              <span>Size</span>
              <input max="512" min="1" type="range" value={brushSize} onChange={(event) => setBrushSize(Number(event.target.value))} />
              <output>{brushSize}px</output>
            </label>
            <label>
              <span>Strength</span>
              <input max="1" min="0" step="0.01" type="range" value={brushStrength} onChange={(event) => setBrushStrength(Number(event.target.value))} />
              <output>{brushStrength.toFixed(2)}</output>
            </label>
          </div>
        ) : null}
        {brushAdjustMode && brushAdjustHud ? (
          <div className="brush-adjust-hud" style={{ left: brushAdjustHud.x, top: brushAdjustHud.y }}>
            <span>{brushAdjustMode === "size" ? `${brushSize}px` : brushStrength.toFixed(2)}</span>
            <i style={{ width: brushAdjustMode === "size" ? clamp(brushSize, 18, 160) : 72, height: brushAdjustMode === "size" ? clamp(brushSize, 18, 160) : 72 }} />
          </div>
        ) : null}
        {modelError ? <div className="viewport-error">{modelError}</div> : null}
      </div>
    </section>
  );
}

function modeLightIntensity(mode: PreviewMode): number {
  if (mode === "flat" || mode === "normals" || mode === "coverage") {
    return 0;
  }

  return mode === "clay" ? 1.9 : 2.35;
}
