# Repository Guidelines

## Project Structure & Module Organization

This repository contains the DSH Automation Cordis plugin for scheduled coding tasks.

- `src/` — Host-side TypeScript logic. Key areas include `index.ts` (plugin wiring/config), `service.ts` (persistence, claiming, and scheduling), `executor.ts` (run execution), `recurrence.ts` (time rules), `rpc.ts` and `tools.ts` (RPC/agent APIs).
- `src/client/` — Browser/UI code for the DSH Web settings and chat entry points; React components use PascalCase names.
- `tests/` — Node.js Test suites and DSH runtime stubs.
- `scripts/` — Build and release-note utilities.
- `lib/` — Generated bundles and declarations committed for plugin consumption.
- `assets/`, `docs/`, and root changelogs — screenshots, Chinese handoff/architecture notes, and release documentation.

## Build, Test, and Development Commands

Use Node.js 22.19+ or 24 and pnpm.

- `pnpm install` — install dependencies.
- `pnpm typecheck` — run the strict TypeScript compiler without emitting.
- `pnpm test` — run all `tests/*.test.ts` suites with DSH stubs and `tsx`.
- `pnpm build` — emit declarations plus Host ESM and browser bundles into `lib/`.
- `pnpm check` — run typecheck, tests, and build; do this before committing.

To exercise the plugin locally, build it and add it to DSH Web with `dsh plugin --profile web add .`.

## Coding Style & Naming Conventions

Write TypeScript ESM with `.ts` import extensions. Follow the existing two-space indentation, trailing commas, strict typing, and explicit public types. Prefer descriptive kebab-case file names such as `permission-presets.ts`; use PascalCase for React components and interfaces where existing code does so. Keep mutation boundaries, permission checks, and timezone/recurrence rules explicit. No formatter or linter is configured, so match surrounding code and ensure `pnpm check` passes.

## Testing Guidelines

Tests use `node:test`, `node:assert/strict`, and small handcrafted DSH/storage stubs. Name files `*.test.ts` and group behavior by the module or user-facing flow. Add regression tests for scheduling edge cases, timezone changes, persistence races, permission policy, and RPC contracts. Run a targeted suite with `node --import ./tests/register-dsh-stubs.mjs --import tsx --test tests/service.test.ts`, then the full suite.

## Commit & Pull Request Guidelines

History uses Conventional Commit prefixes such as `docs:` and `chore:`; use concise scoped subjects such as `fix(executor):` when helpful. Keep generated `lib/` artifacts in sync when source changes affect published bundles.

Pull requests should include a short behavioral summary, test evidence, linked issues, migration/config notes, and screenshots for visible Web UI changes. Preserve compatibility with supported DSH peer versions and document intentional storage/history changes.
