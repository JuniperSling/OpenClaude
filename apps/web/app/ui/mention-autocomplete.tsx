"use client";

import { useEffect, useRef } from "react";
import type { WorkspaceFileNode } from "./api";

export function MentionAutocomplete({
  matches,
  activeIndex,
  onHoverIndex,
  onSelect
}: {
  matches: WorkspaceFileNode[];
  activeIndex: number;
  onHoverIndex: (index: number) => void;
  onSelect: (path: string) => void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!listRef.current || matches.length === 0) return;
    const active = listRef.current.querySelector<HTMLElement>(".mention-option.active");
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, matches.length]);

  if (matches.length === 0) {
    return (
      <div className="mention-popover">
        <div className="mention-empty">没有匹配文件</div>
      </div>
    );
  }

  return (
    <div className="mention-popover" ref={listRef}>
      {matches.map((file, index) => (
        <button
          key={file.path}
          type="button"
          className={`mention-option ${index === activeIndex ? "active" : ""}`}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => onHoverIndex(index)}
          onClick={() => onSelect(file.path)}
        >
          <span>{file.name}</span>
          <small>{file.path}</small>
        </button>
      ))}
    </div>
  );
}
