# pi-statusbar

替换 pi 内置 footer 的扩展：左侧会话数据（用量/缓存命中率/成本/上下文占用），右侧模型身份（accent 高亮 + 工作中/待命指示）。窄屏自动逐段降级。

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

- 上下文占用是唯一使用语义色的数据：>70% 警告（黄）、>90% 危险（红）；其余一律 dim。
- 分支名用 accent 色，是唯一与数据并列的强调。
- 依赖的 `@earendil-works/pi-*` 由 pi 核心打包，无需单独安装。