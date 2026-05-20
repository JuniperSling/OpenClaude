"use client";

import type { MouseEvent } from "react";
import type { WorkspaceFileNode } from "./api";

export function FileTree({
  node,
  selectedPath,
  token,
  dropTargetPath,
  onSelect,
  onOpenPreview,
  onContextMenu,
  onInsertReference,
  onDelete,
  onMove,
  onUploadToDirectory,
  onDropTargetChange,
  rawUrl
}: {
  node: WorkspaceFileNode;
  selectedPath?: string;
  token: string;
  dropTargetPath?: string;
  onSelect: (node: WorkspaceFileNode) => void;
  onOpenPreview: (node: WorkspaceFileNode) => void;
  onContextMenu: (event: MouseEvent, node?: WorkspaceFileNode) => void;
  onInsertReference: (path: string) => void;
  onDelete: (path: string) => void;
  onMove: (fromPath: string, targetDirectory: string) => void;
  onUploadToDirectory: (dataTransfer: DataTransfer, targetDirectory: string) => void;
  onDropTargetChange: (path?: string) => void;
  rawUrl: (path: string, token: string) => string;
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
          token={token}
          dropTargetPath={dropTargetPath}
          depth={0}
          onSelect={onSelect}
          onOpenPreview={onOpenPreview}
          onContextMenu={onContextMenu}
          onInsertReference={onInsertReference}
          onDelete={onDelete}
          onMove={onMove}
          onUploadToDirectory={onUploadToDirectory}
          onDropTargetChange={onDropTargetChange}
          rawUrl={rawUrl}
        />
      ))}
    </div>
  );
}

function FileTreeNode({
  node,
  selectedPath,
  token,
  dropTargetPath,
  depth,
  onSelect,
  onOpenPreview,
  onContextMenu,
  onInsertReference,
  onDelete,
  onMove,
  onUploadToDirectory,
  onDropTargetChange,
  rawUrl
}: {
  node: WorkspaceFileNode;
  selectedPath?: string;
  token: string;
  dropTargetPath?: string;
  depth: number;
  onSelect: (node: WorkspaceFileNode) => void;
  onOpenPreview: (node: WorkspaceFileNode) => void;
  onContextMenu: (event: MouseEvent, node?: WorkspaceFileNode) => void;
  onInsertReference: (path: string) => void;
  onDelete: (path: string) => void;
  onMove: (fromPath: string, targetDirectory: string) => void;
  onUploadToDirectory: (dataTransfer: DataTransfer, targetDirectory: string) => void;
  onDropTargetChange: (path?: string) => void;
  rawUrl: (path: string, token: string) => string;
}) {
  const isDirectory = node.type === "directory";
  const canDropInto = isDirectory;
  return (
    <div className="file-tree-node">
      <div
        className={`file-row ${selectedPath === node.path ? "selected" : ""} ${
          dropTargetPath === node.path ? "drop-target" : ""
        }`}
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
          const isWorkspaceMove = event.dataTransfer.types.includes("application/x-openclaude-workspace-move");
          if (event.dataTransfer.types.includes("Files") || isWorkspaceMove) {
            event.preventDefault();
            event.stopPropagation();
            onDropTargetChange(node.path);
            event.dataTransfer.dropEffect = isWorkspaceMove ? "move" : "copy";
          }
        }}
        onDragLeave={(event) => {
          if (!canDropInto || event.currentTarget.contains(event.relatedTarget as Node)) return;
          onDropTargetChange(undefined);
        }}
        onDrop={(event) => {
          if (!canDropInto) return;
          event.preventDefault();
          event.stopPropagation();
          onDropTargetChange(undefined);
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
        {!isDirectory ? (
          <button
            className="file-action"
            type="button"
            title="引用"
            onClick={(event) => {
              event.stopPropagation();
              onInsertReference(node.path);
            }}
          >
            @
          </button>
        ) : null}
        {!isDirectory ? (
          <a
            className="file-action"
            title="下载"
            href={rawUrl(node.path, token)}
            download={node.name}
            onClick={(event) => event.stopPropagation()}
          >
            ↓
          </a>
        ) : null}
        {node.path ? (
          <button
            className="file-action danger"
            type="button"
            title="删除"
            onClick={(event) => {
              event.stopPropagation();
              onDelete(node.path);
            }}
          >
            ×
          </button>
        ) : null}
      </div>
      {isDirectory && node.children?.length ? (
        <div>
          {node.children.map((child) => (
            <FileTreeNode
              key={child.path}
              node={child}
              selectedPath={selectedPath}
              token={token}
              dropTargetPath={dropTargetPath}
              depth={depth + 1}
              onSelect={onSelect}
              onOpenPreview={onOpenPreview}
              onContextMenu={onContextMenu}
              onInsertReference={onInsertReference}
              onDelete={onDelete}
              onMove={onMove}
              onUploadToDirectory={onUploadToDirectory}
              onDropTargetChange={onDropTargetChange}
              rawUrl={rawUrl}
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
