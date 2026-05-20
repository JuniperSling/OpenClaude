"use client";

import type { WorkspaceFileNode } from "./api";

export function MentionAutocomplete({
  query,
  files,
  onSelect
}: {
  query: string;
  files: WorkspaceFileNode[];
  onSelect: (path: string) => void;
}) {
  const normalized = query.toLowerCase();
  const matches = files
    .filter((file) => file.path.toLowerCase().includes(normalized))
    .slice(0, 8);

  if (matches.length === 0) {
    return (
      <div className="mention-popover">
        <div className="mention-empty">没有匹配文件</div>
      </div>
    );
  }

  return (
    <div className="mention-popover">
      {matches.map((file) => (
        <button key={file.path} type="button" className="mention-option" onMouseDown={(event) => event.preventDefault()} onClick={() => onSelect(file.path)}>
          <span>{file.name}</span>
          <small>{file.path}</small>
        </button>
      ))}
    </div>
  );
}
