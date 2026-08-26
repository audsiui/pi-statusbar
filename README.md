# pi-statusbar

替换 pi 内置 footer 的多行扩展：第 1 行工作目录（~ 缩写）+ git 分支 + 会话名，第 2 行会话数据（上下文占用/用量/缓存 R/W/命中率/成本）+ 右侧模型身份（accent 高亮 + 工作中/待命指示 + thinking 级别），第 3 行扩展状态（若有）。窄屏自动逐段降级。

## 安装

```bash
pi install git:github.com/audsiui/pi-statusbar@v1.0.0
```

想临时试用（仅当前运行，不写入 settings）：

```bash
pi -e git:github.com/audsiui/pi-statusbar
```

## 卸载

```bash
pi remove git:github.com/audsiui/pi-statusbar
```

## 说明

- 多行布局：工作目录/分支/会话名独立一行，与内置 footer 信息层级一致；可叠加额外的状态行。
- 上下文占用是唯一使用语义色的数据：>70% 警告（黄）、>90% 危险（红）；其余一律 dim。
- 分支名用 accent 色，是唯一与数据并列的强调。
- 依赖的 `@earendil-works/pi-*` 由 pi 核心打包，无需单独安装。