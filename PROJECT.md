# Project: Minecraft Autonomous Companion (NeoForge 26.1.2 Live Connection)

## Architecture
- **Protocol & Network Layer (`src/network/`)**: Direct Protocol 775 (NeoForge 26.1.2) client connector (`liveProtocolClient.js`), SLP Ping verifier (`slpVerifier.js`), Configuration Phase state machine, packet telemetry.
- **Autonomous Task Engine (`src/tasks/`, `src/ai/`)**: Zombie spawner farming loop at `[-256, -20, -432]`, combat pacing with weapon cooldowns, XP orb and item pickup, vitality monitoring (auto-eat, retreat).
- **Persistence & Telemetry Layer (`src/db/`, `src/telemetry/`)**: PostgreSQL 17 database persistence, action audit logs, movement telemetry, telemetry batch ingester.
- **Web Dashboard Layer (`src/web/`)**: Dual HTTP Express & WebSocket broadcaster on port 8080, real-time UI with Google Fonts Poppins, dark mode styling with `AppColors`, 100% Bahasa Indonesia UI labels.
- **Testing & Verification Harness (`test/`)**: 4-Tier test harness (Tier 1 Feature, Tier 2 Boundary, Tier 3 Cross-Feature, Tier 4 Real-World Application) + Tier 5 Adversarial Hardening.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | NeoForge 26.1.2 Protocol 775 Handshake | Connect to `atoms-girl.tun.ply.gg:25565` through Handshaking -> Login -> Configuration -> Play states | M1 | R1, Survey |
| 2 | Configuration Phase Handler | Handle 28 `registry_data` packets, `tags`, and `finish_configuration` negotiation | M1 | R1, Survey |
| 3 | Keepalive & Play State Packet Handling | Respond to `keep_alive`, send `teleport_confirm`, `player_loaded`, `chunk_batch_received` | M1 | R1, R3, Survey |
| 4 | Programmatic SLP Ping Verification | Query SLP ping to server, parse JSON status, extract `players.online` and `players.sample` | M2 | R2, Survey |
| 5 | Live Player Count Validation | Assert `players.online >= 1` and verify connected bot username in `players.sample` | M2 | R2, Survey |
| 6 | 60s+ Persistent Presence | Sustain continuous live presence on server for 60s+ without disconnect/kick | M3 | R3, Survey |
| 7 | Zombie Spawner Farming Task | Autonomous farming loop at spawner `[-256, -20, -432]`, targeting zombies with 625ms weapon cooldown | M3 | R3, Survey |
| 8 | XP Orb & Item Collection | Automatically detect and collect dropped XP orbs and loot, update XP levels | M3 | R3, Survey |
| 9 | Web Dashboard on Port 8080 | Serve Express + WebSocket UI on `http://localhost:8080` streaming live bot telemetry | M4 | R3, Survey |
| 10 | Indonesian UI & Poppins Typography | Web dashboard UI in Bahasa Indonesia with Google Fonts Poppins typography and AppColors tokens | M4 | User Rules, Survey |
| 11 | Master E2E & Live Presence Verification | Run 60s+ live presence verification, SLP assertion, full test suite pass, and Forensic Audit | M5 | R1-R3, Verification |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | Live Protocol 775 & NeoForge Handshake | `src/network/liveProtocolClient.js` | none | DONE |
| 2 | Programmatic SLP Verification Engine | `src/network/slpVerifier.js`, `test/verify_slp.js` | M1 | DONE |
| 3 | Autonomous Zombie Spawner & XP Collector | `src/tasks/zombieSpawnerTask.js`, `src/ai/` | M1, M2 | DONE |
| 4 | Live Web Dashboard (Port 8080) | `src/web/webServer.js`, `src/web/public/` | M3 | DONE |
| 5 | Master E2E Live Integration & Victory Audit | `test/`, Live Server verification, Audit | M1, M2, M3, M4 | DONE |

## Interface Contracts
### `src/network/liveProtocolClient.js` ↔ `src/tasks/zombieSpawnerTask.js`
- `createLiveClient({ host, port, username, version, protocolVersion }) -> LiveClientInstance`
- Events emitted: `spawn`, `packet`, `keep_alive`, `disconnect`, `end`, `error`, `entitySpawn`, `collect`, `experience`
- Methods: `sendPosition(x, y, z, onGround)`, `sendAttack(targetEntityId)`, `sendChat(message)`, `disconnect()`

### `src/network/slpVerifier.js` ↔ `src/web/webServer.js` & Test Harness
- `querySLP({ host, port, timeoutMs }) -> Promise<{ version, players: { online, max, sample: Array<{ id, name }> }, latencyMs }>`
- `verifyBotOnline({ host, port, botUsername, timeoutMs }) -> Promise<{ isOnline: boolean, playerCount: number, inSample: boolean }>`

### `src/tasks/zombieSpawnerTask.js` ↔ `src/web/webServer.js`
- `getTaskStatus() -> { active: boolean, targetCoords: { x, y, z }, zombiesKilled: number, xpGained: number, currentHealth: number, currentFood: number }`
- WebSocket message payload: `TICK_UPDATE`, `TELEMETRY_EVENT`, `TASK_STATE_CHANGE`

## Code Layout
- `src/config/constants.js`: System constants, target coordinates `[-256, -20, -432]`, cooldowns, ports.
- `src/network/liveProtocolClient.js`: Protocol 775 client and packet state machine.
- `src/network/slpVerifier.js`: Programmatic SLP ping queries and player assertions.
- `src/tasks/zombieSpawnerTask.js`: Autonomous farming, mob targeting, and XP collection.
- `src/web/webServer.js`: Express & WebSocket server on port 8080.
- `src/web/public/`: Static web dashboard assets (HTML, CSS, JS) in Bahasa Indonesia with Poppins.
- `test/`: Tier 1–4 E2E test suites, SLP verification tests, live integration tests.
