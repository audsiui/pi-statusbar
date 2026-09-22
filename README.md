# @audsiui/pi-statusbar

A [Pi](https://github.com/earendil-works/pi) extension that replaces the default startup screen, editor chrome, footer, and tool output with a denser, single-line layout.

## What it changes

**Startup screen** — shows a one-line `π · ~/path (git:branch)` header, and re-renders the built-in `[Skills] / [Prompts] / [Extensions]` lists as a single grouped card with a 2-row overflow guard (`+N more`).

**Editor** — wraps the input box in rounded borders (`╭─╮` / `╰─╯`). The top border shows the current model, reasoning level (when on), the running tool name (`[read]`, `[edit]`, `[bash]`, …), and the latest turn's throughput (`52.4 tok/s`). The built-in `working…` row is hidden to avoid a duplicate spinner.

**Footer** — collapses the status bar to one line.

- Left: cwd (with `~`), git branch, staged/modified counts (`+N` green, `~N` yellow), session name.
- Right (anchored): context-usage bar (`▰▰▰▱▱▱ 48.2%/200k`), cost, cache read/write + hit rate, tokens in/out, extension statuses.
- Drops auxiliary metrics from the left when the terminal is too narrow, so the context bar and key info never wrap.

**Tool output** — replaces the multi-line box that Pi draws for every tool execution (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, plus any third-party tool) with a single full-width band: a colored gutter (`▎`) and state glyph (`✓` / `✖` / spinner) on the left, the tool name plus its target argument, and right-aligned metadata (`+12 -3 · 0.3s` for diffs, `7,166 chars · 0.1s` otherwise). The band reuses Pi's own semantic backgrounds (`toolPendingBg` / `toolSuccessBg` / `toolErrorBg`), so running / success / error stay readable at a glance, and a `ctrl+o` hint appears while there is hidden output. Press `Ctrl+O` to expand; expanded bodies are wrapped with a thin side rail so they don't blend into chat text.

## Screenshot

```text
  π · ~/workspace/pi-extend (git:main)

  ╭─ Extensions (8) ────────────────────────────────────────────────────────────╮
  │  • pi-keenable   • rpiv-ask-user   • rpiv-todo   • pi-goal                   │
  ├─ Skills (4) ────────────────────────────────────────────────────────────────┤
  │  • codegraph   • council-mode   • keenable-web-search   • pi-subagents       │
  ├─ Prompts (6) ───────────────────────────────────────────────────────────────┤
  │  • /council   • /parallel-research   • /review-loop   • +3 more             │
  ╰──────────────────────────────────────────────────────────────────────────────╯

╭─ [ ● claude-3-7-sonnet • high ] ─────────────────────── [ 52.4 tok/s ] ──╮
│ Ask me anything or type / for commands...                                  │
╰────────────────────────────────────────────────────────── [ ↵ Send ] ──╯
~/workspace/pi ⎇ main +2 ~5    $0.123 · ⚡85% · ↑12k ↓3k · ▰▰▰▱▱▱ 48.2%/200k

▎ ✓ read  extensions/tools.ts              7,166 chars · 0.1s  ctrl+o
▎ ⠋ bash  pnpm test                                    running…
▎ ✖ bash  pnpm test · Command exited with code 1   103 chars · 2.4s
▎ ✓ edit  extensions/editor.ts                +12 -3 · 0.3s  ctrl+o
```

## Install

```bash
# from npm
pi install npm:@audsiui/pi-statusbar

# from GitHub
pi install git:github.com/audsiui/pi-statusbar

# try without saving config
pi -e npm:@audsiui/pi-statusbar
```

## Uninstall

```bash
pi remove @audsiui/pi-statusbar
```

## Layout

```text
extensions/
├── index.ts          # lifecycle hooks, wires the four components
├── header.ts         # startup header + resource card re-render
├── editor.ts         # rounded editor with model/tool/tps border
├── footer.ts         # single-line status bar
├── tools.ts          # universal single-line tool output hook
└── utils/
    ├── git.ts        # async git status polling (non-blocking)
    ├── tokens.ts     # cached token + cost aggregation
    └── format.ts     # border layout, token formatting, package-name cleanup
```

## Implementation notes

- Only the context-usage bar and git counts carry semantic color; everything else is dim/muted.
- Git status is polled in the background (`GIT_OPTIONAL_LOCKS=0`); token usage is cached. Neither blocks the input or render loop.
- The tool hook covers tools Pi ships with plus any third-party tool that follows the same `toolName` / `render` / `addChild` contract.
- The tool band reuses Pi's own `toolPendingBg` / `toolSuccessBg` / `toolErrorBg`, so the collapsed line keeps the semantic coloring of the native box while staying one row tall. Metadata degrades gracefully (hint → duration → body) instead of being sliced mid-word on narrow terminals.
- Only uses Pi's public surface (`ExtensionAPI`, `sessionManager`, `theme`, `footerData`).

## License

MIT © [audsiui](https://github.com/audsiui)