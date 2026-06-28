import { type CSSProperties, type DragEvent, useEffect, useMemo, useRef, useState } from "react";
import { SortableContext, rectSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Eye, FlipHorizontal, FlipVertical, GripVertical, Grid3X3, Image as ImageIcon, RotateCw, ScanSearch, Trash2, ZoomIn, ZoomOut } from "lucide-react";
import {
  TEXTURE_CHANNELS,
  type PreparedProjection,
  type TextureAsset,
  type TextureChannel,
  type UvEditCommandOptions,
  type UvEditCommandType,
  type UvSegment,
} from "../types/texture";
import { canPreviewInBrowser } from "../utils/textureLoader";

interface UdimPreviewPanelProps {
  textures: TextureAsset[];
  activeChannel: TextureChannel;
  activeTextureId: string | null;
  editorHeight: number;
  exportUdims: Map<string, string>;
  isModelLoaded: boolean;
  preparedProjections: PreparedProjection[];
  selectedPreparedProjectionId: string;
  selectedUvSegments: UvSegment[];
  uvSelectionMode: UvSelectionMode;
  uvSegments: UvSegment[];
  onActiveChannelChange: (channel: TextureChannel) => void;
  onImportFiles: (channel: TextureChannel, files: File[]) => void;
  onPreparedProjectionSelect: (projectionId: string) => void;
  onUvEditCommand: (type: UvEditCommandType, options?: UvEditCommandOptions) => void;
  onUvSelectionModeChange: (mode: UvSelectionMode) => void;
  onRemove: (id: string) => void;
}

type UvSelectionMode = "vertices" | "edges" | "faces" | "island";
type UvTransformMode = "move" | "scale" | "rotate" | null;
type UvProjectionMode = "project-from-view" | "planar" | "box" | "cylindrical" | "spherical";

const UV_VIEWBOX_WIDTH = 900;
const UV_VIEWBOX_HEIGHT = 280;
const UV_VIEWBOX_PADDING = 24;
const MAX_SVG_UV_SEGMENTS = 60000;
const UV_GRID_PADDING = 24;

const EMPTY_UV_PROJECTION = { gridPath: "", uvPath: "" };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getUdimGridPosition(udim: string): { column: number; row: number } {
  const value = Number.parseInt(udim, 10);
  if (!Number.isFinite(value) || value < 1001) {
    return { column: 1, row: 1 };
  }

  const zeroBasedIndex = value - 1001;
  return {
    column: (zeroBasedIndex % 10) + 1,
    row: Math.floor(zeroBasedIndex / 10) + 1,
  };
}

function getChannelTextures(textures: TextureAsset[], channel: TextureChannel): TextureAsset[] {
  return textures.filter((texture) => texture.channel === channel);
}

function isTextureFile(file: File): boolean {
  return Boolean(file.type.startsWith("image/") || /\.(exr|tif|tiff|png|jpe?g|webp|bmp)$/i.test(file.name));
}

function getUvBounds(segments: UvSegment[]) {
  if (segments.length === 0) {
    return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  segments.forEach((segment) => {
    minX = Math.min(minX, segment.x1, segment.x2);
    minY = Math.min(minY, segment.y1, segment.y2);
    maxX = Math.max(maxX, segment.x1, segment.x2);
    maxY = Math.max(maxY, segment.y1, segment.y2);
  });

  minX = Math.floor(minX);
  minY = Math.floor(minY);
  maxX = Math.ceil(maxX);
  maxY = Math.ceil(maxY);

  return {
    minX,
    minY,
    maxX: Math.max(maxX, minX + 1),
    maxY: Math.max(maxY, minY + 1),
  };
}

function buildUvProjection(segments: UvSegment[], bounds = getUvBounds(segments)) {
  const uvWidth = bounds.maxX - bounds.minX;
  const uvHeight = bounds.maxY - bounds.minY;
  const scale = Math.min(
    (UV_VIEWBOX_WIDTH - UV_VIEWBOX_PADDING * 2) / uvWidth,
    (UV_VIEWBOX_HEIGHT - UV_VIEWBOX_PADDING * 2) / uvHeight,
  );
  const offsetX = (UV_VIEWBOX_WIDTH - uvWidth * scale) / 2;
  const offsetY = (UV_VIEWBOX_HEIGHT - uvHeight * scale) / 2;

  const project = (x: number, y: number) => ({
    x: offsetX + (x - bounds.minX) * scale,
    y: UV_VIEWBOX_HEIGHT - offsetY - (y - bounds.minY) * scale,
  });

  const renderSegments = getRenderableUvSegments(segments);
  const path = renderSegments
    .map((segment) => {
      const start = project(segment.x1, segment.y1);
      const end = project(segment.x2, segment.y2);
      return `M${start.x.toFixed(2)} ${start.y.toFixed(2)}L${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
    })
    .join("");

  const gridLines = [];
  for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
    const start = project(x, bounds.minY);
    const end = project(x, bounds.maxY);
    gridLines.push(`M${start.x.toFixed(2)} ${start.y.toFixed(2)}L${end.x.toFixed(2)} ${end.y.toFixed(2)}`);
  }
  for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
    const start = project(bounds.minX, y);
    const end = project(bounds.maxX, y);
    gridLines.push(`M${start.x.toFixed(2)} ${start.y.toFixed(2)}L${end.x.toFixed(2)} ${end.y.toFixed(2)}`);
  }

  return { gridPath: gridLines.join(""), uvPath: path };
}

function getRenderableUvSegments(segments: UvSegment[]): UvSegment[] {
  if (segments.length <= MAX_SVG_UV_SEGMENTS) {
    return segments;
  }

  const step = Math.ceil(segments.length / MAX_SVG_UV_SEGMENTS);
  const renderSegments: UvSegment[] = [];

  for (let index = 0; index < segments.length; index += step) {
    renderSegments.push(segments[index]);
  }

  return renderSegments;
}

function clipSegmentToUnitSquare(x1: number, y1: number, x2: number, y2: number): [number, number, number, number] | null {
  let start = 0;
  let end = 1;
  const deltaX = x2 - x1;
  const deltaY = y2 - y1;
  const checks = [
    [-deltaX, x1],
    [deltaX, 1 - x1],
    [-deltaY, y1],
    [deltaY, 1 - y1],
  ];

  for (const [edgeDelta, edgeDistance] of checks) {
    if (edgeDelta === 0) {
      if (edgeDistance < 0) {
        return null;
      }
      continue;
    }

    const ratio = edgeDistance / edgeDelta;
    if (edgeDelta < 0) {
      start = Math.max(start, ratio);
    } else {
      end = Math.min(end, ratio);
    }

    if (start > end) {
      return null;
    }
  }

  return [x1 + start * deltaX, y1 + start * deltaY, x1 + end * deltaX, y1 + end * deltaY];
}

function buildTileUvPath(segments: UvSegment[], exportUdim: string): string {
  const udimNumber = Number.parseInt(exportUdim, 10);
  if (!Number.isFinite(udimNumber) || udimNumber < 1001) {
    return "";
  }

  const tileIndex = udimNumber - 1001;
  const tileX = tileIndex % 10;
  const tileY = Math.floor(tileIndex / 10);

  const pathParts: string[] = [];

  for (const segment of segments) {
    if (pathParts.length >= MAX_SVG_UV_SEGMENTS) {
      break;
    }

    const clipped = clipSegmentToUnitSquare(
      segment.x1 - tileX,
      segment.y1 - tileY,
      segment.x2 - tileX,
      segment.y2 - tileY,
    );
    if (!clipped) {
      continue;
    }

    const [x1, y1, x2, y2] = clipped;
    pathParts.push(`M${(x1 * 100).toFixed(2)} ${(100 - y1 * 100).toFixed(2)}L${(x2 * 100).toFixed(2)} ${(100 - y2 * 100).toFixed(2)}`);
  }

  return pathParts.join("");
}

function UdimPreviewCell({
  texture,
  activeChannel,
  exportUdim,
  isActive,
  showUvOverlay,
  selectedUvPath,
  uvPath,
  onRemove,
}: {
  texture: TextureAsset;
  activeChannel: TextureChannel;
  exportUdim: string;
  isActive: boolean;
  showUvOverlay: boolean;
  selectedUvPath: string;
  uvPath: string;
  onRemove: (id: string) => void;
}) {
  const position = getUdimGridPosition(exportUdim);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: texture.id,
    data: {
      type: "uv-tile",
      texture,
    },
  });

  const style = {
    gridColumn: position.column,
    gridRow: position.row,
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <article
      ref={setNodeRef}
      className={`udim-preview-cell${isDragging || isActive ? " is-dragging" : ""}`}
      style={style}
    >
      <button className="uv-cell-drag-handle" type="button" aria-label="Reorder UDIM tile" {...attributes} {...listeners}>
        <GripVertical aria-hidden="true" size={14} />
      </button>
      <button className="uv-cell-remove" type="button" aria-label="Remove texture" onClick={() => onRemove(texture.id)}>
        <Trash2 aria-hidden="true" size={14} />
      </button>
      <div className="udim-cell-label">
        <strong>{exportUdim}</strong>
        <span>{activeChannel}</span>
      </div>
      {canPreviewInBrowser(texture) ? (
        <img src={texture.objectUrl} alt="" draggable={false} />
      ) : (
        <div className="udim-file-fallback">
          <ImageIcon aria-hidden="true" size={22} />
          <span>{texture.extension.replace(".", "") || "file"}</span>
        </div>
      )}
      {(showUvOverlay && uvPath) || selectedUvPath ? (
        <svg className="udim-uv-overlay" viewBox="0 0 100 100" aria-hidden="true">
          {showUvOverlay && uvPath ? <path className="uv-all-wire" d={uvPath} /> : null}
          {selectedUvPath ? <path className="uv-selected-wire" d={selectedUvPath} /> : null}
        </svg>
      ) : null}
      <footer title={texture.originalName}>{texture.originalName}</footer>
    </article>
  );
}

export function UdimPreviewPanel({
  textures,
  activeChannel,
  activeTextureId,
  editorHeight,
  exportUdims,
  isModelLoaded,
  preparedProjections,
  selectedPreparedProjectionId,
  selectedUvSegments,
  uvSelectionMode,
  uvSegments,
  onActiveChannelChange,
  onImportFiles,
  onPreparedProjectionSelect,
  onUvEditCommand,
  onUvSelectionModeChange,
  onRemove,
}: UdimPreviewPanelProps) {
  const [showUvOverlay, setShowUvOverlay] = useState(false);
  const [isTextureFileOver, setIsTextureFileOver] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [autoCellSize, setAutoCellSize] = useState(180);
  const [uvTransformMode, setUvTransformMode] = useState<UvTransformMode>(null);
  const [targetUdim, setTargetUdim] = useState("1001");
  const [projectionMode, setProjectionMode] = useState<UvProjectionMode>("project-from-view");
  const previewCanvasRef = useRef<HTMLDivElement | null>(null);
  const channelTextures = useMemo(() => getChannelTextures(textures, activeChannel), [activeChannel, textures]);
  const hasUvSelection = selectedUvSegments.length > 0;
  const selectedPreparedProjection = preparedProjections.find((projection) => projection.id === selectedPreparedProjectionId) ?? null;
  const maxColumn = Math.max(
    1,
    ...channelTextures.map((texture) => getUdimGridPosition(exportUdims.get(texture.id) ?? "1001").column),
  );
  const maxRow = Math.max(
    1,
    ...channelTextures.map((texture) => getUdimGridPosition(exportUdims.get(texture.id) ?? "1001").row),
  );
  const previewCellSize = Math.round(autoCellSize * zoom);
  const previewCanvasStyle = {
    "--uv-cell-size": `${previewCellSize}px`,
    "--uv-map-width": `${900 * zoom}px`,
    "--uv-map-height": `${280 * zoom}px`,
  } as CSSProperties;
  const uvBounds = useMemo(
    () => getUvBounds(uvSegments.length > 0 ? uvSegments : selectedUvSegments),
    [selectedUvSegments, uvSegments],
  );
  const uvProjection = useMemo(
    () => (channelTextures.length === 0 && uvSegments.length > 0 ? buildUvProjection(uvSegments, uvBounds) : EMPTY_UV_PROJECTION),
    [channelTextures.length, uvBounds, uvSegments],
  );
  const selectedUvProjection = useMemo(
    () => (
      channelTextures.length === 0 && selectedUvSegments.length > 0
        ? buildUvProjection(selectedUvSegments, uvBounds)
        : EMPTY_UV_PROJECTION
    ),
    [channelTextures.length, selectedUvSegments, uvBounds],
  );
  const uvPathsByTextureId = useMemo(() => {
    if (!showUvOverlay || channelTextures.length === 0 || uvSegments.length === 0) {
      return new Map<string, string>();
    }

    return new Map(
      channelTextures.map((texture) => [
        texture.id,
        buildTileUvPath(uvSegments, exportUdims.get(texture.id) ?? "1001"),
      ]),
    );
  }, [channelTextures, exportUdims, showUvOverlay, uvSegments]);
  const selectedUvPathsByTextureId = useMemo(() => {
    if (channelTextures.length === 0 || selectedUvSegments.length === 0) {
      return new Map<string, string>();
    }

    return new Map(
      channelTextures.map((texture) => [
        texture.id,
        buildTileUvPath(selectedUvSegments, exportUdims.get(texture.id) ?? "1001"),
      ]),
    );
  }, [channelTextures, exportUdims, selectedUvSegments]);

  useEffect(() => {
    const element = previewCanvasRef.current;
    if (!element) {
      return undefined;
    }
    const activeElement = element;

    function updateAutoSize() {
      const bounds = activeElement.getBoundingClientRect();
      const toolsHeight = activeElement.querySelector(".uv-layout-tools")?.getBoundingClientRect().height ?? 0;
      const availableWidth = Math.max(1, bounds.width - UV_GRID_PADDING * 2 - Math.max(0, maxColumn - 1));
      const availableHeight = Math.max(1, bounds.height - toolsHeight - UV_GRID_PADDING * 2 - Math.max(0, maxRow - 1));
      const nextSize = Math.floor(clamp(Math.min(availableWidth / maxColumn, availableHeight / maxRow), 96, 560));
      setAutoCellSize(nextSize);
    }

    updateAutoSize();
    const resizeObserver = new ResizeObserver(updateAutoSize);
    resizeObserver.observe(activeElement);

    return () => {
      resizeObserver.disconnect();
    };
  }, [editorHeight, maxColumn, maxRow]);

  useEffect(() => {
    setZoom(1);
  }, [editorHeight, maxColumn, maxRow]);

  function handleTextureDragOver(event: DragEvent<HTMLElement>) {
    if (!Array.from(event.dataTransfer.types).includes("Files")) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsTextureFileOver(true);
  }

  function handleTextureDrop(event: DragEvent<HTMLElement>) {
    if (!Array.from(event.dataTransfer.types).includes("Files")) {
      return;
    }

    event.preventDefault();
    setIsTextureFileOver(false);
    const files = Array.from(event.dataTransfer.files).filter(isTextureFile);
    if (files.length > 0) {
      onImportFiles(activeChannel, files);
    }
  }

  return (
    <section
      className={`uv-preview-editor${isTextureFileOver ? " is-file-over" : ""}`}
      onDragEnter={handleTextureDragOver}
      onDragLeave={() => setIsTextureFileOver(false)}
      onDragOver={handleTextureDragOver}
      onDrop={handleTextureDrop}
    >
      <header className="editor-header uv-editor-header">
        <div>
          <strong>UV/Image Editor</strong>
          <span>{channelTextures.length > 0 ? activeChannel : isModelLoaded ? "Model UV view" : "UDIM tiles"}</span>
        </div>
        <button
          className={`uv-overlay-toggle${showUvOverlay ? " is-active" : ""}`}
          type="button"
          disabled={uvSegments.length === 0}
          onClick={() => setShowUvOverlay((isVisible) => !isVisible)}
        >
          <Eye aria-hidden="true" size={14} />
          Ver UV
        </button>
        <div className="uv-channel-tabs" role="tablist" aria-label="UV preview channel">
          {TEXTURE_CHANNELS.map((channel) => (
            <button
              className={activeChannel === channel ? "is-active" : ""}
              key={channel}
              type="button"
              onClick={() => onActiveChannelChange(channel)}
              title={channel}
            >
              <span>{channel}</span>
              <strong>{getChannelTextures(textures, channel).length}</strong>
            </button>
          ))}
        </div>
      </header>

      <div ref={previewCanvasRef} className="uv-preview-canvas" style={previewCanvasStyle}>
        <div className="uv-layout-tools" onMouseDown={(event) => event.stopPropagation()}>
          <div className="uv-layout-tool-group">
            <button
              className={uvSelectionMode === "vertices" ? "is-active" : ""}
              type="button"
              disabled={!isModelLoaded}
              onClick={() => onUvSelectionModeChange("vertices")}
              title="1"
            >
              Vertex
            </button>
            <button
              className={uvSelectionMode === "edges" ? "is-active" : ""}
              type="button"
              disabled={!isModelLoaded}
              onClick={() => onUvSelectionModeChange("edges")}
              title="2"
            >
              Edge
            </button>
            <button
              className={uvSelectionMode === "faces" ? "is-active" : ""}
              type="button"
              disabled={!isModelLoaded}
              onClick={() => onUvSelectionModeChange("faces")}
              title="3"
            >
              <ScanSearch aria-hidden="true" size={13} />
              Face
            </button>
            <button
              className={uvSelectionMode === "island" ? "is-active" : ""}
              type="button"
              disabled={!isModelLoaded}
              onClick={() => onUvSelectionModeChange("island")}
              title="4"
            >
              Island
            </button>
            <button type="button" disabled={!isModelLoaded || uvSegments.length === 0}>Show Selected UVs</button>
          </div>
          <label className="uv-target-udim">
            <span>Target UDIM</span>
            <input
              inputMode="numeric"
              value={targetUdim}
              onChange={(event) => setTargetUdim(event.target.value.replace(/[^\d]/g, "").slice(0, 4))}
            />
            <button type="button" disabled={!isModelLoaded || !hasUvSelection} onClick={() => onUvEditCommand("move-to-udim", { targetUdim })}>
              Move Island
            </button>
          </label>
          <div className="uv-layout-tool-group uv-transform-tools">
            <button
              className={uvTransformMode === "move" ? "is-active" : ""}
              type="button"
              disabled={!isModelLoaded || !hasUvSelection}
              onClick={() => {
                setUvTransformMode("move");
                onUvEditCommand("move");
              }}
              title="G"
            >
              G Move
            </button>
            <button
              className={uvTransformMode === "scale" ? "is-active" : ""}
              type="button"
              disabled={!isModelLoaded || !hasUvSelection}
              onClick={() => {
                setUvTransformMode("scale");
                onUvEditCommand("scale");
              }}
              title="S"
            >
              S Scale
            </button>
            <button
              className={uvTransformMode === "rotate" ? "is-active" : ""}
              type="button"
              disabled={!isModelLoaded || !hasUvSelection}
              onClick={() => {
                setUvTransformMode("rotate");
                onUvEditCommand("rotate");
              }}
              title="R"
            >
              R Rotate
            </button>
          </div>
          <label className="uv-projection-picker">
            <span>Projection</span>
            <select value={projectionMode} onChange={(event) => setProjectionMode(event.target.value as UvProjectionMode)}>
              <option value="project-from-view">Project From View</option>
              <option value="planar">Planar Projection</option>
              <option value="box">Box Projection</option>
              <option value="cylindrical">Cylindrical Projection</option>
              <option value="spherical">Spherical Projection</option>
            </select>
          </label>
          <label className="prepared-image-picker">
            <span>Prepared Image</span>
            <select
              value={selectedPreparedProjectionId}
              onChange={(event) => onPreparedProjectionSelect(event.target.value)}
            >
              <option value="">None</option>
              {preparedProjections.map((projection) => (
                <option key={projection.id} value={projection.id}>
                  {projection.name}
                </option>
              ))}
            </select>
          </label>
          {selectedPreparedProjection ? (
            <img className="prepared-image-thumb" src={selectedPreparedProjection.thumbnailUrl} alt="" />
          ) : null}
          <div className="uv-layout-tool-group">
            <button type="button" disabled={!selectedPreparedProjection}>Apply to Selected Island</button>
            <button type="button" disabled={!selectedPreparedProjection}>Apply to Selected Faces</button>
            <button type="button" disabled={!selectedPreparedProjection}>Fit to Island</button>
            <button type="button" disabled={!selectedPreparedProjection}>Center</button>
            <button type="button" disabled={!selectedPreparedProjection} title="Rotate 90 degrees">
              <RotateCw aria-hidden="true" size={13} />
            </button>
            <button type="button" disabled={!selectedPreparedProjection} title="Flip horizontal">
              <FlipHorizontal aria-hidden="true" size={13} />
            </button>
            <button type="button" disabled={!selectedPreparedProjection} title="Flip vertical">
              <FlipVertical aria-hidden="true" size={13} />
            </button>
            <button type="button" disabled={!selectedPreparedProjection}>Bake to Texture</button>
          </div>
        </div>
        {channelTextures.length > 0 ? (
          <SortableContext items={channelTextures.map((texture) => texture.id)} strategy={rectSortingStrategy}>
            <div
              className="udim-tile-grid"
              style={{
                gridTemplateColumns: `repeat(${maxColumn}, var(--uv-cell-size))`,
                gridTemplateRows: `repeat(${maxRow}, var(--uv-cell-size))`,
              }}
            >
              {channelTextures.map((texture) => (
                <UdimPreviewCell
                  key={texture.id}
                  texture={texture}
                  activeChannel={activeChannel}
                  exportUdim={exportUdims.get(texture.id) ?? "1001"}
                  isActive={activeTextureId === texture.id}
                  showUvOverlay={showUvOverlay}
                  selectedUvPath={selectedUvPathsByTextureId.get(texture.id) ?? ""}
                  uvPath={uvPathsByTextureId.get(texture.id) ?? ""}
                  onRemove={onRemove}
                />
              ))}
            </div>
          </SortableContext>
        ) : (
          <div className={`uv-empty-state${isModelLoaded ? " has-model" : ""}`}>
            <Grid3X3 aria-hidden="true" size={18} />
            <svg className="uv-wire-map" viewBox="0 0 900 280" role="img" aria-label="UV grid preview">
              <defs>
                <pattern id="uv-grid-small" width="45" height="45" patternUnits="userSpaceOnUse">
                  <path d="M 45 0 L 0 0 0 45" fill="none" stroke="rgba(255,255,255,0.11)" strokeWidth="1" />
                </pattern>
                <pattern id="uv-grid-large" width="180" height="180" patternUnits="userSpaceOnUse">
                  <rect width="180" height="180" fill="url(#uv-grid-small)" />
                  <path d="M 180 0 L 0 0 0 180" fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="1.5" />
                </pattern>
              </defs>
              <rect width="900" height="280" fill="url(#uv-grid-large)" />
              {isModelLoaded && uvProjection.gridPath ? (
                <path className="uv-major-grid" d={uvProjection.gridPath} fill="none" />
              ) : null}
              {isModelLoaded && uvProjection.uvPath ? (
                <path className="uv-wire" d={uvProjection.uvPath} fill="none" />
              ) : null}
              {isModelLoaded && selectedUvProjection.uvPath ? (
                <path className="uv-selected-wire" d={selectedUvProjection.uvPath} fill="none" />
              ) : null}
            </svg>
          </div>
        )}
        <div className="uv-zoom-control" onMouseDown={(event) => event.stopPropagation()}>
          <ZoomOut aria-hidden="true" size={14} />
          <input
            aria-label="UV editor zoom"
            max="2.25"
            min="0.65"
            step="0.05"
            type="range"
            value={zoom}
            onChange={(event) => setZoom(Number(event.target.value))}
          />
          <ZoomIn aria-hidden="true" size={14} />
        </div>
      </div>
    </section>
  );
}
