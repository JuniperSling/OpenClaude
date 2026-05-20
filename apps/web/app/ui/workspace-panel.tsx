"use client";

import { useRef, useState } from "react";
import type { WorkspaceFileNode } from "./api";
import { createWorkspaceFolder, deleteWorkspacePath, uploadWorkspaceFiles, workspaceRawUrl } from "./api";
import { FilePreview } from "./file-preview";
import { FileTree } from "./file-tree";

export function WorkspacePanel({
  token,
  root,
  rootPath,
  isOpen,
  onClose,
  onRefresh,
  onInsertReference
}: {
  token: string;
  root?: WorkspaceFileNode;
  rootPath?: string;
  isOpen: boolean;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onInsertReference: (path: string) => void;
}) {
  const [selectedNode, setSelectedNode] = useState<WorkspaceFileNode | undefined>();
  const [previewNode, setPreviewNode] = useState<WorkspaceFileNode | undefined>();
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  async function uploadFiles(files: Array<{ file: File; path?: string }>) {
    if (files.length === 0) return;
    setError(undefined);
    try {
      await uploadWorkspaceFiles(token, files);
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleCreateFolder() {
    const name = window.prompt("文件夹名称");
    if (!name?.trim()) return;
    try {
      await createWorkspaceFolder(token, name.trim());
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleDelete(path: string) {
    try {
      await deleteWorkspacePath(token, path);
      if (selectedNode?.path === path) setSelectedNode(undefined);
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <aside className={`workspace-panel ${isOpen ? "open" : ""}`}>
      <header className="workspace-header">
        <div>
          <strong>Workspace</strong>
          <small title={rootPath}>{rootPath ?? "正在加载路径..."}</small>
        </div>
        <button className="icon-button mobile-only" type="button" aria-label="关闭 Workspace" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="workspace-toolbar">
        <button type="button" onClick={() => fileInputRef.current?.click()}>
          上传
        </button>
        <button type="button" onClick={handleCreateFolder}>
          新建文件夹
        </button>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []).map((file) => ({ file, path: file.name }));
          event.target.value = "";
          void uploadFiles(files);
        }}
      />
      <div
        className={`workspace-drop ${isDragging ? "dragging" : ""}`}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node)) return;
          setIsDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setIsDragging(false);
          void collectDroppedFiles(event.dataTransfer).then(uploadFiles);
        }}
      >
        <div className="workspace-tree-wrap compact-scroll">
          {root ? (
            <FileTree
              node={root}
              selectedPath={selectedNode?.path}
              token={token}
              onSelect={setSelectedNode}
              onOpenPreview={setPreviewNode}
              onInsertReference={onInsertReference}
              onDelete={handleDelete}
              rawUrl={workspaceRawUrl}
            />
          ) : (
            <div className="workspace-empty">正在加载 Workspace...</div>
          )}
        </div>
      </div>
      {error ? <div className="workspace-error">{error}</div> : null}
      <div className="workspace-hint">双击文件打开预览</div>
      {previewNode ? (
        <div className="file-preview-modal" role="dialog" aria-modal="true" aria-label={`预览 ${previewNode.name}`}>
          <div className="file-preview-dialog">
            <header className="file-preview-header">
              <div>
                <strong>{previewNode.name}</strong>
                <small>{previewNode.path}</small>
              </div>
              <button type="button" aria-label="关闭预览" onClick={() => setPreviewNode(undefined)}>
                ×
              </button>
            </header>
            <div className="file-preview-body compact-scroll">
              <FilePreview token={token} node={previewNode} />
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  );
}

type DroppedFileSystemEntry = {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  file?: (success: (file: File) => void, failure?: (error: Error) => void) => void;
  createReader?: () => {
    readEntries: (success: (entries: DroppedFileSystemEntry[]) => void, failure?: (error: Error) => void) => void;
  };
};

export async function collectDroppedFiles(dataTransfer: DataTransfer): Promise<Array<{ file: File; path?: string }>> {
  const entries: DroppedFileSystemEntry[] = [];
  for (const item of Array.from(dataTransfer.items ?? [])) {
    const withEntry = item as unknown as { webkitGetAsEntry?: () => DroppedFileSystemEntry | null };
    const entry = withEntry.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }

  if (entries.length === 0) {
    return Array.from(dataTransfer.files ?? []).map((file) => ({ file, path: file.name }));
  }

  const collected = await Promise.all(entries.map((entry) => collectEntry(entry, "")));
  return collected.flat();
}

async function collectEntry(entry: DroppedFileSystemEntry, parentPath: string): Promise<Array<{ file: File; path?: string }>> {
  const entryPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
  if (entry.isFile && entry.file) {
    const file = await new Promise<File>((resolve, reject) => entry.file?.(resolve, reject));
    return [{ file, path: entryPath }];
  }
  if (!entry.isDirectory || !entry.createReader) return [];
  const reader = entry.createReader();
  const children = await new Promise<DroppedFileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
  const nested = await Promise.all(children.map((child) => collectEntry(child, entryPath)));
  return nested.flat();
}
