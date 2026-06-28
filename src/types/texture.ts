export const TEXTURE_CHANNELS = [
  "BaseColor",
  "Roughness",
  "Normal",
  "Metallic",
  "AO",
  "Custom",
] as const;

export type TextureChannel = (typeof TEXTURE_CHANNELS)[number];

export type ValidationSeverity = "warning" | "error";

export interface TextureAsset {
  id: string;
  file: File;
  objectUrl: string;
  originalName: string;
  extension: string;
  channel: TextureChannel;
  udim: string;
  detectedUdim: string | null;
}

export type RenamePatterns = Record<TextureChannel, string>;

export interface ValidationIssue {
  id: string;
  severity: ValidationSeverity;
  message: string;
  textureIds?: string[];
}

export interface NamedTextureAsset extends TextureAsset {
  finalName: string;
}

export interface PaintExportLayer {
  canvas: HTMLCanvasElement;
  columns: number;
  rows: number;
  tileSize: number;
  tileTextureIds: string[];
  hasPaint: boolean;
  version: number;
}

export interface UvSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export type UvEditCommandType =
  | "move"
  | "scale"
  | "rotate"
  | "move-to-udim"
  | "normalize"
  | "straight"
  | "gridify"
  | "rectify"
  | "project-from-view"
  | "planar"
  | "box"
  | "cylindrical"
  | "spherical"
  | "undo"
  | "redo";

export interface UvEditCommandOptions {
  currentUdim?: string;
  deltaU?: number;
  historyGroupId?: number;
  deltaV?: number;
  rotationDeg?: number;
  scaleFactor?: number;
  targetUdim?: string;
}

export interface UvEditCommand extends UvEditCommandOptions {
  id: number;
  type: UvEditCommandType;
}

export type PreparedProjectionStatus = "prepared" | "applied" | "not-applied";

export interface PreparedProjection {
  id: string;
  name: string;
  objectUrl: string;
  thumbnailUrl: string;
  width: number;
  height: number;
  createdAt: string;
  status: PreparedProjectionStatus;
}

export type ModelOutlinerNodeType = "model" | "group" | "mesh";

export interface ModelOutlinerNode {
  id: string;
  parentId: string | null;
  name: string;
  type: ModelOutlinerNodeType;
  depth: number;
  childCount: number;
}
