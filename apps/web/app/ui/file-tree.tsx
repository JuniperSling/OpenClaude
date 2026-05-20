"use client";

import type { WorkspaceFileNode } from "./api";

export function FileTree({
  node,
  selectedPath,
  token,
  onSelect,
  onOpenPreview,
  onInsertReference,
  onDelete,
  rawUrl
}: {
  node: WorkspaceFileNode;
  selectedPath?: string;
  token: string;
  onSelect: (node: WorkspaceFileNode) => void;
  onOpenPreview: (node: WorkspaceFileNode) => void;
  onInsertReference: (path: string) => void;
  onDelete: (path: string) => void;
  rawUrl: (path: string, token: string) => string;
}) {
  const children = node.children ?? [];
  return (
    <div className="file-tree">
      {children.length === 0 ? <div className="workspace-empty">暂无文件，拖拽文件到这里上传</div> : null}
      {children.map((child) => (
        <FileTreeNode
          key={child.path}
          node={child}
          selectedPath={selectedPath}
          token={token}
          depth={0}
          onSelect={onSelect}
          onOpenPreview={onOpenPreview}
          onInsertReference={onInsertReference}
          onDelete={onDelete}
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
  depth,
  onSelect,
  onOpenPreview,
  onInsertReference,
  onDelete,
  rawUrl
}: {
  node: WorkspaceFileNode;
  selectedPath?: string;
  token: string;
  depth: number;
  onSelect: (node: WorkspaceFileNode) => void;
  onOpenPreview: (node: WorkspaceFileNode) => void;
  onInsertReference: (path: string) => void;
  onDelete: (path: string) => void;
  rawUrl: (path: string, token: string) => string;
}) {
  const isDirectory = node.type === "directory";
  return (
    <div className="file-tree-node">
      <div
        className={`file-row ${selectedPath === node.path ? "selected" : ""}`}
        draggable={!isDirectory}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => onSelect(node)}
        onDoubleClick={() => {
          if (!isDirectory) onOpenPreview(node);
        }}
        onDragStart={(event) => {
          if (isDirectory) return;
          event.dataTransfer.setData("application/x-openclaude-workspace-file", JSON.stringify({ path: node.path }));
          event.dataTransfer.effectAllowed = "copy";
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
              depth={depth + 1}
              onSelect={onSelect}
              onOpenPreview={onOpenPreview}
              onInsertReference={onInsertReference}
              onDelete={onDelete}
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
