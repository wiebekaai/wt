// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  formatColumns,
  loadConfig,
  parsePorcelain,
  slugify,
  resolveWorktreePath,
  isDirty,
  parseEnvFlags,
  buildRsyncArgs,
} from "./wt.mjs";

const SCRIPT = fileURLToPath(new URL("./wt.mjs", import.meta.url));

// Don't let an inherited FORCE_COLOR leak into spawned children — tests that
// want color set it explicitly in their own env override.
delete process.env["FORCE_COLOR"];

// ── formatColumns ─────────────────────────────────────────────────────────────

test("formatColumns: TTY aligns columns with two-space gap", () => {
  const result = formatColumns(
    [
      ["foo", "bar"],
      ["longer", "baz"],
    ],
    { tty: true },
  );
  const lines = result.split("\n");
  // 'foo' padded to width 6, then '  ' separator
  assert.equal(lines[0], "foo     bar");
  assert.equal(lines[1], "longer  baz");
});

test("formatColumns: non-TTY produces tab-separated rows", () => {
  const result = formatColumns(
    [
      ["foo", "bar"],
      ["longer", "baz"],
    ],
    { tty: false },
  );
  assert.equal(result, "foo\tbar\nlonger\tbaz");
});

test("formatColumns: single column, no extra spaces", () => {
  const result = formatColumns([["only"]], { tty: true });
  assert.equal(result, "only");
});

test("formatColumns: three columns aligned", () => {
  const result = formatColumns(
    [
      ["a", "bb", "ccc"],
      ["dddd", "ee", "f"],
    ],
    { tty: true },
  );
  const lines = result.split("\n");
  // col-0 width=4, col-1 width=2, col-2 last (no pad)
  assert.equal(lines[0], "a     bb  ccc");
  assert.equal(lines[1], "dddd  ee  f");
});

test("formatColumns: single row, multiple columns", () => {
  const result = formatColumns([["x", "y", "z"]], { tty: true });
  assert.equal(result, "x  y  z");
});

test("formatColumns: empty rows array returns empty string", () => {
  const result = formatColumns([], { tty: true });
  assert.equal(result, "");
});

test("formatColumns: non-TTY single column has no tabs", () => {
  const result = formatColumns([["abc"], ["def"]], { tty: false });
  assert.equal(result, "abc\ndef");
});

// ── CLI integration ───────────────────────────────────────────────────────────

test("wt --help: exits 0 and prints commands to stderr", () => {
  const { status, stderr } = spawnSync(process.execPath, [SCRIPT, "--help"]);
  assert.equal(status, 0);
  const out = stderr.toString();
  assert.match(out, /init/);
  assert.match(out, /list/);
  assert.match(out, /add/);
  assert.match(out, /\bremove\b/);
  assert.match(out, /cp/);
});

test("wt (no args): exits non-zero and prints help to stderr", () => {
  const { status, stderr, stdout } = spawnSync(process.execPath, [SCRIPT]);
  assert.notEqual(status, 0);
  assert.match(stderr.toString(), /Usage/);
  assert.equal(stdout.toString(), "");
});

test("wt <unknown>: exits non-zero and prints help to stderr", () => {
  const { status, stderr, stdout } = spawnSync(process.execPath, [
    SCRIPT,
    "bogus",
  ]);
  assert.notEqual(status, 0);
  assert.match(stderr.toString(), /unknown command/);
  assert.equal(stdout.toString(), "");
});

test("wt <cmd> --help: exits 0 and prints per-command help", () => {
  for (const cmd of ["init", "list", "add", "remove", "cp"]) {
    const { status, stderr } = spawnSync(process.execPath, [
      SCRIPT,
      cmd,
      "--help",
    ]);
    assert.equal(status, 0, `wt ${cmd} --help should exit 0`);
    assert.match(
      stderr.toString(),
      /Usage/,
      `wt ${cmd} --help should print Usage`,
    );
  }
});

test("wt add: no branches argument prints usage and exits 1", () => {
  const { status, stderr } = spawnSync(process.execPath, [SCRIPT, "add"]);
  assert.equal(status, 1);
  assert.match(stderr.toString(), /Usage/);
});

test("DEBUG=1 wt <unknown>: prints stack trace to stderr", () => {
  const { status, stderr } = spawnSync(process.execPath, [SCRIPT, "bogus"], {
    env: { ...process.env, DEBUG: "1" },
  });
  assert.notEqual(status, 0);
  const out = stderr.toString();
  assert.match(out, /Error: unknown command/);
  assert.match(out, /\n\s+at /); // typical stack frame line
});

// ── loadConfig ────────────────────────────────────────────────────────────────

test("loadConfig: returns defaults when no config files exist", () => {
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const cwd = mkdtempSync(join(tmpdir(), "wt-"));
  const config = loadConfig({ cwd, home });
  assert.deepEqual(config, {
    path: join(home, ".worktrees"),
    postCreate: [],
  });
});

test("loadConfig: user-only config returned unmodified", () => {
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const cwd = mkdtempSync(join(tmpdir(), "wt-"));
  writeFileSync(
    join(home, ".wt.json"),
    JSON.stringify({ path: "/custom", postCreate: ["echo hi"] }),
  );
  const config = loadConfig({ cwd, home });
  assert.deepEqual(config, { path: "/custom", postCreate: ["echo hi"] });
});

test("loadConfig: project-only config returned unmodified", () => {
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const cwd = mkdtempSync(join(tmpdir(), "wt-"));
  spawnSync("git", ["init", cwd]);
  writeFileSync(
    join(cwd, ".wt.json"),
    JSON.stringify({ path: "/proj", postCreate: ["npm ci"] }),
  );
  const config = loadConfig({ cwd, home });
  assert.deepEqual(config, { path: "/proj", postCreate: ["npm ci"] });
});

test("loadConfig: project config wins over user config (shallow merge)", () => {
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const cwd = mkdtempSync(join(tmpdir(), "wt-"));
  spawnSync("git", ["init", cwd]);
  writeFileSync(
    join(home, ".wt.json"),
    JSON.stringify({ path: "/user", postCreate: ["echo user"] }),
  );
  writeFileSync(join(cwd, ".wt.json"), JSON.stringify({ path: "/proj" }));
  const config = loadConfig({ cwd, home });
  assert.equal(config.path, "/proj");
  assert.deepEqual(config.postCreate, ["echo user"]);
});

test("loadConfig: project postCreate replaces user postCreate entirely", () => {
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const cwd = mkdtempSync(join(tmpdir(), "wt-"));
  spawnSync("git", ["init", cwd]);
  writeFileSync(
    join(home, ".wt.json"),
    JSON.stringify({ postCreate: ["a", "b"] }),
  );
  writeFileSync(join(cwd, ".wt.json"), JSON.stringify({ postCreate: ["c"] }));
  const config = loadConfig({ cwd, home });
  assert.deepEqual(config.postCreate, ["c"]);
});

test("loadConfig: ~ in user path expands to home", () => {
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const cwd = mkdtempSync(join(tmpdir(), "wt-"));
  writeFileSync(
    join(home, ".wt.json"),
    JSON.stringify({ path: "~/.worktrees" }),
  );
  const config = loadConfig({ cwd, home });
  assert.equal(config.path, join(home, ".worktrees"));
});

test("loadConfig: relative project path resolves against main repo root", () => {
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const cwd = mkdtempSync(join(tmpdir(), "wt-"));
  spawnSync("git", ["init", cwd]);
  writeFileSync(join(cwd, ".wt.json"), JSON.stringify({ path: "./worktrees" }));
  const config = loadConfig({ cwd, home });
  assert.equal(config.path, join(realpathSync(cwd), "worktrees"));
});

test("loadConfig: outside git repo, project config is skipped", () => {
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const cwd = mkdtempSync(join(tmpdir(), "wt-"));
  // cwd is NOT a git repo; even if a stray .wt.json sits here, it must not load
  writeFileSync(join(cwd, ".wt.json"), JSON.stringify({ path: "/stray" }));
  const config = loadConfig({ cwd, home });
  assert.equal(config.path, join(home, ".worktrees"));
});

test("loadConfig: JSONC line comments are stripped", () => {
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const cwd = mkdtempSync(join(tmpdir(), "wt-"));
  writeFileSync(
    join(home, ".wt.json"),
    `{\n  // this is a comment\n  "path": "/home"\n}`,
  );
  const config = loadConfig({ cwd, home });
  assert.equal(config.path, "/home");
});

test("loadConfig: JSONC block comments are stripped", () => {
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const cwd = mkdtempSync(join(tmpdir(), "wt-"));
  writeFileSync(
    join(home, ".wt.json"),
    `{\n  /* block comment */\n  "path": "/block"\n}`,
  );
  const config = loadConfig({ cwd, home });
  assert.equal(config.path, "/block");
});

test("loadConfig: comment markers inside strings are not stripped", () => {
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const cwd = mkdtempSync(join(tmpdir(), "wt-"));
  writeFileSync(join(home, ".wt.json"), `{"path": "/a//b/*c*/d"}`);
  const config = loadConfig({ cwd, home });
  assert.equal(config.path, "/a//b/*c*/d");
});

test("loadConfig: malformed JSON throws error naming the file", () => {
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const cwd = mkdtempSync(join(tmpdir(), "wt-"));
  writeFileSync(join(home, ".wt.json"), "{ bad json }");
  assert.throws(
    () => loadConfig({ cwd, home }),
    (err) => {
      assert.match(/** @type {Error} */ (err).message, /\.wt\.json/);
      return true;
    },
  );
});

// ── wt init ───────────────────────────────────────────────────────────────────

test("wt init: no ~/.wt.json → creates user-level config", () => {
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const cwd = mkdtempSync(join(tmpdir(), "wt-"));
  const { status } = spawnSync(process.execPath, [SCRIPT, "init"], {
    cwd,
    env: { ...process.env, HOME: home },
  });
  assert.equal(status, 0);
  assert.ok(existsSync(join(home, ".wt.json")));
});

test("wt init: ~/.wt.json exists + git repo → creates project-level config", () => {
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const repo = mkdtempSync(join(tmpdir(), "wt-"));
  spawnSync("git", ["init", repo]);
  writeFileSync(join(home, ".wt.json"), "{}");
  const { status } = spawnSync(process.execPath, [SCRIPT, "init"], {
    cwd: repo,
    env: { ...process.env, HOME: home },
  });
  assert.equal(status, 0);
  assert.ok(existsSync(join(repo, ".wt.json")));
});

test("wt init --user: always targets ~/.wt.json", () => {
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const repo = mkdtempSync(join(tmpdir(), "wt-"));
  spawnSync("git", ["init", repo]);
  const { status } = spawnSync(process.execPath, [SCRIPT, "init", "--user"], {
    cwd: repo,
    env: { ...process.env, HOME: home },
  });
  assert.equal(status, 0);
  assert.ok(existsSync(join(home, ".wt.json")));
  assert.ok(!existsSync(join(repo, ".wt.json")));
});

test("wt init --project: always targets repo .wt.json", () => {
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const repo = mkdtempSync(join(tmpdir(), "wt-"));
  spawnSync("git", ["init", repo]);
  const { status } = spawnSync(
    process.execPath,
    [SCRIPT, "init", "--project"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );
  assert.equal(status, 0);
  assert.ok(existsSync(join(repo, ".wt.json")));
  assert.ok(!existsSync(join(home, ".wt.json")));
});

test("wt init: existing target errors without --force", () => {
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const cwd = mkdtempSync(join(tmpdir(), "wt-"));
  writeFileSync(join(home, ".wt.json"), "{}");
  // user already exists and not in git repo → target is user again
  const { status, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "init", "--user"],
    { cwd, env: { ...process.env, HOME: home } },
  );
  assert.equal(status, 1);
  assert.match(stderr.toString(), /^✗/m);
});

test("wt init --force: overwrites existing target", () => {
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const cwd = mkdtempSync(join(tmpdir(), "wt-"));
  writeFileSync(join(home, ".wt.json"), "{}");
  const { status } = spawnSync(
    process.execPath,
    [SCRIPT, "init", "--user", "--force"],
    { cwd, env: { ...process.env, HOME: home } },
  );
  assert.equal(status, 0);
  assert.notEqual(readFileSync(join(home, ".wt.json"), "utf8"), "{}");
});

test("wt init: generated template round-trips through loadConfig", () => {
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const cwd = mkdtempSync(join(tmpdir(), "wt-"));
  spawnSync(process.execPath, [SCRIPT, "init"], {
    cwd,
    env: { ...process.env, HOME: home },
  });
  const config = loadConfig({ cwd, home });
  assert.deepEqual(config, { path: join(home, ".worktrees"), postCreate: [] });
});

test("wt init --project: outside git repo errors clearly", () => {
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const cwd = mkdtempSync(join(tmpdir(), "wt-"));
  const { status, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "init", "--project"],
    { cwd, env: { ...process.env, HOME: home } },
  );
  assert.equal(status, 1);
  assert.match(stderr.toString(), /^✗/m);
  assert.match(stderr.toString(), /git/i);
});

test("loadConfig: malformed JSON exits 1 with error output via CLI", () => {
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const cwd = mkdtempSync(join(tmpdir(), "wt-"));
  execFileSync("git", ["init", "-q"], { cwd });
  writeFileSync(join(home, ".wt.json"), "{ bad json }");
  const { status, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "add", "feat-x"],
    { cwd, env: { ...process.env, HOME: home } },
  );
  assert.equal(status, 1);
  const out = stderr.toString();
  assert.match(out, /^✗/m);
  assert.match(out, /\.wt\.json/);
});

// ── parsePorcelain ────────────────────────────────────────────────────────────

test("parsePorcelain: single normal worktree", () => {
  const text = `worktree /repo/main\nHEAD abc1234\nbranch refs/heads/main\n`;
  const result = parsePorcelain(text);
  assert.deepEqual(result, [
    { slug: "main", branch: "main", path: "/repo/main" },
  ]);
});

test("parsePorcelain: multiple worktrees", () => {
  const text = [
    "worktree /repo/main\nHEAD aaa\nbranch refs/heads/main",
    "worktree /repo/feat-x\nHEAD bbb\nbranch refs/heads/feat-x",
    "worktree /repo/other\nHEAD ccc\nbranch refs/heads/other",
  ].join("\n\n");
  const result = parsePorcelain(text);
  assert.equal(result.length, 3);
  assert.equal(result[0].slug, "main");
  assert.equal(result[1].slug, "feat-x");
  assert.equal(result[2].slug, "other");
});

test("parsePorcelain: detached HEAD shows sha with prefix", () => {
  const text = `worktree /repo/detached\nHEAD deadbeef\ndetached\n`;
  const result = parsePorcelain(text);
  assert.equal(result.length, 1);
  assert.equal(result[0].branch, "(detached) deadbeef");
  assert.equal(result[0].slug, "detached");
});

test("parsePorcelain: strips refs/heads/ prefix from branch", () => {
  const text = `worktree /repo/feat\nHEAD abc\nbranch refs/heads/feature/cool\n`;
  const [entry] = parsePorcelain(text);
  assert.equal(entry.branch, "feature/cool");
});

test("parsePorcelain: empty string returns empty array", () => {
  assert.deepEqual(parsePorcelain(""), []);
});

// ── wt list (integration) ─────────────────────────────────────────────────────

/** @returns {{ repo: string, cleanup: () => void }} */
function makeGitRepo() {
  const repo = mkdtempSync(join(tmpdir(), "wt-repo-"));
  spawnSync("git", ["init", repo]);
  spawnSync("git", ["-C", repo, "config", "user.email", "test@test.com"]);
  spawnSync("git", ["-C", repo, "config", "user.name", "Test"]);
  // need at least one commit so worktree list works
  spawnSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "init"]);
  return { repo, cleanup: () => {} };
}

test("wt list: prints one row per worktree in TTY mode", () => {
  const { repo } = makeGitRepo();
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const { status, stdout } = spawnSync(process.execPath, [SCRIPT, "list"], {
    cwd: repo,
    env: { ...process.env, HOME: home },
  });
  assert.equal(status, 0);
  const out = stdout.toString().trim();
  assert.ok(out.length > 0, "should print at least one row");
});

test("wt list --json: emits valid JSON array with slug/branch/path", () => {
  const { repo } = makeGitRepo();
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const { status, stdout } = spawnSync(
    process.execPath,
    [SCRIPT, "list", "--json"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );
  assert.equal(status, 0);
  const arr = JSON.parse(stdout.toString());
  assert.ok(Array.isArray(arr));
  assert.ok(arr.length > 0);
  for (const entry of arr) {
    assert.ok("slug" in entry);
    assert.ok("branch" in entry);
    assert.ok("path" in entry);
  }
});

test("wt list: outside git repo exits 2 with git's own error", () => {
  const cwd = mkdtempSync(join(tmpdir(), "wt-nogit-"));
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const { status, stderr } = spawnSync(process.execPath, [SCRIPT, "list"], {
    cwd,
    env: { ...process.env, HOME: home },
  });
  assert.equal(status, 2);
  assert.match(stderr.toString(), /not a git repository/i);
});

// ── slugify ───────────────────────────────────────────────────────────────────

test("slugify: slashes replaced with dashes", () => {
  assert.equal(slugify("feat/foo"), "feat-foo");
});

test("slugify: runs of dashes collapse", () => {
  assert.equal(slugify("feat//foo"), "feat-foo");
  assert.equal(slugify("a--b"), "a-b");
});

test("slugify: leading and trailing dashes trimmed", () => {
  assert.equal(slugify("-feat-"), "feat");
});

test("slugify: leading and trailing dots trimmed", () => {
  assert.equal(slugify(".feat."), "feat");
});

test("slugify: dots in middle preserved", () => {
  assert.equal(slugify("v1.0.0"), "v1.0.0");
});

test("slugify: mixed case preserved", () => {
  assert.equal(slugify("FeatFoo"), "FeatFoo");
  assert.equal(slugify("UPPER-lower"), "UPPER-lower");
});

test("slugify: Unicode characters replaced with dashes and trimmed", () => {
  assert.equal(slugify("feat-café"), "feat-caf");
});

test("slugify: spaces replaced and trimmed", () => {
  assert.equal(slugify(" feat "), "feat");
});

// ── resolveWorktreePath ───────────────────────────────────────────────────────

test("resolveWorktreePath: composes base/repo/slug", () => {
  const config = { path: "/worktrees", postCreate: [] };
  assert.equal(
    resolveWorktreePath("my-repo", "feat/foo", config),
    "/worktrees/my-repo/feat-foo",
  );
});

test("resolveWorktreePath: custom absolute path respected", () => {
  const config = { path: "/custom/path", postCreate: [] };
  assert.equal(
    resolveWorktreePath("repo", "main", config),
    "/custom/path/repo/main",
  );
});

// ── wt add (integration) ──────────────────────────────────────────────────────

test("wt add: creates worktree at expected path, stdout is the path", () => {
  const { repo } = makeGitRepo();
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const wtBase = mkdtempSync(join(tmpdir(), "wt-base-"));
  writeFileSync(join(home, ".wt.json"), JSON.stringify({ path: wtBase }));

  const repoName = repo.split("/").pop();
  const expectedPath = join(wtBase, repoName ?? "", "feat-foo");

  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "add", "feat/foo"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );

  assert.equal(status, 0, `stderr: ${stderr.toString()}`);
  assert.equal(stdout.toString().trim(), expectedPath);
  assert.ok(
    existsSync(expectedPath),
    "worktree directory should exist on disk",
  );
});

test("wt add: stdout is the sole output (nothing else on stdout)", () => {
  const { repo } = makeGitRepo();
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const wtBase = mkdtempSync(join(tmpdir(), "wt-base-"));
  writeFileSync(join(home, ".wt.json"), JSON.stringify({ path: wtBase }));

  const { status, stdout } = spawnSync(
    process.execPath,
    [SCRIPT, "add", "my-branch"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );

  assert.equal(status, 0);
  const lines = stdout.toString().trim().split("\n");
  assert.equal(lines.length, 1, "stdout must contain exactly one line");
});

test("wt add: slug collision with existing path exits 1 with error", () => {
  const { repo } = makeGitRepo();
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const wtBase = mkdtempSync(join(tmpdir(), "wt-base-"));
  writeFileSync(join(home, ".wt.json"), JSON.stringify({ path: wtBase }));

  const repoName = repo.split("/").pop();
  const collisionPath = join(wtBase, repoName ?? "", "feat-foo");
  mkdirSync(collisionPath, { recursive: true });

  const { status, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "add", "feat/foo"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );

  assert.equal(status, 1);
  assert.match(stderr.toString(), /^✗/m);
});

test("wt add: nonexistent --base exits 2", () => {
  const { repo } = makeGitRepo();
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const wtBase = mkdtempSync(join(tmpdir(), "wt-base-"));
  writeFileSync(join(home, ".wt.json"), JSON.stringify({ path: wtBase }));

  const { status } = spawnSync(
    process.execPath,
    [SCRIPT, "add", "feat/foo", "--base", "nonexistent-does-not-exist"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );

  assert.equal(status, 2);
});

// ── branch-state helpers ──────────────────────────────────────────────────────

/**
 * Create a bare origin repo + a clone with user config and an initial commit.
 * @returns {{ origin: string, repo: string }}
 */
function makeGitRepoWithOrigin() {
  const origin = mkdtempSync(join(tmpdir(), "wt-origin-"));
  spawnSync("git", ["init", "--bare", origin]);

  const repo = mkdtempSync(join(tmpdir(), "wt-repo-"));
  spawnSync("git", ["clone", origin, repo]);
  spawnSync("git", ["-C", repo, "config", "user.email", "test@test.com"]);
  spawnSync("git", ["-C", repo, "config", "user.name", "Test"]);
  spawnSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "init"]);
  spawnSync("git", ["-C", repo, "push", "origin", "HEAD:main"]);
  // ensure origin/HEAD is set so default base resolution works
  spawnSync("git", ["-C", repo, "remote", "set-head", "origin", "main"]);
  return { origin, repo };
}

// ── wt add branch-state (integration) ────────────────────────────────────────

test("wt add: local branch exists → checks out into new worktree", () => {
  const { repo } = makeGitRepoWithOrigin();
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const wtBase = mkdtempSync(join(tmpdir(), "wt-base-"));
  writeFileSync(join(home, ".wt.json"), JSON.stringify({ path: wtBase }));

  // seed a local branch
  spawnSync("git", ["-C", repo, "branch", "feat/existing-local"]);

  const repoName = repo.split("/").pop();
  const expectedPath = join(wtBase, repoName ?? "", "feat-existing-local");

  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "add", "feat/existing-local"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );

  assert.equal(status, 0, `stderr: ${stderr.toString()}`);
  assert.equal(stdout.toString().trim(), expectedPath);
  assert.ok(
    existsSync(expectedPath),
    "worktree directory should exist on disk",
  );

  // verify the worktree is on the expected branch
  const { stdout: branchOut } = spawnSync(
    "git",
    ["-C", expectedPath, "branch", "--show-current"],
    { encoding: "utf8" },
  );
  assert.equal(branchOut.trim(), "feat/existing-local");
});

test("wt add: remote-only branch → creates local tracking branch", () => {
  const { repo } = makeGitRepoWithOrigin();
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const wtBase = mkdtempSync(join(tmpdir(), "wt-base-"));
  writeFileSync(join(home, ".wt.json"), JSON.stringify({ path: wtBase }));

  // create branch in clone, push to remote, delete locally
  spawnSync("git", ["-C", repo, "branch", "feat/remote-only"]);
  spawnSync("git", ["-C", repo, "push", "origin", "feat/remote-only"]);
  spawnSync("git", ["-C", repo, "branch", "-d", "feat/remote-only"]);

  const repoName = repo.split("/").pop();
  const expectedPath = join(wtBase, repoName ?? "", "feat-remote-only");

  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "add", "feat/remote-only"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );

  assert.equal(status, 0, `stderr: ${stderr.toString()}`);
  assert.equal(stdout.toString().trim(), expectedPath);
  assert.ok(
    existsSync(expectedPath),
    "worktree directory should exist on disk",
  );

  // verify the worktree is on a local tracking branch
  const { stdout: branchOut } = spawnSync(
    "git",
    ["-C", expectedPath, "branch", "--show-current"],
    { encoding: "utf8" },
  );
  assert.equal(branchOut.trim(), "feat/remote-only");
});

test("wt add: new branch with --base branches from specified ref", () => {
  const { repo } = makeGitRepoWithOrigin();
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const wtBase = mkdtempSync(join(tmpdir(), "wt-base-"));
  writeFileSync(join(home, ".wt.json"), JSON.stringify({ path: wtBase }));

  // create a release branch as base
  spawnSync("git", ["-C", repo, "branch", "release-1.2"]);

  const repoName = repo.split("/").pop();
  const expectedPath = join(wtBase, repoName ?? "", "feat-new");

  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "add", "feat/new", "--base", "release-1.2"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );

  assert.equal(status, 0, `stderr: ${stderr.toString()}`);
  assert.equal(stdout.toString().trim(), expectedPath);
  assert.ok(existsSync(expectedPath));
});

test("wt add: --base with mixed conflicts lists all in one message, no worktrees created", () => {
  const { repo } = makeGitRepoWithOrigin();
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const wtBase = mkdtempSync(join(tmpdir(), "wt-base-"));
  writeFileSync(join(home, ".wt.json"), JSON.stringify({ path: wtBase }));

  spawnSync("git", ["-C", repo, "branch", "have-local"]);
  spawnSync("git", ["-C", repo, "branch", "have-remote"]);
  spawnSync("git", ["-C", repo, "push", "origin", "have-remote"]);
  spawnSync("git", ["-C", repo, "branch", "-d", "have-remote"]);

  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "add", "fresh", "have-local", "have-remote", "--base", "main"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );

  assert.notEqual(status, 0);
  const err = stderr.toString();
  assert.match(err, /existing branches:/);
  assert.match(err, /have-local \(local\)/);
  assert.match(err, /have-remote \(origin\)/);
  assert.equal(stdout.toString(), "");

  // atomicity: no worktree directory should have been created for any branch
  const repoName = repo.split("/").pop() ?? "";
  assert.ok(!existsSync(join(wtBase, repoName, "fresh")));
  assert.ok(!existsSync(join(wtBase, repoName, "have-local")));
  assert.ok(!existsSync(join(wtBase, repoName, "have-remote")));
});

test("wt add: --base with remote-only branch errors with (origin) hint", () => {
  const { repo } = makeGitRepoWithOrigin();
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const wtBase = mkdtempSync(join(tmpdir(), "wt-base-"));
  writeFileSync(join(home, ".wt.json"), JSON.stringify({ path: wtBase }));

  spawnSync("git", ["-C", repo, "branch", "remote-only"]);
  spawnSync("git", ["-C", repo, "push", "origin", "remote-only"]);
  spawnSync("git", ["-C", repo, "branch", "-d", "remote-only"]);

  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "add", "remote-only", "--base", "main"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );

  assert.notEqual(status, 0, "expected non-zero exit");
  assert.match(stderr.toString(), /remote-only \(origin\)/);
  assert.equal(stdout.toString(), "");
});

test("wt add: --base with existing local branch errors with (local) hint", () => {
  const { repo } = makeGitRepoWithOrigin();
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const wtBase = mkdtempSync(join(tmpdir(), "wt-base-"));
  writeFileSync(join(home, ".wt.json"), JSON.stringify({ path: wtBase }));

  spawnSync("git", ["-C", repo, "branch", "existing-local"]);

  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "add", "existing-local", "--base", "main"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );

  assert.notEqual(status, 0, "expected non-zero exit");
  assert.match(stderr.toString(), /existing-local \(local\)/);
  assert.match(stderr.toString(), /--base/);
  assert.equal(stdout.toString(), "", "no path should be printed on stdout");
});

// ── wt add postCreate (integration) ──────────────────────────────────────────

test("wt add: postCreate runs with WT_ROOT/WT_FROM/WT_BRANCH set", () => {
  const { repo } = makeGitRepoWithOrigin();
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const wtBase = mkdtempSync(join(tmpdir(), "wt-base-"));
  writeFileSync(
    join(home, ".wt.json"),
    JSON.stringify({
      path: wtBase,
      postCreate: [
        `printf '%s\\n%s\\n%s\\n' "$WT_ROOT" "$WT_FROM" "$WT_BRANCH" > env.txt`,
      ],
    }),
  );

  const repoName = repo.split("/").pop();
  const expectedPath = join(wtBase, repoName ?? "", "feat-hook");

  const { status, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "add", "feat/hook"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );

  assert.equal(status, 0, `stderr: ${stderr.toString()}`);
  const captured = readFileSync(join(expectedPath, "env.txt"), "utf8")
    .trim()
    .split("\n");
  // WT_ROOT is composed from config.path (not resolved), WT_FROM comes from
  // `git rev-parse --show-toplevel` which resolves symlinks like /var → /private/var.
  assert.equal(captured[0], expectedPath);
  assert.equal(captured[1], realpathSync(repo));
  assert.equal(captured[2], "feat/hook");
});

test("wt add: from inside a worktree, child lands as sibling under the canonical repo name", () => {
  const { repo } = makeGitRepoWithOrigin();
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const wtBase = mkdtempSync(join(tmpdir(), "wt-base-"));
  writeFileSync(join(home, ".wt.json"), JSON.stringify({ path: wtBase }));

  const repoName = repo.split("/").pop() ?? "";
  const parentPath = join(wtBase, repoName, "feat-parent");
  const expectedChildPath = join(wtBase, repoName, "feat-child");

  const parent = spawnSync(process.execPath, [SCRIPT, "add", "feat/parent"], {
    cwd: repo,
    env: { ...process.env, HOME: home },
  });
  assert.equal(parent.status, 0, `parent stderr: ${parent.stderr.toString()}`);

  const child = spawnSync(process.execPath, [SCRIPT, "add", "feat/child"], {
    cwd: parentPath,
    env: { ...process.env, HOME: home },
  });
  assert.equal(child.status, 0, `child stderr: ${child.stderr.toString()}`);
  assert.equal(child.stdout.toString().trim(), expectedChildPath);
  assert.ok(existsSync(expectedChildPath));
});

test("wt add: from inside a worktree, WT_FROM in postCreate is the parent worktree", () => {
  const { repo } = makeGitRepoWithOrigin();
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const wtBase = mkdtempSync(join(tmpdir(), "wt-base-"));
  writeFileSync(
    join(home, ".wt.json"),
    JSON.stringify({
      path: wtBase,
      postCreate: [`printf '%s' "$WT_FROM" > from.txt`],
    }),
  );

  const repoName = repo.split("/").pop() ?? "";
  const parentPath = join(wtBase, repoName, "feat-parent");
  const childPath = join(wtBase, repoName, "feat-child");

  const parent = spawnSync(process.execPath, [SCRIPT, "add", "feat/parent"], {
    cwd: repo,
    env: { ...process.env, HOME: home },
  });
  assert.equal(parent.status, 0, `parent stderr: ${parent.stderr.toString()}`);

  const child = spawnSync(
    process.execPath,
    [SCRIPT, "add", "--keep", "feat/child"],
    { cwd: parentPath, env: { ...process.env, HOME: home } },
  );
  assert.equal(child.status, 0, `child stderr: ${child.stderr.toString()}`);

  const captured = readFileSync(join(childPath, "from.txt"), "utf8");
  assert.equal(captured, realpathSync(parentPath));
});

test("wt add: project relative path resolves against main repo even from inside a worktree", () => {
  const { repo } = makeGitRepoWithOrigin();
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  // Project config with a RELATIVE path; resolving incorrectly (against cwd)
  // would create nested worktrees inside the parent worktree.
  writeFileSync(
    join(repo, ".wt.json"),
    JSON.stringify({ path: "./worktrees" }),
  );

  const repoName = repo.split("/").pop() ?? "";
  const expectedBase = join(realpathSync(repo), "worktrees", repoName);

  const parent = spawnSync(
    process.execPath,
    [SCRIPT, "add", "--keep", "feat/parent"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );
  assert.equal(parent.status, 0, `parent stderr: ${parent.stderr.toString()}`);
  const parentPath = parent.stdout.toString().trim();
  assert.equal(parentPath, join(expectedBase, "feat-parent"));

  const child = spawnSync(
    process.execPath,
    [SCRIPT, "add", "--keep", "feat/child"],
    { cwd: parentPath, env: { ...process.env, HOME: home } },
  );
  assert.equal(child.status, 0, `child stderr: ${child.stderr.toString()}`);
  const childPath = child.stdout.toString().trim();
  assert.equal(childPath, join(expectedBase, "feat-child"));
});

test("wt add: postCreate stdout flows to stderr; stdout is just the path", () => {
  const { repo } = makeGitRepoWithOrigin();
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const wtBase = mkdtempSync(join(tmpdir(), "wt-base-"));
  writeFileSync(
    join(home, ".wt.json"),
    JSON.stringify({
      path: wtBase,
      postCreate: ["echo HELLO_FROM_HOOK"],
    }),
  );

  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "add", "feat/echo"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );

  assert.equal(status, 0, `stderr: ${stderr.toString()}`);
  const lines = stdout.toString().trim().split("\n");
  assert.equal(
    lines.length,
    1,
    "stdout should contain exactly one line (the path)",
  );
  assert.match(stderr.toString(), /HELLO_FROM_HOOK/);
});

test("wt add: postCreate failure stops chain, leaves worktree, exits non-zero, no path on stdout", () => {
  const { repo } = makeGitRepoWithOrigin();
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const wtBase = mkdtempSync(join(tmpdir(), "wt-base-"));
  writeFileSync(
    join(home, ".wt.json"),
    JSON.stringify({
      path: wtBase,
      postCreate: ["echo FIRST_RAN", "exit 1", "echo SHOULD_NOT_RUN"],
    }),
  );

  const repoName = repo.split("/").pop();
  const expectedPath = join(wtBase, repoName ?? "", "feat-bad");

  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "add", "feat/bad"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );

  assert.notEqual(status, 0);
  assert.equal(
    stdout.toString(),
    "",
    "stdout should be empty on postCreate failure",
  );
  const err = stderr.toString();
  assert.match(err, /FIRST_RAN/);
  assert.ok(
    !/SHOULD_NOT_RUN/.test(err),
    "commands after a failed hook must not run",
  );
  assert.match(err, /^✗ postCreate failed/m);
  assert.match(err, /exit 1/);
  assert.ok(
    existsSync(expectedPath),
    "worktree should stay on disk after hook failure",
  );
});

test("wt add: postCreate inherits parent env (PATH)", () => {
  const { repo } = makeGitRepoWithOrigin();
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const wtBase = mkdtempSync(join(tmpdir(), "wt-base-"));
  writeFileSync(
    join(home, ".wt.json"),
    JSON.stringify({
      path: wtBase,
      postCreate: ['test -n "$PATH" && printf OK > path.txt'],
    }),
  );

  const repoName = repo.split("/").pop();
  const expectedPath = join(wtBase, repoName ?? "", "feat-env");

  const { status, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "add", "feat/env"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );

  assert.equal(status, 0, `stderr: ${stderr.toString()}`);
  assert.equal(readFileSync(join(expectedPath, "path.txt"), "utf8"), "OK");
});

test("wt add: multiple postCreate commands run in order; all must succeed", () => {
  const { repo } = makeGitRepoWithOrigin();
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const wtBase = mkdtempSync(join(tmpdir(), "wt-base-"));
  writeFileSync(
    join(home, ".wt.json"),
    JSON.stringify({
      path: wtBase,
      postCreate: [
        "echo one >> log.txt",
        "echo two >> log.txt",
        "echo three >> log.txt",
      ],
    }),
  );

  const repoName = repo.split("/").pop();
  const expectedPath = join(wtBase, repoName ?? "", "feat-seq");

  const { status, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "add", "feat/seq"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );

  assert.equal(status, 0, `stderr: ${stderr.toString()}`);
  const log = readFileSync(join(expectedPath, "log.txt"), "utf8")
    .trim()
    .split("\n");
  assert.deepEqual(log, ["one", "two", "three"]);
});

// ── isDirty ───────────────────────────────────────────────────────────────────

test("isDirty: returns false for a clean repo", () => {
  const { repo } = makeGitRepo();
  assert.equal(isDirty(repo), false);
});

test("isDirty: returns true when untracked file present", () => {
  const { repo } = makeGitRepo();
  writeFileSync(join(repo, "untracked.txt"), "hello");
  assert.equal(isDirty(repo), true);
});

test("isDirty: returns true when tracked file modified", () => {
  const { repo } = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "v1");
  spawnSync("git", ["-C", repo, "add", "file.txt"]);
  spawnSync("git", ["-C", repo, "commit", "-m", "add file"]);
  writeFileSync(join(repo, "file.txt"), "v2");
  assert.equal(isDirty(repo), true);
});

// ── dirty-tree helpers ────────────────────────────────────────────────────────

/**
 * Make a repo with staged + untracked dirty changes.
 * @returns {{ repo: string, wtBase: string, home: string }}
 */
function makeDirtyRepo() {
  const { repo } = makeGitRepo();
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const wtBase = mkdtempSync(join(tmpdir(), "wt-base-"));
  writeFileSync(join(home, ".wt.json"), JSON.stringify({ path: wtBase }));

  // Create a tracked file and commit it
  writeFileSync(join(repo, "tracked.txt"), "original");
  spawnSync("git", ["-C", repo, "add", "tracked.txt"]);
  spawnSync("git", ["-C", repo, "commit", "-m", "add tracked"]);

  // Now dirty: modify tracked file + add untracked file
  writeFileSync(join(repo, "tracked.txt"), "modified");
  writeFileSync(join(repo, "untracked.txt"), "new");
  return { repo, home, wtBase };
}

// ── wt add dirty-tree (integration) ──────────────────────────────────────────

test("wt add: clean tree passes through without prompt", () => {
  const { repo } = makeGitRepo();
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const wtBase = mkdtempSync(join(tmpdir(), "wt-base-"));
  writeFileSync(join(home, ".wt.json"), JSON.stringify({ path: wtBase }));

  const { status, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "add", "feat/clean"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );
  assert.equal(status, 0, `stderr: ${stderr.toString()}`);
  assert.ok(!/uncommitted/i.test(stderr.toString()));
});

test("wt add: dirty + non-TTY + no flag → exits 1 with error naming flags", () => {
  const { repo, home } = makeDirtyRepo();

  const { status, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "add", "feat/dirty"],
    {
      cwd: repo,
      env: { ...process.env, HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  assert.equal(status, 1, `stderr: ${stderr.toString()}`);
  const out = stderr.toString();
  assert.match(out, /uncommitted/i);
  assert.match(out, /--move|--keep|--copy/);
});

test("wt add --keep: dirty tree creates worktree, source stays dirty", () => {
  const { repo, home, wtBase } = makeDirtyRepo();
  const repoName = repo.split("/").pop();
  const expectedPath = join(wtBase, repoName ?? "", "feat-keep");

  const { status, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "add", "feat/keep", "--keep"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );
  assert.equal(status, 0, `stderr: ${stderr.toString()}`);
  assert.ok(existsSync(expectedPath));
  // source is still dirty
  assert.equal(isDirty(repo), true);
});

test("wt add --move: dirty tree creates worktree with changes, source becomes clean", () => {
  const { repo, home, wtBase } = makeDirtyRepo();
  const repoName = repo.split("/").pop();
  const expectedPath = join(wtBase, repoName ?? "", "feat-move");

  const { status, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "add", "feat/move", "--move"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );
  assert.equal(status, 0, `stderr: ${stderr.toString()}`);
  assert.ok(existsSync(expectedPath));

  // source should now be clean
  assert.equal(isDirty(repo), false, "source should be clean after --move");

  // new worktree should have the modified tracked file
  const movedContent = readFileSync(join(expectedPath, "tracked.txt"), "utf8");
  assert.equal(movedContent, "modified");
});

test("wt add --move: clean tree exits 2 (nothing to stash)", () => {
  const { repo } = makeGitRepo();
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const wtBase = mkdtempSync(join(tmpdir(), "wt-base-"));
  writeFileSync(join(home, ".wt.json"), JSON.stringify({ path: wtBase }));

  const { status } = spawnSync(
    process.execPath,
    [SCRIPT, "add", "feat/move-clean", "--move"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );
  assert.equal(status, 2);
});

test("wt add --copy: dirty tree creates worktree with changes, source stays dirty", () => {
  const { repo, home, wtBase } = makeDirtyRepo();
  const repoName = repo.split("/").pop();
  const expectedPath = join(wtBase, repoName ?? "", "feat-copy");

  const { status, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "add", "feat/copy", "--copy"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );
  assert.equal(status, 0, `stderr: ${stderr.toString()}`);
  assert.ok(existsSync(expectedPath));

  // source should still be dirty
  assert.equal(
    isDirty(repo),
    true,
    "source should still be dirty after --copy",
  );

  // new worktree should have the modified tracked file
  const copiedContent = readFileSync(join(expectedPath, "tracked.txt"), "utf8");
  assert.equal(copiedContent, "modified");

  // untracked file should also be present in new worktree
  assert.ok(existsSync(join(expectedPath, "untracked.txt")));
});

// ── wt add multi-branch (integration) ────────────────────────────────────────

test("wt add a b c: clean tree creates three worktrees, stdout has three paths in order", () => {
  const { repo } = makeGitRepoWithOrigin();
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const wtBase = mkdtempSync(join(tmpdir(), "wt-base-"));
  writeFileSync(join(home, ".wt.json"), JSON.stringify({ path: wtBase }));

  const repoName = repo.split("/").pop();

  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "add", "feat/alpha", "feat/beta", "feat/gamma"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );

  assert.equal(status, 0, `stderr: ${stderr.toString()}`);
  const lines = stdout.toString().trim().split("\n");
  assert.equal(lines.length, 3, "stdout should have exactly three lines");

  const expectedPaths = ["feat-alpha", "feat-beta", "feat-gamma"].map((slug) =>
    join(wtBase, repoName ?? "", slug),
  );
  assert.deepEqual(lines, expectedPaths);
  for (const p of expectedPaths) {
    assert.ok(existsSync(p), `worktree should exist on disk: ${p}`);
  }
});

test("wt add --move a b c: dirty tree, changes land in first worktree, rest are clean", () => {
  const { repo, home, wtBase } = makeDirtyRepo();
  const repoName = repo.split("/").pop();

  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "add", "--move", "feat/first", "feat/second", "feat/third"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );

  assert.equal(status, 0, `stderr: ${stderr.toString()}`);
  const lines = stdout.toString().trim().split("\n");
  assert.equal(lines.length, 3);

  const firstPath = join(wtBase, repoName ?? "", "feat-first");
  const secondPath = join(wtBase, repoName ?? "", "feat-second");
  const thirdPath = join(wtBase, repoName ?? "", "feat-third");

  // First worktree has the moved changes
  assert.equal(
    readFileSync(join(firstPath, "tracked.txt"), "utf8"),
    "modified",
  );
  assert.ok(existsSync(join(firstPath, "untracked.txt")));

  // Second and third are clean (no modified tracked.txt = back to original)
  assert.equal(
    readFileSync(join(secondPath, "tracked.txt"), "utf8"),
    "original",
  );
  assert.ok(!existsSync(join(secondPath, "untracked.txt")));
  assert.equal(
    readFileSync(join(thirdPath, "tracked.txt"), "utf8"),
    "original",
  );
  assert.ok(!existsSync(join(thirdPath, "untracked.txt")));

  // Source is now clean
  assert.equal(isDirty(repo), false);
});

test("wt add a b c: failure on second branch, first path on stdout, third never attempted", () => {
  const { repo } = makeGitRepoWithOrigin();
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const wtBase = mkdtempSync(join(tmpdir(), "wt-base-"));
  writeFileSync(join(home, ".wt.json"), JSON.stringify({ path: wtBase }));

  const repoName = repo.split("/").pop();
  // Pre-create the destination for 'feat/second' to force a collision on the second branch
  const secondPath = join(wtBase, repoName ?? "", "feat-second");
  mkdirSync(secondPath, { recursive: true });

  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "add", "feat/first", "feat/second", "feat/third"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );

  assert.notEqual(status, 0, "should exit non-zero");
  assert.match(stderr.toString(), /^✗/m);

  const outLines = stdout.toString().trim().split("\n").filter(Boolean);
  assert.equal(
    outLines.length,
    1,
    "only first branch path should be on stdout",
  );
  assert.equal(outLines[0], join(wtBase, repoName ?? "", "feat-first"));

  // Third should never have been attempted
  assert.ok(
    !existsSync(join(wtBase, repoName ?? "", "feat-third")),
    "third worktree should not exist",
  );
});

test("wt add --keep a b c: dirty tree with --keep creates all three worktrees, source stays dirty", () => {
  const { repo, home, wtBase } = makeDirtyRepo();
  const repoName = repo.split("/").pop();

  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "add", "--keep", "feat/one", "feat/two", "feat/three"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );

  assert.equal(status, 0, `stderr: ${stderr.toString()}`);
  const lines = stdout.toString().trim().split("\n");
  assert.equal(lines.length, 3);
  for (const slug of ["feat-one", "feat-two", "feat-three"]) {
    assert.ok(existsSync(join(wtBase, repoName ?? "", slug)));
  }
  assert.equal(
    isDirty(repo),
    true,
    "source should still be dirty after --keep",
  );
});

test("wt add a b c: dirty + non-TTY + no flag → fails once before any worktree is created", () => {
  const { repo, home, wtBase } = makeDirtyRepo();
  const repoName = repo.split("/").pop();

  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "add", "feat/a", "feat/b", "feat/c"],
    {
      cwd: repo,
      env: { ...process.env, HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  assert.equal(status, 1);
  assert.match(stderr.toString(), /uncommitted/i);
  assert.equal(stdout.toString(), "", "no paths should be printed on error");
  // No worktrees should have been created
  for (const slug of ["feat-a", "feat-b", "feat-c"]) {
    assert.ok(!existsSync(join(wtBase, repoName ?? "", slug)));
  }
});

// ── parseEnvFlags ─────────────────────────────────────────────────────────────

test("parseEnvFlags: --foo-bar baz → WT_FOO_BAR=baz", () => {
  const { envFlags, warnings, branches } = parseEnvFlags(
    ["--foo-bar", "baz"],
    [],
  );
  assert.deepEqual(envFlags, { WT_FOO_BAR: "baz" });
  assert.deepEqual(warnings, []);
  assert.deepEqual(branches, []);
});

test("parseEnvFlags: bare --skip-install → WT_SKIP_INSTALL=1", () => {
  const { envFlags } = parseEnvFlags(["--skip-install"], []);
  assert.deepEqual(envFlags, { WT_SKIP_INSTALL: "1" });
});

test("parseEnvFlags: bare flag followed by another flag → value=1", () => {
  const { envFlags } = parseEnvFlags(["--foo", "--bar", "val"], []);
  assert.deepEqual(envFlags, { WT_FOO: "1", WT_BAR: "val" });
});

test("parseEnvFlags: multiple flags with values", () => {
  const { envFlags } = parseEnvFlags(
    ["--api-key", "abc", "--region", "eu"],
    [],
  );
  assert.deepEqual(envFlags, { WT_API_KEY: "abc", WT_REGION: "eu" });
});

test("parseEnvFlags: positional args before flags become branches", () => {
  const { branches, envFlags } = parseEnvFlags(
    ["feat/foo", "feat/bar", "--skip-install"],
    [],
  );
  assert.deepEqual(branches, ["feat/foo", "feat/bar"]);
  assert.deepEqual(envFlags, { WT_SKIP_INSTALL: "1" });
});

test("parseEnvFlags: non-flag token after unknown flag consumed as its value", () => {
  const { envFlags, branches } = parseEnvFlags(
    ["--key", "val", "branch-name"],
    [],
  );
  assert.deepEqual(envFlags, { WT_KEY: "val" });
  assert.deepEqual(branches, ["branch-name"]);
});

test("parseEnvFlags: typo within Levenshtein ≤ 2 produces warning, still promotes", () => {
  const { envFlags, warnings } = parseEnvFlags(["--bsae", "main"], ["base"]);
  assert.deepEqual(envFlags, { WT_BSAE: "main" });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /--bsae/);
  assert.match(warnings[0], /--base/);
});

test("parseEnvFlags: typo distance > 2 produces no warning", () => {
  const { warnings } = parseEnvFlags(
    ["--completely-different", "val"],
    ["base"],
  );
  assert.deepEqual(warnings, []);
});

test("parseEnvFlags: known flags are not collected (pre-stripped scenario)", () => {
  const { envFlags } = parseEnvFlags(
    ["feat/foo"],
    ["base", "move", "keep", "copy"],
  );
  assert.deepEqual(envFlags, {});
});

// ── wt add env flags (integration) ───────────────────────────────────────────

test("wt add: --api-key abc → WT_API_KEY=abc in postCreate", () => {
  const { repo } = makeGitRepoWithOrigin();
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const wtBase = mkdtempSync(join(tmpdir(), "wt-base-"));
  writeFileSync(
    join(home, ".wt.json"),
    JSON.stringify({
      path: wtBase,
      postCreate: ['printf "%s" "$WT_API_KEY" > api_key.txt'],
    }),
  );

  const repoName = repo.split("/").pop();
  const expectedPath = join(wtBase, repoName ?? "", "feat-envflag");

  const { status, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "add", "feat/envflag", "--api-key", "abc"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );
  assert.equal(status, 0, `stderr: ${stderr.toString()}`);
  assert.equal(readFileSync(join(expectedPath, "api_key.txt"), "utf8"), "abc");
});

test("wt add: bare --skip-install → WT_SKIP_INSTALL=1 in postCreate", () => {
  const { repo } = makeGitRepoWithOrigin();
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const wtBase = mkdtempSync(join(tmpdir(), "wt-base-"));
  writeFileSync(
    join(home, ".wt.json"),
    JSON.stringify({
      path: wtBase,
      postCreate: ['printf "%s" "$WT_SKIP_INSTALL" > skip.txt'],
    }),
  );

  const repoName = repo.split("/").pop();
  const expectedPath = join(wtBase, repoName ?? "", "feat-skip");

  const { status, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "add", "feat/skip", "--skip-install"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );
  assert.equal(status, 0, `stderr: ${stderr.toString()}`);
  assert.equal(readFileSync(join(expectedPath, "skip.txt"), "utf8"), "1");
});

test("wt add: --bsae main prints did-you-mean warning to stderr", () => {
  const { repo } = makeGitRepoWithOrigin();
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const wtBase = mkdtempSync(join(tmpdir(), "wt-base-"));
  writeFileSync(join(home, ".wt.json"), JSON.stringify({ path: wtBase }));

  const { status, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "add", "feat/typo", "--bsae", "main"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );
  assert.equal(status, 0, `stderr: ${stderr.toString()}`);
  const errStr = stderr.toString();
  assert.match(errStr, /--bsae/);
  assert.match(errStr, /--base/);
});

test("wt add: --base main not promoted to WT_BASE env var", () => {
  const { repo } = makeGitRepoWithOrigin();
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const wtBase = mkdtempSync(join(tmpdir(), "wt-base-"));
  writeFileSync(
    join(home, ".wt.json"),
    JSON.stringify({
      path: wtBase,
      postCreate: ['printf "%s" "${WT_BASE:-EMPTY}" > base_check.txt'],
    }),
  );

  const repoName = repo.split("/").pop();
  const expectedPath = join(wtBase, repoName ?? "", "feat-nobase");

  const { status, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "add", "feat/nobase", "--base", "main"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );
  assert.equal(status, 0, `stderr: ${stderr.toString()}`);
  assert.equal(
    readFileSync(join(expectedPath, "base_check.txt"), "utf8"),
    "EMPTY",
  );
});

// ── buildRsyncArgs ────────────────────────────────────────────────────────────

test("buildRsyncArgs: acceptance criteria example", () => {
  const result = buildRsyncArgs([
    ".env**",
    "**/.env*",
    "**/.shopify/**",
    "!**/node_modules/**",
    "!**/.env.example",
  ]);
  assert.deepEqual(result, [
    "--exclude=.git",
    "--include=*/",
    "--exclude=**/node_modules/**",
    "--exclude=**/.env.example",
    "--include=.env**",
    "--include=**/.env*",
    "--include=**/.shopify/**",
    "--exclude=*",
  ]);
});

test("buildRsyncArgs: all positives", () => {
  const result = buildRsyncArgs([".env", "secrets.json"]);
  assert.deepEqual(result, [
    "--exclude=.git",
    "--include=*/",
    "--include=.env",
    "--include=secrets.json",
    "--exclude=*",
  ]);
});

test("buildRsyncArgs: all negatives", () => {
  const result = buildRsyncArgs(["!node_modules", "!dist"]);
  assert.deepEqual(result, [
    "--exclude=.git",
    "--include=*/",
    "--exclude=node_modules",
    "--exclude=dist",
    "--exclude=*",
  ]);
});

test("buildRsyncArgs: empty array", () => {
  const result = buildRsyncArgs([]);
  assert.deepEqual(result, ["--exclude=.git", "--include=*/", "--exclude=*"]);
});

test("buildRsyncArgs: single positive", () => {
  const result = buildRsyncArgs([".env"]);
  assert.deepEqual(result, [
    "--exclude=.git",
    "--include=*/",
    "--include=.env",
    "--exclude=*",
  ]);
});

test("buildRsyncArgs: preserves relative order within negatives", () => {
  const result = buildRsyncArgs(["!b", "!a"]);
  assert.equal(result[2], "--exclude=b");
  assert.equal(result[3], "--exclude=a");
});

test("buildRsyncArgs: preserves relative order within positives", () => {
  const result = buildRsyncArgs(["b", "a"]);
  assert.equal(result[2], "--include=b");
  assert.equal(result[3], "--include=a");
});

test("buildRsyncArgs: always excludes .git first", () => {
  assert.equal(buildRsyncArgs([])[0], "--exclude=.git");
  assert.equal(buildRsyncArgs([".env"])[0], "--exclude=.git");
  assert.equal(buildRsyncArgs(["!foo", "bar"])[0], "--exclude=.git");
});

// ── wt cp (CLI integration) ───────────────────────────────────────────────────

test("wt cp: missing WT_FROM exits 1 with clear error", () => {
  const { status, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "cp", ".env"],
    { env: { ...process.env, WT_FROM: undefined, WT_ROOT: "/tmp/somewhere" } },
  );
  assert.equal(status, 1);
  assert.match(stderr.toString(), /postCreate/);
});

test("wt cp: missing WT_ROOT exits 1 with clear error", () => {
  const { status, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "cp", ".env"],
    { env: { ...process.env, WT_FROM: "/tmp/somewhere", WT_ROOT: undefined } },
  );
  assert.equal(status, 1);
  assert.match(stderr.toString(), /postCreate/);
});

test("wt cp: both WT vars missing exits 1 with clear error", () => {
  const { status, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "cp", ".env"],
    { env: { ...process.env, WT_FROM: undefined, WT_ROOT: undefined } },
  );
  assert.equal(status, 1);
  assert.match(stderr.toString(), /postCreate/);
});

test("wt cp: integration — copies matching files from WT_FROM to WT_ROOT", () => {
  const src = mkdtempSync(join(tmpdir(), "wt-src-"));
  const dst = mkdtempSync(join(tmpdir(), "wt-dst-"));

  // create files in src: .env should be included, .env.example excluded, index.js excluded
  writeFileSync(join(src, ".env"), "SECRET=1");
  writeFileSync(join(src, ".env.example"), "SECRET=");
  writeFileSync(join(src, "index.js"), "console.log(1)");
  // place .env.example also in a subdirectory to test depth matching
  mkdirSync(join(src, "sub"));
  writeFileSync(join(src, "sub", ".env.example"), "SECRET=");

  const { status, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "cp", ".env*", "!.env.example", "!**/.env.example"],
    { env: { ...process.env, WT_FROM: src, WT_ROOT: dst } },
  );

  assert.equal(status, 0, `stderr: ${stderr.toString()}`);
  assert.ok(existsSync(join(dst, ".env")), ".env should be copied");
  assert.ok(
    !existsSync(join(dst, ".env.example")),
    ".env.example should be excluded at root",
  );
  assert.ok(
    !existsSync(join(dst, "sub", ".env.example")),
    ".env.example should be excluded in subdir",
  );
  assert.ok(
    !existsSync(join(dst, "index.js")),
    "index.js should not be copied",
  );
});

// ── wt rm (integration) ───────────────────────────────────────────────────────

/**
 * Create a git repo with a linked worktree at a known path.
 * Returns the repo path, the worktree path, and its branch name.
 * @param {{ dirty?: boolean }} [opts]
 * @returns {{ repo: string, wtPath: string, branch: string, home: string, wtBase: string }}
 */
function makeRepoWithLinkedWorktree(opts = {}) {
  const { repo } = makeGitRepo();
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const wtBase = mkdtempSync(join(tmpdir(), "wt-base-"));
  writeFileSync(join(home, ".wt.json"), JSON.stringify({ path: wtBase }));

  const branch = "feat/rm-test";
  spawnSync("git", ["-C", repo, "branch", branch]);
  const wtPath = join(wtBase, repo.split("/").pop() ?? "", "feat/rm-test");
  mkdirSync(dirname(wtPath), { recursive: true });
  spawnSync("git", ["-C", repo, "worktree", "add", wtPath, branch]);

  if (opts.dirty) {
    writeFileSync(join(wtPath, "dirty.txt"), "change");
  }

  return { repo, wtPath, branch, home, wtBase };
}

test("wt remove: removes a clean linked worktree", () => {
  const { repo, wtPath, home } = makeRepoWithLinkedWorktree();

  const { status, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "remove", "feat/rm-test"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );

  assert.equal(status, 0, `stderr: ${stderr.toString()}`);
  assert.ok(!existsSync(wtPath), "worktree directory should be gone");
});

test("wt remove: dirty worktree exits 1 and leaves worktree intact", () => {
  const { repo, wtPath, home } = makeRepoWithLinkedWorktree({ dirty: true });

  const { status, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "remove", "feat/rm-test"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );

  assert.equal(status, 1, `stderr: ${stderr.toString()}`);
  assert.match(stderr.toString(), /^✗/m);
  assert.ok(existsSync(wtPath), "worktree should still exist");
});

test("wt remove --force: dirty worktree is removed", () => {
  const { repo, wtPath, home } = makeRepoWithLinkedWorktree({ dirty: true });

  const { status, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "remove", "--force", "feat/rm-test"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );

  assert.equal(status, 0, `stderr: ${stderr.toString()}`);
  assert.ok(!existsSync(wtPath), "worktree should be gone");
});

test("wt remove: attempting to remove main worktree errors with clear message, exits 1", () => {
  const { repo } = makeGitRepo();
  const home = mkdtempSync(join(tmpdir(), "wt-"));

  const { status, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "remove", "main"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );

  assert.equal(status, 1);
  assert.match(stderr.toString(), /^✗/m);
  assert.match(stderr.toString(), /main worktree/i);
});

test("wt remove: unknown branch name exits 1 with error", () => {
  const { repo } = makeGitRepo();
  const home = mkdtempSync(join(tmpdir(), "wt-"));

  const { status, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "remove", "does-not-exist"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );

  assert.equal(status, 1);
  assert.match(stderr.toString(), /^✗/m);
});

test("wt remove -d: removes worktree and safe-deletes merged branch", () => {
  const { repo } = makeGitRepoWithOrigin();
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const wtBase = mkdtempSync(join(tmpdir(), "wt-base-"));
  writeFileSync(join(home, ".wt.json"), JSON.stringify({ path: wtBase }));

  // Create and push a branch so it's "merged" (origin/main is its ancestor)
  const branch = "feat/to-delete";
  spawnSync("git", ["-C", repo, "branch", branch]);
  const wtPath = join(wtBase, repo.split("/").pop() ?? "", "feat/to-delete");
  mkdirSync(dirname(wtPath), { recursive: true });
  spawnSync("git", ["-C", repo, "worktree", "add", wtPath, branch]);

  const { status, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "remove", "-d", "feat/to-delete"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );

  assert.equal(status, 0, `stderr: ${stderr.toString()}`);
  assert.ok(!existsSync(wtPath), "worktree should be gone");

  // branch should also be deleted
  const { status: branchStatus } = spawnSync(
    "git",
    ["-C", repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    { stdio: "ignore" },
  );
  assert.notEqual(branchStatus, 0, "branch should have been deleted");
});

test("wt remove -D: removes worktree and force-deletes unmerged branch", () => {
  const { repo } = makeGitRepoWithOrigin();
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const wtBase = mkdtempSync(join(tmpdir(), "wt-base-"));
  writeFileSync(join(home, ".wt.json"), JSON.stringify({ path: wtBase }));

  const branch = "feat/unmerged";
  spawnSync("git", ["-C", repo, "branch", branch]);
  const wtPath = join(wtBase, repo.split("/").pop() ?? "", "feat/unmerged");
  mkdirSync(dirname(wtPath), { recursive: true });
  spawnSync("git", ["-C", repo, "worktree", "add", wtPath, branch]);

  // Add a commit so branch is unmerged
  writeFileSync(join(wtPath, "newfile.txt"), "content");
  spawnSync("git", ["-C", wtPath, "add", "newfile.txt"]);
  spawnSync("git", ["-C", wtPath, "commit", "-m", "unmerged commit"]);

  const { status, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "remove", "-D", "feat/unmerged"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );

  assert.equal(status, 0, `stderr: ${stderr.toString()}`);
  assert.ok(!existsSync(wtPath), "worktree should be gone");

  const { status: branchStatus } = spawnSync(
    "git",
    ["-C", repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    { stdio: "ignore" },
  );
  assert.notEqual(branchStatus, 0, "branch should have been force-deleted");
});

test("wt remove -D: implies --force for dirty worktree", () => {
  const { repo, wtPath, branch, home } = makeRepoWithLinkedWorktree({
    dirty: true,
  });

  // Add a commit to make it unmerged
  spawnSync("git", ["-C", wtPath, "add", "."]);
  spawnSync("git", ["-C", wtPath, "commit", "-m", "dirty commit"]);

  const { status, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "remove", "-D", "feat/rm-test"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );

  assert.equal(status, 0, `stderr: ${stderr.toString()}`);
  assert.ok(!existsSync(wtPath));
});

test("wt remove: multi-target removes all when all clean", () => {
  const { repo } = makeGitRepo();
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const wtBase = mkdtempSync(join(tmpdir(), "wt-base-"));
  writeFileSync(join(home, ".wt.json"), JSON.stringify({ path: wtBase }));

  const repoName = repo.split("/").pop() ?? "";
  const paths = ["feat-a", "feat-b", "feat-c"].map((slug) => {
    const branch = slug;
    const wtPath = join(wtBase, repoName, slug);
    mkdirSync(dirname(wtPath), { recursive: true });
    spawnSync("git", ["-C", repo, "branch", branch]);
    spawnSync("git", ["-C", repo, "worktree", "add", wtPath, branch]);
    return wtPath;
  });

  const { status, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "remove", "feat-a", "feat-b", "feat-c"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );

  assert.equal(status, 0, `stderr: ${stderr.toString()}`);
  for (const p of paths) {
    assert.ok(!existsSync(p), `${p} should be removed`);
  }
});

test("wt remove: multi-target stops on failure, keeps prior removals", () => {
  const { repo } = makeGitRepo();
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const wtBase = mkdtempSync(join(tmpdir(), "wt-base-"));
  writeFileSync(join(home, ".wt.json"), JSON.stringify({ path: wtBase }));

  const repoName = repo.split("/").pop() ?? "";

  // feat-first: clean
  const firstPath = join(wtBase, repoName, "feat-first");
  mkdirSync(dirname(firstPath), { recursive: true });
  spawnSync("git", ["-C", repo, "branch", "feat-first"]);
  spawnSync("git", ["-C", repo, "worktree", "add", firstPath, "feat-first"]);

  // feat-dirty: dirty (will fail without --force)
  const dirtyPath = join(wtBase, repoName, "feat-dirty");
  mkdirSync(dirname(dirtyPath), { recursive: true });
  spawnSync("git", ["-C", repo, "branch", "feat-dirty"]);
  spawnSync("git", ["-C", repo, "worktree", "add", dirtyPath, "feat-dirty"]);
  writeFileSync(join(dirtyPath, "dirty.txt"), "change");

  // feat-third: clean (should not be attempted)
  const thirdPath = join(wtBase, repoName, "feat-third");
  mkdirSync(dirname(thirdPath), { recursive: true });
  spawnSync("git", ["-C", repo, "branch", "feat-third"]);
  spawnSync("git", ["-C", repo, "worktree", "add", thirdPath, "feat-third"]);

  const { status } = spawnSync(
    process.execPath,
    [SCRIPT, "remove", "feat-first", "feat-dirty", "feat-third"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );

  assert.notEqual(status, 0, "should exit non-zero on failure");
  assert.ok(
    !existsSync(firstPath),
    "feat-first was already removed before failure",
  );
  assert.ok(
    existsSync(dirtyPath),
    "feat-dirty should still exist (removal failed)",
  );
  assert.ok(existsSync(thirdPath), "feat-third should not have been attempted");
});

// ── issue-14: drop slug from UX ───────────────────────────────────────────────

test("wt list: non-TTY output has two tab-separated columns (branch, path)", () => {
  const { repo } = makeGitRepo();
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const { status, stdout } = spawnSync(process.execPath, [SCRIPT, "list"], {
    cwd: repo,
    env: { ...process.env, HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(status, 0);
  const lines = stdout.toString().trim().split("\n");
  assert.equal(lines.length, 1);
  const fields = lines[0].split("\t");
  assert.equal(
    fields.length,
    2,
    `expected 2 tab-separated fields, got: ${lines[0]}`,
  );
});

test("wt remove: looks up by branch name (with slash)", () => {
  const { repo, wtPath, home } = makeRepoWithLinkedWorktree();

  const { status, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "remove", "feat/rm-test"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );

  assert.equal(status, 0, `stderr: ${stderr.toString()}`);
  assert.ok(!existsSync(wtPath), "worktree directory should be gone");
});

test("wt remove: unknown branch prints 'no worktree for branch:' error", () => {
  const { repo } = makeGitRepo();
  const home = mkdtempSync(join(tmpdir(), "wt-"));

  const { status, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "remove", "does-not-exist"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );

  assert.equal(status, 1);
  assert.match(stderr.toString(), /No worktree for branch: does-not-exist/i);
});

test("wt remove --help: contains no occurrence of 'slug'", () => {
  const { status, stderr } = spawnSync(process.execPath, [
    SCRIPT,
    "remove",
    "--help",
  ]);
  assert.equal(status, 0);
  assert.ok(
    !stderr.toString().includes("slug"),
    "remove --help should not mention 'slug'",
  );
});

// ── issue-16: wt rm confirmation output ──────────────────────────────────────

test("wt remove: emits success confirmation with branch on stderr", () => {
  const { repo, branch, home } = makeRepoWithLinkedWorktree();

  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "remove", branch],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );

  assert.equal(status, 0, `stderr: ${stderr.toString()}`);
  assert.equal(stdout.toString(), "", "stdout must be empty");
  assert.match(stderr.toString(), /✓ Removed feat\/rm-test/);
});

test("wt remove -d: emits 'and deleted branch' when branch deletion succeeds", () => {
  const { repo } = makeGitRepoWithOrigin();
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const wtBase = mkdtempSync(join(tmpdir(), "wt-base-"));
  writeFileSync(join(home, ".wt.json"), JSON.stringify({ path: wtBase }));

  const branch = "feat/to-delete-16";
  spawnSync("git", ["-C", repo, "branch", branch]);
  const wtPath = join(wtBase, repo.split("/").pop() ?? "", "feat-to-delete-16");
  mkdirSync(dirname(wtPath), { recursive: true });
  spawnSync("git", ["-C", repo, "worktree", "add", wtPath, branch]);

  const { status, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "remove", "-d", branch],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );

  assert.equal(status, 0, `stderr: ${stderr.toString()}`);
  assert.match(stderr.toString(), /and deleted branch/);
});

test("wt remove a b c: emits one confirmation line per removed worktree", () => {
  const { repo } = makeGitRepo();
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const wtBase = mkdtempSync(join(tmpdir(), "wt-base-"));
  writeFileSync(join(home, ".wt.json"), JSON.stringify({ path: wtBase }));

  const repoName = repo.split("/").pop() ?? "";
  for (const b of ["feat-x", "feat-y", "feat-z"]) {
    const p = join(wtBase, repoName, b);
    mkdirSync(dirname(p), { recursive: true });
    spawnSync("git", ["-C", repo, "branch", b]);
    spawnSync("git", ["-C", repo, "worktree", "add", p, b]);
  }

  const { status, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "remove", "feat-x", "feat-y", "feat-z"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );

  assert.equal(status, 0, `stderr: ${stderr.toString()}`);
  const confirmLines = stderr
    .toString()
    .split("\n")
    .filter((l) => l.startsWith("✓ Removed "));
  assert.equal(confirmLines.length, 3, "should have 3 confirmation lines");
});

// ── issue-18: color in wt list ────────────────────────────────────────────────

test("wt list: non-TTY without FORCE_COLOR emits no ANSI codes", () => {
  const { repo } = makeGitRepo();
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const { status, stdout } = spawnSync(process.execPath, [SCRIPT, "list"], {
    cwd: repo,
    env: {
      ...process.env,
      HOME: home,
      FORCE_COLOR: undefined,
      NO_COLOR: undefined,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(status, 0);
  assert.ok(!/\x1b/.test(stdout.toString()), "no ANSI codes in non-TTY output");
});

test("wt list: FORCE_COLOR=1 emits ANSI green for the main worktree row", () => {
  const { repo } = makeGitRepo();
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const { status, stdout } = spawnSync(process.execPath, [SCRIPT, "list"], {
    cwd: repo,
    env: { ...process.env, HOME: home, FORCE_COLOR: "1", NO_COLOR: undefined },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(status, 0);
  assert.ok(/\x1b\[32m/.test(stdout.toString()), "should contain green escape");
});

test("wt list: current non-main worktree row has no color (only the marker distinguishes it)", () => {
  const { repo, home, entries } = makeRepoWithMultipleWorktrees(1);
  const { status, stdout } = spawnSync(process.execPath, [SCRIPT, "list"], {
    cwd: entries[0].wtPath,
    env: { ...process.env, HOME: home, FORCE_COLOR: "1", NO_COLOR: undefined },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(status, 0);
  const out = stdout.toString();
  const lines = out.split("\n");
  const currentLine = lines.find((l) => l.includes(entries[0].branch)) ?? "";
  assert.ok(!/\x1b\[32m/.test(currentLine), "current row should not be green");
  assert.ok(!/\x1b\[1m/.test(currentLine), "current row should not be bold");
});

test("wt list: decorated output marks the current row with '* ' and others with '  '", () => {
  const { repo, home, entries } = makeRepoWithMultipleWorktrees(1);
  const { status, stdout } = spawnSync(process.execPath, [SCRIPT, "list"], {
    cwd: entries[0].wtPath,
    env: { ...process.env, HOME: home, FORCE_COLOR: "1", NO_COLOR: undefined },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(status, 0);
  const stripAnsi = (/** @type {string} */ s) =>
    s.replace(/\x1b\[[0-9;]*m/g, "");
  const lines = stdout.toString().split("\n").filter(Boolean).map(stripAnsi);
  const currentLine = lines.find((l) => l.includes(entries[0].branch)) ?? "";
  const mainLine = lines.find((l) => /\bmain\b/.test(l)) ?? "";
  assert.ok(
    currentLine.startsWith("* "),
    `current row should start with '* ', got: ${JSON.stringify(currentLine)}`,
  );
  assert.ok(
    mainLine.startsWith("  "),
    `non-current row should start with '  ', got: ${JSON.stringify(mainLine)}`,
  );
});

test("wt list: non-TTY output has no leading marker (preserves branch\\tpath contract)", () => {
  const { repo, home } = makeRepoWithMultipleWorktrees(1);
  const { status, stdout } = spawnSync(process.execPath, [SCRIPT, "list"], {
    cwd: repo,
    env: {
      ...process.env,
      HOME: home,
      FORCE_COLOR: undefined,
      NO_COLOR: undefined,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(status, 0);
  const lines = stdout.toString().split("\n").filter(Boolean);
  for (const line of lines) {
    assert.ok(
      !line.startsWith("* ") && !line.startsWith("  "),
      `non-TTY row must not have a marker prefix: ${JSON.stringify(line)}`,
    );
    assert.ok(line.includes("\t"), "non-TTY row must be tab-separated");
  }
});

test("wt list: NO_COLOR=1 overrides FORCE_COLOR, emits no ANSI codes", () => {
  const { repo } = makeGitRepo();
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const { status, stdout } = spawnSync(process.execPath, [SCRIPT, "list"], {
    cwd: repo,
    env: { ...process.env, HOME: home, FORCE_COLOR: "1", NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(status, 0);
  assert.ok(!/\x1b/.test(stdout.toString()), "NO_COLOR should suppress ANSI");
});

test("wt list --json: output has no ANSI codes even with FORCE_COLOR=1", () => {
  const { repo } = makeGitRepo();
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const { status, stdout } = spawnSync(
    process.execPath,
    [SCRIPT, "list", "--json"],
    {
      cwd: repo,
      env: {
        ...process.env,
        HOME: home,
        FORCE_COLOR: "1",
        NO_COLOR: undefined,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  assert.equal(status, 0);
  assert.ok(!/\x1b/.test(stdout.toString()), "JSON output must be ANSI-free");
  JSON.parse(stdout.toString()); // must still be valid JSON
});

// ── wt rm --all (#19) ─────────────────────────────────────────────────────────

/** Create a repo with N clean linked worktrees, returns paths and branch names. */
function makeRepoWithMultipleWorktrees(count = 2) {
  const { repo } = makeGitRepo();
  const home = mkdtempSync(join(tmpdir(), "wt-"));
  const wtBase = mkdtempSync(join(tmpdir(), "wt-base-"));
  writeFileSync(join(home, ".wt.json"), JSON.stringify({ path: wtBase }));
  const repoName = repo.split("/").pop() ?? "";
  const entries = Array.from({ length: count }, (_, i) => {
    const branch = `feat-${i + 1}`;
    const wtPath = join(wtBase, repoName, branch);
    mkdirSync(dirname(wtPath), { recursive: true });
    spawnSync("git", ["-C", repo, "branch", branch]);
    spawnSync("git", ["-C", repo, "worktree", "add", wtPath, branch]);
    return { branch, wtPath };
  });
  return { repo, home, entries };
}

test("wt remove --all: empty state prints message and exits 0", () => {
  const { repo } = makeGitRepo();
  const home = mkdtempSync(join(tmpdir(), "wt-"));

  const { status, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "remove", "--all"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );

  assert.equal(status, 0, `stderr: ${stderr.toString()}`);
  assert.match(stderr.toString(), /No worktrees to remove/);
});

test("wt remove --all: clean tree removes without --force or prompt", () => {
  const { repo, home, entries } = makeRepoWithMultipleWorktrees(2);

  const { status, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "remove", "--all"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );

  assert.equal(status, 0, `stderr: ${stderr.toString()}`);
  for (const { wtPath } of entries) {
    assert.ok(!existsSync(wtPath), `${wtPath} should be removed`);
  }
  assert.doesNotMatch(stderr.toString(), /\?/, "must not prompt");
});

test("wt remove --all --force: removes all non-main worktrees, leaves main intact", () => {
  const { repo, home, entries } = makeRepoWithMultipleWorktrees(2);

  const { status, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "remove", "--all", "--force"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );

  assert.equal(status, 0, `stderr: ${stderr.toString()}`);
  for (const { wtPath } of entries) {
    assert.ok(!existsSync(wtPath), `${wtPath} should be removed`);
  }
  assert.ok(existsSync(repo), "main worktree must remain");
  assert.match(stderr.toString(), /✓ Removed/);
});

test("wt remove --all: dirty worktree without --force prints per-worktree errors, removes nothing", () => {
  const { repo, home, entries } = makeRepoWithMultipleWorktrees(2);
  const [clean, dirty] = entries;
  writeFileSync(join(dirty.wtPath, "dirty.txt"), "change");

  const { status, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "remove", "--all"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );

  assert.equal(status, 1);
  assert.match(stderr.toString(), /uncommitted changes/);
  assert.ok(existsSync(clean.wtPath), "clean worktree must not be removed");
  assert.ok(existsSync(dirty.wtPath), "dirty worktree must not be removed");
});

test("wt remove --all --force: removes dirty worktrees", () => {
  const { repo, home, entries } = makeRepoWithMultipleWorktrees(1);
  writeFileSync(join(entries[0].wtPath, "dirty.txt"), "change");

  const { status, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "remove", "--all", "--force"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );

  assert.equal(status, 0, `stderr: ${stderr.toString()}`);
  assert.ok(
    !existsSync(entries[0].wtPath),
    "dirty worktree should be removed with --force",
  );
});

test("wt remove --all -D: removes and force-deletes all non-main branches", () => {
  const { repo, home, entries } = makeRepoWithMultipleWorktrees(2);
  for (const { wtPath, branch } of entries) {
    writeFileSync(join(wtPath, "file.txt"), branch);
    spawnSync("git", ["-C", wtPath, "add", "."]);
    spawnSync("git", ["-C", wtPath, "commit", "-m", `${branch} commit`]);
  }

  const { status, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "remove", "--all", "-D"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );

  assert.equal(status, 0, `stderr: ${stderr.toString()}`);
  for (const { branch } of entries) {
    const { status: branchStatus } = spawnSync(
      "git",
      ["-C", repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { stdio: "ignore" },
    );
    assert.notEqual(
      branchStatus,
      0,
      `branch ${branch} should have been deleted`,
    );
  }
});

test("wt remove --all combined with branch names errors", () => {
  const { repo } = makeGitRepo();
  const home = mkdtempSync(join(tmpdir(), "wt-"));

  const { status, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, "remove", "--all", "feat-x"],
    { cwd: repo, env: { ...process.env, HOME: home } },
  );

  assert.equal(status, 1);
  assert.match(stderr.toString(), /--all/);
});

test("wt remove: no branches argument prints usage and exits 1", () => {
  const { status, stderr } = spawnSync(process.execPath, [SCRIPT, "remove"]);
  assert.equal(status, 1);
  assert.match(stderr.toString(), /Usage/);
});
