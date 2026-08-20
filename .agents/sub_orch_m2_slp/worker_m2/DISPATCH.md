## 2026-08-18T18:07:59Z

You are Worker M2 for Milestone 2: Programmatic SLP Verification Engine.
Working directory: /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/.agents/sub_orch_m2_slp/worker_m2
Project root: /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion
Original Request file: /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/.agents/ORIGINAL_REQUEST.md
Scope file: /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/.agents/sub_orch_m2_slp/SCOPE.md
Project plan: /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/PROJECT.md

Read the Explorer reports before starting:
- Explorer 1: /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/.agents/sub_orch_m2_slp/explorer_1/analysis.md
- Explorer 2: /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/.agents/sub_orch_m2_slp/explorer_2/analysis.md
- Explorer 3: /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/.agents/sub_orch_m2_slp/explorer_3/analysis.md

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

File Write Ownership (You exclusively own these files):
1. `src/network/slpVerifier.js`
2. `test/verify_slp.js`
3. `test/helpers/mockSlpServer.js`
4. `test/network/slp_verifier.test.js`

Tasks to implement:
1. `src/network/slpVerifier.js`:
   - Pure Node.js `node:net` implementation of Minecraft SLP protocol (Protocol 775, Minecraft 1.21.x / NeoForge 26.1.2).
   - Low-level codecs: `writeVarInt`, `readVarInt`, `writeString`, `readString`, `PacketFramer` accumulator to handle TCP chunking of ~13KB payloads.
   - Implement `querySLP({ host, port = 25565, timeoutMs = 5000, protocolVersion = 775 })`:
     * Send Handshake packet (ID 0x00, protocolVersion, host, port, nextState=1).
     * Send Status Request packet (ID 0x00).
     * Parse Status Response JSON (`version`, `players`, `description`, `favicon`).
     * Extract clean plain text description from string or Chat Component object.
     * Send Ping packet (ID 0x01, BigInt timestamp) and handle Pong packet (ID 0x01) to measure round-trip latency. Fallback gracefully if server closes connection after Status Response.
     * Clean socket teardown on success, error, or timeout.
   - Implement `verifyBotOnline({ host, port = 25565, botUsername, timeoutMs = 5000, protocolVersion = 775 })`:
     * Call `querySLP`.
     * Check `playerCount = status.players.online`.
     * Check if `botUsername` is present in `status.players.sample` (if sample array exists).
     * Return structured verification result:
       `{ isOnline, playerCount, maxPlayers, inSample, sampleOmitted, sample, version, descriptionText, latencyMs, rawStatus }`
   - Export all public methods cleanly: `{ querySLP, verifyBotOnline, PacketFramer, writeVarInt, readVarInt }`.

2. `test/helpers/mockSlpServer.js`:
   - Fast, deterministic mock Minecraft SLP server using `net.createServer`.
   - Supports configurable responses, simulated latency, sample lists, malformed JSON injection, connection drop after status, and Ping/Pong.
   - Auto-assigns ephemeral ports (`port: 0`) and provides `start()` and `close()` lifecycle methods.

3. `test/network/slp_verifier.test.js`:
   - Comprehensive test suite using Node.js native `node:test` and `node:assert/strict`.
   - Test cases for:
     * Valid SLP query with mock server
     * TCP chunking / fragmented packet reassembly
     * Ping / Pong round-trip latency verification
     * Timeout handling on unresponsive host
     * Connection refused handling
     * Malformed JSON payload handling
     * `verifyBotOnline` with bot present in sample
     * `verifyBotOnline` with bot absent from sample
     * `verifyBotOnline` with empty / omitted sample
     * Live server integration test with `atoms-girl.tun.ply.gg:25565` (skip or pass gracefully if network is temporarily unreachable)

4. `test/verify_slp.js`:
   - Standalone CLI utility.
   - Parse CLI arguments: `--host`, `--port`, `--bot`, `--timeout`, `--json`, `--help`.
   - Formatted, colored human-readable output in Bahasa Indonesia by default.
   - Machine-readable pure JSON output when `--json` flag is provided.
   - Clean exit codes: `0` on success, `1` on failure / offline / timeout / bot not found.
   - Can also be directly executed via `node test/verify_slp.js`.

5. Run all tests and CLI executions to verify 100% passing results.
6. Write all code comments and user-facing messages in Bahasa Indonesia.
7. Write your handoff report `handoff.md` with complete verification outputs and test commands.
8. Send a message to parent when done.
