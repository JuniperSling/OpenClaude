import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Workspace } from "@openclaude/shared";

export type WorkspaceLayout = {
  userRoot: string;
  sharedHomePath: string;
  sdkSessionStoragePath: string;
  workspacesRoot: string;
  workspaceRoot: string;
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
    return {
      userRoot,
      sharedHomePath,
      sdkSessionStoragePath,
      workspacesRoot,
      workspaceRoot
    };
  }

  async ensureWorkspace(workspace: Pick<Workspace, "id" | "userId">): Promise<WorkspaceLayout> {
    const layout = this.layout(workspace.userId, workspace.id);
    await mkdir(path.join(layout.workspaceRoot, "uploads"), { recursive: true });
    await mkdir(path.join(layout.workspaceRoot, "files"), { recursive: true });
    await mkdir(path.join(layout.workspaceRoot, ".claude", "skills"), { recursive: true });
    await mkdir(layout.sharedHomePath, { recursive: true });
    await mkdir(layout.sdkSessionStoragePath, { recursive: true });
    return layout;
  }

  async projectSkills(workspaceRoot: string, skills: SkillProjection[]): Promise<string[]> {
    const skillsRoot = path.join(workspaceRoot, ".claude", "skills");
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
  if (command.includes("..")) return "Path traversal is not allowed in Bash commands.";
  if (risky.some((pattern) => pattern.test(command))) {
    return "Command matched the OpenClaude risky Bash deny list.";
  }
  return undefined;
}
