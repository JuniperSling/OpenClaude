import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Workspace } from "@openclaude/shared";

export type WorkspaceLayout = {
  userRoot: string;
  sharedHomePath: string;
  sdkSessionStoragePath: string;
  workspacesRoot: string;
  workspaceRoot: string;
  globalWorkspacePath: string;
  attachmentsPath: string;
  userSkillsPath: string;
};

export type SkillProjection = {
  name: string;
  description?: string;
  content: string;
};

export class WorkspacePathGuard {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  resolveInside(relativeOrAbsolutePath: string): string {
    const candidate = path.resolve(this.root, relativeOrAbsolutePath);
    if (candidate !== this.root && !candidate.startsWith(`${this.root}${path.sep}`)) {
      throw new Error(`Path escapes workspace: ${relativeOrAbsolutePath}`);
    }
    return candidate;
  }

  isInside(relativeOrAbsolutePath: string): boolean {
    try {
      this.resolveInside(relativeOrAbsolutePath);
      return true;
    } catch {
      return false;
    }
  }
}

export class LocalWorkspaceManager {
  constructor(private readonly dataDir: string) {}

  layout(userId: string, workspaceId: string): WorkspaceLayout {
    const userRoot = path.resolve(this.dataDir, "users", userId);
    const sharedHomePath = path.join(userRoot, "home");
    const sdkSessionStoragePath = path.join(userRoot, "claude");
    const workspacesRoot = path.join(userRoot, "workspaces");
    const workspaceRoot = path.join(workspacesRoot, workspaceId);
    return this.buildLayout(userRoot, sharedHomePath, sdkSessionStoragePath, workspacesRoot, workspaceRoot);
  }

  globalLayout(userId: string): WorkspaceLayout {
    const userRoot = path.resolve(this.dataDir, "users", userId);
    const sharedHomePath = path.join(userRoot, "home");
    const sdkSessionStoragePath = path.join(userRoot, "claude");
    const workspacesRoot = path.join(userRoot, "workspaces");
    const workspaceRoot = path.join(userRoot, "workspace");
    return this.buildLayout(userRoot, sharedHomePath, sdkSessionStoragePath, workspacesRoot, workspaceRoot);
  }

  globalWorkspaceId(userId: string): string {
    const safeUserId = userId.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 80) || "user";
    return `global-${safeUserId}`;
  }

  async ensureGlobalWorkspace(userId: string): Promise<WorkspaceLayout> {
    const layout = this.globalLayout(userId);
    await mkdir(layout.workspaceRoot, { recursive: true });
    await mkdir(layout.sharedHomePath, { recursive: true });
    await mkdir(layout.sdkSessionStoragePath, { recursive: true });
    await mkdir(layout.attachmentsPath, { recursive: true });
    await mkdir(layout.userSkillsPath, { recursive: true });
    return layout;
  }

  private buildLayout(
    userRoot: string,
    sharedHomePath: string,
    sdkSessionStoragePath: string,
    workspacesRoot: string,
    workspaceRoot: string
  ): WorkspaceLayout {
    return {
      userRoot,
      sharedHomePath,
      sdkSessionStoragePath,
      workspacesRoot,
      workspaceRoot,
      globalWorkspacePath: path.join(userRoot, "workspace"),
      attachmentsPath: path.join(userRoot, "attachments"),
      userSkillsPath: path.join(userRoot, "skills")
    };
  }

  async ensureWorkspace(workspace: Pick<Workspace, "id" | "userId"> & Partial<Pick<Workspace, "rootPath">>): Promise<WorkspaceLayout> {
    const layout = workspace.rootPath
      ? this.buildLayout(
          path.resolve(this.dataDir, "users", workspace.userId),
          path.join(path.resolve(this.dataDir, "users", workspace.userId), "home"),
          path.join(path.resolve(this.dataDir, "users", workspace.userId), "claude"),
          path.join(path.resolve(this.dataDir, "users", workspace.userId), "workspaces"),
          workspace.rootPath
        )
      : this.layout(workspace.userId, workspace.id);
    if (layout.workspaceRoot === layout.globalWorkspacePath) {
      await this.ensureGlobalWorkspace(workspace.userId);
    } else {
      await this.ensureLayout(layout);
    }
    return layout;
  }

  private async ensureLayout(layout: WorkspaceLayout): Promise<void> {
    await mkdir(path.join(layout.workspaceRoot, "uploads"), { recursive: true });
    await mkdir(path.join(layout.workspaceRoot, "files"), { recursive: true });
    await mkdir(path.join(layout.workspaceRoot, ".claude", "skills"), { recursive: true });
    await mkdir(layout.sharedHomePath, { recursive: true });
    await mkdir(layout.sdkSessionStoragePath, { recursive: true });
  }

  async projectSkills(workspaceRoot: string, skills: SkillProjection[]): Promise<string[]> {
    const skillsRoot = path.join(path.dirname(workspaceRoot), "skills");
    await rm(skillsRoot, { recursive: true, force: true });
    await mkdir(skillsRoot, { recursive: true });

    const projected: string[] = [];
    for (const skill of skills) {
      const skillName = sanitizeName(skill.name);
      const skillDir = path.join(skillsRoot, skillName);
      await mkdir(skillDir, { recursive: true });
      const description = skill.description ?? `OpenClaude skill ${skillName}`;
      const body = skill.content.trimEnd();
      await writeFile(
        path.join(skillDir, "SKILL.md"),
        `---\nname: ${skillName}\ndescription: ${description}\n---\n${body}\n`,
        "utf8"
      );
      projected.push(skillName);
    }
    return projected;
  }
}

export function sanitizeName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function shouldBlockBashCommand(command: string): string | undefined {
  const risky = [
    /\brm\s+-rf\b/,
    /\bsudo\b/,
    /\bcurl\b/,
    /\bwget\b/,
    /\bssh\b/,
    /\bscp\b/,
    /\bdd\b/,
    /\bmkfs\b/,
    /\bchmod\s+777\b/
  ];
  if (risky.some((pattern) => pattern.test(command))) {
    return "Command matched the OpenClaude risky Bash deny list.";
  }
  return undefined;
}
