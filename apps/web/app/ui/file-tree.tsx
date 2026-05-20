"use client";

import type { MouseEvent } from "react";
import type { WorkspaceFileNode } from "./api";

export function FileTree({
  node,
  selectedPath,
  onSelect,
  onOpenPreview,
  onContextMenu,
  onMove,
  onUploadToDirectory
}: {
  node: WorkspaceFileNode;
  selectedPath?: string;
  onSelect: (node: WorkspaceFileNode) => void;
  onOpenPreview: (node: WorkspaceFileNode) => void;
  onContextMenu: (event: MouseEvent, node?: WorkspaceFileNode) => void;
  onMove: (fromPath: string, targetDirectory: string) => void;
  onUploadToDirectory: (dataTransfer: DataTransfer, targetDirectory: string) => void;
}) {
  const children = node.children ?? [];
  return (
    <div className="file-tree" onContextMenu={(event) => onContextMenu(event)}>
      {children.length === 0 ? <div className="workspace-empty">暂无文件，拖拽文件到这里上传</div> : null}
      {children.map((child) => (
        <FileTreeNode
          key={child.path}
          node={child}
          selectedPath={selectedPath}
          depth={0}
          onSelect={onSelect}
          onOpenPreview={onOpenPreview}
          onContextMenu={onContextMenu}
          onMove={onMove}
          onUploadToDirectory={onUploadToDirectory}
        />
      ))}
    </div>
  );
}

function FileTreeNode({
  node,
  selectedPath,
  depth,
  onSelect,
  onOpenPreview,
  onContextMenu,
  onMove,
  onUploadToDirectory
}: {
  node: WorkspaceFileNode;
  selectedPath?: string;
  depth: number;
  onSelect: (node: WorkspaceFileNode) => void;
  onOpenPreview: (node: WorkspaceFileNode) => void;
  onContextMenu: (event: MouseEvent, node?: WorkspaceFileNode) => void;
  onMove: (fromPath: string, targetDirectory: string) => void;
  onUploadToDirectory: (dataTransfer: DataTransfer, targetDirectory: string) => void;
}) {
  const isDirectory = node.type === "directory";
  const canDropInto = isDirectory;
  return (
    <div className="file-tree-node">
      <div
        className={`file-row ${selectedPath === node.path ? "selected" : ""}`}
        draggable={Boolean(node.path)}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => {
          onSelect(node);
          if (!isDirectory) onOpenPreview(node);
        }}
        onContextMenu={(event) => onContextMenu(event, node)}
        onDragStart={(event) => {
          if (!node.path) return;
          event.dataTransfer.setData("application/x-openclaude-workspace-move", node.path);
          if (!isDirectory) {
            event.dataTransfer.setData("application/x-openclaude-workspace-file", JSON.stringify({ path: node.path }));
          }
          event.dataTransfer.effectAllowed = "copyMove";
        }}
        onDragOver={(event) => {
          if (!canDropInto) return;
          if (event.dataTransfer.types.includes("Files") || event.dataTransfer.types.includes("application/x-openclaude-workspace-move")) {
            event.preventDefault();
            event.dataTransfer.dropEffect = event.dataTransfer.types.includes("application/x-openclaude-workspace-move") ? "move" : "copy";
          }
        }}
        onDrop={(event) => {
          if (!canDropInto) return;
          event.preventDefault();
          event.stopPropagation();
          const movingPath = event.dataTransfer.getData("application/x-openclaude-workspace-move");
          if (movingPath) {
            onMove(movingPath, node.path);
            return;
          }
          if (event.dataTransfer.types.includes("Files")) {
            onUploadToDirectory(event.dataTransfer, node.path);
          }
        }}
      >
        <span className="file-icon">{isDirectory ? "▸" : fileIcon(node)}</span>
        <span className="file-name" title={node.path}>
          {node.name}
        </span>
      </div>
      {isDirectory && node.children?.length ? (
        <div>
          {node.children.map((child) => (
            <FileTreeNode
              key={child.path}
              node={child}
              selectedPath={selectedPath}
              depth={depth + 1}
              onSelect={onSelect}
              onOpenPreview={onOpenPreview}
              onContextMenu={onContextMenu}
              onMove={onMove}
              onUploadToDirectory={onUploadToDirectory}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function flattenWorkspaceFiles(node?: WorkspaceFileNode): WorkspaceFileNode[] {
  if (!node) return [];
  const children = node.children ?? [];
  return [
    ...(node.type === "file" ? [node] : []),
    ...children.flatMap((child) => flattenWorkspaceFiles(child))
  ];
}

function fileIcon(node: WorkspaceFileNode) {
  switch (node.previewType) {
    case "image":
      return "▧";
    case "pdf":
      return "PDF";
    case "markdown":
      return "MD";
    case "code":
      return "{}";
    default:
      return "·";
  }
}
