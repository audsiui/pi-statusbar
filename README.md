# @audsiui/pi-statusbar

A [Pi](https://github.com/earendil-works/pi) extension that replaces the default startup screen, editor chrome, and footer with a denser, single-line layout.

## What it changes

**Startup screen** — silences Pi's built-in verbose header (logo + keybinding hints) and re-renders the built-in `[Skills] / [Prompts] / [Extensions]` lists as a single grouped card with a 2-row overflow guard (`+N more`). The chat body (tool calls, thinking) is left to Pi's native rendering.

**Editor** — wraps the input box in rounded borders (`╭─╮` / `╰─╯`). The top border shows the current model, reasoning level (when on), the running tool name (`[read]`, `[edit]`, `[bash]`, …), and the latest turn's throughput (`52.4 tok/s`). The built-in `working…` row is hidden to avoid a duplicate spinner.

**Footer** — collapses the status bar to one line.

- Left: cwd (with `~`), git branch, staged/modified counts (`+N` green, `~N` yellow), session name.
- Right (anchored): context-usage bar (`▰▰▰▱▱▱ 48.2%/200k`), cost, cache read/write + hit rate, tokens in/out, extension statuses.
- Drops auxiliary metrics from the left when the terminal is too narrow, so the context bar and key info never wrap.

## Screenshot

```text
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
├── index.ts          # lifecycle hooks, wires the three components
├── header.ts         # silent header + startup resource card re-render
├── editor.ts         # rounded editor with model/tool/tps border
├── footer.ts         # single-line status bar
└── utils/
    ├── git.ts        # async git status polling (non-blocking)
    ├── tokens.ts     # cached token + cost aggregation
    └── format.ts     # border layout, token formatting, package-name cleanup
```

## Implementation notes

- Only the context-usage bar and git counts carry semantic color; everything else is dim/muted.
- Git status is polled in the background (`GIT_OPTIONAL_LOCKS=0`); token usage is cached. Neither blocks the input or render loop.
- The chat body (tool calls, thinking blocks) is never touched — Pi's native `ToolExecutionComponent` renders it, so `Ctrl+O` expansion and all tool renderers keep working unchanged.
- Only uses Pi's public surface (`ExtensionAPI`, `sessionManager`, `theme`, `footerData`).

## License

MIT © [audsiui](https://github.com/audsiui)