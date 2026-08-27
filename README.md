# @audsiui/pi-statusbar

终端极简美学全套套件 —— **极客仪表盘 Header + 模型边框输入框 + 极致单行状态栏**。

彻底重塑终端交互体验：启动一秒拉满极客仪式感；模型身份与思考状态移至输入框顶部边框；底部释放为纯净优雅的单行遥测栏，为代码展示多省出垂直空间。

```text
  ┌─┐┬  
  ├─┘│  π coding agent · v0.84.3
  ┴  ┴  ~/workspace/pi-extend (git:main)

  [ / ] 指令菜单    [ ! ] 运行终端    [Alt+M] 切换模型    [Ctrl+P] 命令面板

  ┌─ 🧩 扩展组件 (8) ──────────────────────────────────────────────────────────┐
  │  • statusbar       • pi-keenable   • pi-codegraph    • pi-subagents        │
  │  • rpiv-todo       • pi-plan-mode  • pi-goal         • rpiv-ask-user       │
  ├─ ⚡ 技能 (4) ──────────────────────┬─ 💬 快捷模版 (6) ─────────────────────┤
  │  • keenable-search • codegraph     │  • /council       • /review-loop      │
  │  • council-mode    • pi-subagents  │  • /cleanup       • /research         │
  └────────────────────────────────────┴───────────────────────────────────────┘

╭─ [ ● claude-3-7-sonnet • high ] ─────────────────────────────────────────────╮
│ Ask me anything or type / for commands...                                    │
╰──────────────────────────────────────────────────────────────── [ ↵ Send ] ──╯
~/workspace/pi ⎇ main +2 ~5        ▰▰▰▱▱▱ 48.2%/200k · $0.123 · ⚡85% · ↑12k ↓3k
```

### 三位一体核心功能

1. **极客仪表盘 Header (`header.ts`)**：
   - **智能包名洗净**：过滤冗余的 `@scope/`、`:dist`、`:file.ts`，整齐美观。
   - **2 行阈值保护**：每个卡片区域无论装多少插件，最多只占 2 行，超出自动收敛为 `+X 更多`，绝不垂直膨胀。
   - **屏幕高度自适应**：分屏矮窗口（<26 行）自动切换微型胶囊模式，全屏大窗口展开完整网格。
2. **模型边框输入框 (`editor.ts`)**：
   - 模型身份（`●` 运行 / `○` 待命）与思考等级直接内嵌在顶边框。
   - **实时工具执行感知**：模型读写文件或运行命令时，顶边框实时显示 `[read]` / `[edit]` / `[bash]`。
   - **独占动态反馈**：隐藏内置重复的 `working...` 行，消除双重 Spinner 冲突。
3. **极致单行状态栏 (`footer.ts`)**：
   - 彻底将底部压缩为 1 行，屏幕有效阅读高度增加。
   - 左侧环境（路径、Git 分支、`+绿 ~黄` 变更计数、会话名）。
   - 右侧遥测（分段着色仪表、费用、缓存节省、Token 吞吐）。
   - 响应式抗压：窄屏按优先级逐步丢弃辅助指标，永远不折行。

### 模块化项目结构

```text
extensions/
├── index.ts               # 主入口：生命周期与组件组装
├── header.ts              # 迎宾仪表盘组件
├── editor.ts              # 圆角模型边框输入框组件
├── footer.ts              # 单行状态栏组件
└── utils/
    ├── git.ts             # 极速 Git 检查与并发锁
    ├── tokens.ts          # O(1) 缓存用量统计
    └── format.ts          # 边框绘制、格式化与包名洗净
```

## 安装

### 方式 1：通过 npm 安装（推荐）

```bash
pi install npm:@audsiui/pi-statusbar
```

### 方式 2：通过 GitHub 安装

```bash
pi install git:github.com/audsiui/pi-statusbar@v1.3.0
```

临时试用（仅当前会话有效，不写入全局 settings）：

```bash
# npm 试用
pi -e npm:@audsiui/pi-statusbar

# 本地目录试用
pi -e /path/to/pi-statusbar
```

## 卸载

```bash
pi remove @audsiui/pi-statusbar
```

## 说明

- 颜色纪律：语义色只用于"有行动含义"的地方——上下文仪表（渐变）和 git 变更状态（+绿 ~黄）；其余一律 dim 保持安静。
- 分支名与模型用 accent 色，是身份锚点。
- 上下文阈值取社区实测的行动阈值：≥50% 黄（开始清理/压缩）、≥80% 红（准备开新会话），而非内置的被动阈值。
- git 状态异步拉取 + 缓存（`GIT_OPTIONAL_LOCKS=0`），渲染永不阻塞。
- 全部使用官方公共 API（`ExtensionAPI` / `sessionManager` / `footerData` / `theme`），统计口径与内置 footer 一致。
- 依赖的 `@earendil-works/pi-*` 由 pi 核心打包，无需单独安装。