# Original User Request

## Initial Request — 2026-08-18T16:03:18Z

<USER_REQUEST>
Build an autonomous, self-verifying Minecraft AI navigation and task execution system that iteratively tests itself in an automated headless test world (starting from flat A→B navigation and scaling to 3D obstacles, stairs, caves, and spawner farms) using local PostgreSQL telemetry and DeepSeek AI brain.

Working directory: ~/teamwork_projects/minecraft_autonomous_companion
Integrity mode: development

## Requirements

### R1. Headless Automated Bot Test Harness
Build a headless automated test runner (using a local Node.js Mineflayer / dedicated bot test harness) that connects directly to a test world or server in the background without needing a manual graphical Minecraft window open.

### R2. Progressive Difficulty Navigation Benchmark Suite
Implement an automated curriculum test suite spanning 4 levels of difficulty:
- **Level 1 (Flat Ground):** Point A → Point B (30m distance) on flat terrain.
- **Level 2 (Obstacles & Elevation):** 50m course containing 1-block steps, elevation changes, and obstacle detours.
- **Level 3 (Stairs, Ladders & Bridges):** Vertical navigation across built stairs, ladder shafts, and 1-block narrow bridges.
- **Level 4 (Underground Spawner Farm Target):** Full navigation from surface coordinates down to target farm coordinates `[-256, -20, -432]`.

### R3. Autonomous Self-Correction & Metric Logging
The bot must evaluate its own travel progress every tick, detect when stuck, apply dynamic recovery (re-routing / jumping / step correction), and log every test run result (success/failure, travel duration, obstacle count, and coordinate delta) into the local PostgreSQL database `minecraft_companion`.

### R4. DeepSeek AI Brain & Multi-Step Task Execution
Integrate DeepSeek AI (`deepseek-chat`) to plan and execute multi-step in-game tasks (zombie farming with attack cooldown, multi-chest item sorting, and trash incineration).

## Acceptance Criteria

### Headless Automated Benchmarks
- [ ] Level 1 Test: 100% success rate across 5 consecutive automated headless test runs.
- [ ] Level 2 Test: 100% success rate over terrain obstacles without getting stuck.
- [ ] Level 3 Test: 100% success rate traversing stairs, ladders, and narrow bridges.
- [ ] Level 4 Test: Successfully navigates to the target coordinates `[-256, -20, -432]`.

### Verification & Database Persistence
- [ ] Programmatic automated test runner executes all benchmark levels headless and outputs passing test assertions.
- [ ] PostgreSQL database `minecraft_companion` records all test metrics in `telemetry_logs` and `movement_action_logs`.
- [ ] Web dashboard at `http://localhost:8080` displays real-time telemetry, test progress, and AI chat terminal.

</USER_REQUEST>
