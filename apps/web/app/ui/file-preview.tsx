"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { WorkspaceFileContentResponse, WorkspaceFileNode } from "./api";
import { getWorkspaceFileContent, workspaceRawUrl } from "./api";

export function FilePreview({ token, node }: { token: string; node?: WorkspaceFileNode }) {
  const [content, setContent] = useState<WorkspaceFileContentResponse | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    setContent(undefined);
    setError(undefined);
    if (!node || node.type !== "file") return;
    if (!["text", "markdown", "code"].includes(node.previewType ?? "unsupported")) return;
    void getWorkspaceFileContent(token, node.path)
      .then(setContent)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [node, token]);

  if (!node) {
    return <div className="file-preview-placeholder">选择一个文件预览</div>;
  }

  if (node.type === "directory") {
    return <div className="file-preview-placeholder">文件夹：{node.path || "workspace"}</div>;
  }

  if (node.previewType === "image") {
    return <img className="file-preview-image" src={workspaceRawUrl(node.path, token)} alt={node.name} />;
  }

  if (node.previewType === "pdf") {
    return <iframe className="file-preview-pdf" src={workspaceRawUrl(node.path, token)} title={node.name} />;
  }

  if (error) {
    return <div className="file-preview-placeholder">{error}</div>;
  }

  if (!content && ["text", "markdown", "code"].includes(node.previewType ?? "unsupported")) {
    return <div className="file-preview-placeholder">正在加载预览...</div>;
  }

  if (content?.previewType === "markdown") {
    return (
      <div className="file-preview-markdown markdown-content">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content.content}</ReactMarkdown>
      </div>
    );
  }

  if (content) {
    return (
      <pre className="file-preview-code">
        <code>{content.content}</code>
      </pre>
    );
  }

  return <div className="file-preview-placeholder">暂不支持预览，可下载查看</div>;
}
