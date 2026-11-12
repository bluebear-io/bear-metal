import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { assertRepoRootInWorkspace, createWorkspaceGuardedTools, validateWorkspaceBashCommand } from "./workspace-guard.js";

describe("workspace guard", () => {
  it("reads files when the workspace root is a symlinked path", async () => {
    const parent = await mkdtemp(join(tmpdir(), "bear-metal-aliased-workspace-"));
    const workspace = join(parent, "workspace");
    const alias = join(parent, "alias");
    try {
      await mkdir(workspace);
      await writeFile(join(workspace, "source.txt"), "source contents");
      await symlink(workspace, alias, process.platform === "win32" ? "junction" : "dir");
      const tools = createWorkspaceGuardedTools(alias);
      const ls = tools.find((tool) => tool.name === "ls");
      if (!ls) throw new Error("ls tool missing");
      const list = ls.execute as unknown as (id: string, params: { path: string }) => Promise<{ content: Array<{ text: string }> }>;
      expect((await list("root", { path: "." })).content[0]?.text).toContain("source.txt");
      const read = tools.find((tool) => tool.name === "read");
      if (!read) throw new Error("read tool missing");
      const execute = read.execute as unknown as (id: string, params: { path: string }) => Promise<{ content: Array<{ text: string }> }>;
      const result = await execute("canonical", { path: join(workspace, "source.txt") });
      expect(result.content[0]?.text).toContain("source contents");
      const write = tools.find((tool) => tool.name === "write");
      if (!write) throw new Error("write tool missing");
      await (write.execute as unknown as (id: string, params: { path: string; content: string }) => Promise<unknown>)(
        "aliased-write",
        { path: join(alias, "new.txt"), content: "written through alias" },
      );
      expect(await readFile(join(workspace, "new.txt"), "utf8")).toBe("written through alias");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("rejects research file reads outside the cloned workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bear-metal-research-workspace-"));
    const outside = await mkdtemp(join(tmpdir(), "bear-metal-research-outside-"));
    try {
      const secret = join(outside, "secret.txt");
      await writeFile(secret, "host secret");
      await symlink(secret, join(workspace, "linked-secret.txt"));
      const read = createWorkspaceGuardedTools(workspace).find((tool) => tool.name === "read");
      if (!read) throw new Error("read tool missing");
      const execute = read.execute as unknown as (id: string, params: { path: string }) => Promise<unknown>;
      await expect(execute("absolute", { path: secret })).rejects.toThrow(/outside workspace/);
      await expect(execute("symlink", { path: join(workspace, "linked-secret.txt") })).rejects.toThrow(/outside workspace/);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
  it("keeps language caches outside the disposable workspace", async () => {
    const home = await mkdtemp(join(tmpdir(), "bear-metal-home-test-"));
    const workspace = await mkdtemp(join(tmpdir(), "bear-metal-workspace-test-"));
    await mkdir(join(home, ".ssh"));
    await writeFile(join(home, ".ssh", "id_rsa"), "private-key");
    vi.stubEnv("HOME", home);
    try {
      const bash = createWorkspaceGuardedTools(workspace).find((tool) => tool.name === "bash");
      expect(bash).toBeDefined();
      await (bash!.execute as (id: string, params: { command: string }) => Promise<unknown>)("cache", { command: 'mkdir -p "$HOME/go/pkg/mod" "$HOME/.cache/pip" && printf go > "$HOME/go/pkg/mod/marker" && printf python > "$HOME/.cache/pip/marker"' });
      const probe = await (bash!.execute as unknown as (id: string, params: { command: string }) => Promise<{ content: Array<{ text: string }> }>) ("probe", { command: 'test ! -e "$HOME/.ssh/id_rsa" && printf isolated' });
      expect(probe.content[0]?.text).toContain("isolated");
      await rm(workspace, { recursive: true, force: true });
      expect(await readFile(join(home, ".bear-metal/cache-home/go/pkg/mod/marker"), "utf8")).toBe("go");
      expect(await readFile(join(home, ".bear-metal/cache-home/.cache/pip/marker"), "utf8")).toBe("python");
    } finally {
      vi.unstubAllEnvs();
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
  it("recovers on a later shell command after cache home becomes creatable", async () => {
    const home = await mkdtemp(join(tmpdir(), "bear-metal-home-recovery-test-"));
    const workspace = await mkdtemp(join(tmpdir(), "bear-metal-workspace-recovery-test-"));
    const blockedParent = join(home, ".bear-metal");
    await writeFile(blockedParent, "blocked");
    vi.stubEnv("HOME", home);
    try {
      const bash = createWorkspaceGuardedTools(workspace).find((tool) => tool.name === "bash");
      expect(bash).toBeDefined();
      const execute = bash!.execute as unknown as (id: string, params: { command: string }) => Promise<{ content: Array<{ text: string }> }>;
      await expect(execute("blocked", { command: "printf ready" })).rejects.toThrow(/ENOTDIR|EEXIST/);
      await rm(blockedParent);
      const result = await execute("recovered", { command: "printf ready" });
      expect(result.content[0]?.text).toContain("ready");
    } finally {
      vi.unstubAllEnvs();
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
  it("rejects repo roots outside the cloned workspace", () => {
    expect(() => assertRepoRootInWorkspace("/tmp/workspace/myrepo", "/tmp/workspace/myrepo/bear-metal")).not.toThrow();
    expect(() => assertRepoRootInWorkspace("/tmp/workspace/myrepo", "/Users/other/projects/bear-metal")).toThrow(
      /outside workspace/,
    );
  });

  it("rejects bash commands that escape the workspace", () => {
    expect(() => validateWorkspaceBashCommand("git status", "/tmp/workspace/myrepo")).not.toThrow();
    expect(() => validateWorkspaceBashCommand("npx vitest run src/**/*.test.ts", "/tmp/workspace/myrepo")).not.toThrow();
    expect(() => validateWorkspaceBashCommand("git remote add origin https://github.com/your-org/myrepo", "/tmp/workspace/myrepo")).not.toThrow();
    expect(() => validateWorkspaceBashCommand("cd /Users/other/projects/bear-metal", "/tmp/workspace/myrepo")).toThrow(
      /outside workspace/,
    );
    expect(() => validateWorkspaceBashCommand("cd ..", "/tmp/workspace/myrepo")).toThrow(/outside workspace/);
    expect(() => validateWorkspaceBashCommand("ls ~/projects", "/tmp/workspace/myrepo")).toThrow(/outside workspace/);
  });

  it("allows AWS log group names but still rejects real paths outside the workspace", () => {
    const root = "/tmp/workspace/myrepo";
    const allowed = [
      "aws logs tail /aws/lambda/dev-blueden-bff --since 1h",
      'aws logs start-query --log-group-names "/aws/lambda/dev-blueden-risks" --query-string "fields @message"',
      "aws logs describe-log-groups --log-group-name-prefix=/aws/lambda/dev-blueden-",
      "aws logs filter-log-events --log-group-name '/aws/vendedlogs/states/dev-pipeline' | head",
      "AWS_ACCESS_KEY_ID=x AWS_SESSION_TOKEN=y aws logs tail /aws/lambda/prod-blueden-bff > out.txt",
      "cd repo && aws logs get-log-events --log-group-name /aws/lambda/dev-blueden-bff --log-stream-name s",
      'AWS_REGION="us-east-1" AWS_PROFILE=\'prod\' aws logs tail /aws/lambda/prod-blueden-bff',
    ];
    for (const command of allowed) {
      expect(() => validateWorkspaceBashCommand(command, root)).not.toThrow();
    }
    expect(() => validateWorkspaceBashCommand("cat /aws/lambda/../../etc/passwd", root)).toThrow(/outside workspace/);
    expect(() => validateWorkspaceBashCommand("cat /aws", root)).toThrow(/outside workspace/);
    expect(() => validateWorkspaceBashCommand("cat /awsx/lambda/foo", root)).toThrow(/outside workspace/);
    expect(() => validateWorkspaceBashCommand("cat /etc/passwd /aws/lambda/x", root)).toThrow(/outside workspace/);
    const notLogGroupNames = [
      "cat /aws/lambda/x",
      "mkdir -p /aws/lambda/x",
      "echo x > /aws/lambda/x",
      "aws logs tail /aws/lambda/x > /aws/lambda/y",
      "aws logs tail /aws/lambda/x 2>/aws/lambda/y",
      "aws logs tail /aws/lambda/x | tee /aws/lambda/y",
      "aws logs tail /aws/lambda/x; touch /aws/lambda/y",
      "aws s3 cp s3://bucket/key /aws/lambda/x",
      "touch '; aws logs tail' /aws/lambda/x",
      'touch "; aws logs tail" /aws/lambda/x',
      "touch \\; aws logs tail /aws/lambda/x",
      "echo $(touch /aws/lambda/x)",
      "FOO='; aws logs tail' /aws/lambda/x",
      'FOO="; aws logs tail" /aws/lambda/x',
      "FOO=a'; aws logs tail' /aws/lambda/x",
      "FOO=\\; aws logs tail /aws/lambda/x",
    ];
    for (const command of notLogGroupNames) {
      expect(() => validateWorkspaceBashCommand(command, root), command).toThrow(/outside workspace/);
    }
  });

  it("blocks git push in all forms", () => {
    const root = "/tmp/workspace/myrepo";
    expect(() => validateWorkspaceBashCommand("git push", root)).toThrow(/git push is not allowed/);
    expect(() => validateWorkspaceBashCommand("git push -u origin HEAD", root)).toThrow(/git push is not allowed/);
    expect(() => validateWorkspaceBashCommand("git push --force-with-lease", root)).toThrow(/git push is not allowed/);
    expect(() => validateWorkspaceBashCommand("git push origin --delete my-branch", root)).toThrow(/git push is not allowed/);
    expect(() => validateWorkspaceBashCommand("git push --tags", root)).toThrow(/git push is not allowed/);
    // git operations that are not push remain allowed
    expect(() => validateWorkspaceBashCommand("git status", root)).not.toThrow();
    expect(() => validateWorkspaceBashCommand("git commit -m 'fix'", root)).not.toThrow();
    expect(() => validateWorkspaceBashCommand("git merge origin/main", root)).not.toThrow();
  });

  it("blocks gh CLI in all forms", () => {
    const root = "/tmp/workspace/myrepo";
    expect(() => validateWorkspaceBashCommand("gh pr create", root)).toThrow(/gh CLI is not allowed/);
    expect(() => validateWorkspaceBashCommand("gh issue list", root)).toThrow(/gh CLI is not allowed/);
    expect(() => validateWorkspaceBashCommand("gh auth status", root)).toThrow(/gh CLI is not allowed/);
    // similar-looking strings that are not the gh CLI remain allowed
    expect(() => validateWorkspaceBashCommand("echo 'gh is cool'", root)).not.toThrow();
    expect(() => validateWorkspaceBashCommand("touch /tmp/workspace/myrepo/ghfile", root)).not.toThrow();
  });
});
