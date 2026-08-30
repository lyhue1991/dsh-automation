/** 给模型看的定时任务入口说明，避免把「定时任务」理解成操作系统 cron。 */

export const AUTOMATION_PROMPT_NAME = 'tool:automation'
export const AUTOMATION_PROMPT_ORDER = 118

export const AUTOMATION_PROMPT_TEXT = [
  'When the user wants to create a scheduled task, a planned task, or to have something run automatically every day/week/on weekdays, you must call automation_create.',
  'Do not suggest crontab, cron, systemd timers, GitHub Actions, or CI schedules unless the user explicitly asks for an OS-level cron.',
  'schedule_create is only for reminders inside the current conversation; it never opens a standalone coding Session. Standalone work such as daily reports, running code, or research must use automation_create.',
  'Natural language mapping: every weekday / Monday through Friday → kind=weekly, weekdays=["MO","TU","WE","TH","FR"]; every day → kind=daily; 8 AM → time="08:00".',
  'Advanced schedule mapping: 15th minute of every hour → kind=hourly, minute=15; the 31st of every month → kind=monthly, month_day=31; every 3 days → kind=custom, every_days=3. monthly/custom also require time.',
  'Use Asia/Shanghai when no time zone is specified. The prompt must be a complete task description that each independent run can understand on its own.',
].join('\n')

export const AUTOMATION_CREATE_DESCRIPTION = [
  'Use when the user wants to create a scheduled task, a planned task, or to have something run automatically every day/week/on weekdays.',
  'Do not fall back to crontab, systemd, or CI.',
  'Creates one standalone DSH automation for the current workspace; each trigger opens a brand-new Session and does not inherit the current conversation.',
  'Example for weekdays at 8 AM: kind=weekly, weekdays=["MO","TU","WE","TH","FR"], time="08:00", time_zone="Asia/Shanghai".',
  'Also supports hourly(minute), monthly(month_day + time), and custom(every_days + time).',
  'Always use an explicit IANA time zone. Minimum interval is 5 minutes. Defaults to read-only; choose workspace-write only when file changes are required.',
].join('')

export function shouldUseAutomationCreate(userText: string): boolean {
  const text = userText.trim()
  if (text === '') return false
  const wantsSchedule = /定时任务|计划任务|每小时|每天|每周|每月|每(?:隔)?\d+天|工作日|每周一到周五|cron/.test(text)
  const wantsOsCron = /crontab\s+-e|systemd timer|github actions|操作系统.*cron|系统级.?cron/.test(text)
  return wantsSchedule && !wantsOsCron
}
