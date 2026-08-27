# @audsiui/pi-statusbar

终端极简美学扩展 —— **模型边框输入框 + 极致单行状态栏**。

将模型身份与思考状态移至输入框顶部边框，眼球焦点与控制枢纽合一；底部释放为纯净优雅的单行遥测栏，为代码展示多省出整整一行垂直空间。

```text
╭─ [ ● claude-3-7-sonnet • high ] ────────────────────────────────╮
│ Ask me anything or type / for commands...                       │
╰─────────────────────────────────────────────────── [ ↵ Send ] ──╯
~/workspace/pi ⎇ main +2 ~5        ▰▰▰▱▱▱ 48.2%/200k · $0.123 · ⚡85% · ↑12k ↓3k
```

- **模型边框输入框**：模型身份（`●` 运行 / `○` 待命）与思考等级直接内嵌在顶边框，运行中实时旋转 Braille 点阵动画；配合现代圆角 `╭─╮` `╰─╯` 容器。
- **单行遥测状态栏**：
  - 左侧环境：工作目录（`~` 缩写）、Git 分支与变更（`+绿 ~黄`）、会话名。
  - 右侧指标：上下文占用（分段染色、空轨道保持暗调）、费用、缓存命中率、Token 吞吐、扩展状态。
- **性能与空间优化**：
  - 空间节约：底部栏彻底压缩为 1 行，屏幕有效阅读高度增加。
  - 缓存驱动：Token 统计 O(1) 缓存读取，打字与高频重绘帧零额外开销。
  - 极速 Git：带 `-uno` 避免无效大目录扫描，且轮次结束即时刷新。
  - 窄屏优雅降级：按优先级从右侧末尾丢弃辅助指标，绝不折行堆叠。

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