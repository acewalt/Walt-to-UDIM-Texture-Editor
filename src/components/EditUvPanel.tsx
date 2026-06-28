import { ChevronsRight, Eye, EyeOff, Grid3X3, Move, RotateCw, Scaling, Send } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { TextureAsset, TextureChannel, UvEditCommandOptions, UvEditCommandType, UvSegment } from "../types/texture";

interface EditUvPanelProps {
  activeChannel: TextureChannel;
  exportUdims: Map<string, string>;
  selectedFaceCount: number;
  selectedUvSegments: UvSegment[];
  textures: TextureAsset[];
  uvSegments: UvSegment[];
  onMinimize: () => void;
  onUvEditCommand: (type: UvEditCommandType, options?: UvEditCommandOptions) => void;
}

type ActiveUvTool = "move" | "scale" | "rotate" | null;

interface ModalTransformState {
  historyGroupId: number;
  lastX: number;
  lastY: number;
  lastDistance: number;
  lastAngle: number;
  typedRotationDeg: number;
}

const EDIT_UV_DEFAULT_VIEWBOX_WIDTH = 960;
const EDIT_UV_DEFAULT_VIEWBOX_HEIGHT = 520;
const EDIT_UV_VIEWBOX_PADDING = 14;
const UDIM_COLUMNS = 10;

const UDIM_MENU_COLUMNS = 10;
const UDIM_MENU_ROWS = 10;

const MINI_MAP_UDIMS = Array.from({ length: UDIM_MENU_ROWS }, (_, row) =>
  Array.from({ length: UDIM_MENU_COLUMNS }, (_, column) => String(1001 + row * UDIM_COLUMNS + column)),
);

function getUdimOffset(udim = "1001") {
  const value = Number.parseInt(udim, 10);
  const zeroBased = Number.isFinite(value) && value >= 1001 ? value - 1001 : 0;
  return {
    x: zeroBased % UDIM_COLUMNS,
    y: Math.floor(zeroBased / UDIM_COLUMNS),
  };
}

function getUdimFromSegments(segments: UvSegment[]) {
  if (segments.length === 0) {
    return "1001";
  }

  const minX = Math.min(...segments.map((segment) => Math.min(segment.x1, segment.x2)));
  const minY = Math.min(...segments.map((segment) => Math.min(segment.y1, segment.y2)));
  const tileIndex = Math.max(0, Math.floor(minX)) + Math.max(0, Math.floor(minY)) * UDIM_COLUMNS;
  return String(1001 + tileIndex);
}

function clipLineToTile(segment: UvSegment, tileX: number, tileY: number): UvSegment | null {
  const minX = tileX;
  const maxX = tileX + 1;
  const minY = tileY;
  const maxY = tileY + 1;
  let t0 = 0;
  let t1 = 1;
  const dx = segment.x2 - segment.x1;
  const dy = segment.y2 - segment.y1;

  const clip = (p: number, q: number) => {
    if (p === 0) {
      return q >= 0;
    }

    const t = q / p;
    if (p < 0) {
      if (t > t1) {
        return false;
      }
      if (t > t0) {
        t0 = t;
      }
    } else {
      if (t < t0) {
        return false;
      }
      if (t < t1) {
        t1 = t;
      }
    }
    return true;
  };

  if (!clip(-dx, segment.x1 - minX) || !clip(dx, maxX - segment.x1) || !clip(-dy, segment.y1 - minY) || !clip(dy, maxY - segment.y1)) {
    return null;
  }

  return {
    x1: segment.x1 + t0 * dx,
    y1: segment.y1 + t0 * dy,
    x2: segment.x1 + t1 * dx,
    y2: segment.y1 + t1 * dy,
  };
}

function buildEditUvProjection(segments: UvSegment[], currentUdim: string, viewBox: { width: number; height: number }) {
  const tile = getUdimOffset(currentUdim);
  const scale = Math.max(80, Math.min(viewBox.width, viewBox.height) - EDIT_UV_VIEWBOX_PADDING * 2);
  const offsetX = (viewBox.width - scale) / 2;
  const offsetY = (viewBox.height - scale) / 2;
  const project = (x: number, y: number) => ({
    x: offsetX + (x - tile.x) * scale,
    y: viewBox.height - offsetY - (y - tile.y) * scale,
  });

  const min = project(tile.x, tile.y);
  const max = project(tile.x + 1, tile.y + 1);
  const tileRect = {
    x: Math.min(min.x, max.x),
    y: Math.min(min.y, max.y),
    width: Math.abs(max.x - min.x),
    height: Math.abs(max.y - min.y),
  };

  const gridPath: string[] = [];
  for (let step = 0; step <= 10; step += 1) {
    const u = tile.x + step / 10;
    const v = tile.y + step / 10;
    const verticalStart = project(u, tile.y);
    const verticalEnd = project(u, tile.y + 1);
    const horizontalStart = project(tile.x, v);
    const horizontalEnd = project(tile.x + 1, v);
    gridPath.push(`M${verticalStart.x.toFixed(2)} ${verticalStart.y.toFixed(2)}L${verticalEnd.x.toFixed(2)} ${verticalEnd.y.toFixed(2)}`);
    gridPath.push(`M${horizontalStart.x.toFixed(2)} ${horizontalStart.y.toFixed(2)}L${horizontalEnd.x.toFixed(2)} ${horizontalEnd.y.toFixed(2)}`);
  }

  const uvPath = segments
    .flatMap((segment) => {
      const clipped = clipLineToTile(segment, tile.x, tile.y);
      if (!clipped) {
        return [];
      }

      const start = project(clipped.x1, clipped.y1);
      const end = project(clipped.x2, clipped.y2);
      return [`M${start.x.toFixed(2)} ${start.y.toFixed(2)}L${end.x.toFixed(2)} ${end.y.toFixed(2)}`];
    })
    .join("");

  return { gridPath: gridPath.join(""), scale, tileRect, uvPath };
}

function getCommandOptions(currentUdim: string, extra: UvEditCommandOptions = {}): UvEditCommandOptions {
  return { currentUdim, ...extra };
}

export function EditUvPanel({
  activeChannel,
  exportUdims,
  selectedFaceCount,
  selectedUvSegments,
  textures,
  uvSegments,
  onMinimize,
  onUvEditCommand,
}: EditUvPanelProps) {
  const [targetUdim, setTargetUdim] = useState("1001");
  const [currentUdim, setCurrentUdim] = useState("1001");
  const [activeTool, setActiveTool] = useState<ActiveUvTool>(null);
  const [isPointerInside, setIsPointerInside] = useState(false);
  const [isUdimMapOpen, setIsUdimMapOpen] = useState(false);
  const [showTileUvs, setShowTileUvs] = useState(false);
  const [showTileImage, setShowTileImage] = useState(true);
  const [rotationInput, setRotationInput] = useState("");
  const [viewBox, setViewBox] = useState({ width: EDIT_UV_DEFAULT_VIEWBOX_WIDTH, height: EDIT_UV_DEFAULT_VIEWBOX_HEIGHT });
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const hoverPointRef = useRef<{ x: number; y: number } | null>(null);
  const modalTransformRef = useRef<ModalTransformState | null>(null);
  const historyGroupCounterRef = useRef(0);
  const editUvProjection = useMemo(() => buildEditUvProjection(selectedUvSegments, currentUdim, viewBox), [currentUdim, selectedUvSegments, viewBox]);
  const tileUvProjection = useMemo(() => buildEditUvProjection(uvSegments, currentUdim, viewBox), [currentUdim, uvSegments, viewBox]);
  const activeTileTexture = useMemo(
    () => textures.find((texture) => texture.channel === activeChannel && exportUdims.get(texture.id) === currentUdim) ?? null,
    [activeChannel, currentUdim, exportUdims, textures],
  );
  const hasSelection = selectedUvSegments.length > 0;
  const canShowTileImage = Boolean(activeTileTexture);

  useEffect(() => {
    if (activeTool !== "rotate") {
      setRotationInput("");
    }
  }, [activeTool]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return undefined;
    }
    const canvasElement = canvas;

    function updateViewBox() {
      const bounds = canvasElement.getBoundingClientRect();
      setViewBox({
        width: Math.max(260, Math.round(bounds.width)),
        height: Math.max(260, Math.round(bounds.height)),
      });
    }

    updateViewBox();
    const observer = new ResizeObserver(updateViewBox);
    observer.observe(canvasElement);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const nextUdim = getUdimFromSegments(selectedUvSegments);
    setCurrentUdim(nextUdim);
    setTargetUdim(nextUdim);
  }, [selectedUvSegments]);

  useEffect(() => {
    if (!isPointerInside) {
      return undefined;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable='true']")) {
        return;
      }

      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === "z") {
        event.preventDefault();
        setActiveTool(null);
        clearModalTransform();
        onUvEditCommand(event.shiftKey ? "redo" : "undo", getCommandOptions(currentUdim));
        return;
      }

      if ((event.ctrlKey || event.metaKey) && key === "y") {
        event.preventDefault();
        clearModalTransform();
        onUvEditCommand("redo", getCommandOptions(currentUdim));
        return;
      }

      if (activeTool === "rotate" && handleRotateNumericKey(event)) {
        return;
      }

      if (key === "escape" || key === "enter") {
        clearModalTransform();
        return;
      }

      if (key === "g" || key === "s" || key === "r") {
        event.preventDefault();
        startModalTransform(key === "g" ? "move" : key === "s" ? "scale" : "rotate");
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeTool, currentUdim, hasSelection, isPointerInside, onUvEditCommand, rotationInput]);

  function sendCommand(type: UvEditCommandType, options: UvEditCommandOptions = {}) {
    if (!hasSelection && type !== "move-to-udim") {
      return;
    }

    onUvEditCommand(type, getCommandOptions(currentUdim, options));
  }

  function clearModalTransform() {
    setActiveTool(null);
    setRotationInput("");
    modalTransformRef.current = null;
  }

  function getTransformCenter(canvasBounds: DOMRect) {
    const tileCenterX = editUvProjection.tileRect.x + editUvProjection.tileRect.width / 2;
    const tileCenterY = editUvProjection.tileRect.y + editUvProjection.tileRect.height / 2;
    return {
      x: canvasBounds.left + (tileCenterX / viewBox.width) * canvasBounds.width,
      y: canvasBounds.top + (tileCenterY / viewBox.height) * canvasBounds.height,
    };
  }

  function createModalTransformState(point: { x: number; y: number }, historyGroupId: number) {
    const canvasBounds = canvasRef.current?.getBoundingClientRect();
    if (!canvasBounds) {
      return { historyGroupId, lastX: point.x, lastY: point.y, lastDistance: 1, lastAngle: 0, typedRotationDeg: 0 };
    }

    const center = getTransformCenter(canvasBounds);
    return {
      historyGroupId,
      lastX: point.x,
      lastY: point.y,
      lastDistance: Math.max(1, Math.hypot(point.x - center.x, point.y - center.y)),
      lastAngle: Math.atan2(point.y - center.y, point.x - center.x),
      typedRotationDeg: 0,
    };
  }

  function getFallbackModalPoint() {
    const canvasBounds = canvasRef.current?.getBoundingClientRect();
    if (!canvasBounds) {
      return { x: 0, y: 0 };
    }

    return getTransformCenter(canvasBounds);
  }

  function ensureModalTransformState() {
    if (modalTransformRef.current) {
      return modalTransformRef.current;
    }

    historyGroupCounterRef.current += 1;
    const point = hoverPointRef.current ?? getFallbackModalPoint();
    modalTransformRef.current = createModalTransformState(point, historyGroupCounterRef.current);
    return modalTransformRef.current;
  }

  function applyRotationNumericValue(nextValue: string) {
    if (!hasSelection) {
      return;
    }

    const transformState = ensureModalTransformState();
    const parsedValue = Number.parseFloat(nextValue);
    const nextRotationDeg = Number.isFinite(parsedValue) ? parsedValue : 0;
    const deltaRotationDeg = nextRotationDeg - transformState.typedRotationDeg;

    modalTransformRef.current = {
      ...transformState,
      typedRotationDeg: nextRotationDeg,
    };
    setRotationInput(nextValue);

    if (Math.abs(deltaRotationDeg) > 0.0001) {
      sendCommand("rotate", {
        historyGroupId: transformState.historyGroupId,
        rotationDeg: deltaRotationDeg,
      });
    }
  }

  function handleRotateNumericKey(event: KeyboardEvent) {
    const key = event.key;
    let nextValue: string | null = null;

    if (/^\d$/.test(key)) {
      nextValue = `${rotationInput}${key}`;
    } else if (key === "." && !rotationInput.includes(".")) {
      nextValue = rotationInput.length > 0 ? `${rotationInput}.` : "0.";
    } else if (key === "-" && rotationInput.length === 0) {
      nextValue = "-";
    } else if (key === "Backspace") {
      nextValue = rotationInput.slice(0, -1);
    }

    if (nextValue === null) {
      return false;
    }

    event.preventDefault();
    applyRotationNumericValue(nextValue);
    return true;
  }

  function startModalTransform(tool: Exclude<ActiveUvTool, null>) {
    if (!hasSelection) {
      return;
    }

    setActiveTool(tool);
    setRotationInput("");
    historyGroupCounterRef.current += 1;
    modalTransformRef.current = hoverPointRef.current ? createModalTransformState(hoverPointRef.current, historyGroupCounterRef.current) : null;
  }

  function toggleModalTransform(tool: Exclude<ActiveUvTool, null>) {
    if (activeTool === tool) {
      clearModalTransform();
      return;
    }

    startModalTransform(tool);
  }

  function handleCanvasPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!activeTool || event.button !== 0) {
      return;
    }

    event.preventDefault();
    clearModalTransform();
  }

  function handleCanvasPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    hoverPointRef.current = { x: event.clientX, y: event.clientY };

    if (!activeTool || !hasSelection) {
      return;
    }

    if (!modalTransformRef.current) {
      historyGroupCounterRef.current += 1;
      modalTransformRef.current = createModalTransformState(hoverPointRef.current, historyGroupCounterRef.current);
      return;
    }

    const canvasBounds = canvasRef.current?.getBoundingClientRect();
    if (!canvasBounds) {
      return;
    }

    const dampening = event.shiftKey ? 0.25 : 1;
    const currentState = modalTransformRef.current;

    if (activeTool === "move") {
      const deltaX = (event.clientX - currentState.lastX) * dampening;
      const deltaY = (event.clientY - currentState.lastY) * dampening;
      if (Math.abs(deltaX) + Math.abs(deltaY) < 0.8) {
        return;
      }

      modalTransformRef.current = { ...currentState, lastX: event.clientX, lastY: event.clientY };
      const viewboxPerCssX = viewBox.width / Math.max(1, canvasBounds.width);
      const viewboxPerCssY = viewBox.height / Math.max(1, canvasBounds.height);
      sendCommand("move", {
        deltaU: (deltaX * viewboxPerCssX) / editUvProjection.scale,
        deltaV: (-deltaY * viewboxPerCssY) / editUvProjection.scale,
        historyGroupId: currentState.historyGroupId,
      });
      return;
    }

    const center = getTransformCenter(canvasBounds);
    if (activeTool === "scale") {
      const distance = Math.max(1, Math.hypot(event.clientX - center.x, event.clientY - center.y));
      const rawScale = distance / Math.max(1, currentState.lastDistance);
      const scaleFactor = event.shiftKey ? 1 + (rawScale - 1) * 0.25 : rawScale;
      if (Math.abs(scaleFactor - 1) < 0.004) {
        return;
      }

      modalTransformRef.current = { ...currentState, lastX: event.clientX, lastY: event.clientY, lastDistance: distance };
      sendCommand("scale", {
        historyGroupId: currentState.historyGroupId,
        scaleFactor: Math.max(0.92, Math.min(1.08, scaleFactor)),
      });
      return;
    }

    const angle = Math.atan2(event.clientY - center.y, event.clientX - center.x);
    let deltaAngle = angle - currentState.lastAngle;
    if (deltaAngle > Math.PI) {
      deltaAngle -= Math.PI * 2;
    } else if (deltaAngle < -Math.PI) {
      deltaAngle += Math.PI * 2;
    }
    const rotationDeg = (-deltaAngle * 180 / Math.PI) * dampening;
    if (Math.abs(rotationDeg) < 0.15) {
      return;
    }

    modalTransformRef.current = { ...currentState, lastX: event.clientX, lastY: event.clientY, lastAngle: angle };
    sendCommand("rotate", { historyGroupId: currentState.historyGroupId, rotationDeg });
  }

  function handleMiniMapUdimClick(udim: string) {
    setCurrentUdim(udim);
    setTargetUdim(udim);
    setIsUdimMapOpen(false);
  }

  return (
    <section
      className="edit-uv-panel"
      aria-label="UV Editor"
      onPointerEnter={() => setIsPointerInside(true)}
      onPointerLeave={() => setIsPointerInside(false)}
    >
      <header className="edit-uv-panel-header">
        <span>
          <Grid3X3 aria-hidden="true" size={15} />
          UV Editor
        </span>
        <strong>{selectedFaceCount} selected</strong>
        <button className="edit-uv-minimize-button" type="button" title="Minimize UV Editor" onClick={onMinimize}>
          <ChevronsRight aria-hidden="true" size={14} />
        </button>
      </header>
      <div className="edit-uv-toolbar">
        <button
          className={activeTool === "move" ? "is-active" : ""}
          type="button"
          disabled={!hasSelection}
          onClick={() => toggleModalTransform("move")}
        >
          <Move aria-hidden="true" size={13} />
          G Move
        </button>
        <button
          className={activeTool === "scale" ? "is-active" : ""}
          type="button"
          disabled={!hasSelection}
          onClick={() => toggleModalTransform("scale")}
        >
          <Scaling aria-hidden="true" size={13} />
          S Scale
        </button>
        <button
          className={activeTool === "rotate" ? "is-active" : ""}
          type="button"
          disabled={!hasSelection}
          onClick={() => toggleModalTransform("rotate")}
        >
          <RotateCw aria-hidden="true" size={13} />
          R Rotate
        </button>
        <button type="button" disabled={!hasSelection} onClick={() => sendCommand("normalize")}>Normalize</button>
        <button type="button" disabled={!hasSelection} onClick={() => sendCommand("straight")}>Straight</button>
        <button type="button" disabled={!hasSelection} onClick={() => sendCommand("gridify")}>Gridify</button>
        <button type="button" disabled={!hasSelection} onClick={() => sendCommand("rectify")}>Rectify</button>
        <button
          className={showTileUvs ? "is-active" : ""}
          type="button"
          disabled={uvSegments.length === 0}
          onClick={() => setShowTileUvs((isVisible) => !isVisible)}
          title="Show every model UV edge inside the current UDIM"
        >
          <Grid3X3 aria-hidden="true" size={13} />
          Tile UVs
        </button>
        <button
          className={showTileImage && canShowTileImage ? "is-active" : ""}
          type="button"
          disabled={!canShowTileImage}
          onClick={() => setShowTileImage((isVisible) => !isVisible)}
          title={canShowTileImage ? activeTileTexture?.originalName : "No image on current UDIM"}
        >
          {showTileImage ? <Eye aria-hidden="true" size={13} /> : <EyeOff aria-hidden="true" size={13} />}
          Image
        </button>
      </div>
      <div className="edit-uv-context-row">
        <div className="edit-udim-menu">
          <button
            className={`edit-udim-menu-trigger${isUdimMapOpen ? " is-active" : ""}`}
            type="button"
            onClick={() => setIsUdimMapOpen((isOpen) => !isOpen)}
          >
            UDIM {currentUdim}
            <ChevronsRight aria-hidden="true" size={12} />
          </button>
          {isUdimMapOpen ? (
            <div className="edit-udim-minimap" aria-label="Current UDIM map">
              {MINI_MAP_UDIMS.flat().map((udim) => (
                <button
                  className={currentUdim === udim ? "is-active" : ""}
                  key={udim}
                  type="button"
                  onClick={() => handleMiniMapUdimClick(udim)}
                >
                  {udim}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <label className="edit-uv-target-udim">
          <span>Target UDIM</span>
          <input
            inputMode="numeric"
            value={targetUdim}
            onChange={(event) => setTargetUdim(event.target.value.replace(/[^\d]/g, "").slice(0, 4))}
          />
        </label>
        <button
          className="edit-uv-move-to-udim"
          type="button"
          disabled={!hasSelection}
          onClick={() => sendCommand("move-to-udim", { targetUdim })}
        >
          <Send aria-hidden="true" size={13} />
          Move to UDIM
        </button>
      </div>
      <div
        ref={canvasRef}
        className={`edit-uv-canvas${activeTool ? " is-transforming" : ""}`}
        onPointerDown={handleCanvasPointerDown}
        onPointerMove={handleCanvasPointerMove}
      >
        <svg viewBox={`0 0 ${viewBox.width} ${viewBox.height}`} aria-label="Selected UV editor">
          <defs>
            <pattern id="edit-uv-panel-grid" width="32" height="32" patternUnits="userSpaceOnUse">
              <path d="M 32 0 L 0 0 0 32" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
            </pattern>
          </defs>
          <rect width={viewBox.width} height={viewBox.height} fill="url(#edit-uv-panel-grid)" />
          {showTileImage && activeTileTexture ? (
            <image
              className="edit-uv-tile-image"
              href={activeTileTexture.objectUrl}
              preserveAspectRatio="none"
              {...editUvProjection.tileRect}
            />
          ) : null}
          <rect className="edit-uv-current-tile" {...editUvProjection.tileRect} />
          {editUvProjection.gridPath ? <path className="edit-uv-major-grid" d={editUvProjection.gridPath} /> : null}
          {showTileUvs && tileUvProjection.uvPath ? <path className="edit-uv-other-path" d={tileUvProjection.uvPath} /> : null}
          {editUvProjection.uvPath ? <path className="edit-uv-selected-path" d={editUvProjection.uvPath} /> : null}
        </svg>
        {activeTool === "rotate" && rotationInput ? <div className="edit-uv-modal-readout">Rotate {rotationInput} deg</div> : null}
        {selectedUvSegments.length === 0 ? <div className="edit-uv-empty">Select faces or an island in the viewport.</div> : null}
      </div>
      <footer className="edit-uv-panel-footer">
        {(["project-from-view", "planar", "box", "cylindrical", "spherical"] as UvEditCommandType[]).map((command) => (
          <button key={command} type="button" disabled={!hasSelection} onClick={() => sendCommand(command)}>
            {command === "project-from-view" ? "Project From View" : command[0].toUpperCase() + command.slice(1)}
          </button>
        ))}
      </footer>
    </section>
  );
}
