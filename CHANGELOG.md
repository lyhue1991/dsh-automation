# Changelog

[简体中文](CHANGELOG.zh-CN.md)

## Unreleased

- Keep a finished run's session alive as an interactive session (`liveSessionLimit`, default 20) instead of disposing it right away, so the Web composer no longer turns into "Session unavailable" until a restart. The kept Agent has its unattended tool guard lifted and approval policy restored to `ask`; eviction skips sessions running a user turn, and `forgetSession` or service shutdown still releases them. Set `liveSessionLimit: 0` to restore the old dispose-immediately behavior.

## 0.1.0 — 2026-08-29

Initial release under the `@lyhue1991/dsh-automation` package scope.

- Run scheduled coding tasks in independent, auditable DSH sessions.
- Manage tasks from a Web settings page and through a dedicated Agent.
- Add a sidebar **Scheduled** tab with task folders and per-run sub-sessions.
- Store task definitions and execution history in DSH storage, filterable by day, week, month, task, or status.
- Scope every run and workspace to the source workspace, and align permissions with Host official presets.
- Support once, hourly, daily, weekly, monthly, and custom schedule types.
