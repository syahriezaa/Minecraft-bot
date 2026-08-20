## 2026-08-18T18:09:08Z
You are Worker 1 for Milestone 3 (Autonomous Zombie Spawner Farming, Persistent Presence & XP Collection).
Your working directory is: /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/.agents/worker_m3_1
Project root: /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

You MUST read the following authoritative files:
1. /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/.agents/ORIGINAL_REQUEST.md
2. /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/PROJECT.md
3. /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/.agents/sub_orch_m3_autonomy/SCOPE.md
4. /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/.agents/explorer_m3_1/handoff.md
5. /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/.agents/explorer_m3_2/handoff.md
6. /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/.agents/explorer_m3_3/handoff.md
7. /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/src/config/constants.js
8. /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/src/network/liveProtocolClient.js
9. /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/src/ai/taskPlanner.js
10. /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/test/runner.js
11. /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/test/e2e/test_zombie_combat_xp.js

Exclusive Write Ownership:
- `src/tasks/zombieSpawnerTask.js`
- `src/tasks/persistentCompanion.js`
- `src/ai/taskPlanner.js`
- `test/unit/zombieSpawnerTask.test.js` (or `test/tasks/zombieSpawnerTask.test.js`)
- `test/unit/persistentCompanion.test.js` (or `test/tasks/persistentCompanion.test.js`)

Requirements:
1. Create `src/tasks/zombieSpawnerTask.js`:
   - Stationing & farming loop at coordinates `[-256, -20, -432]`.
   - Dual client adapter supporting `LiveProtocolClient` (Protocol 775) and `MockArenaHarness` / Mineflayer.
   - Pacing combat with weapon cooldowns (`WEAPON_COOLDOWNS_MS.sword = 625ms`).
   - XP orb collection, Minecraft level calculation, loot pickup tracking.
   - Vitality management (auto-eat when hunger `food <= 14` or health recovery needed; retreat if `health < 6` HP).
   - Status reporting interface `getTaskStatus()`.
2. Create `src/tasks/persistentCompanion.js`:
   - Persistent presence manager (surviving 60s+ on server).
   - Keepalive heartbeat watchdog (25s threshold).
   - Anti-AFK micro-motion / micro-rotation (periodic subtle yaw/pitch adjustments with valid MovementFlags).
   - Auto-reconnect state machine with exponential backoff and jitter.
   - Sub-task lifecycle supervisor (register, start, pause, resume).
   - Telemetry and Web Dashboard event emission (`TICK_UPDATE`, `TELEMETRY_EVENT`, `TASK_STATE_CHANGE`).
3. Update `src/ai/taskPlanner.js`:
   - Integrate `_executeFarmMobs` with `ZombieSpawnerTask`.
4. Create comprehensive tests in `test/` verifying all Milestone 3 functionality.
5. Run the tests (including `node test/runner.js`, `node test/e2e/test_zombie_combat_xp.js`, and your new test files) to verify 100% PASS.
6. All code comments and user/error messages MUST be in Bahasa Indonesia.
