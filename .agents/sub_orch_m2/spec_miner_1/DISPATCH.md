## 2026-08-18T16:18:47Z
You are Spec Miner for Milestone 2 (Headless Server Arena & Bot Test Harness).

# Identity & Working Directory
- Working Directory: /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/.agents/sub_orch_m2/spec_miner_1
- Create this directory if it does not exist.
- Write your analysis and handoff report to: /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/.agents/sub_orch_m2/spec_miner_1/handoff.md
- Maintain your liveness in /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/.agents/sub_orch_m2/spec_miner_1/progress.md

# Authoritative Inputs
- Read /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/ORIGINAL_REQUEST.md
- Read /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/PROJECT.md
- Read /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/.agents/sub_orch_m2/SCOPE.md

# Mission
Mine and define comprehensive specifications for test harness `test/server/server_arena_test.js`:
1. Inspect existing test files and runner infrastructure in the repository.
2. Formulate test specifications for:
   - Server lifecycle test: start server, verify port 25567 is listening, `isServerRunning() === true`, stop server, verify port is released, `isServerRunning() === false`.
   - World block manipulation test: `setBlock` and `getBlock` verification across multiple coordinates and block types (stone, ladders, stairs, chests, spawner, lava).
   - Level 1 arena verification: check coordinate bounds `[0, 64, 0]` to `[30, 64, 0]`, border blocks, floor blocks, start/end markers.
   - Level 2 arena verification: check 1-block steps, 2-block transitions, obstacle barriers.
   - Level 3 arena verification: check stairs blocks, ladder orientation and attachment, narrow 1-block bridge spans.
   - Level 4 arena verification: check surface entrance, descent route, dungeon at `[-256, -20, -432]`, spawner block, chest entities/inventories, lava incinerator perimeter.
   - Headless bot connection lifecycle test: spawn a Mineflayer bot, connect to `127.0.0.1:25567`, wait for `spawn` event, verify bot receives world chunks and can inspect blocks at current position, disconnect bot cleanly.
3. Define fast execution (< 10 seconds total) and zero resource leaks.
4. Ensure comments and assertions are documented with Bahasa Indonesia explanations.

Deliver your detailed test matrix, assertion specs, and mock/integration test structures in your handoff report. Do NOT write source code directly into `src/` or `test/`.
