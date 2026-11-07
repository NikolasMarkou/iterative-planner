---
description: Open the Iterative Planner dashboard for this project's plans
argument-hint: "[--plan <plan-id>] [--no-usage] [--interval <seconds>]"
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

Open the planner dashboard, a live read-only web page showing the plans in this project.

1. If you already started a dashboard earlier in this session, say so and give its path again. Do not start a second one.
2. From the project root, run this as a background Bash command (set run_in_background), because `--watch` keeps running and never exits on its own:

   `node "$HOME/.claude/skills/iterative-planner/scripts/dashboard.mjs" --watch --open $ARGUMENTS`

3. When the first output arrives, tell the user the line that starts with `Dashboard:`. That is the page's location.
4. If the command exits with an error (exit code 1 or 2), show its message and do not say the dashboard is running.
5. If no browser opens, for example on a machine with no display, tell the user to open the printed path themselves.

To stop the dashboard, stop the background task.

This command expects the skill at its default install folder, `~/.claude/skills/iterative-planner/`.
