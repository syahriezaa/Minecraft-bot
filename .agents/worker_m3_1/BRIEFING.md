# BRIEFING — 2026-08-18T18:09:08Z

## Mission
Implement Milestone 3: Autonomous Zombie Spawner Farming, Persistent Presence & XP Collection (`zombieSpawnerTask.js`, `persistentCompanion.js`, `taskPlanner.js` integration, and comprehensive test suite).

## 🔒 My Identity
- Archetype: implementer
- Roles: implementer, qa, specialist
- Working directory: /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/.agents/worker_m3_1
- Original parent: 53648abc-b6ca-4c1b-9978-fe41e9b605e2
- Milestone: Milestone 3 (Autonomous Zombie Spawner Farming, Persistent Presence & XP Collection)

## 🔒 Key Constraints
- Genuine implementation — no hardcoded test outputs or dummy facades.
- All code comments and user-facing error messages in Bahasa Indonesia.
- Exclusive write ownership: `src/tasks/zombieSpawnerTask.js`, `src/tasks/persistentCompanion.js`, `src/ai/taskPlanner.js`, and unit/task test files.
- Stationing & farming loop at `[-256, -20, -432]`.
- Dual client adapter supporting `LiveProtocolClient` (Protocol 775) and `MockArenaHarness` / Mineflayer.
- Pacing combat with weapon cooldowns (`WEAPON_COOLDOWNS_MS.sword = 625ms`).
- XP orb collection, Minecraft level calculation, loot pickup tracking.
- Vitality management (auto-eat when hunger `food <= 14` or health recovery needed; retreat if `health < 6` HP).
- Status reporting interface `getTaskStatus()`.
- Persistent presence manager (surviving 60s+ on server), Keepalive heartbeat watchdog (25s threshold), Anti-AFK micro-motion / micro-rotation (MovementFlags).
- Auto-reconnect state machine with exponential backoff and jitter.
- Sub-task lifecycle supervisor (register, start, pause, resume).
- Telemetry and Web Dashboard event emission (`TICK_UPDATE`, `TELEMETRY_EVENT`, `TASK_STATE_CHANGE`).
- Verify 100% test pass with `node test/runner.js` and `node test/e2e/test_zombie_combat_xp.js`.

## Current Parent
- Conversation ID: 53648abc-b6ca-4c1b-9978-fe41e9b605e2
- Updated: 2026-08-18T18:09:08Z

## Task Summary
- **What to build**: `zombieSpawnerTask.js`, `persistentCompanion.js`, integrate with `taskPlanner.js`, unit/integration tests in `test/unit/` or `test/tasks/`.
- **Success criteria**: All tests pass, genuine behavior, dual adapter support, full feature set according to M3 specs.
- **Interface contracts**: PROJECT.md, SCOPE.md, explorer handoffs.
- **Code layout**: src/tasks, src/ai, test/

## Change Tracker
- **Files modified**: None yet
- **Build status**: Pending
- **Pending issues**: None

## Quality Status
- **Build/test result**: Pending initial test run
- **Lint status**: Clean
- **Tests added/modified**: TBD

## Loaded Skills
- None requested
