#!/usr/bin/env node
// @ts-check
import { fileURLToPath } from "node:url";
import {
  readFileSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, basename, dirname, isAbsolute } from "node:path";
import { execSync, execFileSync, spawnSync } from "node:child_process";

/**
 * Strip `//` line comments and `/* *\/` block comments from a JSON string.
 * Respects string literals so URLs and quoted content are never touched.
 * @param {string} text
 * @returns {string}
 */
function stripJsonComments(text) {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    if (inString) {
      if (text[i] === "\\") {
        out += text[i] + text[i + 1];
        i += 2;
      } else if (text[i] === '"') {
        inString = false;
        out += text[i++];
      } else {
        out += text[i++];
      }
    } else if (text[i] === '"') {
      inString = true;
      out += text[i++];
    } else if (text[i] === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (text[i] === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
    } else {
      out += text[i++];
    }
  }
  return out;
}

/**
 * @param {string} filePath
 * @returns {Record<string, unknown>}
 */
function readConfigFile(filePath) {
  if (!existsSync(filePath)) return {};
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    throw new Error(
      `cannot read ${filePath}: ${/** @type {Error} */ (err).message}`,
    );
  }
  try {
    return JSON.parse(stripJsonComments(/** @type {string} */ (raw)));
  } catch (err) {
    throw new Error(
      `malformed JSON in ${filePath}: ${/** @type {Error} */ (err).message}`,
    );
  }
}

/**
 * Resolve a `path` value from a config file to an absolute path.
 * `~` expands to `home`; absolute paths pass through; relative paths
 * resolve against `anchorDir` (the directory containing the config file).
 * @param {string} raw
 * @param {string} anchorDir
 * @param {string} home
 * @returns {string}
 */
function resolveConfigPath(raw, anchorDir, home) {
  if (raw.startsWith("~")) return raw.replace(/^~/, home);
  if (isAbsolute(raw)) return raw;
  return join(anchorDir, raw);
}

/**
 * Load and merge `~/.wt.json` (user) and `<main-repo-root>/.wt.json` (project).
 * Project keys win; arrays replace entirely. The returned `path` is always
 * absolute: `~` is expanded against `home`, and a relative `path` is resolved
 * against the directory of the `.wt.json` it came from.
 * Outside a git repo, only user config is loaded.
 * @param {{ cwd?: string, home?: string }} [opts]
 * @returns {{ path: string, postCreate: string[] }}
 */
export function loadConfig(opts = {}) {
  const { cwd = process.cwd(), home = homedir() } = opts;

  const userConfig = readConfigFile(join(home, ".wt.json"));
  const userPath =
    typeof userConfig["path"] === "string"
      ? resolveConfigPath(userConfig["path"], home, home)
      : null;

  const mainRepoPath = findMainRepoPath(cwd);
  const projectConfig = mainRepoPath
    ? readConfigFile(join(mainRepoPath, ".wt.json"))
    : {};
  const projectPath =
    typeof projectConfig["path"] === "string" && mainRepoPath
      ? resolveConfigPath(projectConfig["path"], mainRepoPath, home)
      : null;

  const merged = { ...userConfig, ...projectConfig };
  return {
    path: projectPath ?? userPath ?? join(home, ".worktrees"),
    postCreate: Array.isArray(merged["postCreate"])
      ? /** @type {string[]} */ (merged["postCreate"])
      : [],
  };
}

/**
 * Return true if the git working tree at `cwd` has any uncommitted changes
 * (tracked modifications, staged changes, or untracked files).
 * @param {string} [cwd]
 * @returns {boolean}
 */
export function isDirty(cwd = process.cwd()) {
  const out = execSync("git status --porcelain", {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return out.trim().length > 0;
}

async function readKey() {
  return new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once("data", (buf) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      resolve(buf.toString());
    });
  });
}

/**
 * Prompt the user interactively for how to handle uncommitted changes.
 * Returns 'move', 'keep', 'copy', or exits with code 1 if abort is chosen.
 * @returns {Promise<'move' | 'keep' | 'copy'>}
 */
async function promptDirtyAction() {
  warn("Source tree has uncommitted changes");
  process.stderr.write(`How to proceed? [K]eep  [c]opy  [m]ove  [a]bort `);

  while (true) {
    const key = await readKey();
    const choice = key.toLowerCase();
    const isEnter = key === "\r" || key === "\n";
    const isCancel = key === "\x03" || key === "\x1b";

    if (isCancel || choice === "a") {
      process.stderr.write("\n");
      error("Aborted");
      process.exit(1);
    }
    if (choice === "m") {
      process.stderr.write("\n");
      return "move";
    }
    if (choice === "c") {
      process.stderr.write("\n");
      return "copy";
    }
    if (choice === "k" || isEnter) {
      process.stderr.write("\n");
      return "keep";
    }
    // ignore unrecognized keys, keep waiting
  }
}

/**
 * Copy the source working-tree diff (tracked changes + untracked files) into
 * `dstDir` without touching `srcDir`. Exits 2 on failure.
 * @param {string} srcDir
 * @param {string} dstDir
 */
function applyCopyToWorktree(srcDir, dstDir) {
  // Apply tracked + staged changes
  const diff = spawnSync("git", ["-C", srcDir, "diff", "HEAD"], {
    encoding: "buffer",
  });
  if (diff.stdout && diff.stdout.length > 0) {
    const apply = spawnSync("git", ["-C", dstDir, "apply"], {
      input: diff.stdout,
      stdio: ["pipe", "ignore", "inherit"],
    });
    if (apply.status !== 0) {
      fatal("Failed to apply diff to new worktree", undefined, { code: 2 });
    }
  }

  // Copy untracked files via tar
  const ls = spawnSync(
    "git",
    ["-C", srcDir, "ls-files", "-o", "--exclude-standard"],
    {
      encoding: "utf8",
    },
  );
  const untracked = (ls.stdout ?? "")
    .trim()
    .split("\n")
    .filter((f) => f);
  if (untracked.length > 0) {
    const tarCreate = spawnSync(
      "tar",
      ["-c", "-C", srcDir, "--", ...untracked],
      {
        encoding: "buffer",
      },
    );
    if (tarCreate.status !== 0) {
      fatal("Failed to tar untracked files", undefined, { code: 2 });
    }
    const tarExtract = spawnSync("tar", ["-x", "-C", dstDir], {
      input: tarCreate.stdout ?? Buffer.alloc(0),
      stdio: ["pipe", "ignore", "inherit"],
    });
    if (tarExtract.status !== 0) {
      fatal("Failed to extract untracked files to new worktree", undefined, {
        code: 2,
      });
    }
  }
}

/**
 * Parse unknown `--flag [value]` pairs out of an args array.
 * Positional (non-flag) args are collected in `branches`.
 * `knownFlags` is consulted only for typo suggestions; callers must strip
 * known flags from `args` before calling.
 * @param {string[]} args
 * @param {string[]} knownFlags  bare names without `--`, used only for typo suggestions
 * @returns {{ envFlags: Record<string, string>, warnings: string[], branches: string[] }}
 */
export function parseEnvFlags(args, knownFlags) {
  // Levenshtein edit distance, used to flag near-matches as likely typos.
  /** @type {(a: string, b: string) => number} */
  const editDistance = (a, b) => {
    const m = a.length,
      n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) =>
      Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
    );
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] =
          a[i - 1] === b[j - 1]
            ? dp[i - 1][j - 1]
            : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
    return dp[m][n];
  };

  /** @type {Record<string, string>} */
  const envFlags = {};
  /** @type {string[]} */
  const warnings = [];
  /** @type {string[]} */
  const branches = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      branches.push(arg);
      continue;
    }

    const name = arg.slice(2);

    for (const known of knownFlags) {
      if (editDistance(name, known) <= 2) {
        warnings.push(`--${name} treated as env (did you mean --${known}?)`);
        break;
      }
    }

    const next = args[i + 1];
    let value;
    if (next !== undefined && !next.startsWith("--")) {
      value = next;
      i++;
    } else {
      value = "1";
    }

    envFlags["WT_" + name.replace(/-/g, "_").toUpperCase()] = value;
  }

  return { envFlags, warnings, branches };
}

/**
 * Convert a string to a filesystem-safe slug.
 * Non-alphanumeric/dot/hyphen → `-`; runs of `-` collapse; leading/trailing
 * `-` and `.` stripped; case preserved; no length cap.
 * @param {string} input
 * @returns {string}
 */
export function slugify(input) {
  return input
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

/**
 * Return the main repo's top-level path for `cwd`, or `null` outside a git
 * repo. Uses `--git-common-dir` so this resolves to the main worktree's root
 * even when `cwd` is inside a linked worktree.
 * @param {string} cwd
 * @returns {string | null}
 */
function findMainRepoPath(cwd) {
  try {
    const commonDir = execSync(
      "git rev-parse --path-format=absolute --git-common-dir",
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return dirname(commonDir);
  } catch {
    return null;
  }
}

/**
 * Resolve the filesystem path for a new worktree:
 * `<config.path>/<repoName>/<slug(branch)>`. `config.path` is expected to be
 * already absolute (see `loadConfig`).
 * @param {string} repoName
 * @param {string} branch
 * @param {{ path: string }} config
 * @returns {string}
 */
export function resolveWorktreePath(repoName, branch, config) {
  return join(config.path, repoName, slugify(branch));
}

const INIT_TEMPLATE = `\
{
  // Where worktrees are stored. Default: ~/.worktrees
  // "path": "~/.worktrees",

  // Shell commands run inside each new worktree after creation.
  // "postCreate": [
  //   "npm ci",
  //   "wt cp '.env*'"
  // ]
}
`;

/** @param {string[]} args */
function cmdInit(args) {
  const forceUser = args.includes("--user");
  const forceProject = args.includes("--project");
  const force = args.includes("--force");

  if (forceUser && forceProject)
    fatal("Cannot use --user and --project together");

  const home = homedir();
  const cwd = process.cwd();
  const userPath = join(home, ".wt.json");

  let target;
  if (forceUser) {
    target = userPath;
  } else if (forceProject) {
    const repoPath = findMainRepoPath(cwd);
    if (!repoPath)
      fatal("Not in a git repo", "Use --user or run inside a git repo.");
    target = join(/** @type {string} */ (repoPath), ".wt.json");
  } else if (!existsSync(userPath)) {
    target = userPath;
  } else {
    const repoPath = findMainRepoPath(cwd);
    target = repoPath ? join(repoPath, ".wt.json") : userPath;
  }

  if (existsSync(target) && !force) {
    fatal(`${bold(target)} already exists`, "Pass --force to overwrite.");
  }

  writeFileSync(target, INIT_TEMPLATE, "utf8");
  success(`Wrote ${bold(target)}`);
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const visibleLength = (/** @type {string} */ s) =>
  s.replace(ANSI_RE, "").length;
const padVisible = (/** @type {string} */ s, /** @type {number} */ w) =>
  s + " ".repeat(Math.max(0, w - visibleLength(s)));

/**
 * Format rows into aligned columns for a TTY, or tab-separated when piped.
 * @param {string[][]} rows
 * @param {{ tty?: boolean }} [opts]
 * @returns {string}
 */
export function formatColumns(rows, opts = {}) {
  const { tty = Boolean(process.stdout.isTTY) } = opts;
  if (!tty) {
    return rows.map((row) => row.join("\t")).join("\n");
  }
  const widths = /** @type {number[]} */ ([]);
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      widths[i] = Math.max(widths[i] ?? 0, visibleLength(row[i]));
    }
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) =>
          i < row.length - 1 ? padVisible(cell, widths[i]) : cell,
        )
        .join("  "),
    )
    .join("\n");
}

export const TOP_HELP = `\
Manage worktrees.

Usage:
  $ wt <command> [flags]

Commands:
${formatColumns(
  [
    ["  init", "Create a .wt.json config file"],
    ["  list", "List worktrees"],
    ["  add", "Create worktree(s)"],
    ["  remove", "Remove worktree(s)"],
    ["  cp", "Copy files into a new worktree"],
  ],
  { tty: true },
)}

Examples:
  wt add feat-login              create a worktree for feat-login
  wt add feat-a feat-b           create multiple at once
  wt list                        show worktrees in this repo
  wt remove feat-login -d        remove worktree and delete branch

Run \`wt <command> --help\` for per-command flags and examples.
`;

/** @type {Record<string, string>} */
export const CMD_HELP = {
  init: `\
Usage: wt init [--user] [--project] [--force]

Write a commented .wt.json config template.

Flags:
  --user      Write to ~/.wt.json (default when it doesn't exist)
  --project   Write to <repo-root>/.wt.json
  --force     Overwrite an existing config file
`,
  list: `\
Usage: wt list [--json]

List worktrees.

Flags:
  --json   Emit JSON array of { slug, branch, path }
`,
  add: `\
Usage: wt add <branch…> [--base <ref>] [--move] [--keep] [--copy]

Create worktree(s). The new worktree path is printed on stdout.
Default base: HEAD (the current branch).

Flags:
  --base <ref>   Branch from this ref instead of HEAD
  --move         Move uncommitted changes into the first new worktree
  --keep         Keep uncommitted changes in the source (default when TTY)
  --copy         Copy uncommitted changes into the new worktree (flag only)

Unknown flags (e.g. --api-key foo) are passed as WT_API_KEY=foo to postCreate.
`,
  remove: `\
Usage: wt remove <branch…> [--force] [-d] [-D]
       wt remove --all     [--force] [-d] [-D]

Remove worktree(s) by branch name. --all removes every non-main worktree.

Flags:
  --all     Remove every non-main worktree (cannot be combined with branch names)
  --force   Remove even if the worktree has uncommitted changes;
            required for --all when not running in a TTY
  -d        Delete the associated branch if merged upstream
  -D        Force-delete the branch; implies --force for the worktree
`,
  cp: `\
Usage: wt cp <glob…>

Copy files from \$WT_FROM to \$WT_ROOT using rsync.
Must be run from a postCreate hook.

Positive globs are included; prefix with ! to exclude.

Example:
  wt cp '.env*' '**/.env*' '!**/.env.example' '!**/node_modules/**'
`,
};

const COMMANDS = /** @type {const} */ (["init", "list", "add", "remove", "cp"]);

async function main() {
  const argv = process.argv.slice(2);

  if (argv.length === 0) {
    process.stderr.write(TOP_HELP);
    process.exit(1);
  }

  if (argv[0] === "--help" || argv[0] === "-h") {
    process.stderr.write(TOP_HELP);
    process.exit(0);
  }

  const [cmd, ...rest] = argv;

  if (!COMMANDS.includes(/** @type {any} */ (cmd))) {
    if (process.env["DEBUG"]) {
      const err = new Error(`unknown command '${cmd}'`);
      process.stderr.write(
        (err.stack ?? `Error: unknown command '${cmd}'`) + "\n",
      );
      process.exit(1);
    }
    process.stderr.write(`wt: unknown command '${cmd}'\n\n`);
    process.stderr.write(TOP_HELP);
    process.exit(1);
  }

  if (rest.includes("--help") || rest.includes("-h")) {
    process.stderr.write(
      CMD_HELP[cmd] ?? `wt: no help available for '${cmd}'\n`,
    );
    process.exit(0);
  }

  switch (cmd) {
    case "init":
      return cmdInit(rest);
    case "list":
      return cmdList(rest);
    case "add":
      return await cmdAdd(rest);
    case "remove":
      return await cmdRm(rest);
    case "cp":
      return cmdCp(rest);
  }
}

const useColor =
  process.env["NO_COLOR"] == null &&
  (process.env["FORCE_COLOR"] != null || Boolean(process.stdout.isTTY));

export const dim = (/** @type {string} */ s) =>
  useColor ? `\x1b[2m${s}\x1b[22m` : s;
export const bold = (/** @type {string} */ s) =>
  useColor ? `\x1b[1m${s}\x1b[22m` : s;
export const green = (/** @type {string} */ s) =>
  useColor ? `\x1b[32m${s}\x1b[39m` : s;
export const cyan = (/** @type {string} */ s) =>
  useColor ? `\x1b[36m${s}\x1b[39m` : s;
export const blue = (/** @type {string} */ s) =>
  useColor ? `\x1b[34m${s}\x1b[39m` : s;
export const hilight = bold;

/** @param {string} detail */
function writeDetail(detail) {
  for (const line of detail.split("\n")) {
    process.stderr.write(`${dim(line)}\n`);
  }
}

/** @param {string} msg @param {string} [detail] */
export function success(msg, detail) {
  const icon = useColor ? "\x1b[32m✓\x1b[0m" : "✓";
  process.stderr.write(`${icon} ${msg}\n`);
  if (detail) writeDetail(detail);
}

/** @param {string} msg @param {string} [detail] */
export function warn(msg, detail) {
  const icon = useColor ? "\x1b[33m⚠︎\x1b[0m" : "⚠︎";
  process.stderr.write(`${icon} ${msg}\n`);
  if (detail) writeDetail(detail);
}

/** @param {string} msg @param {string} [detail] */
export function error(msg, detail) {
  const icon = useColor ? "\x1b[31m✗\x1b[0m" : "✗";
  process.stderr.write(`${icon} ${msg}\n`);
  if (detail) writeDetail(detail);
}

/**
 * @param {string} msg
 * @param {string | undefined} [detail]
 * @param {{ code?: number, cause?: unknown, newline?: boolean }} [opts]
 * @returns {never}
 */
export function fatal(msg, detail, opts = {}) {
  const { code = 1, cause, newline = false } = opts;
  if (process.env["DEBUG"]) {
    const err =
      cause instanceof Error
        ? cause
        : new Error(msg, cause ? { cause } : undefined);
    if (!(cause instanceof Error)) err.message = msg;
    process.stderr.write((err.stack ?? `Error: ${msg}`) + "\n");
  } else {
    if (newline) process.stderr.write("\n");
    const icon = useColor ? "\x1b[1;31m✗\x1b[0m" : "✗";
    process.stderr.write(`${icon} ${msg}\n`);
    if (detail) writeDetail(detail);
  }
  process.exit(code);
}

/**
 * Parse `git worktree list --porcelain` output into structured records.
 * @param {string} text
 * @returns {{ slug: string, branch: string, path: string }[]}
 */
export function parsePorcelain(text) {
  return text
    .trim()
    .split(/\n\n+/)
    .filter((block) => block.trim())
    .map((block) => {
      let path = "";
      let head = "";
      let branch = "";
      let detached = false;
      for (const line of block.split("\n")) {
        if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
        else if (line.startsWith("HEAD ")) head = line.slice("HEAD ".length);
        else if (line.startsWith("branch "))
          branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
        else if (line === "detached") detached = true;
      }
      return {
        slug: path.split("/").pop() ?? path,
        branch: detached ? `(detached) ${head}` : branch,
        path,
      };
    });
}

/** @param {string[]} args */
function cmdList(args) {
  const useJson = args.includes("--json");

  /** @type {string} */
  let porcelain;
  try {
    porcelain = execSync("git worktree list --porcelain", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
  } catch {
    process.exit(2);
  }

  const worktrees = parsePorcelain(/** @type {string} */ (porcelain));

  if (useJson) {
    process.stdout.write(JSON.stringify(worktrees) + "\n");
    return;
  }

  if (worktrees.length === 0) return;

  const cwd = process.cwd();
  const mainPath = worktrees[0]?.path;
  const rows = worktrees.map((w) => {
    const isMain = w.path === mainPath;
    const isCurrent = cwd.startsWith(w.path);
    const isDetached = w.branch.startsWith("(detached)");
    const marker = useColor ? (isCurrent ? "* " : "  ") : "";
    let branch = w.branch;
    if (isDetached) branch = dim(branch);
    if (isMain) branch = green(branch);
    return [marker + branch, dim(w.path)];
  });
  process.stdout.write(formatColumns(rows, { tty: useColor }) + "\n");
}

/**
 * Whether a branch exists locally, only on the remote, or is new.
 * @param {string} branch
 * @returns {'local' | 'remote' | 'new'}
 */
function getBranchState(branch) {
  /** @type {(ref: string) => boolean} */
  const refExists = (ref) => {
    try {
      execFileSync("git", ["show-ref", "--verify", "--quiet", ref], {
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  };
  if (refExists(`refs/heads/${branch}`)) return "local";
  if (refExists(`refs/remotes/origin/${branch}`)) return "remote";
  return "new";
}

const ADD_KNOWN_FLAGS = ["base", "move", "keep", "copy"];

/** @param {string[]} args */
async function cmdAdd(args) {
  let explicitBase = /** @type {string | null} */ (null);
  const moveFlag = args.includes("--move");
  const keepFlag = args.includes("--keep");
  const copyFlag = args.includes("--copy");

  // Strip the known flags (and their values) so parseEnvFlags only sees unknowns
  /** @type {string[]} */
  const filteredArgs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--base" && i + 1 < args.length) {
      explicitBase = args[++i];
    } else if (
      args[i] === "--move" ||
      args[i] === "--keep" ||
      args[i] === "--copy"
    ) {
      // skip
    } else {
      filteredArgs.push(args[i]);
    }
  }

  const { envFlags, warnings, branches } = parseEnvFlags(
    filteredArgs,
    ADD_KNOWN_FLAGS,
  );
  for (const w of warnings) warn(w);

  if (branches.length === 0) {
    process.stderr.write(CMD_HELP["add"]);
    process.exit(1);
  }

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    fatal(/** @type {Error} */ (err).message);
  }

  let repoPath;
  let canonicalRepoPath;
  try {
    repoPath = execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // Use the main worktree's basename so children added from inside a linked
    // worktree land as siblings under the same <base>/<repo>/ namespace.
    const commonDir = execSync(
      "git rev-parse --path-format=absolute --git-common-dir",
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    canonicalRepoPath = dirname(commonDir);
  } catch (err) {
    fatal("Not in a git repo", undefined, { code: 2, cause: err });
  }
  const repoName = basename(/** @type {string} */ (canonicalRepoPath));

  const base = explicitBase ?? "HEAD";

  // --base is meaningful only when creating a brand-new branch. Validate up
  // front so we don't silently ignore it for branches that already exist
  // locally or on origin (and so we don't half-create worktrees before failing).
  if (explicitBase !== null) {
    const conflicts =
      /** @type {{ name: string, state: 'local' | 'remote' }[]} */ (
        branches
          .map((b) => ({ name: b, state: getBranchState(b) }))
          .filter((c) => c.state !== "new")
      );
    if (conflicts.length > 0) {
      const list = conflicts
        .map((c) => `${c.name} (${c.state === "local" ? "local" : "origin"})`)
        .join(", ");
      const noun = conflicts.length === 1 ? "branch" : "branches";
      fatal(
        `--base cannot be used with existing ${noun}: ${list}`,
        "Drop --base, or pick branch names that don't exist yet.",
      );
    }
  }

  // Resolve dirty-tree dirtyAction before touching any worktrees
  /** @type {'move' | 'keep' | 'copy' | null} */
  let dirtyAction = moveFlag
    ? "move"
    : keepFlag
      ? "keep"
      : copyFlag
        ? "copy"
        : null;

  const dirty = isDirty(/** @type {string} */ (repoPath));
  if (dirty && dirtyAction === null) {
    const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (!isTTY) {
      fatal(
        "Source tree has uncommitted changes",
        "Pass --move, --keep, or --copy.",
      );
    }
    dirtyAction = await promptDirtyAction();
  }

  // --move: stash before creating any worktree (source must be clean for stash pop to apply cleanly)
  if (dirtyAction === "move") {
    const push = spawnSync(
      "git",
      ["-C", /** @type {string} */ (repoPath), "stash", "push", "-u"],
      {
        stdio: ["ignore", "ignore", "inherit"],
      },
    );
    if (push.status !== 0) process.exit(2);
  }

  let moveApplied = false;
  /** @type {string[]} */
  const createdPaths = [];
  // Flush the path block on any exit (success or fatal mid-loop), so already-
  // created worktrees are still reported to stdout for shell wrappers.
  process.on("exit", () => {
    if (createdPaths.length === 0) return;
    process.stderr.write("\n");
    process.stdout.write(createdPaths.join("\n") + "\n");
  });

  for (const [i, branch] of branches.entries()) {
    if (branches.length > 1) {
      if (i > 0) process.stderr.write("\n");
      process.stderr.write(`${blue("›")} ${bold(branch)}\n`);
    }
    const worktreePath = resolveWorktreePath(repoName, branch, config);

    if (existsSync(worktreePath)) {
      fatal(`${bold(worktreePath)} already exists`);
    }

    mkdirSync(dirname(worktreePath), { recursive: true });

    const state = getBranchState(branch);

    /** @type {string[]} */
    let gitArgs;
    if (state === "local") {
      gitArgs = ["worktree", "add", worktreePath, branch];
    } else if (state === "remote") {
      gitArgs = [
        "worktree",
        "add",
        "--track",
        "-b",
        branch,
        worktreePath,
        `origin/${branch}`,
      ];
    } else {
      gitArgs = [
        "worktree",
        "add",
        "-b",
        branch,
        worktreePath,
        /** @type {string} */ (base),
      ];
    }

    try {
      execFileSync("git", gitArgs, {
        stdio: ["ignore", "ignore", "inherit"],
      });
    } catch {
      process.exit(2);
    }

    // Apply dirtyAction: move only to first worktree, copy to each
    if (dirtyAction === "move" && !moveApplied) {
      const pop = spawnSync("git", ["-C", worktreePath, "stash", "pop"], {
        stdio: ["ignore", "ignore", "inherit"],
      });
      if (pop.status !== 0) {
        fatal(
          "Failed to pop stash in new worktree",
          "Stash is still on the stack.",
          { code: 2 },
        );
      }
      moveApplied = true;
    } else if (dirtyAction === "copy") {
      applyCopyToWorktree(/** @type {string} */ (repoPath), worktreePath);
    }

    success(`Created ${bold(branch)}`, worktreePath);

    runPostCreate(config.postCreate, {
      root: worktreePath,
      from: /** @type {string} */ (repoPath),
      branch,
      envFlags,
    });

    createdPaths.push(worktreePath);
  }
}

/**
 * Execute `postCreate` hook commands in a freshly-created worktree.
 * Each command runs via `sh -c` with cwd=WT_ROOT and WT_ROOT/WT_FROM/WT_BRANCH
 * exposed. Hook stdout is redirected to wt's stderr so `wt add`'s stdout
 * contract (paths only) holds. Stops on first non-zero exit.
 * @param {string[]} commands
 * @param {{ root: string, from: string, branch: string, envFlags?: Record<string, string> }} ctx
 */
function runPostCreate(commands, ctx) {
  if (commands.length === 0) return;
  const env = {
    ...process.env,
    WT_ROOT: ctx.root,
    WT_FROM: ctx.from,
    WT_BRANCH: ctx.branch,
    ...ctx.envFlags,
  };
  for (const cmd of commands) {
    process.stderr.write(`${cyan("$")} ${cmd}\n`);
    const result = spawnSync("sh", ["-c", cmd], {
      cwd: ctx.root,
      env,
      stdio: ["ignore", process.stderr.fd, "inherit"],
    });
    if (result.status !== 0) {
      fatal(`postCreate failed: ${bold(cmd)}`, undefined, { code: 2 });
    }
  }
}

/** @param {string[]} args */
async function cmdRm(args) {
  const forceFlag = args.includes("--force");
  const allFlag = args.includes("--all");
  const safeDel = args.includes("-d");
  const forceDel = args.includes("-D");
  const force = forceFlag || forceDel;

  const branches = args.filter((a) => !a.startsWith("-"));

  if (allFlag && branches.length > 0) {
    fatal("--all cannot be combined with branch names");
  }

  if (!allFlag && branches.length === 0) {
    process.stderr.write(CMD_HELP["remove"]);
    process.exit(1);
  }

  /** @type {string} */
  let porcelain;
  try {
    porcelain = execSync("git worktree list --porcelain", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
  } catch {
    process.exit(2);
  }

  const worktrees = parsePorcelain(/** @type {string} */ (porcelain));
  const mainPath = worktrees[0]?.path ?? "";

  if (allFlag) {
    const targets = worktrees.slice(1);
    if (targets.length === 0) {
      process.stderr.write("No worktrees to remove\n");
      process.exit(0);
    }

    const dirty = force ? [] : targets.filter((w) => safeIsDirty(w));
    if (dirty.length > 0) {
      const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
      if (!isTTY) {
        for (const w of dirty) {
          error(`${bold(w.branch)} has uncommitted changes`);
        }
        process.exit(1);
      }

      const noun = dirty.length === 1 ? "worktree has" : "worktrees have";
      warn(`${dirty.length} ${noun} uncommitted changes`);
      const rows = targets.map((w) => [w.branch, dim(w.path)]);
      process.stderr.write(formatColumns(rows) + "\n");
      process.stderr.write(`Remove all? [Y]es  [n]o `);
      while (true) {
        const key = await readKey();
        const choice = key.toLowerCase();
        const isEnter = key === "\r" || key === "\n";
        const isCancel = key === "\x03" || key === "\x1b";
        if (isCancel || choice === "n") {
          process.stderr.write("\n");
          error("Aborted");
          process.exit(1);
        }
        if (choice === "y" || isEnter) {
          process.stderr.write("\n");
          break;
        }
        // ignore unrecognized keys, keep waiting
      }
    }

    for (const w of targets) {
      rmWorktree(w, force, safeDel, forceDel);
    }
    return;
  }

  let failures = 0;
  for (const name of branches) {
    const wt = worktrees.find((w) => w.branch === name);
    if (!wt) {
      error(`No worktree for branch: ${bold(name)}`);
      failures++;
      continue;
    }

    if (wt.path === mainPath) {
      error("Cannot remove the main worktree");
      failures++;
      continue;
    }

    if (!force && safeIsDirty(wt)) {
      error(
        `${bold(name)} has uncommitted changes`,
        "Pass --force to override.",
      );
      failures++;
      continue;
    }

    if (!rmWorktree(wt, force, safeDel, forceDel)) {
      failures++;
    }
  }
  if (failures > 0) process.exit(1);
}

/**
 * Wrap `isDirty` so a broken worktree (unreadable `.git`, missing dir, etc.)
 * fails fast with a clear hint instead of crashing inside execSync.
 * @param {{ branch: string, path: string }} wt
 * @returns {boolean}
 */
function safeIsDirty(wt) {
  try {
    return isDirty(wt.path);
  } catch {
    fatal(
      `Cannot read worktree state at ${bold(wt.path)}`,
      "Worktree may be broken. Pass --force to remove anyway, or run `git worktree repair`.",
    );
  }
}

/**
 * Remove a linked worktree, emit a confirmation line on stderr, and optionally
 * delete its branch. Returns true on success, false on failure; the caller
 * sets the process exit code based on the aggregate result.
 * @param {{ branch: string, path: string }} wt
 * @param {boolean} force
 * @param {boolean} safeDel
 * @param {boolean} forceDel
 * @returns {boolean}
 */
function rmWorktree(wt, force, safeDel, forceDel) {
  const removeArgs = ["worktree", "remove"];
  if (force) removeArgs.push("--force");
  removeArgs.push(wt.path);

  try {
    execFileSync("git", removeArgs, {
      stdio: ["ignore", "ignore", "inherit"],
    });
  } catch {
    // With --force, fall back to nuking the directory and pruning git's admin
    // state. Covers cases git won't handle even with --force (locked worktree,
    // permissions, etc.) and the desync case where the dir is left behind
    // after a partial removal.
    if (force) {
      try {
        // Unlock first so prune isn't blocked by a leftover lock entry.
        spawnSync("git", ["worktree", "unlock", wt.path], { stdio: "ignore" });
        rmSync(wt.path, { recursive: true, force: true });
        execFileSync("git", ["worktree", "prune"], {
          stdio: ["ignore", "ignore", "inherit"],
        });
      } catch {
        error(`Failed to remove ${bold(wt.branch)}`, wt.path);
        return false;
      }
    } else {
      error(
        `Failed to remove ${bold(wt.branch)}`,
        `${wt.path}\nPass --force to remove anyway.`,
      );
      return false;
    }
  }

  if (safeDel || forceDel) {
    const branchArgs = ["branch", forceDel ? "-D" : "-d", wt.branch];
    try {
      execFileSync("git", branchArgs, {
        stdio: ["ignore", "ignore", "inherit"],
      });
      success(`Removed ${bold(wt.branch)} and deleted branch`);
      return true;
    } catch {
      success(`Removed ${bold(wt.branch)}`);
      return false;
    }
  }
  success(`Removed ${bold(wt.branch)}`);
  return true;
}

/**
 * Translate include/exclude glob arguments into rsync filter flags.
 * Negatives (leading `!`) become `--exclude=...` and are emitted first;
 * positives become `--include=...` and follow. Both groups preserve input order.
 * `.git` is always excluded first so rsync never replaces a worktree's gitlink
 * file with the source's `.git` directory.
 * The result is bracketed by a leading `--include=*\/` (directory descent) and
 * a trailing `--exclude=*` (default-deny).
 * @param {string[]} globs
 * @returns {string[]}
 */
export function buildRsyncArgs(globs) {
  const excludes = globs
    .filter((g) => g.startsWith("!"))
    .map((g) => `--exclude=${g.slice(1)}`);
  const includes = globs
    .filter((g) => !g.startsWith("!"))
    .map((g) => `--include=${g}`);
  return [
    "--exclude=.git",
    "--include=*/",
    ...excludes,
    ...includes,
    "--exclude=*",
  ];
}

/** @param {string[]} args */
function cmdCp(args) {
  const from = process.env["WT_FROM"];
  const root = process.env["WT_ROOT"];
  if (!from || !root) {
    fatal(
      "`wt cp` must be run from a postCreate hook",
      "WT_FROM and WT_ROOT must be set.",
    );
  }

  const rsyncArgs = buildRsyncArgs(args);
  const result = spawnSync(
    "rsync",
    ["-a", ...rsyncArgs, `${from}/`, `${root}/`],
    {
      stdio: ["ignore", "ignore", "inherit"],
    },
  );

  if (/** @type {any} */ (result).error?.code === "ENOENT") {
    fatal("rsync not found on $PATH", undefined, { code: 2 });
  }

  if (result.status !== 0) process.exit(2);
}

if (realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    fatal(/** @type {Error} */ (err)?.message ?? String(err), undefined, {
      code: 2,
      cause: err,
    });
  });
}
