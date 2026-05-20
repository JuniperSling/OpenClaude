"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { WorkspaceFileNode } from "./api";
import { createWorkspaceFolder, deleteWorkspacePath, moveWorkspacePath, uploadWorkspaceFiles, workspaceRawUrl } from "./api";
import { FilePreview } from "./file-preview";
import { FileTree } from "./file-tree";

type WorkspaceContextMenu = {
  x: number;
  y: number;
  node?: WorkspaceFileNode;
};

type UploadStatus = {
  kind: "uploading" | "success" | "error";
  message: string;
  percent?: number;
};

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
  const [contextMenu, setContextMenu] = useState<WorkspaceContextMenu | undefined>();
  const [uploadTargetPath, setUploadTargetPath] = useState("");
  const [dropTargetPath, setDropTargetPath] = useState<string | undefined>();
  const [uploadStatus, setUploadStatus] = useState<UploadStatus | undefined>();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(undefined);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (uploadStatus?.kind !== "success") return;
    const timer = window.setTimeout(() => setUploadStatus(undefined), 3000);
    return () => window.clearTimeout(timer);
  }, [uploadStatus]);

  async function uploadFiles(files: Array<{ file: File; path?: string }>, targetPath = "") {
    if (files.length === 0) return;
    setError(undefined);
    setUploadStatus({ kind: "uploading", message: `正在上传 ${files.length} 个项目...`, percent: 0 });
    try {
      const result = await uploadWorkspaceFiles(token, files, targetPath, ({ percent }) => {
        setUploadStatus({ kind: "uploading", message: `正在上传 ${files.length} 个项目...`, percent });
      });
      await onRefresh();
      setUploadStatus({ kind: "success", message: `上传完成：${result.files.length} 个项目`, percent: 100 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setUploadStatus({ kind: "error", message: `上传失败：${message}` });
    }
  }

  async function handleCreateFolder(targetPath = "") {
    const name = window.prompt("文件夹名称");
    if (!name?.trim()) return;
    try {
      await createWorkspaceFolder(token, joinWorkspacePath(targetPath, name.trim()));
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

  async function handleMove(fromPath: string, targetDirectory: string) {
    const destination = joinWorkspacePath(targetDirectory, workspaceBasename(fromPath));
    if (!destination || destination === fromPath || targetDirectory.startsWith(`${fromPath}/`)) return;
    try {
      await moveWorkspacePath(token, fromPath, destination);
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleContextMenu(event: MouseEvent, node?: WorkspaceFileNode) {
    event.preventDefault();
    event.stopPropagation();
    setSelectedNode(node);
    setContextMenu({ x: event.clientX, y: event.clientY, node });
  }

  function targetDirectoryFor(node?: WorkspaceFileNode) {
    if (!node) return "";
    return node.type === "directory" ? node.path : workspaceDirname(node.path);
  }

  function startUpload(targetPath: string, kind: "file" | "folder") {
    setUploadTargetPath(targetPath);
    setContextMenu(undefined);
    if (kind === "folder") {
      folderInputRef.current?.click();
    } else {
      fileInputRef.current?.click();
    }
  }

  function openDownload(path: string) {
    window.open(workspaceRawUrl(path, token), "_blank", "noopener,noreferrer");
  }

  return (
    <aside className={`workspace-panel ${isOpen ? "open" : ""}`}>
      <header className="workspace-header">
        <div>
          <strong>Workspace</strong>
          <small title={rootPath}>{rootPath ?? "正在加载路径..."}</small>
          {uploadStatus ? (
            <div className={`workspace-upload-status ${uploadStatus.kind}`}>
              <span>{uploadStatus.message}</span>
              {uploadStatus.percent !== undefined ? <span>{uploadStatus.percent}%</span> : null}
              {uploadStatus.kind === "uploading" ? (
                <div className="workspace-upload-bar">
                  <span style={{ width: `${uploadStatus.percent ?? 12}%` }} />
                </div>
              ) : null}
            </div>
          ) : null}
          {error ? <div className="workspace-error">{error}</div> : null}
        </div>
        <button className="icon-button mobile-only" type="button" aria-label="关闭 Workspace" onClick={onClose}>
          ×
        </button>
      </header>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []).map((file) => ({ file, path: file.name }));
          const targetPath = uploadTargetPath;
          event.target.value = "";
          setUploadTargetPath("");
          void uploadFiles(files, targetPath);
        }}
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        style={{ display: "none" }}
        {...{ webkitdirectory: "", directory: "" }}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []).map((file) => {
            const withRelativePath = file as File & { webkitRelativePath?: string };
            return { file, path: withRelativePath.webkitRelativePath || file.name };
          });
          const targetPath = uploadTargetPath;
          event.target.value = "";
          setUploadTargetPath("");
          void uploadFiles(files, targetPath);
        }}
      />
      <div
        className={`workspace-drop ${isDragging ? "dragging" : ""}`}
        onContextMenu={(event) => handleContextMenu(event)}
        onDragOver={(event) => {
          if (
            !event.dataTransfer.types.includes("Files") &&
            !event.dataTransfer.types.includes("application/x-openclaude-workspace-move")
          ) {
            return;
          }
          event.preventDefault();
          if (event.dataTransfer.types.includes("application/x-openclaude-workspace-move")) {
            event.dataTransfer.dropEffect = "move";
            setIsDragging(false);
          } else {
            event.dataTransfer.dropEffect = "copy";
            setIsDragging(true);
          }
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node)) return;
          setIsDragging(false);
          setDropTargetPath(undefined);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setIsDragging(false);
          setDropTargetPath(undefined);
          const movingPath = event.dataTransfer.getData("application/x-openclaude-workspace-move");
          if (movingPath) {
            void handleMove(movingPath, "");
            return;
          }
          void collectDroppedFiles(event.dataTransfer).then((files) => uploadFiles(files, ""));
        }}
      >
        <div className="workspace-tree-wrap compact-scroll">
          {root ? (
            <FileTree
              node={root}
              selectedPath={selectedNode?.path}
              token={token}
              dropTargetPath={dropTargetPath}
              onSelect={(node) => setSelectedNode(node)}
              onOpenPreview={setPreviewNode}
              onContextMenu={handleContextMenu}
              onInsertReference={onInsertReference}
              onDelete={handleDelete}
              onMove={handleMove}
              onUploadToDirectory={(dataTransfer, targetPath) => {
                void collectDroppedFiles(dataTransfer).then((files) => uploadFiles(files, targetPath));
              }}
              onDropTargetChange={setDropTargetPath}
              rawUrl={workspaceRawUrl}
            />
          ) : (
            <div className="workspace-empty">正在加载 Workspace...</div>
          )}
        </div>
      </div>
      {contextMenu ? (
        <div
          className="workspace-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          {contextMenu.node?.type === "file" ? (
            <>
              <button
                type="button"
                onClick={() => {
                  if (contextMenu.node) setPreviewNode(contextMenu.node);
                  setContextMenu(undefined);
                }}
              >
                打开预览
              </button>
              <button
                type="button"
                onClick={() => {
                  if (contextMenu.node) onInsertReference(contextMenu.node.path);
                  setContextMenu(undefined);
                }}
              >
                引用
              </button>
              <button
                type="button"
                onClick={() => {
                  if (contextMenu.node) openDownload(contextMenu.node.path);
                  setContextMenu(undefined);
                }}
              >
                下载
              </button>
            </>
          ) : null}
          <button
            type="button"
            onClick={() => {
              const target = targetDirectoryFor(contextMenu.node);
              setContextMenu(undefined);
              void handleCreateFolder(target);
            }}
          >
            新建文件夹
          </button>
          <button type="button" onClick={() => startUpload(targetDirectoryFor(contextMenu.node), "file")}>
            上传文件
          </button>
          <button type="button" onClick={() => startUpload(targetDirectoryFor(contextMenu.node), "folder")}>
            上传文件夹
          </button>
          {contextMenu.node?.path ? (
            <button
              className="danger"
              type="button"
              onClick={() => {
                void handleDelete(contextMenu.node!.path);
                setContextMenu(undefined);
              }}
            >
              删除
            </button>
          ) : null}
        </div>
      ) : null}
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

function joinWorkspacePath(basePath: string, name: string): string {
  const cleanBase = basePath.replace(/^\/+|\/+$/g, "");
  const cleanName = name.replace(/^\/+|\/+$/g, "");
  return cleanBase ? `${cleanBase}/${cleanName}` : cleanName;
}

function workspaceBasename(filePath: string): string {
  return filePath.split("/").filter(Boolean).pop() ?? filePath;
}

function workspaceDirname(filePath: string): string {
  const parts = filePath.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}
