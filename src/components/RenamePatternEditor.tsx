import { Braces } from "lucide-react";
import { TEXTURE_CHANNELS, type RenamePatterns, type TextureChannel } from "../types/texture";

interface RenamePatternEditorProps {
  baseName: string;
  patterns: RenamePatterns;
  onChangeBaseName: (baseName: string) => void;
  onChangePattern: (channel: TextureChannel, pattern: string) => void;
}

export function RenamePatternEditor({
  baseName,
  patterns,
  onChangeBaseName,
  onChangePattern,
}: RenamePatternEditorProps) {
  return (
    <section className="toolbar-section pattern-editor">
      <div className="section-title">
        <Braces aria-hidden="true" size={18} />
        <h2>Rename patterns</h2>
      </div>
      <label className="field">
        <span>Base name</span>
        <input value={baseName} onChange={(event) => onChangeBaseName(event.target.value)} />
      </label>
      <div className="pattern-list">
        {TEXTURE_CHANNELS.map((channel) => (
          <label className="field pattern-row" key={channel}>
            <span>{channel}</span>
            <input
              value={patterns[channel]}
              onChange={(event) => onChangePattern(channel, event.target.value)}
              spellCheck={false}
            />
          </label>
        ))}
      </div>
    </section>
  );
}
