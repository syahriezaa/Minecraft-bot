## 2026-08-18T18:06:14Z
You are Explorer 1 for Milestone 3 (Autonomous Zombie Spawner & XP Collector).
Your working directory is: /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/.agents/explorer_m3_1
Project root: /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion

You MUST read the following authoritative files:
1. /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/.agents/ORIGINAL_REQUEST.md
2. /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/PROJECT.md
3. /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/.agents/sub_orch_m3_autonomy/SCOPE.md
4. /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/src/config/constants.js
5. /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/src/network/liveProtocolClient.js
6. /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/test/e2e/test_zombie_combat_xp.js

Your task:
Investigate and design `src/tasks/zombieSpawnerTask.js`:
- Spawner farming loop targeting coordinates [-256, -20, -432].
- Target tracking and entity acquisition (zombies within attack range).
- Weapon cooldown pacing (WEAPON_COOLDOWNS_MS.sword = 625ms, axe = 1250ms, etc.) to prevent spam attacks and adhere to combat mechanics.
- XP orb & loot pickup detection and level tracking.
- Vitality management (auto-eat if food drops below threshold or health regeneration is needed, retreat if HP < 6).
- Status interface: `getTaskStatus() -> { active, targetCoords, zombiesKilled, xpGained, currentHealth, currentFood, ... }`.
- Compatibility with both LiveProtocolClient (raw Protocol 775 packets) and MockArenaHarness / Mineflayer bot.

Write your findings and implementation design to `/Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/.agents/explorer_m3_1/handoff.md` and report back.
