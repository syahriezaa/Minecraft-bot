# Scope: Milestone 2 — Headless Server Arena & Bot Test Harness

## Architecture
Milestone 2 provides the headless server environment and procedural world arena generator for the Minecraft Autonomous Companion project. It runs zero-Java in-process Minecraft test server (using `flying-squid` or built-in test server harness on port 25567) and procedurally generates the 4 benchmark arenas directly in the world block storage.

```
+-------------------------------------------------------------------------+
|                        src/server/testServer.js                         |
|  - Headless in-process Minecraft server launcher (flying-squid/custom)  |
|  - Lifecycle: startTestServer, stopTestServer, isServerRunning          |
|  - World mutation: resetWorld, setBlock, getBlock                       |
|  - Zero Java dependency, runs on port 25567                             |
+-------------------------------------------------------------------------+
                                     │
                                     ▼
+-------------------------------------------------------------------------+
|                        src/server/arenaBuilder.js                       |
|  - Procedural arena world generator for 4 benchmark levels:             |
|    * Level 1: Flat Ground 30m sprint ([0,64,0] to [30,64,0])            |
|    * Level 2: Obstacles & Elevation 50m course                          |
|    * Level 3: Vertical stairs, vertical ladders, 1-block bridges        |
|    * Level 4: Underground cave descent to [-256, -20, -432] with        |
|               zombie spawner dungeon, chests, lava incinerator          |
+-------------------------------------------------------------------------+
                                     │
                                     ▼
+-------------------------------------------------------------------------+
|                  test/server/server_arena_test.js                       |
|  - Integration & unit tests for server lifecycle, arena generation,     |
|    block verification, and bot connection test                          |
+-------------------------------------------------------------------------+
```

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Headless Test Server Arena | In-process zero-Java Minecraft server launcher on port 25567 | M2 | ORIGINAL_REQUEST §R1 |
| 2 | Level 1 Benchmark Arena | Procedural flat ground arena [0,64,0] to [30,64,0] | M2 | ORIGINAL_REQUEST §R2 |
| 3 | Level 2 Benchmark Arena | Procedural obstacle & elevation 50m course | M2 | ORIGINAL_REQUEST §R2 |
| 4 | Level 3 Benchmark Arena | Procedural stairs, ladder shafts, and 1-block narrow bridges | M2 | ORIGINAL_REQUEST §R2 |
| 5 | Level 4 Benchmark Arena | Procedural underground descent to [-256, -20, -432] with spawner, chests, lava | M2 | ORIGINAL_REQUEST §R2 |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M2.1 | Headless Test Server (`testServer.js`) | `startTestServer`, `stopTestServer`, `isServerRunning`, `resetWorld`, `setBlock`, `getBlock` | M1 | IN_PROGRESS |
| M2.2 | Procedural Arena Generator (`arenaBuilder.js`) | Build Level 1, Level 2, Level 3, and Level 4 procedural arenas | M2.1 | IN_PROGRESS |
| M2.3 | Server & Arena Test Suite (`server_arena_test.js`) | Automated tests for lifecycle, arena blocks, and bot connection | M2.1, M2.2 | IN_PROGRESS |

## Interface Contracts
### `src/server/testServer.js`
- `startTestServer(options)`: Promise resolving when server is ready on port (default 25567, host '127.0.0.1', version '1.20.1' or '1.19.4' or '1.16.5').
- `stopTestServer()`: Promise resolving when server has cleanly shut down.
- `isServerRunning()`: boolean.
- `resetWorld()`: Clears/resets world chunks.
- `setBlock(x, y, z, blockNameOrId, properties)`: Synchronously or asynchronously sets block in the server world.
- `getBlock(x, y, z)`: Returns block at coordinates with name, type, and properties.
- `getServerInstance()`: Returns the underlying server instance for direct inspection.

### `src/server/arenaBuilder.js`
- `buildLevel1Arena(server, options)`: Builds 30m flat sprint arena from `[0, 64, 0]` to `[30, 64, 0]` with stone floor/borders.
- `buildLevel2Arena(server, options)`: Builds 50m obstacle course with 1-block steps, 2-block elevation transitions, and detour barriers.
- `buildLevel3Arena(server, options)`: Builds vertical navigation course with cobblestone stairs, ladder shafts, and 1-block bridges across gaps.
- `buildLevel4Arena(server, options)`: Builds underground descent route from surface `[0, 64, 0]` to target `[-256, -20, -432]`, with zombie spawner dungeon room, chests with items, and safe perimeter lava incinerator pit.
- `buildArena(level, server, options)`: Helper dispatching to level 1, 2, 3, or 4.
- `clearArena(server, bounds)`: Clears blocks in arena bounds.

## Code Layout
- `src/server/testServer.js` (Exclusive ownership: M2)
- `src/server/arenaBuilder.js` (Exclusive ownership: M2)
- `test/server/server_arena_test.js` (Exclusive ownership: M2)
