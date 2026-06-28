import type { TextureAsset, TextureChannel } from "../types/texture";
import { getExportUdimForIndex, normalizeUdim } from "./udim";

const CHANNEL_SCORE: TextureChannel[] = ["BaseColor", "Normal", "Roughness", "Metallic", "AO", "Custom"];
const BROWSER_PREVIEW_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp"]);

export function canPreviewInBrowser(texture: TextureAsset): boolean {
  return BROWSER_PREVIEW_EXTENSIONS.has(texture.extension);
}

export function getTileForChannel(textures: TextureAsset[], channel: TextureChannel, udim = "1001"): TextureAsset | null {
  const targetUdim = normalizeUdim(udim);
  const channelTextures = textures.filter((texture) => texture.channel === channel);
  return (
    channelTextures.find(
      (texture, index) => getExportUdimForIndex(index) === targetUdim && canPreviewInBrowser(texture),
    ) ?? null
  );
}

export function getPreviewTexture(textures: TextureAsset[], udim = "1001"): TextureAsset | null {
  for (const channel of CHANNEL_SCORE) {
    const texture = getTileForChannel(textures, channel, udim);
    if (texture) {
      return texture;
    }
  }

  return textures[0] ?? null;
}
