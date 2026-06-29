import { ChangeEvent, type CSSProperties, type PointerEvent as ReactPointerEvent, useCallback, useMemo, useRef, useState } from "react";
import {
  closestCorners,
  DndContext,
  DragEndEvent,
  DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { arrayMove, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import {
  Box,
  ChevronDown,
  ChevronRight,
  Download,
  Eye,
  EyeOff,
  FileBox,
  FolderTree,
  CircleHelp,
  ImagePlus,
  Layers3,
  Settings2,
} from "lucide-react";
import { EditUvPanel } from "./components/EditUvPanel";
import { ModelViewer } from "./components/ModelViewer";
import { ProjectionRipper } from "./components/ProjectionRipper";
import { UdimPreviewPanel } from "./components/UdimPreviewPanel";
import {
  TEXTURE_CHANNELS,
  type ModelOutlinerNode,
  type NamedTextureAsset,
  type PaintExportLayer,
  type PreparedProjection,
  type TextureAsset,
  type TextureChannel,
  type UvEditCommand,
  type UvEditCommandOptions,
  type UvEditCommandType,
  type UvSegment,
} from "./types/texture";
import { exportRenamedTextures } from "./utils/exportZip";
import { buildFinalNameMap, type ExportNameOptions, type NameSeparator } from "./utils/rename";
import { createTextureAsset, getExportUdimForIndex, validateTextures } from "./utils/udim";

function getTextureChannel(textures: TextureAsset[], id: string): TextureChannel | null {
  return textures.find((texture) => texture.id === id)?.channel ?? null;
}

function reorderWithinChannel(textures: TextureAsset[], activeId: string, overId: string): TextureAsset[] {
  const activeTexture = textures.find((texture) => texture.id === activeId);
  const overTexture = textures.find((texture) => texture.id === overId);
  if (!activeTexture || !overTexture || activeTexture.channel !== overTexture.channel) {
    return textures;
  }

  const channelTextures = textures.filter((texture) => texture.channel === activeTexture.channel);
  const activeIndex = channelTextures.findIndex((texture) => texture.id === activeId);
  const overIndex = channelTextures.findIndex((texture) => texture.id === overId);

  if (activeIndex < 0 || overIndex < 0) {
    return textures;
  }

  const reorderedChannel = arrayMove(channelTextures, activeIndex, overIndex);
  let nextChannelIndex = 0;
  return textures.map((texture) =>
    texture.channel === activeTexture.channel ? reorderedChannel[nextChannelIndex++] : texture,
  );
}

type WorkspaceMode = "uv-layout" | "texture-projection";
type UvSelectionMode = "vertices" | "edges" | "faces" | "island";
type ViewportMode = "object" | "edit" | "texture-paint";

export default function App() {
  const [textures, setTextures] = useState<TextureAsset[]>([]);
  const [baseName, setBaseName] = useState("Brigitte_body");
  const [nameSeparator, setNameSeparator] = useState<NameSeparator>(".");
  const [includeExtension, setIncludeExtension] = useState(true);
  const [activeImportChannel, setActiveImportChannel] = useState<TextureChannel>("BaseColor");
  const [activeTextureId, setActiveTextureId] = useState<string | null>(null);
  const [isFileMenuOpen, setIsFileMenuOpen] = useState(false);
  const [isHelpMenuOpen, setIsHelpMenuOpen] = useState(false);
  const [isModelLoaded, setIsModelLoaded] = useState(false);
  const [modelNodes, setModelNodes] = useState<ModelOutlinerNode[]>([]);
  const [hiddenModelNodeIds, setHiddenModelNodeIds] = useState<Set<string>>(() => new Set());
  const [modelUvSegments, setModelUvSegments] = useState<UvSegment[]>([]);
  const [selectedUvSegments, setSelectedUvSegments] = useState<UvSegment[]>([]);
  const [selectedEditFaceCount, setSelectedEditFaceCount] = useState(0);
  const [uvSelectionMode, setUvSelectionMode] = useState<UvSelectionMode>("faces");
  const [viewportMode, setViewportMode] = useState<ViewportMode>("object");
  const [editUvPanelWidth, setEditUvPanelWidth] = useState(760);
  const [isEditUvPanelMinimized, setIsEditUvPanelMinimized] = useState(false);
  const [uvEditorHeight, setUvEditorHeight] = useState(270);
  const [uvEditCommand, setUvEditCommand] = useState<UvEditCommand | null>(null);
  const [modelExportRequest, setModelExportRequest] = useState(0);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("uv-layout");
  const [preparedProjections, setPreparedProjections] = useState<PreparedProjection[]>([]);
  const [selectedPreparedProjectionId, setSelectedPreparedProjectionId] = useState<string>("");
  const mainEditorRef = useRef<HTMLElement | null>(null);
  const menuTextureInputRef = useRef<HTMLInputElement | null>(null);
  const menuFbxInputRef = useRef<HTMLInputElement | null>(null);
  const paintExportLayerRef = useRef<PaintExportLayer | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 6,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const exportUdims = useMemo(() => {
    const udims = new Map<string, string>();
    TEXTURE_CHANNELS.forEach((channel) => {
      textures
        .filter((texture) => texture.channel === channel)
        .forEach((texture, index) => {
          udims.set(texture.id, getExportUdimForIndex(index));
        });
    });
    return udims;
  }, [textures]);
  const exportNameOptions = useMemo<ExportNameOptions>(
    () => ({
      separator: nameSeparator,
      includeExtension,
    }),
    [includeExtension, nameSeparator],
  );
  const finalNames = useMemo(
    () => buildFinalNameMap(textures, baseName, exportNameOptions, exportUdims),
    [textures, baseName, exportNameOptions, exportUdims],
  );
  const validationIssues = useMemo(() => validateTextures(textures, finalNames), [textures, finalNames]);
  const namedTextures = useMemo<NamedTextureAsset[]>(
    () =>
      textures.map((texture) => ({
        ...texture,
        finalName: finalNames.get(texture.id) ?? texture.originalName,
      })),
    [textures, finalNames],
  );
  const errors = validationIssues.filter((issue) => issue.severity === "error");
  const warnings = validationIssues.filter((issue) => issue.severity === "warning");
  const canExport = namedTextures.length > 0 && errors.length === 0;
  const exportPreviewName =
    namedTextures[0]?.finalName ??
    `${baseName.trim() || "TextureSet"}_BaseColor${nameSeparator}1001${includeExtension ? ".png" : ""}`;
  const mainEditorStyle = {
    "--edit-uv-panel-width": `${editUvPanelWidth}px`,
    "--uv-editor-height": `${uvEditorHeight}px`,
  } as CSSProperties;

  const requestUvEditCommand = useCallback((type: UvEditCommandType, options: UvEditCommandOptions = {}) => {
    setUvEditCommand((currentCommand) => ({
      id: (currentCommand?.id ?? 0) + 1,
      type,
      ...options,
    }));
  }, []);

  function handleImportFiles(channel: TextureChannel, files: File[]) {
    setTextures((currentTextures) => [
      ...currentTextures,
      ...files.map((file) => createTextureAsset(file, channel)),
    ]);
  }

  function handleMenuTextureImport(event: ChangeEvent<HTMLInputElement>) {
    const files = event.target.files;
    if (!files || files.length === 0) {
      return;
    }

    handleImportFiles(activeImportChannel, Array.from(files));
    event.target.value = "";
    setIsFileMenuOpen(false);
  }

  function handleExport() {
    if (!canExport) {
      return;
    }

    exportRenamedTextures(namedTextures, baseName, paintExportLayerRef.current);
    setIsFileMenuOpen(false);
    setIsHelpMenuOpen(false);
  }

  function handleModelExport() {
    if (!isModelLoaded) {
      return;
    }

    setModelExportRequest((request) => request + 1);
    setIsFileMenuOpen(false);
    setIsHelpMenuOpen(false);
  }

  function handlePreparedProjectionAdd(projection: PreparedProjection) {
    setPreparedProjections((currentProjections) => [projection, ...currentProjections]);
    setSelectedPreparedProjectionId(projection.id);
  }

  const handleModelNodesChange = useCallback((nodes: ModelOutlinerNode[]) => {
    setModelNodes(nodes);
    setHiddenModelNodeIds(new Set());
  }, []);

  const handleToggleModelNode = useCallback((id: string) => {
    setHiddenModelNodeIds((currentHiddenIds) => {
      const nextHiddenIds = new Set(currentHiddenIds);
      if (nextHiddenIds.has(id)) {
        nextHiddenIds.delete(id);
      } else {
        nextHiddenIds.add(id);
      }

      return nextHiddenIds;
    });
  }, []);

  function handleUvResizePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    const editor = mainEditorRef.current;
    if (!editor) {
      return;
    }

    event.preventDefault();
    const bounds = editor.getBoundingClientRect();
    const minimumUvHeight = 170;
    const maximumUvHeight = Math.max(minimumUvHeight, bounds.height - 240);

    function handlePointerMove(moveEvent: PointerEvent) {
      const nextHeight = Math.min(maximumUvHeight, Math.max(minimumUvHeight, bounds.bottom - moveEvent.clientY));
      setUvEditorHeight(Math.round(nextHeight));
    }

    function handlePointerUp() {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  }

  function handleEditUvPanelResizePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    const editor = mainEditorRef.current;
    if (!editor) {
      return;
    }

    event.preventDefault();
    const bounds = editor.getBoundingClientRect();
    const minimumPanelWidth = 360;
    const maximumPanelWidth = Math.max(minimumPanelWidth, bounds.width - 360);

    function handlePointerMove(moveEvent: PointerEvent) {
      const nextWidth = Math.min(maximumPanelWidth, Math.max(minimumPanelWidth, bounds.right - moveEvent.clientX));
      setEditUvPanelWidth(Math.round(nextWidth));
    }

    function handlePointerUp() {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  }

  function handleRemove(id: string) {
    setTextures((currentTextures) => {
      const texture = currentTextures.find((item) => item.id === id);
      if (texture) {
        URL.revokeObjectURL(texture.objectUrl);
      }

      return currentTextures.filter((item) => item.id !== id);
    });
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveTextureId(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent) {
    const activeId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;
    setActiveTextureId(null);

    if (!overId || activeId === overId) {
      return;
    }

    const activeChannel = getTextureChannel(textures, activeId);
    const overChannel = getTextureChannel(textures, overId);

    if (!activeChannel || !overChannel) {
      return;
    }

    if (activeChannel === overChannel) {
      setTextures((currentTextures) => reorderWithinChannel(currentTextures, activeId, overId));
    }
  }

  const modelViewer = (
    <ModelViewer
      textures={textures}
      fbxInputRef={menuFbxInputRef}
      hiddenModelNodeIds={hiddenModelNodeIds}
      onModelNodesChange={handleModelNodesChange}
      onModelLoaded={setIsModelLoaded}
      onModelUvLayout={setModelUvSegments}
      onViewportModeChange={setViewportMode}
      editSelectionMode={uvSelectionMode}
      onEditSelectionModeChange={setUvSelectionMode}
      onSelectedUvSegmentsChange={setSelectedUvSegments}
      onSelectedFaceCountChange={setSelectedEditFaceCount}
      uvEditCommand={uvEditCommand}
      modelExportRequest={modelExportRequest}
      onPaintLayerChange={(paintLayer) => {
        paintExportLayerRef.current = paintLayer;
      }}
    />
  );

  return (
    <main className="app-shell blender-shell">
      <header className="top-menu-bar">
        <div className="app-brand-mini">
          <Layers3 aria-hidden="true" size={15} />
          <span>Walt to UDIM Texture Editor</span>
        </div>
        <nav className="top-menu-nav" aria-label="Application menu">
          <div className="menu-root">
            <button
              className="menu-root-button"
              type="button"
              onClick={() => {
                setIsFileMenuOpen((isOpen) => !isOpen);
                setIsHelpMenuOpen(false);
              }}
            >
              File
              <ChevronDown aria-hidden="true" size={13} />
            </button>
            {isFileMenuOpen ? (
              <div className="file-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setIsFileMenuOpen(false);
                    menuTextureInputRef.current?.click();
                  }}
                >
                  <span className="menu-item-main">
                    <ImagePlus aria-hidden="true" size={15} />
                    Import Textures
                  </span>
                  <span className="menu-item-meta">{activeImportChannel}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setIsFileMenuOpen(false);
                    menuFbxInputRef.current?.click();
                  }}
                >
                  <span className="menu-item-main">
                    <FileBox aria-hidden="true" size={15} />
                    Import Model
                  </span>
                  <span className="menu-item-meta">FBX / OBJ</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={!canExport}
                  onClick={() => {
                    setIsFileMenuOpen(false);
                    handleExport();
                  }}
                >
                  <span className="menu-item-main">
                    <Download aria-hidden="true" size={15} />
                    Export Renamed Textures
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={!isModelLoaded}
                  onClick={() => {
                    setIsFileMenuOpen(false);
                    handleModelExport();
                  }}
                >
                  <span className="menu-item-main">
                    <FileBox aria-hidden="true" size={15} />
                    Export Model OBJ
                  </span>
                </button>
              </div>
            ) : null}
          </div>
          <button
            className="menu-root-button"
            type="button"
            onClick={() => {
              setIsFileMenuOpen(false);
              setIsHelpMenuOpen(false);
            }}
          >
            Edit
          </button>
          <div className="menu-root">
            <button
              className="menu-root-button"
              type="button"
              onClick={() => {
                setIsHelpMenuOpen((isOpen) => !isOpen);
                setIsFileMenuOpen(false);
              }}
            >
              <CircleHelp aria-hidden="true" size={14} />
              Help
              <ChevronDown aria-hidden="true" size={13} />
            </button>
            {isHelpMenuOpen ? (
              <div className="file-menu help-menu" role="menu">
                <header>
                  <CircleHelp aria-hidden="true" size={15} />
                  <strong>Acerca de</strong>
                </header>
                <p>
                  If you found this helpful and would like to support its development, you can buy
                  me a coffee. Thank you so much for your support!
                </p>
                <p>
                  Si esto te resulto util y quieres apoyar su desarrollo, puedes invitarme un cafe.
                  Muchas gracias por tu apoyo!
                </p>
                <a href="https://paypal.me/waltDx" target="_blank" rel="noreferrer">
                  https://paypal.me/waltDx
                </a>
              </div>
            ) : null}
          </div>
        </nav>
        <div className="workspace-mode-tabs" role="tablist" aria-label="Workspace mode">
          <button
            className={workspaceMode === "uv-layout" ? "is-active" : ""}
            type="button"
            onClick={() => setWorkspaceMode("uv-layout")}
          >
            UV Layout Editor
          </button>
          <button
            className={workspaceMode === "texture-projection" ? "is-active" : ""}
            type="button"
            onClick={() => setWorkspaceMode("texture-projection")}
          >
            Texture Projection
          </button>
        </div>
        <input
          ref={menuTextureInputRef}
          className="hidden-input"
          type="file"
          accept="image/*,.exr,.tif,.tiff"
          multiple
          onChange={handleMenuTextureImport}
        />
      </header>

      <div className="blender-workspace">
        <section
          ref={mainEditorRef}
          className={`main-editor${workspaceMode === "texture-projection" ? " is-projection-mode" : ""}${workspaceMode === "uv-layout" && viewportMode === "edit" ? " has-edit-uv-panel" : ""}`}
          style={mainEditorStyle}
        >
          <div className={`uv-layout-workspace${workspaceMode === "uv-layout" ? " is-active" : ""}`} aria-hidden={workspaceMode !== "uv-layout"}>
            <>
              <div
                className={`editor-top-area${viewportMode === "edit" ? " is-edit-split" : ""}${
                  viewportMode === "edit" && isEditUvPanelMinimized ? " is-uv-minimized" : ""
                }`}
              >
                {modelViewer}
                {viewportMode === "edit" ? (
                  isEditUvPanelMinimized ? (
                    <button
                      className="edit-uv-panel-restore"
                      type="button"
                      title="Show UV Editor"
                      onClick={() => setIsEditUvPanelMinimized(false)}
                    >
                      UV
                    </button>
                  ) : (
                    <>
                      <div
                        className="editor-column-resize-handle edit-uv-panel-resize-handle"
                        role="separator"
                        aria-label="Resize UV Editor"
                        onPointerDown={handleEditUvPanelResizePointerDown}
                      />
                      <EditUvPanel
                        activeChannel={activeImportChannel}
                        exportUdims={exportUdims}
                        selectedFaceCount={selectedEditFaceCount}
                        selectedUvSegments={selectedUvSegments}
                        textures={textures}
                        uvSegments={modelUvSegments}
                        onMinimize={() => setIsEditUvPanelMinimized(true)}
                        onUvEditCommand={requestUvEditCommand}
                      />
                    </>
                  )
                ) : null}
              </div>
              <div className="editor-resize-handle" role="separator" aria-label="Resize UV/Image Editor" onPointerDown={handleUvResizePointerDown} />
              <DndContext
                sensors={sensors}
                collisionDetection={closestCorners}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
                onDragCancel={() => setActiveTextureId(null)}
              >
                <UdimPreviewPanel
                  textures={textures}
                  activeChannel={activeImportChannel}
                  activeTextureId={activeTextureId}
                  editorHeight={uvEditorHeight}
                  exportUdims={exportUdims}
                  isModelLoaded={isModelLoaded}
                  preparedProjections={preparedProjections}
                  selectedPreparedProjectionId={selectedPreparedProjectionId}
                  selectedUvSegments={selectedUvSegments}
                  uvSelectionMode={uvSelectionMode}
                  uvSegments={modelUvSegments}
                  onActiveChannelChange={setActiveImportChannel}
                  onImportFiles={handleImportFiles}
                  onPreparedProjectionSelect={setSelectedPreparedProjectionId}
                  onUvEditCommand={requestUvEditCommand}
                  onUvSelectionModeChange={setUvSelectionMode}
                  onRemove={handleRemove}
                />
              </DndContext>
            </>
          </div>
          {workspaceMode === "texture-projection" ? (
            <ProjectionRipper
              preparedProjections={preparedProjections}
              onPreparedProjectionAdd={handlePreparedProjectionAdd}
            />
          ) : null}
        </section>

        <aside className="side-panels">
          <section className="outliner-panel scene-outliner-panel">
            <header className="panel-title">
              <FolderTree aria-hidden="true" size={15} />
              <span>Outliner</span>
            </header>
            <div className="outliner-tree">
              <div className="outliner-row outliner-collection">
                <ChevronDown aria-hidden="true" size={13} />
                <FolderTree aria-hidden="true" size={14} />
                <span>Scene Collection</span>
              </div>
              {modelNodes.length === 0 ? (
                <div className="outliner-empty">No model imported</div>
              ) : (
                modelNodes.map((node) => (
                  <div
                    className={`outliner-row outliner-node is-${node.type}${hiddenModelNodeIds.has(node.id) ? " is-hidden-node" : ""}`}
                    key={node.id}
                    style={{ paddingLeft: `${10 + node.depth * 16}px` }}
                  >
                    <ChevronRight className={node.childCount === 0 ? "is-placeholder" : ""} aria-hidden="true" size={13} />
                    <Box aria-hidden="true" size={14} />
                    <span title={node.name}>{node.name}</span>
                    <button
                      className="outliner-visibility-button"
                      type="button"
                      aria-label={hiddenModelNodeIds.has(node.id) ? `Show ${node.name}` : `Hide ${node.name}`}
                      title={hiddenModelNodeIds.has(node.id) ? "Show object" : "Hide object"}
                      onClick={() => handleToggleModelNode(node.id)}
                    >
                      {hiddenModelNodeIds.has(node.id) ? <EyeOff aria-hidden="true" size={14} /> : <Eye aria-hidden="true" size={14} />}
                    </button>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="properties-panel">
            <header className="panel-title">
              <Settings2 aria-hidden="true" size={15} />
              <span>Properties</span>
            </header>
            <div className="properties-scroll">
              <section className="property-block">
                <header className="property-block-header">
                  <strong>Base Info</strong>
                </header>
                <div className="property-block-body">
                  <label className="field">
                    <span>Base name</span>
                    <input value={baseName} onChange={(event) => setBaseName(event.target.value)} />
                  </label>
                  <div className="outliner-stats">
                    <div>
                      <strong>{textures.length}</strong>
                      <span>Textures</span>
                    </div>
                    <div>
                      <strong>{new Set(exportUdims.values()).size}</strong>
                      <span>UDIMs</span>
                    </div>
                    <div>
                      <strong>{validationIssues.length}</strong>
                      <span>Issues</span>
                    </div>
                  </div>
                  <div className="prepared-projection-summary">
                    <strong>Prepared Projections</strong>
                    {preparedProjections.length === 0 ? (
                      <span>No prepared images</span>
                    ) : (
                      preparedProjections.slice(0, 5).map((projection) => (
                        <button
                          className={selectedPreparedProjectionId === projection.id ? "is-active" : ""}
                          key={projection.id}
                          type="button"
                          onClick={() => {
                            setSelectedPreparedProjectionId(projection.id);
                            setWorkspaceMode("uv-layout");
                          }}
                        >
                          <img src={projection.thumbnailUrl} alt="" />
                          <span>{projection.name}</span>
                          <small>{projection.status}</small>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              </section>

              <section className="property-block">
                <header className="property-block-header">
                  <strong>Export Settings</strong>
                </header>
                <div className="property-block-body">
                  <label className="field">
                    <span>Export name</span>
                    <output title={exportPreviewName}>{exportPreviewName}</output>
                  </label>
                  <div className="format-row">
                    <span>UDIM separator</span>
                    <div className="separator-toggle" role="group" aria-label="Export name separator">
                      <button
                        className={nameSeparator === "." ? "is-active" : ""}
                        type="button"
                        onClick={() => setNameSeparator(".")}
                      >
                        .
                      </button>
                      <button
                        className={nameSeparator === "_" ? "is-active" : ""}
                        type="button"
                        onClick={() => setNameSeparator("_")}
                      >
                        _
                      </button>
                    </div>
                  </div>
                  <label className="checkbox-field">
                    <input
                      checked={includeExtension}
                      type="checkbox"
                      onChange={(event) => setIncludeExtension(event.target.checked)}
                    />
                    <span>Include file extension</span>
                  </label>
                </div>
              </section>

              <section className="property-block export-state-block">
                <header className="property-block-header">
                  <strong>Export State</strong>
                </header>
                <div className="property-block-body">
                  <button className="properties-export-button" type="button" disabled={!canExport} onClick={handleExport}>
                    {canExport ? "Ready to Export" : textures.length > 0 ? "Fix Issues Before Export" : "No Textures Imported"}
                  </button>
                  <div className="validation-list compact" aria-live="polite">
                    {errors.map((issue) => (
                      <div className="validation-item error" key={issue.id}>
                        <span>{issue.message}</span>
                      </div>
                    ))}
                    {warnings.map((issue) => (
                      <div className="validation-item warning" key={issue.id}>
                        <span>{issue.message}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </section>
            </div>
          </section>

        </aside>
      </div>
    </main>
  );
}
