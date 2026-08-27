# pi-statusbar

替换 pi 内置 footer 的状态栏扩展，按现代终端设计理念（Claude Code statusline / claude-stat / Calm Tech / Starship）构建：

```
▰▱▱▱ 48.2%/200k · ↑126 ↓131 · ⇣24k ⚡58.3% · $0.123      ● model • medium
~/workspace/pi ⎇ main +2 ~5 • 会话名 · [扩展状态]
```

- 第 1 行（仪表，变化频率最高）：上下文占用（渐变绿→黄→红，行动阈值 50%/80%）、输入/输出 token、缓存读/写、缓存命中率、成本。
- 第 2 行（环境，低频信息）：工作目录（~ 缩写）、git 分支（accent）、暂存/修改计数（+绿 ~黄）、会话名、扩展状态（`ctx.ui.setStatus`）。
- 右侧：模型身份（accent 加粗，● 工作中 / ○ 待命）+ 思考级别（官方 thinking* 色阶，灰→蓝→紫→品红表达智能程度）。
- 窄屏按价值逐段降级：先丢会话名 → git → 成本 → 缓存 → 用量，永不换行、不挤压。

## 安装

### 方式 1：通过 npm 安装（推荐）

```bash
pi install npm:@audsiui/pi-statusbar
```

### 方式 2：通过 GitHub 安装

```bash
pi install git:github.com/audsiui/pi-statusbar@v1.2.0
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