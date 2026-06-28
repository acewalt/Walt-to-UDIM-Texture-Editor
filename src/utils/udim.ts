import type { TextureAsset, TextureChannel, ValidationIssue } from "../types/texture";

const UDIM_PATTERN = /(?:^|[._\-\s])(1\d{3})(?=$|[._\-\s])/;
const VALID_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".tif", ".tiff", ".exr", ".bmp", ".webp"]);

export function detectUdim(fileName: string): string | null {
  const match = fileName.match(UDIM_PATTERN);
  return match?.[1] ?? null;
}

export function getExtension(fileName: string): string {
  const index = fileName.lastIndexOf(".");
  return index >= 0 ? fileName.slice(index).toLowerCase() : "";
}

export function isValidTextureExtension(fileName: string): boolean {
  return VALID_EXTENSIONS.has(getExtension(fileName));
}

export function normalizeUdim(udim: string): string {
  const trimmed = udim.trim();
  if (!trimmed) {
    return "";
  }

  const value = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(value)) {
    return trimmed;
  }

  if (value > 0 && value < 1000) {
    return String(1000 + value);
  }

  return String(value);
}

export function getUdimNumber(udim: string): number | null {
  const normalized = normalizeUdim(udim);
  if (!/^1\d{3}$/.test(normalized)) {
    return null;
  }

  const value = Number.parseInt(normalized, 10);
  return value >= 1001 ? value : null;
}

export function getTileIndexFromUdim(udim: string): number | null {
  const udimNumber = getUdimNumber(udim);
  return udimNumber === null ? null : udimNumber - 1000;
}

export function getExportUdimForIndex(index: number): string {
  return String(1001 + index);
}

export function createTextureAsset(file: File, channel: TextureChannel): TextureAsset {
  const detectedUdim = detectUdim(file.name);
  return {
    id: `${crypto.randomUUID()}-${file.name}`,
    file,
    objectUrl: URL.createObjectURL(file),
    originalName: file.name,
    extension: getExtension(file.name),
    channel,
    udim: detectedUdim ?? "",
    detectedUdim,
  };
}

export function sortByUdim<T extends TextureAsset>(textures: T[]): T[] {
  return [...textures].sort((a, b) => {
    const aValue = getUdimNumber(a.udim);
    const bValue = getUdimNumber(b.udim);

    if (aValue === null && bValue === null) {
      return a.originalName.localeCompare(b.originalName);
    }

    if (aValue === null) {
      return 1;
    }

    if (bValue === null) {
      return -1;
    }

    return aValue - bValue || a.originalName.localeCompare(b.originalName);
  });
}

export function findMissingUdimTiles(textures: TextureAsset[]): string[] {
  const udims = textures
    .map((texture) => getUdimNumber(texture.udim))
    .filter((udim): udim is number => udim !== null);

  if (udims.length < 2) {
    return [];
  }

  const min = Math.min(...udims);
  const max = Math.max(...udims);
  const existing = new Set(udims);
  const missing: string[] = [];

  for (let udim = min; udim <= max; udim += 1) {
    if (!existing.has(udim)) {
      missing.push(String(udim));
    }
  }

  return missing;
}

export function validateTextures(textures: TextureAsset[], finalNames: Map<string, string>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const invalidFiles = textures.filter((texture) => !isValidTextureExtension(texture.originalName));
  if (invalidFiles.length > 0) {
    issues.push({
      id: "invalid-extensions",
      severity: "error",
      message: `Invalid extension: ${invalidFiles.map((texture) => texture.originalName).join(", ")}`,
      textureIds: invalidFiles.map((texture) => texture.id),
    });
  }

  const sourceUdimGroups = new Map<TextureChannel, TextureAsset[]>();
  textures.forEach((texture) => {
    const group = sourceUdimGroups.get(texture.channel) ?? [];
    group.push(texture);
    sourceUdimGroups.set(texture.channel, group);
  });

  sourceUdimGroups.forEach((group, channel) => {
    const byUdim = new Map<string, TextureAsset[]>();
    group.forEach((texture) => {
      const normalizedUdim = normalizeUdim(texture.udim);
      if (!normalizedUdim || getUdimNumber(texture.udim) === null) {
        return;
      }

      const bucket = byUdim.get(normalizedUdim) ?? [];
      bucket.push(texture);
      byUdim.set(normalizedUdim, bucket);
    });

    byUdim.forEach((bucket, udim) => {
      if (bucket.length > 1) {
        issues.push({
          id: `duplicate-source-udim-${channel}-${udim}`,
          severity: "warning",
          message: `Repeated source UDIM ${udim} in ${channel}; export UDIMs are assigned by order`,
          textureIds: bucket.map((texture) => texture.id),
        });
      }
    });
  });

  const finalNameBuckets = new Map<string, string[]>();
  finalNames.forEach((finalName, textureId) => {
    const bucket = finalNameBuckets.get(finalName) ?? [];
    bucket.push(textureId);
    finalNameBuckets.set(finalName, bucket);
  });

  finalNameBuckets.forEach((textureIds, finalName) => {
    if (textureIds.length > 1) {
      issues.push({
        id: `duplicate-final-${finalName}`,
        severity: "error",
        message: `Duplicate final name: ${finalName}`,
        textureIds,
      });
    }
  });

  textures.forEach((texture) => {
    const lowerName = texture.originalName.toLowerCase();
    const looksLikeNormal = /\b(normal|norm|nrm)\b|[._-](normal|norm|nrm)([._-]|$)/.test(lowerName);
    if (looksLikeNormal && texture.channel !== "Normal") {
      issues.push({
        id: `normal-wrong-channel-${texture.id}`,
        severity: "warning",
        message: `Normal map may be in the wrong channel: ${texture.originalName}`,
        textureIds: [texture.id],
      });
    }
  });

  return issues;
}
