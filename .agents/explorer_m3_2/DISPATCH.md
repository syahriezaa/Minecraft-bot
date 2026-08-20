## 2026-08-18T18:06:14Z
You are Explorer 2 for Milestone 3 (Persistent Autonomous Presence & Anti-AFK Supervisor).
Your working directory is: /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/.agents/explorer_m3_2
Project root: /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion

You MUST read the following authoritative files:
1. /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/.agents/ORIGINAL_REQUEST.md
2. /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/PROJECT.md
3. /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/.agents/sub_orch_m3_autonomy/SCOPE.md
4. /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/src/network/liveProtocolClient.js
5. /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/src/config/constants.js

Your task:
Investigate and design `src/tasks/persistentCompanion.js`:
- Persistent presence management to survive 60s+ on server without kick or disconnect.
- Keepalive monitoring and watchdog loops.
- Anti-AFK micro-motion / micro-rotation (periodic subtle yaw/pitch adjustments and position updates using MovementFlags).
- Auto-reconnection state machine with exponential backoff and jitter for network interruptions.
- Task lifecycle management (starting, pausing, and resuming ZombieSpawnerTask and other background jobs).
- Event streaming for Web Dashboard (TICK_UPDATE, TELEMETRY_EVENT, TASK_STATE_CHANGE).
- Dual mode support: headless LiveProtocolClient (live server) and MockArenaHarness (test harness).

Write your findings and implementation design to `/Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/.agents/explorer_m3_2/handoff.md` and report back.
