<div align="center">

  # DSH Automation

  **在独立 DSH Session 中按计划执行编码任务**

  [English](README.md) · [更新日志](CHANGELOG.zh-CN.md) · [Apache-2.0](LICENSE)

  [![许可证：Apache-2.0](https://img.shields.io/badge/许可证-Apache--2.0-blue.svg)](LICENSE)
  [![npm package](https://img.shields.io/npm/v/%40lyhue1991%2Fdsh-automation.svg?label=npm%20package)](https://www.npmjs.com/package/@lyhue1991/dsh-automation)
  [![npm 下载量](https://img.shields.io/npm/dt/%40lyhue1991%2Fdsh-automation.svg?label=npm%20%E4%B8%8B%E8%BD%BD%E9%87%8F)](https://www.npmjs.com/package/@lyhue1991/dsh-automation)
  [![DSH Web Plugin](https://img.shields.io/badge/DSH%20Web-Plugin-0f766e.svg)](https://github.com/lyhue1991/dsh-automation)
  [![Node.js 22 or later](https://img.shields.io/badge/Node.js-22%20or%20later-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)
</div>

DSH Automation 是社区维护的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件，并非 DeepSeek AI 官方产品。

衍生自 Apache-2.0 开源原版 [@michengai/dsh-automation](https://github.com/MichengAI/dsh-automation)，详见 [NOTICE](NOTICE)。

## 主要功能

- **定时编码任务** — 每次到期都在新的 Agent 和 Session 中运行。
- **完整调度控制** — 不重复、每小时、每天、每周、每月、间隔和自定义间隔天数。
- **双入口管理** — 在「设置 → 定时任务」管理，或在任意对话里描述即可创建。
- **工作区限定** — 可选工作目录、模型、技能和 Host 任意权限预设。
- **持久化记录** — 每次运行的状态都会记录并支持筛选。

## 安装

从 npm 安装到 `web` profile：

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
dsh plugin --profile web add @lyhue1991/dsh-automation@latest --registry=https://registry.npmjs.org/
dsh --profile web --dump-config
```

重启 DSH Web 并在浏览器硬刷新。需要钉死某一版时，把 `@latest` 换成 `@0.1.0`。

从源码安装（需 Node.js 22.19+），克隆仓库后：

```powershell
Set-Location D:\Repository\deepseek-harness-plugin
git clone https://github.com/lyhue1991/dsh-automation.git
Set-Location .\dsh-automation
pnpm install
pnpm build
dsh plugin --profile web add .
dsh --profile web --dump-config
```

重启 DSH Web 并在浏览器硬刷新。

## 许可证

本项目采用 [Apache License 2.0](LICENSE)。
