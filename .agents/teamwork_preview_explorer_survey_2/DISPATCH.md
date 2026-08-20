# Dispatch: Survey Explorer 2 (Database Telemetry & Web Dashboard)
Target: Investigate PostgreSQL database schema and logging for `minecraft_companion` (tables: `telemetry_logs`, `movement_action_logs`, migrations, queries), live telemetry streaming (WebSocket/SSE/Express/Fastify/Node.js), and Web Dashboard on http://localhost:8080 (real-time metrics, test run status, AI chat terminal, UI labels in Bahasa Indonesia, Poppins font).

Authoritative Request: /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/ORIGINAL_REQUEST.md
Working Directory: /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/.agents/teamwork_preview_explorer_survey_2
Output: /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/.agents/teamwork_preview_explorer_survey_2/analysis.md and handoff.md

## 2026-08-18T16:04:38Z
<USER_REQUEST>
You are Survey Explorer 2 for the Minecraft Autonomous Companion project.

# Working Directory
/Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/.agents/teamwork_preview_explorer_survey_2

# Authoritative Request
Read /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/ORIGINAL_REQUEST.md

# Mission
Investigate and survey the PostgreSQL telemetry logging and Web Dashboard architecture:
1. PostgreSQL database schema design for `minecraft_companion`:
   - `telemetry_logs`: test run ID, level, status (success/failure), travel duration, obstacle count, coordinate delta, path history, timestamp, etc.
   - `movement_action_logs`: bot tick, position (x, y, z), velocity, action (move, jump, re-route, recover), stuck status, timestamp.
   - Migration scripts, indexing strategy, foreign keys, and connection pooling.
2. Real-time telemetry streaming and web server:
   - Web server running on `http://localhost:8080` (Express/Fastify/Koa/Node.js HTTP + WebSocket/SSE).
   - Real-time updates of bot position, benchmark test execution status, navigation path visualizer / charts, and AI chat terminal.
3. User Rules & UI styling:
   - UI labels and user-facing error messages in Bahasa Indonesia.
   - Typography: Google Fonts Poppins.
   - Clean, modern dashboard interface.

# Instructions & Output Requirements
- Do NOT write source code for the project. You are an exploratory research and design agent.
- Write your comprehensive survey and schema/dashboard designs to /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/.agents/teamwork_preview_explorer_survey_2/analysis.md
- Write a structured handoff report to /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/.agents/teamwork_preview_explorer_survey_2/handoff.md
- Send a completion message back to the orchestrator using `send_message`.
</USER_REQUEST>
