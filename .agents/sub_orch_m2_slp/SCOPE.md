# Scope: Milestone 2 — Programmatic SLP Verification Engine

## Architecture
- Module: `src/network/slpVerifier.js`
- Test / CLI utility: `test/verify_slp.js`
- Responsibilities:
  - Raw TCP packet encoding & decoding for Minecraft Server List Ping (SLP) on Protocol 775 / 1.21.x (Handshake packet with nextState=1, Status Request packet 0x00, Status Response packet 0x00 with VarInt length prefix + JSON string, Ping packet 0x01 with 64-bit Long payload, Pong packet 0x01).
  - High-level helper `querySLP({ host, port, timeoutMs })`: queries server, returns `{ version: { name, protocol }, players: { max, online, sample: Array<{ name, id }> }, description, favicon, latencyMs }`.
  - High-level helper `verifyBotOnline({ host, port, botUsername, timeoutMs })`: asserts `players.online >= 1`, checks if `botUsername` is present in `players.sample`, returns `{ isOnline: boolean, playerCount: number, inSample: boolean, rawStatus: object, latencyMs: number }`.
  - Standalone CLI runner `test/verify_slp.js`: accepts arguments/environment for host, port, and bot username, outputs formatted JSON status, validates player counts, latency, and sample list, and returns exit code 0 on success / 1 on failure.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 4 | Programmatic SLP Ping Verification | Query SLP ping to server, parse JSON status, extract `players.online` and `players.sample` | M2 | R2, Survey |
| 5 | Live Player Count Validation | Assert `players.online >= 1` and verify connected bot username in `players.sample` | M2 | R2, Survey |

## Interface Contracts
### `src/network/slpVerifier.js`
```javascript
/**
 * Melakukan query Server List Ping (SLP) ke Minecraft server
 * @param {Object} options
 * @param {string} options.host - Hostname / IP target
 * @param {number} options.port - Port server Minecraft (default: 25565)
 * @param {number} [options.timeoutMs=5000] - Batas waktu timeout dalam milidetik
 * @returns {Promise<{
 *   version: { name: string, protocol: number },
 *   players: { max: number, online: number, sample?: Array<{ id: string, name: string }> },
 *   description: any,
 *   favicon?: string,
 *   latencyMs: number
 * }>}
 */
async function querySLP({ host, port = 25565, timeoutMs = 5000 }) { ... }

/**
 * Melakukan verifikasi apakah bot dengan username tertentu sedang online
 * @param {Object} options
 * @param {string} options.host
 * @param {number} options.port
 * @param {string} options.botUsername
 * @param {number} [options.timeoutMs=5000]
 * @returns {Promise<{
 *   isOnline: boolean,
 *   playerCount: number,
 *   inSample: boolean,
 *   rawStatus: object,
 *   latencyMs: number
 * }>}
 */
async function verifyBotOnline({ host, port = 25565, botUsername, timeoutMs = 5000 }) { ... }

module.exports = {
  querySLP,
  verifyBotOnline,
};
```

### `test/verify_slp.js`
- CLI tool: `node test/verify_slp.js [--host <host>] [--port <port>] [--bot <username>] [--timeout <ms>] [--json]`
- Can also be run directly as a test script.
- Handles both online server assertions and mock server verification.

## Code Layout & Ownership
- `src/network/slpVerifier.js`: Dedicated exclusively to Worker M2.
- `test/verify_slp.js`: Dedicated exclusively to Worker M2.
- `test/unit/slp_verifier.test.js` or similar test files: Worker M2 & Reviewers.
