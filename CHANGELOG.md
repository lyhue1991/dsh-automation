# Changelog

[简体中文](CHANGELOG.zh-CN.md)

## 0.5.0 — 2026-10-18

- Upgrade to DSH 0.2.x: peer dependencies now require `>=0.2.1-rc.2 <0.3.0`, dev dependencies are pinned to `0.2.1-rc.2`, and preset imports move from `dsh-agent-presets` to the split `dsh-agent-preset` + `dsh-agent-preset-registry` packages. The `agentPresets` service surface (mount/list/defaultId/composedPreset) is unchanged.
- The plugin now takes over scheduled tasks on new DSH builds: its profile patch disables the official `schedule` host service and the built-in "Scheduled tasks" settings page (`ui-schedule`). The official `tool-schedule` session tool stays declared but goes inert on its own — it only registers tools inside `ctx.inject(['schedule'])`, so with the service off it disappears from the tool catalog without an extra patch. Disable this plugin to restore the official schedule stack.
- The automation system prompt shrinks to two routing sentences: schedule requests go to `automation_create`, and OS-level cron stays off the table unless asked. Parameter mapping, examples, and the Asia/Shanghai default moved into the `automation_create` tool description, where they belong. `schedule_create` is no longer referenced anywhere: with the official tool disabled, mentioning it could only tempt the model into calling a tool that no longer exists.

## 0.4.0 — 2026-10-03

- The sidebar no longer depends on `dsh-codex-ui`: it wraps the official workspace tree directly, with the "Tasks / Scheduled tasks" tabs coexisting with the official search and workspace menus. The related probing and downgrading logic was removed.
- The in-progress indicator on scheduled-task rows now uses the same rotating spinner as the official StateDot (track + breathing arc), replacing the old pixel-chase dots, and degrades with the system reduced-motion setting.
- Scheduled session rows and group headers get a quick archive button, so archiving no longer requires opening the "⋯" menu. When the host does not pass `archiveSession` through, it falls back to the official `ctx.uiWorkspace.archiveSession`; `uiWorkspace` is now declared in the client inject list and its read is guarded, so an undeclared ctx property can no longer throw and retire the whole `sidebar.workspaces` slot.
- New `excludedAgentPresets` config (default `['minimal']`): agents on excluded presets no longer mount the automation management tools.

## 0.3.6 — 2026-09-25

- DSH 0.1.7 renamed the size-suffixed primitive icon exports (`IconEllipsisOutline16` → `IconEllipsisOutlineRegular`), so the four host icons the scheduled-task sidebar imported resolved to `undefined`. Rendering one threw during render, and the supervised `sidebar.workspaces` single slot retired its registration — the whole workspace region, project sessions included, went blank until a page reload. Those icons are now local copies in the plugin.
- Give the scheduled-task sidebar its own error boundary: an internal crash falls back to the native workspace tree instead of tearing down the host registration, and rendering an undeclared host child slot (`sidebar.channels`) no longer throws.
- Add a regression test that forbids importing size-suffixed host icons and pins the fallback boundary in place.

## 0.3.3 — 2026-09-08

- Read automation session event logs through the API supported by both older and newer DSH Session runtimes, preventing completed runs from being marked failed with `events is not iterable`.

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
