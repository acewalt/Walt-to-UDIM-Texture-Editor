import { useState } from "react";
import { CSS } from "@dnd-kit/utilities";
import { useSortable } from "@dnd-kit/sortable";
import { GripVertical, Trash2 } from "lucide-react";
import { TEXTURE_CHANNELS, type TextureAsset, type TextureChannel } from "../types/texture";

interface TextureTileCardProps {
  texture: TextureAsset;
  finalName: string;
  exportUdim: string;
  highlighted?: boolean;
  onChangeChannel: (id: string, channel: TextureChannel) => void;
  onRemove: (id: string) => void;
}

export function TextureTileCard({
  texture,
  finalName,
  exportUdim,
  highlighted = false,
  onChangeChannel,
  onRemove,
}: TextureTileCardProps) {
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: texture.id,
    data: {
      type: "texture",
      texture,
    },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <article
      ref={setNodeRef}
      className={`texture-card${isDragging ? " is-dragging" : ""}${highlighted ? " has-issue" : ""}`}
      style={style}
    >
      <button className="drag-handle icon-button" type="button" aria-label="Drag tile" {...attributes} {...listeners}>
        <GripVertical aria-hidden="true" size={16} />
      </button>
      <button className="remove-button icon-button" type="button" aria-label="Remove texture" onClick={() => onRemove(texture.id)}>
        <Trash2 aria-hidden="true" size={16} />
      </button>

      <div className="texture-thumb">
        {thumbnailFailed ? (
          <div className="texture-thumb-fallback">{texture.extension.replace(".", "") || "file"}</div>
        ) : (
          <img src={texture.objectUrl} alt="" onError={() => setThumbnailFailed(true)} />
        )}
      </div>

      <div className="texture-meta">
        <div className="name-pair">
          <span className="meta-label">Original</span>
          <strong title={texture.originalName}>{texture.originalName}</strong>
        </div>
        <div className="name-pair">
          <span className="meta-label">Final</span>
          <strong title={finalName}>{finalName}</strong>
        </div>
      </div>

      <div className="tile-controls">
        <label className="field">
          <span>Export UDIM</span>
          <output>{exportUdim}</output>
        </label>
        <label className="field">
          <span>Channel</span>
          <select value={texture.channel} onChange={(event) => onChangeChannel(texture.id, event.target.value as TextureChannel)}>
            {TEXTURE_CHANNELS.map((channel) => (
              <option key={channel} value={channel}>
                {channel}
              </option>
            ))}
          </select>
        </label>
      </div>
    </article>
  );
}
