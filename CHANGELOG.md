# Changelog

[简体中文](CHANGELOG.zh-CN.md)

## 0.3.2 — 2026-09-03

- Enable `@` references in scheduled-task prompt forms, with workspace file lookup and DSH session suggestions.
- Raise the default concurrent automation run limit from 2 to 4, and reject manual runs once that global limit is already active.

## 0.3.1 — 2026-09-02

- Include `agentPreset` in automation snapshot results so the edit form preserves the selected preset instead of silently falling back to the default.

## 0.3.0 — 2026-09-01

- Add Agent preset selection to scheduled tasks. The Web create/edit forms and Agent create/update APIs now expose Host presets, persist the selected preset, and validate it against the currently available list.
- Expand the unattended tool allowlist with additional Host and PI tools, including `bash_io`, `find`, `ls`, and goal-tracking tools.

## 0.2.0 — 2026-08-31

- Keep a finished run's session alive as an interactive session (`liveSessionLimit`, default 20) instead of disposing it right away, so the Web composer no longer turns into "Session unavailable" until a restart. The kept Agent has its unattended tool guard lifted and approval policy restored to `ask`; eviction skips sessions running a user turn, and `forgetSession` or service shutdown still releases them. Set `liveSessionLimit: 0` to restore the old dispose-immediately behavior.
- Convert host/tool-facing strings to English: `automation_*` tool and parameter descriptions, the `tool:automation` prompt section, unattended tool-guard reasons, approval reasons, and service/executor/rpc error messages. Web UI strings remain locale-driven in `src/client`.

## 0.1.0 — 2026-08-29

Initial release under the `@lyhue1991/dsh-automation` package scope.

- Run scheduled coding tasks in independent, auditable DSH sessions.
- Manage tasks from a Web settings page and through a dedicated Agent.
- Add a sidebar **Scheduled** tab with task folders and per-run sub-sessions.
- Store task definitions and execution history in DSH storage, filterable by day, week, month, task, or status.
- Scope every run and workspace to the source workspace, and align permissions with Host official presets.
- Support once, hourly, daily, weekly, monthly, and custom schedule types.
