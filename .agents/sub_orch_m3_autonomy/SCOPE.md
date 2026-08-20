# Scope: Milestone 3 — Autonomous Zombie Spawner & XP Collector

## Architecture
Milestone 3 implements the autonomous operational loops for persistent presence and farming:
1. **`src/tasks/zombieSpawnerTask.js`**:
   - Spawner targeting at coordinates `[-256, -20, -432]`.
   - Mob tracking and target priority queue (Zombies within reach/farm perimeter).
   - Combat execution respecting weapon cooldowns (`WEAPON_COOLDOWNS_MS.sword = 625ms`).
   - XP orb collection and inventory loot acquisition.
   - Vitality management (auto-eat food when hunger/health drops, retreat threshold).
   - Telemetry status reporter (`getTaskStatus()`).

2. **`src/tasks/persistentCompanion.js`**:
   - Continuous presence manager and lifecycle supervisor.
   - Anti-AFK micro-movement loop (periodic yaw/pitch micro-rotation and subtle position adjustments to avoid server idle kicks).
   - Health and keep-alive watchdog with connection state recovery.
   - Support for both `LiveProtocolClient` (live server NeoForge 26.1.2) and mock/test environments.
   - Event emitter for web dashboard integration (`TICK_UPDATE`, `TELEMETRY_EVENT`, `TASK_STATE_CHANGE`).

3. **`src/ai/taskPlanner.js`**:
   - Integration with `ZombieSpawnerTask` for AI-directed command execution.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 6 | 60s+ Persistent Presence | Sustain continuous live presence on server for 60s+ without disconnect/kick, keepalive watchdog, anti-AFK micro-motion | M3 | R3, Survey |
| 7 | Zombie Spawner Farming Task | Autonomous farming loop at spawner `[-256, -20, -432]`, targeting zombies with 625ms weapon cooldown | M3 | R3, Survey |
| 8 | XP Orb & Item Collection | Automatically detect and collect dropped XP orbs and loot, update XP levels | M3 | R3, Survey |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 3.1 | Autonomous Spawner Farming & XP Collection | `src/tasks/zombieSpawnerTask.js` | M1 | IN_PROGRESS |
| 3.2 | Persistent Presence & Anti-AFK Supervisor | `src/tasks/persistentCompanion.js` | M1, M3.1 | IN_PROGRESS |
| 3.3 | AI Planner & System Integration | `src/ai/taskPlanner.js` | M3.1, M3.2 | IN_PROGRESS |

## Interface Contracts
### `src/network/liveProtocolClient.js` ↔ `src/tasks/persistentCompanion.js`
- `client.sendPositionAndRotation({ x, y, z, yaw, pitch, onGround, hasHorizontalCollision })`
- `client.sendAttack(targetEntityId)`
- `client.sendChat(message)`
- `client.on('keep_alive', (id) => ...)`
- `client.on('health', ({ health, food }) => ...)`

### `src/tasks/zombieSpawnerTask.js` ↔ `src/web/webServer.js` & Dashboard
- `getTaskStatus() -> { active: boolean, targetCoords: { x, y, z }, zombiesKilled: number, xpGained: number, currentHealth: number, currentFood: number, runtimeSeconds: number }`
- Events: `task_start`, `task_step`, `mob_killed`, `xp_collected`, `vitality_warning`, `task_complete`

## Code Layout
- `src/config/constants.js`: System constants, `TARGET_SPAWNER_COORDINATES`, `WEAPON_COOLDOWNS_MS`.
- `src/network/liveProtocolClient.js`: Protocol 775 client.
- `src/tasks/zombieSpawnerTask.js`: Spawner farming logic.
- `src/tasks/persistentCompanion.js`: Persistent presence supervisor.
- `src/ai/taskPlanner.js`: Task planning and execution engine.
