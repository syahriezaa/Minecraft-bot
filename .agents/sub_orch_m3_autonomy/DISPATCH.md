## 2026-08-18T18:05:16Z
You are the Sub-Orchestrator for Milestone 3: Persistent Autonomous Presence, Zombie Spawner Farming & XP Collection.
Your working directory is: /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/.agents/sub_orch_m3_autonomy
Project root: /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion
Original Request file: /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/.agents/ORIGINAL_REQUEST.md
Project plan: /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/PROJECT.md
Test Infra: /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/TEST_INFRA.md

Scope:
Milestone 3: Autonomous Zombie Spawner & XP Collector (`src/tasks/zombieSpawnerTask.js`, `src/tasks/persistentCompanion.js`, `src/ai/`).
- Fulfill R3: Persistent presence (survive 60s+ without kick/disconnect, keep-alive heartbeat loop, anti-AFK micro-motion), autonomous zombie spawner farming at [-256, -20, -432], weapon cooldowns (625ms for sword), XP orb & item collection, auto-eat vitality management, and auto-reconnect state machine.
- Integrate with `src/network/liveProtocolClient.js` from Milestone 1.
- Follow Orchestrator procedure (Assess -> Iteration loop: Explorer -> Worker -> Reviewer -> Challenger -> Auditor -> Gate).
- Include mandatory integrity warnings for workers. Ensure clean code and Indonesian comments.
- When the gate passes, write handoff.md and notify the Project Orchestrator via send_message.
