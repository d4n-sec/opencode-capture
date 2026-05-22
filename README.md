# opencode-capture

`opencode-capture` 是一个 OpenCode 插件，用来捕获真实会话中的交互事实链，并把结果落盘为可追溯的结构化数据，便于回放、审计、分析和后续导出。

## 能力概览

- 捕获用户消息、助手文本、reasoning、system prompt
- 捕获工具调用、子 agent 调用、审批链路、命令结果
- 按项目和 session 落盘到 `.opencode/capture_log/`
- 支持将单个 session 导出为纯交互流 `interaction.json`

## 安装

项目内安装：

```bash
# 1. 安装 npm 包
npm install opencode-capture
# 2. 执行接入命令，写入 OpenCode 插件配置
npx opencode-capture install
```

全局安装：

```bash
# 1. 全局安装 npm 包
npm install -g opencode-capture
# 2. 执行全局接入命令
opencode-capture install --global
```

说明：

- `opencode-capture install` 负责把插件接入到 OpenCode，不是 npm 的安装命令
- 项目内安装会写入 `.opencode/plugins/opencode-capture.js`
- 全局安装会写入 `~/.config/opencode/plugins/opencode-capture.js`
- `opencode-capture install` 会初始化 `.opencode/capture_log/settings.json`

## 常用命令

```bash
opencode-capture enable
opencode-capture disable
opencode-capture status
opencode-capture export --session <session-id>
```

如果是项目内安装，也可以使用：

```bash
npx opencode-capture enable
npx opencode-capture disable
npx opencode-capture status
npx opencode-capture export --session <session-id>
```

## 目录结构

默认捕获目录：

```text
.opencode/capture_log/<project_key>/<session_id>/
```

典型内容：

```text
meta.json
raw/events.jsonl
artifact/
export/interaction.json
```

## GitHub Release 安装

下载 release 包后，可直接本地安装：

```bash
# 1. 安装 release 包
npm install ./<release-asset>.tar.gz
# 2. 执行接入命令
npx opencode-capture install
```

如果是全局安装：

```bash
# 1. 全局安装 release 包
npm install -g ./<release-asset>.tar.gz
# 2. 执行全局接入命令
opencode-capture install --global
```

## 发布 Release 包

执行：

```bash
npm run release:pack
```

该命令会：

- 构建 `dist/`
- 生成 npm tarball
- 在 `tmp/release/` 下保留 `.tgz`
- 同时复制一份 `.tar.gz`，便于直接上传到 GitHub Release
