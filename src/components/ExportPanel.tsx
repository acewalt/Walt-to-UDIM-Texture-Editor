import { Download, TriangleAlert } from "lucide-react";
import type { NamedTextureAsset, ValidationIssue } from "../types/texture";
import { exportRenamedTextures } from "../utils/exportZip";

interface ExportPanelProps {
  textures: NamedTextureAsset[];
  archiveName: string;
  issues: ValidationIssue[];
}

export function ExportPanel({ textures, archiveName, issues }: ExportPanelProps) {
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  const canExport = textures.length > 0 && errors.length === 0;

  return (
    <section className="toolbar-section export-panel">
      <div className="section-title">
        <Download aria-hidden="true" size={18} />
        <h2>Export</h2>
      </div>

      <button
        className="primary-button export-button"
        type="button"
        disabled={!canExport}
        onClick={() => exportRenamedTextures(textures, archiveName)}
      >
        <Download aria-hidden="true" size={18} />
        Export renamed textures
      </button>

      <div className="validation-list" aria-live="polite">
        {issues.length === 0 ? (
          <div className="validation-ok">{textures.length > 0 ? "Ready to export" : "No textures imported"}</div>
        ) : null}
        {errors.map((issue) => (
          <div className="validation-item error" key={issue.id}>
            <TriangleAlert aria-hidden="true" size={16} />
            <span>{issue.message}</span>
          </div>
        ))}
        {warnings.map((issue) => (
          <div className="validation-item warning" key={issue.id}>
            <TriangleAlert aria-hidden="true" size={16} />
            <span>{issue.message}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
