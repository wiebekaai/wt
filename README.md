# wt

Manage worktrees.

## Install

```sh
pnpm add -g github:wiebekaai/wt
```

## Usage

- `wt init` — create `.wt.json` config file
- `wt list` — list worktrees
- `wt add <branch…>` — create worktree(s)
- `wt remove <branch…>` — remove worktree(s) (`-d`/`-D` to delete the branch too)
- `wt cp <glob…>` — rsync-backed file copy, for use inside `postCreate`

Run `wt <command> --help` for flags and examples.

## Config

`wt` reads `~/.wt.json` (your defaults) merged with `<repo-root>/.wt.json` (project, committed).

```jsonc
{
  // Where worktrees are stored. Default: ~/.worktrees/<repo>/<slug>
  "path": "~/.worktrees",

  // Shell commands to run inside each new worktree after creation.
  //
  // Available environment variables:
  //  - $WT_ROOT    path to the new worktree (also the cwd)
  //  - $WT_FROM    path to the source worktree
  //  - $WT_BRANCH  branch name of the new worktree
  //  - $WT_<KEY>   for any --key value passed to `wt add`
  "postCreate": [
    // Install dependencies
    "pnpm install",
    // Copy .env files
    "wt cp '.env*' '!**/.env.example' '!**/node_modules/**'",
  ],
}
```
