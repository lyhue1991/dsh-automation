/** 给模型看的定时任务入口说明，避免把「定时任务」理解成操作系统 cron。 */

export const AUTOMATION_PROMPT_NAME = 'tool:automation'
export const AUTOMATION_PROMPT_ORDER = 118

// 只保留路由引导：参数映射与时区规则已由 automation_create 的工具描述和 schema 覆盖，
// 这里不再重复。防 cron 路由必须留在系统提示词——若模型已决定走 cron 路线，
// 它不会细看工具描述里的 "Do not fall back to crontab"。
export const AUTOMATION_PROMPT_TEXT = [
  'When the user wants anything to run on a schedule (daily/weekly/hourly/monthly tasks, reminders, or periodic reports), call automation_create; it opens a brand-new Session per run.',
  'Do not suggest crontab, cron, systemd timers, GitHub Actions, or CI schedules unless the user explicitly asks for an OS-level cron.',
].join('\n')

export const AUTOMATION_CREATE_DESCRIPTION = [
  'Use when the user wants to create a scheduled task, a planned task, or to have something run automatically every day/week/on weekdays.',
  'Do not fall back to crontab, systemd, or CI.',
  'Creates one standalone DSH automation for the current workspace; each trigger opens a brand-new Session and does not inherit the current conversation.',
  'Natural language mapping: every weekday / Monday through Friday → kind=weekly, weekdays=["MO","TU","WE","TH","FR"]; every day → kind=daily; 8 AM → time="08:00".',
  'Advanced mapping: 15th minute of every hour → kind=hourly, minute=15; the 31st of every month → kind=monthly, month_day=31; every 3 days → kind=custom, every_days=3. monthly/custom also require time.',
  'Always use an explicit IANA time zone; default to Asia/Shanghai when the user does not specify one. Minimum interval is 5 minutes. Defaults to read-only; choose workspace-write only when file changes are required.',
].join('')

export function shouldUseAutomationCreate(userText: string): boolean {
  const text = userText.trim()
  if (text === '') return false
  const wantsSchedule = /定时任务|计划任务|每小时|每天|每周|每月|每(?:隔)?\d+天|工作日|每周一到周五|cron/.test(text)
  const wantsOsCron = /crontab\s+-e|systemd timer|github actions|操作系统.*cron|系统级.?cron/.test(text)
  return wantsSchedule && !wantsOsCron
}
