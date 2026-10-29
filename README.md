# agent-tools

Small personal add-ons for coding agents.

- `claude-code/` — Claude Code statusline and mods
- `pi/` — Pi extensions

# Claude Code

## claude-code/statusline/ (the taskbar)

![statusline](docs/statusline.png)

`taskbar-statusline.py` is a `statusLine` command: cwd, context bar, model, git branch, PR link, session cost and 5h/7d rate limits.

```json
"statusLine": { "type": "command", "command": "python3 ~/.claude/taskbar-statusline.py" }
```
Copy the script to `~/.claude/` and add the setting above to `~/.claude/settings.json`.

## claude-code/mods/file-pane (the side pane)
A Claude Code mod that opens a right-hand pane Claude can put things in: files with pinned lines, git diffs, navigable directories, images, markdown, code and mermaid diagrams. Claude uses the `show` tool; you can use `/show`.

Install: copy `claude-code/mods/file-pane` into `~/.claude/mods/` and start Claude Code with
`CLAUDE_CODE_PLUGIN_DIRS=~/.claude/mods/file-pane`.

Notes
- Mermaid needs `npm i -g @mermaid-js/mermaid-cli`.
- Over SSH or in terminals that don't answer the graphics probe, set `CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1`.
- JSX compiles to a global `h(...)`, so never name a variable `h` in a function that renders JSX.

# Pi (`pi/extensions/`)
Copy into `~/.pi/agent/extensions/`.
- `taskbar.ts` — footer with cwd, tokens, cost, context meter, model and branch. `/cost-toggle` shows or hides it; `/pwd [dir]` shows or changes the working directory.
- `prompt-editor.ts` — dimmed `>` prompt in the empty editor.
