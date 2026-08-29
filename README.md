<div align="center">

  # DSH Automation

  **Run standalone coding tasks on a schedule in DeepSeek Harness**

  [简体中文](README.zh-CN.md) · [Changelog](CHANGELOG.md) · [Apache-2.0](LICENSE)

  [![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
  [![npm package](https://img.shields.io/npm/v/%40lyhue1991%2Fdsh-automation.svg?label=npm%20package)](https://www.npmjs.com/package/@lyhue1991/dsh-automation)
  [![npm downloads](https://img.shields.io/npm/dt/%40lyhue1991%2Fdsh-automation.svg?label=npm%20downloads)](https://www.npmjs.com/package/@lyhue1991/dsh-automation)
  [![DSH Web Plugin](https://img.shields.io/badge/DSH%20Web-Plugin-0f766e.svg)](https://github.com/lyhue1991/dsh-automation)
  [![Node.js 22 or later](https://img.shields.io/badge/Node.js-22%20or%20later-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)
</div>

DSH Automation is a community-maintained [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin, not an official DeepSeek AI product.

## Features

- **Scheduled coding tasks** — each run starts a fresh Agent and Session.
- **Full schedule control** — once, hourly, daily, weekly, monthly, interval, and custom every-N-days.
- **Dual entry** — manage tasks from **Settings → Scheduled Tasks** or by describing them in any chat.
- **Workspace scoping** — pick the workspace, model, skills, and any Host permission preset.
- **Durable history** — every run status is recorded and filterable.

## Installation

Install from npm into the `web` profile:

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
dsh plugin --profile web add @lyhue1991/dsh-automation@latest --registry=https://registry.npmjs.org/
dsh --profile web --dump-config
```

Restart DSH Web and hard-refresh the browser. Pin a version with `@0.1.0` instead of `@latest` when needed.

From source (requires Node.js 22.19+), clone the repo, then:

```powershell
Set-Location D:\Repository\deepseek-harness-plugin
git clone https://github.com/lyhue1991/dsh-automation.git
Set-Location .\dsh-automation
pnpm install
pnpm build
dsh plugin --profile web add .
dsh --profile web --dump-config
```

Restart DSH Web and hard-refresh the browser.

## License

[Apache License 2.0](LICENSE)
