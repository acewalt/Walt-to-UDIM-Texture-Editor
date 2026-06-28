import { SortableContext, rectSortingStrategy } from "@dnd-kit/sortable";
import { useDroppable } from "@dnd-kit/core";
import { ArrowDownAZ } from "lucide-react";
import { type DragEvent, useState } from "react";
import type { TextureAsset, TextureChannel } from "../types/texture";
import { TextureTileCard } from "./TextureTileCard";

interface TextureChannelPanelProps {
  channel: TextureChannel;
  textures: TextureAsset[];
  finalNames: Map<string, string>;
  exportUdims: Map<string, string>;
  issueTextureIds: Set<string>;
  onChangeChannel: (id: string, channel: TextureChannel) => void;
  onRemove: (id: string) => void;
  onSortByUdim: (channel: TextureChannel) => void;
  onImportFiles: (channel: TextureChannel, files: File[]) => void;
}

export function TextureChannelPanel({
  channel,
  textures,
  finalNames,
  exportUdims,
  issueTextureIds,
  onChangeChannel,
  onRemove,
  onSortByUdim,
  onImportFiles,
}: TextureChannelPanelProps) {
  const [isFileOver, setIsFileOver] = useState(false);
  const { setNodeRef, isOver } = useDroppable({
    id: `channel-${channel}`,
    data: {
      type: "channel",
      channel,
    },
  });

  function hasFileDrag(event: DragEvent<HTMLElement>): boolean {
    return Array.from(event.dataTransfer.types).includes("Files");
  }

  function handleFileDragOver(event: DragEvent<HTMLElement>) {
    if (!hasFileDrag(event)) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsFileOver(true);
  }

  function handleFileDrop(event: DragEvent<HTMLElement>) {
    if (!hasFileDrag(event)) {
      return;
    }

    event.preventDefault();
    setIsFileOver(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) {
      onImportFiles(channel, files);
    }
  }

  return (
    <section
      ref={setNodeRef}
      className={`channel-panel${isOver || isFileOver ? " is-over" : ""}`}
      onDragOver={handleFileDragOver}
      onDragEnter={handleFileDragOver}
      onDragLeave={() => setIsFileOver(false)}
      onDrop={handleFileDrop}
    >
      <header className="channel-header">
        <div>
          <h3>{channel}</h3>
          <span>{textures.length} tiles</span>
        </div>
        <button className="secondary-button icon-text" type="button" onClick={() => onSortByUdim(channel)}>
          <ArrowDownAZ aria-hidden="true" size={16} />
          Sort UDIM
        </button>
      </header>

      <SortableContext items={textures.map((texture) => texture.id)} strategy={rectSortingStrategy}>
        <div className="tile-grid">
          {textures.map((texture) => (
            <TextureTileCard
              key={texture.id}
              texture={texture}
              finalName={finalNames.get(texture.id) ?? texture.originalName}
              exportUdim={exportUdims.get(texture.id) ?? "1001"}
              highlighted={issueTextureIds.has(texture.id)}
              onChangeChannel={onChangeChannel}
              onRemove={onRemove}
            />
          ))}
          {textures.length === 0 ? <div className="empty-channel">Drop textures here</div> : null}
        </div>
      </SortableContext>
    </section>
  );
}
