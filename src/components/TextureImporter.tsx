import { ChangeEvent, useRef } from "react";
import { ImagePlus, Upload } from "lucide-react";
import { TEXTURE_CHANNELS, type TextureAsset, type TextureChannel } from "../types/texture";
import { createTextureAsset } from "../utils/udim";

interface TextureImporterProps {
  channel: TextureChannel;
  onImport: (textures: TextureAsset[]) => void;
  onChannelChange: (channel: TextureChannel) => void;
}

export function TextureImporter({ channel, onImport, onChannelChange }: TextureImporterProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) {
      return;
    }

    const assets = Array.from(files).map((file) => createTextureAsset(file, channel));
    onImport(assets);
    if (inputRef.current) {
      inputRef.current.value = "";
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    handleFiles(event.target.files);
  }

  return (
    <section className="toolbar-section importer">
      <div className="section-title">
        <ImagePlus aria-hidden="true" size={18} />
        <h2>Import textures</h2>
      </div>
      <div className="import-controls">
        <label className="field compact">
          <span>Channel</span>
          <select value={channel} onChange={(event) => onChannelChange(event.target.value as TextureChannel)}>
            {TEXTURE_CHANNELS.map((textureChannel) => (
              <option key={textureChannel} value={textureChannel}>
                {textureChannel}
              </option>
            ))}
          </select>
        </label>
        <button className="primary-button" type="button" onClick={() => inputRef.current?.click()}>
          <Upload aria-hidden="true" size={18} />
          Import
        </button>
        <input
          ref={inputRef}
          className="hidden-input"
          type="file"
          accept="image/*,.exr,.tif,.tiff"
          multiple
          onChange={handleFileChange}
        />
      </div>
    </section>
  );
}
