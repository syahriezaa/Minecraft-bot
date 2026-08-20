# Scope: Milestone 1 — Live Protocol 775 & NeoForge Handshake

## Architecture
- Module: `src/network/liveProtocolClient.js`
- Sub-components:
  - Protocol 775 state machine: Handshaking (state 1/2) -> Login (0x00 login_start, 0x02 login_success, 0x03 login_acknowledged) -> Configuration (0x01 cookie, 0x07 registry_data, 0x0d update_tags, 0x09 custom_payload, 0x02 finish_configuration / 0x03 finish_configuration ack) -> Play (0x29 login/join_game, 0x2b keep_alive, 0x40 synchronous_teleport / confirm_teleportation 0x00, 0x2e ping/pong, 0x08 chunk_batch_start / 0x0b chunk_batch_finished / 0x07 chunk_batch_received ack, 0x28 player_loaded, 0x1b player_position_and_rotation movement flags { onGround, hasHorizontalCollision }).
  - NeoForge 26.1.2 Handshake integration: channel registration (`minecraft:register`, `neoforge:network`), token exchange/mod negotiation if required, or clean bypass to Play state if vanilla protocol compatible.
  - Live server target: `atoms-girl.tun.ply.gg:25565`.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | TCP Connection & Handshake | Connect to host/port, send Handshake (protocol 775, nextState=2 Login) | M1 | ORIGINAL_REQUEST §R1 |
| 2 | Login State Transition | Handle Login Start, compression if set, Login Success, Login Acknowledged (0x03) | M1 | ORIGINAL_REQUEST §R1 |
| 3 | Configuration Lifecycle | Receive 28 Registries (Biomes, Chat types, Damage types, etc.), Tags, Custom Payloads, send Finish Configuration (0x02), receive Finish Configuration (0x02/0x03) ack | M1 | ORIGINAL_REQUEST §R1 |
| 4 | NeoForge Custom Channel Support | Listen and respond to `minecraft:register`, `fml:handshake` or `neoforge:main` if sent during config/play | M1 | ORIGINAL_REQUEST §R1 |
| 5 | Play Transition & Join Game | Transition to Play (state 4), receive Join Game (0x29) and Game Event packets | M1 | ORIGINAL_REQUEST §R1 |
| 6 | Keepalive & Ping-Pong | Respond to 0x2b keepalive with 0x18 keepalive_response, 0x35 ping with 0x24 pong | M1 | ORIGINAL_REQUEST §R1 |
| 7 | Teleport Confirmation & Player Loaded | Acknowledge 0x40 player_position (teleport_id) with 0x00 confirm_teleportation, send 0x28 player_loaded | M1 | ORIGINAL_REQUEST §R1 |
| 8 | Chunk Batch Acknowledgement | Acknowledge chunk batches with 0x07 chunk_batch_received | M1 | ORIGINAL_REQUEST §R1 |
| 9 | Movement Packet & Protocol Flags | Send 0x1b/0x1a player_position with movement flags `{ onGround: boolean, hasHorizontalCollision: boolean }` as required in 1.21.1 / Protocol 775 | M1 | ORIGINAL_REQUEST §R1 |

## Interface Contracts
### `LiveProtocolClient` (`src/network/liveProtocolClient.js`)
- `constructor(options)`: `{ host, port, username, uuid, authMode }`
- `connect()`: Promise resolving when client reaches `Play` state and receives `join_game`.
- `sendPosition({ x, y, z, onGround, hasHorizontalCollision })`
- `sendPositionAndRotation({ x, y, z, yaw, pitch, onGround, hasHorizontalCollision })`
- `disconnect(reason)`
- Events emitted:
  - `'stateChanged'`: `(oldState, newState)`
  - `'login'`: `(playerData)`
  - `'joined'`: `(gameData)`
  - `'packet'`: `(name, data, state)`
  - `'packet_raw'`: `(packetId, buffer, state)`
  - `'error'`: `(err)`
  - `'close'`: `(reason)`
  - `'keepalive'`: `(id)`
  - `'teleport'`: `({ x, y, z, yaw, pitch, teleportId })`
  - `'chat'`: `(message)`
  - `'registry_data'`: `(registryName, entries)`
