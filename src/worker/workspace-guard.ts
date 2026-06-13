import { constants, existsSync } from "node:fs";
import { access, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLocalBashOperations,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type BashOperations,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export function createWorkspaceGuardedTools(workspaceRoot: string, gitEnv?: NodeJS.ProcessEnv): ToolDefinition[] {
  const root = normalizeWorkspaceRoot(workspaceRoot);
  const localBash = createLocalBashOperations();
  const bashOperations: BashOperations = {
    exec: (command, _cwd, options) => {
      validateWorkspaceBashCommand(command, root);
      return localBash.exec(command, root, {
        ...options,
        env: {
          ...options.env,
          HOME: root,
          PWD: root,
          // git credentials and SSH→HTTPS rewrite — override HOME last so .netrc is found
          ...gitEnv,
        },
      });
    },
  };

  const tools = [
    createReadToolDefinition(root, {
      operations: {
        access: async (path) => {
          await access(await assertExistingPathInWorkspace(root, path), constants.R_OK);
        },
        readFile: async (path) => readFile(await assertExistingPathInWorkspace(root, path)),
      },
    }),
    createBashToolDefinition(root, {
      operations: bashOperations,
      spawnHook: (context) => ({
        ...context,
        cwd: root,
        env: {
          ...context.env,
          HOME: root,
          PWD: root,
          ...gitEnv,
        },
      }),
    }),
    createEditToolDefinition(root, {
      operations: {
        access: async (path) => {
          await access(await assertExistingPathInWorkspace(root, path), constants.R_OK | constants.W_OK);
        },
        readFile: async (path) => readFile(await assertExistingPathInWorkspace(root, path)),
        writeFile: async (path, content) => {
          await writeFile(await assertWritePathInWorkspace(root, path), content, "utf8");
        },
      },
    }),
    createWriteToolDefinition(root, {
      operations: {
        mkdir: async (path) => {
          await mkdir(await assertWritePathInWorkspace(root, path), { recursive: true });
        },
        writeFile: async (path, content) => {
          await writeFile(await assertWritePathInWorkspace(root, path), content, "utf8");
        },
      },
    }),
    createGrepToolDefinition(root, {
      operations: {
        isDirectory: async (path) => (await stat(await assertExistingPathInWorkspace(root, path))).isDirectory(),
        readFile: async (path) => readFile(await assertExistingPathInWorkspace(root, path), "utf8"),
      },
    }),
    createFindToolDefinition(root, {
      operations: {
        exists: (path) => {
          assertPathInWorkspace(root, path);
          return existsSync(path);
        },
        glob: async (pattern, cwd, options) => findWorkspaceFiles(root, cwd, pattern, options.limit),
      },
    }),
    createLsToolDefinition(root, {
      operations: {
        exists: (path) => {
          assertPathInWorkspace(root, path);
          return existsSync(path);
        },
        stat: async (path) => stat(await assertExistingPathInWorkspace(root, path)),
        readdir: async (path) => readdir(await assertExistingPathInWorkspace(root, path)),
      },
    }),
  ];
  return tools as unknown as ToolDefinition[];
}

export function assertRepoRootInWorkspace(workspaceRoot: string, repoRoot: string): string {
  return assertPathInWorkspace(workspaceRoot, repoRoot);
}

export function validateWorkspaceBashCommand(command: string, workspaceRoot: string): void {
  if (command.includes("\0")) {
    throw new Error("Bash command contains a NUL byte");
  }
  if (/(^|[\s;&|(<>{])~(?=$|[/"'\s;&|)>])/.test(command)) {
    throw new Error("Bash command references a home path outside workspace");
  }
  if (/(^|[\s"'`(;&|<>])\.\.(?=\/|$|[\s"'`);&|<>])/.test(command)) {
    throw new Error("Bash command references a parent path outside workspace");
  }
  if (/(^|[\s;&|])(?:cd|pushd|popd)\s+-($|[\s;&|])/.test(command)) {
    throw new Error("Bash command uses directory history outside workspace");
  }
  if (/(^|[\s;&|`(])git\s+push(\s|$)/.test(command)) {
    throw new Error("git push is not allowed in bash — use push_for_review instead");
  }
  if (/(^|[\s;&|`(])gh(\s|$)/.test(command)) {
    throw new Error("gh CLI is not allowed — use the context JSON to discover state and the provided tools to perform operations");
  }

  const root = normalizeWorkspaceRoot(workspaceRoot);
  for (const match of command.matchAll(/(^|[\s"'`=({[,;|&<>])\/[^\s"'`$;&|<>)]*/g)) {
    const prefix = match[1] ?? "";
    const pathRef = match[0].slice(prefix.length);
    const normalized = pathRef.replace(/[),]+$/, "");
    if (!pathInWorkspace(root, resolve(normalized))) {
      throw new Error(`Bash command references path outside workspace: ${normalized}`);
    }
  }
}

function normalizeWorkspaceRoot(workspaceRoot: string): string {
  return resolve(workspaceRoot);
}

function assertPathInWorkspace(workspaceRoot: string, candidate: string): string {
  const root = normalizeWorkspaceRoot(workspaceRoot);
  const target = resolve(candidate);
  if (!pathInWorkspace(root, target)) {
    throw new Error(`Path is outside workspace: ${candidate}`);
  }
  return target;
}

async function assertExistingPathInWorkspace(workspaceRoot: string, candidate: string): Promise<string> {
  const target = assertPathInWorkspace(workspaceRoot, candidate);
  const resolvedTarget = await realpath(target);
  return assertPathInWorkspace(workspaceRoot, resolvedTarget);
}

async function assertWritePathInWorkspace(workspaceRoot: string, candidate: string): Promise<string> {
  const target = assertPathInWorkspace(workspaceRoot, candidate);
  const existingAncestor = await nearestExistingPath(target);
  const resolvedAncestor = await realpath(existingAncestor);
  assertPathInWorkspace(workspaceRoot, resolvedAncestor);
  return target;
}

async function nearestExistingPath(target: string): Promise<string> {
  let current = target;
  while (true) {
    try {
      await access(current);
      return current;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
      const parent = dirname(current);
      if (parent === current) {
        throw error;
      }
      current = parent;
    }
  }
}

function pathInWorkspace(workspaceRoot: string, candidate: string): boolean {
  const relativePath = relative(normalizeWorkspaceRoot(workspaceRoot), resolve(candidate));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

async function findWorkspaceFiles(root: string, cwd: string, pattern: string, limit: number): Promise<string[]> {
  const searchRoot = await assertExistingPathInWorkspace(root, cwd);
  const matches: string[] = [];
  const matcher = globMatcher(pattern);
  await walk(searchRoot, searchRoot, matcher, matches, limit);
  return matches;
}

async function walk(
  searchRoot: string,
  current: string,
  matcher: (path: string) => boolean,
  matches: string[],
  limit: number,
): Promise<void> {
  if (matches.length >= limit) {
    return;
  }

  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") {
      continue;
    }

    const path = resolve(current, entry.name);
    const relativePath = relative(searchRoot, path).split(sep).join("/");
    if (entry.isDirectory()) {
      await walk(searchRoot, path, matcher, matches, limit);
    } else if (matcher(relativePath) || matcher(entry.name)) {
      matches.push(path);
      if (matches.length >= limit) {
        return;
      }
    }
  }
}

function globMatcher(pattern: string): (path: string) => boolean {
  const source = pattern
    .split(/(\*\*|\*|\?)/g)
    .map((part) => {
      if (part === "**") return ".*";
      if (part === "*") return "[^/]*";
      if (part === "?") return "[^/]";
      return part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    })
    .join("");
  return (path) => new RegExp(`^${source}$`).test(path);
}
