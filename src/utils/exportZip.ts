import JSZip from "jszip";
import type { NamedTextureAsset, PaintExportLayer } from "../types/texture";

const EXPORT_MIME_BY_EXTENSION = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);

function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error(`Unable to load ${file.name}`));
    };
    image.src = objectUrl;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Unable to encode painted texture"));
        return;
      }

      resolve(blob);
    }, mimeType);
  });
}

async function createPaintedTextureBlob(texture: NamedTextureAsset, paintLayer: PaintExportLayer): Promise<Blob | File> {
  const tileIndex = paintLayer.tileTextureIds.indexOf(texture.id);
  const mimeType = EXPORT_MIME_BY_EXTENSION.get(texture.extension.toLowerCase());
  if (!paintLayer.hasPaint || tileIndex < 0 || !mimeType) {
    return texture.file;
  }

  try {
    const image = await loadImageFromFile(texture.file);
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth || image.width || paintLayer.tileSize;
    canvas.height = image.naturalHeight || image.height || paintLayer.tileSize;
    const context = canvas.getContext("2d");
    if (!context) {
      return texture.file;
    }

    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    const tileColumn = tileIndex % paintLayer.columns;
    const tileRow = Math.floor(tileIndex / paintLayer.columns);
    context.drawImage(
      paintLayer.canvas,
      tileColumn * paintLayer.tileSize,
      tileRow * paintLayer.tileSize,
      paintLayer.tileSize,
      paintLayer.tileSize,
      0,
      0,
      canvas.width,
      canvas.height,
    );

    return await canvasToBlob(canvas, mimeType);
  } catch {
    return texture.file;
  }
}

export async function exportRenamedTextures(
  textures: NamedTextureAsset[],
  archiveName: string,
  paintLayer?: PaintExportLayer | null,
): Promise<void> {
  const zip = new JSZip();

  await Promise.all(textures.map(async (texture) => {
    const fileContent = paintLayer ? await createPaintedTextureBlob(texture, paintLayer) : texture.file;
    zip.file(texture.finalName, fileContent, {
      binary: true,
      compression: "STORE",
    });
  }));

  const blob = await zip.generateAsync({
    type: "blob",
    compression: "STORE",
  });

  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = `${archiveName || "renamed_textures"}.zip`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}
