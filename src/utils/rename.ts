import type { RenamePatterns, TextureAsset, TextureChannel } from "../types/texture";
import { normalizeUdim } from "./udim";

export type NameSeparator = "." | "_";

export interface ExportNameOptions {
  separator: NameSeparator;
  includeExtension: boolean;
}

export const DEFAULT_PATTERNS: RenamePatterns = {
  BaseColor: "{baseName}_BaseColor.<UDIM>{ext}",
  Roughness: "{baseName}_Roughness.<UDIM>{ext}",
  Normal: "{baseName}_Normal.<UDIM>{ext}",
  Metallic: "{baseName}_Metallic.<UDIM>{ext}",
  AO: "{baseName}_AO.<UDIM>{ext}",
  Custom: "{baseName}_Custom.<UDIM>{ext}",
};

const CHANNEL_ALIASES: Record<TextureChannel, string> = {
  BaseColor: "BaseColor",
  Roughness: "Roughness",
  Normal: "Normal",
  Metallic: "Metallic",
  AO: "AO",
  Custom: "Custom",
};

export function sanitizeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").replace(/\s+/g, "_");
}

export function buildFinalName(texture: TextureAsset, baseName: string, patterns: RenamePatterns): string {
  return buildFinalNameWithUdim(texture, baseName, patterns, normalizeUdim(texture.udim));
}

export function buildFinalNameWithUdim(
  texture: TextureAsset,
  baseName: string,
  patterns: RenamePatterns,
  exportUdim: string,
): string {
  const pattern = patterns[texture.channel] || DEFAULT_PATTERNS[texture.channel];
  const safeBaseName = sanitizeFileName(baseName.trim() || "TextureSet");
  const replacements: Record<string, string> = {
    "{baseName}": safeBaseName,
    "{channel}": CHANNEL_ALIASES[texture.channel],
    "{UDIM}": exportUdim,
    "<UDIM>": exportUdim,
    "{ext}": texture.extension || "",
  };

  return sanitizeFileName(
    Object.entries(replacements).reduce(
      (result, [token, value]) => result.split(token).join(value),
      pattern,
    ),
  );
}

function isExportNameOptions(value: RenamePatterns | ExportNameOptions): value is ExportNameOptions {
  return "separator" in value && "includeExtension" in value;
}

export function buildFinalNameWithOptions(
  texture: TextureAsset,
  baseName: string,
  exportUdim: string,
  options: ExportNameOptions,
): string {
  const safeBaseName = sanitizeFileName(baseName.trim() || "TextureSet");
  const extension = options.includeExtension ? texture.extension || "" : "";
  return sanitizeFileName(`${safeBaseName}_${CHANNEL_ALIASES[texture.channel]}${options.separator}${exportUdim}${extension}`);
}

export function buildFinalNameMap(
  textures: TextureAsset[],
  baseName: string,
  naming: RenamePatterns | ExportNameOptions,
  exportUdims?: Map<string, string>,
): Map<string, string> {
  return new Map(
    textures.map((texture) => {
      const exportUdim = exportUdims?.get(texture.id) ?? normalizeUdim(texture.udim);
      return [
        texture.id,
        isExportNameOptions(naming)
          ? buildFinalNameWithOptions(texture, baseName, exportUdim, naming)
          : buildFinalNameWithUdim(texture, baseName, naming, exportUdim),
      ];
    }),
  );
}
