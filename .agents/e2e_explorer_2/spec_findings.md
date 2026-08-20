# Spesifikasi & Cetak Biru Pengujian E2E (Specification Mining Report)
## Minecraft Autonomous Companion — Protocol 775, SLP, Combat Farming & Dashboard

**Agen**: E2E Explorer 2 (`teamwork_preview_spec_miner`)  
**Parent**: Orchestrator (`1209b8e0-fb31-43b2-b040-465d401ee150`)  
**Tanggal**: 2026-08-19  
**Lokasi Dokumen**: `.agents/e2e_explorer_2/spec_findings.md`  

---

## 1. Sumber Otoritatif Spesifikasi (Specification Sources)

Penyusunan spesifikasi ini didasarkan pada investigasi empiris dan verifikasi sumber-sumber otoritatif berikut:
1. **`ORIGINAL_REQUEST.md` & `.agents/ORIGINAL_REQUEST.md`**: Persyaratan koneksi live ke `atoms-girl.tun.ply.gg:25565`, SLP ping verifikasi `players.online >= 1`, persistent presence 60s+, farming spawner `[-256, -20, -432]`, 625ms weapon cooldown, XP orb pickup, PostgreSQL telemetry logging, dan Web Dashboard port 8080.
2. **`PROJECT.md`**: Arsitektur 5 subsistem (`src/network/`, `src/tasks/`, `src/db/`, `src/web/`, `test/`), kontrak antarmuka API, dan milestone M1–M5.
3. **`TEST_INFRA.md` & `TEST_READY.md`**: Arsitektur pengujian 4-tier berbasis `node:test` dan `node:assert/strict` dengan 163 kasus uji 100% lulus.
4. **Spesifikasi Protokol Minecraft 26.1.2 / Protocol 775**: ProtoDef schema pada `minecraft-data@3.113.2` dan runtime `node-minecraft-protocol@1.54.0`.
5. **Aturan Global Proyek (`RULE[user_global]`)**: 100% Bahasa Indonesia untuk seluruh komentar kode, label UI, dan pesan kesalahan asersi, Google Fonts Poppins, dan design tokens `AppColors`.

---

## 2. Features Discovered

| # | Kategori | Fitur | Deskripsi | Input | Output | Penanganan Error / Batasan | Sumber Otoritatif |
|---|---|---|---|---|---|---|---|
| 1 | Jaringan & Protokol | Handshake Protokol 775 | Inisialisasi koneksi socket TCP dan transisi `HANDSHAKING` $\to$ `LOGIN` | `host: string, port: number, protocolVersion: 775, nextState: 2` | Socket stream siap autentikasi | Melempar error `ECONNREFUSED` atau `ETIMEDOUT` jika server offline | `ORIGINAL_REQUEST §R1`, Protocol 775 Spec |
| 2 | Jaringan & Protokol | Siklus Login & Kompresi | Negosiasi login offline dan dekompresi paket Zlib | `username: string, uuid: string` | `login_success`, `login_acknowledged` | Menolak jika format UUID/username invalid atau kompresi gagal | Protocol 775 Spec, `liveProtocolClient.js` |
| 3 | Jaringan & Protokol | Negosiasi Fase Konfigurasi | Memproses 28 paket `registry_data`, `custom_payload`, dan `tags` | `select_known_packs`, 28 registry packets | `finish_configuration` handshake | Melempar `InvalidConfigurationError` jika skema registri korup | Protocol 775 Spec, `survey_report.md` |
| 4 | Jaringan & Protokol | Transisi State Play | Masuk ke dunia, konfirmasi teleportasi awal, dan muat chunk | `position: { x, y, z, yaw, pitch, teleportId }` | `teleport_confirm`, `player_loaded`, `chunk_batch_received` | Server menendang bot jika `teleport_confirm` tidak dikirim | Protocol 775 Spec, `liveProtocolClient.js` |
| 5 | Jaringan & Protokol | Detak Jantung (Keep-Alive) | Merespons detak jantung keepalive 64-bit secara otomatis | `keep_alive: { keepAliveId: BigInt }` | Balasan `keep_alive` dengan ID identik | Timeout kick (30s) jika respons terlambat | Protocol 775 Spec, `PROJECT.md §M1` |
| 6 | Jaringan & Protokol | Penyesuaian `MovementFlags` | Format paket pergerakan menggunakan bitflags `MovementFlags` | `x, y, z, yaw, pitch, flags: { onGround, hasHorizontalCollision }` | Paket `position_look` valid | `TypeError: Cannot read properties of undefined` jika flag boolean lama | Protocol 775 Spec |
| 7 | Verifikasi SLP | Programmatic SLP Ping | Melakukan handshake status query dan parsing JSON status server | `host: string, port: number, timeoutMs: number` | Objek status JSON `{ version, players, latency }` | Timeout rejection jika server tidak merespons dalam `timeoutMs` | `ORIGINAL_REQUEST §R2`, `slpVerifier.js` |
| 8 | Verifikasi SLP | Validasi Pemain Aktif | Menguji `players.online >= 1` dan pencarian nama bot di `sample` | `statusJson, targetBotUsername: string` | `isOnline: boolean, playerCount: number, inSample: boolean` | Assertion failure jika `online < 1` atau nama bot tidak ditemukan | `ORIGINAL_REQUEST §R2`, `PROJECT.md §M2` |
| 9 | Presensi Otonom | 60s+ Persistent Presence | Mempertahankan koneksi live tanpa disconnect selama $\ge 60$ detik | `sessionDurationTarget: 60000ms` | `connectedDurationMs >= 60000`, 0 kick | Reconnect loop otomatis dan pencatatan error jika terputus | `ORIGINAL_REQUEST §R3`, `PROJECT.md §M3` |
| 10 | Tugas Pertarungan | Zombie Farming Spawner | Menavigasi ke `[-256, -20, -432]` dan menyerang target zombie | `spawnerCoords: [-256,-20,-432], range <= 4.5m` | `attack({ targetId })`, total mob eliminated | Abaikan target di luar jarak perimeter 4.5m | `ORIGINAL_REQUEST §R3`, `constants.js` |
| 11 | Tugas Pertarungan | Weapon Cooldown Pacing | Menegakkan jeda serangan senjata minimum (pedang $\ge 625$ms, kapak $\ge 1000$ms) | `weapon: 'sword' \| 'axe', attackTimestamps: number[]` | Interval serangan $\ge 625$ms | Assertion error `Spam Attack terdeteksi` jika $\Delta t < 625$ms | `constants.js`, `assertions.js` |
| 12 | Tugas Pertarungan | Pengumpulan Bola XP & Loot | Mendeteksi drop XP (+5 per zombie) dan mengambil daging busuk/besi | `xpOrbs, droppedItems` | Kenaikan `xp.points`, `xp.level`, tas bot | Batasi kapasitas tas bot, hindari drop saat penuh | `ORIGINAL_REQUEST §R3`, `test_zombie_combat_xp.js` |
| 13 | Web Dashboard | Express REST API Port 8080 | Menyediakan endpoint status, kontrol aksi, dan eksekusi benchmark | HTTP requests (`/api/status`, `/api/command`, dll) | JSON response `{ success: bool, data: {...} }` | HTTP 400/409/500 dengan payload error terstruktur | `webServer.js`, `PROJECT.md §M4` |
| 14 | Web Dashboard | Siaran Real-Time WebSocket | Menyiarkan event `TICK_UPDATE`, `BENCHMARK_STATUS`, `AI_ACTION_EVENT` | Payload event broadcast | Siaran ke seluruh klien aktif (readyState=1) | Isolasi error parsing JSON, penutupan soket bersih saat teardown | `webServer.js`, `wsTestHelper.js` |
| 15 | Antarmuka & UX | Tipografi Google Fonts Poppins | Memuat dan menerapkan font Poppins di seluruh elemen UI dasbor | CSS stylesheet `@import Poppins` | Tampilan visual tipografi modern | Assertion failure jika font Poppins absen | `RULE[user_global]`, `style.css` |
| 16 | Antarmuka & UX | Design Tokens AppColors | Menerapkan tema gelap baku `#13131A`, `#1A1A24`, `#6C63FF` | CSS custom properties `:root` | Konsistensi palet warna dark mode | Assertion failure jika variabel warna hilang | `RULE[user_global]`, `style.css` |
| 17 | Antarmuka & UX | Lokalisasi 100% Bahasa Indonesia | Seluruh teks UI, status badge, tombol aksi, dan log terminal | String konten antarmuka | 100% Bahasa Indonesia baku | Assertion failure jika terdapat label non-Indonesia | `RULE[user_global]`, `index.html` |
| 18 | Database & Audit | PostgreSQL Telemetry Ingestion | Menyimpan hasil benchmark, log telemetri, dan 20 Hz tick movement | `run_id, tick, coordinates, velocity, stuck_status` | Rekaman tabel `benchmark_runs`, `telemetry_logs`, `movement_action_logs` | Fallback buffering saat transient disconnect database | `telemetryRepository.js`, `dbTestHelper.js` |

---

## 3. Edge Cases & Boundary Conditions

| # | Fitur | Input / Kondisi Ekstrem | Perilaku yang Diharapkan |
|---|---|---|---|
| 1 | Handshake Protokol 775 | Klien mencoba login dengan nomor protokol lama (misal 767 / 1.21.1) | Server menolak koneksi dengan pesan: `"Outdated client! Please use 26.1.2"`. Klien harus melempar error tertangani. |
| 2 | Detak Jantung (Keep-Alive) | Paket `keep_alive` tidak dibalas selama 30 detik (simulasi lag jaringan) | Server memutuskan koneksi dengan alasan `"Timed out"`. Klien memicu event `end` dan mencatat status disconnect ke database. |
| 3 | Pergerakan Protokol 775 | Paket posisi dikirim dengan format boolean lama `{ onGround: true }` | ProtoDef melempar `TypeError: Cannot read properties of undefined (reading '_value')`. Klien wajib menggunakan wrapper `MovementFlags`. |
| 4 | SLP Ping Verifier | Server offline / port tidak terbuka | `querySLP` melempar error timeout yang informatif dalam Bahasa Indonesia: `"Koneksi ke server SLP batas waktu terlampaui (timeout)"`. |
| 5 | SLP Ping Verifier | Server online tapi 0 pemain (`players.online = 0`, `players.sample = []`) | `verifyBotOnline` mengembalikan `{ isOnline: false, playerCount: 0, inSample: false }` tanpa melempar exception fatal. |
| 6 | SLP Ping Verifier | Server memiliki daftar pemain penuh (`players.online = 20/20`) tanpa nama bot | `verifyBotOnline` mengembalikan `{ isOnline: true, playerCount: 20, inSample: false }`. |
| 7 | Persistent Presence | Bot menerima spam paket teleportasi dari server | Bot membalas setiap `teleport_confirm` secara berurutan dengan `teleportId` masing-masing tanpa terjadi race condition. |
| 8 | Zombie Farming | Target zombie berada di luar jangkauan (> 4.5 meter) | Bot tidak melancarkan serangan (mencegah swing kosong) dan mengarahkan pandangan `lookAt` ke target terlebih dahulu. |
| 9 | Weapon Cooldown | Serangan dipanggil dengan jeda < 625ms (spam-click) | Test assertion `assertAttackPacing` menangkap pelanggaran jeda dan melempar pesan kesalahan dalam Bahasa Indonesia. |
| 10 | XP Collection | Nilai XP mencapai batas kenaikan level (misal kelipatan 7 poin) | `experience.points` bertambah, dan `experience.level` terhitung secara akurat tanpa pembulatan desimal. |
| 11 | Web Dashboard WebSocket | Klien mengirim pesan non-JSON atau format rusak | Server membalas paket `{ type: 'ERROR', data: { pesan: 'Format pesan WebSocket harus berupa JSON yang valid.' } }` tanpa crash. |
| 12 | Web Dashboard Port Conflict | Port 8080 sedang digunakan proses lain saat start | Server mock atau launcher menerapkan fallback auto-retry / port increment tanpa melempar uncaught `EADDRINUSE`. |

---

## 4. Rincian Spesifikasi Teknis Mendalam (Deep Dive Specifications)

### 4.1 Modul 1: Protocol 775 & NeoForge 26.1.2 Live Client Handshake

#### A. Alur Protokol & State Machine
1. **State 0: Handshaking**:
   - Paket `set_protocol`:
     ```json
     {
       "protocolVersion": 775,
       "serverHost": "atoms-girl.tun.ply.gg",
       "serverPort": 25565,
       "nextState": 2
     }
     ```
2. **State 2: Login**:
   - Klien mengirim `login_start: { username: "Bot_Petani_AI" }`.
   - Server mengirim `set_compression: { threshold: 256 }` $\to$ Zlib decompression diaktifkan.
   - Server mengirim `login_success: { uuid: "...", username: "Bot_Petani_AI", properties: [] }`.
   - Klien mengirim `login_acknowledged: {}` $\to$ Transisi ke State 3.
3. **State 3: Configuration**:
   - Server mengirim `custom_payload: { channel: "minecraft:brand", data: Buffer("vanilla") }`.
   - Server mengirim `feature_flags: { flags: [] }`.
   - Server mengirim `select_known_packs: { packs: [] }` $\to$ Klien membalas `select_known_packs: { packs: [] }`.
   - Server mengirim 28 paket `registry_data` (termasuk `minecraft:dimension_type`, `minecraft:damage_type`, `minecraft:enchantment`, `minecraft:world_clock`, `minecraft:timeline`, dll.).
   - Server mengirim `tags: { tags: [...] }`.
   - Server mengirim `finish_configuration: {}` $\to$ Klien membalas `finish_configuration: {}` $\to$ Transisi ke State 4.
4. **State 4: Play**:
   - Server mengirim `login: { entityId: 101, isHardcore: false, dimensionNames: [...], maxPlayers: 20, viewDistance: 10, ... }`.
   - Server mengirim `position: { x: -36.5, y: 64.0, z: 6.5, yaw: 0, pitch: 0, teleportId: 1 }`.
   - Klien membalas:
     1. `teleport_confirm: { teleportId: 1 }`
     2. `player_loaded: {}`
     3. `position_look: { x: -36.5, y: 64.0, z: 6.5, yaw: 0, pitch: 0, flags: { onGround: true, hasHorizontalCollision: false } }`
   - Klien menangani paket `keep_alive: { keepAliveId: N }` dengan membalas `keep_alive: { keepAliveId: N }`.

---

### 4.2 Modul 2: Programmatic SLP Ping Verification Engine (`src/network/slpVerifier.js`)

#### A. Kontrak Antarmuka
```javascript
/**
 * Melakukan Server List Ping (SLP) secara terprogram ke server target.
 * @param {Object} options
 * @param {string} options.host - Host server target ('atoms-girl.tun.ply.gg')
 * @param {number} [options.port=25565] - Port server target
 * @param {number} [options.timeoutMs=5000] - Batas waktu timeout query
 * @returns {Promise<{ version: { name: string, protocol: number }, players: { online: number, max: number, sample: Array<{ id: string, name: string }> }, description: string|object, latencyMs: number }>}
 */
async function querySLP({ host, port = 25565, timeoutMs = 5000 });

/**
 * Memverifikasi apakah bot tertentu terdaftar aktif di server melalui SLP.
 * @param {Object} options
 * @param {string} options.host - Host server target
 * @param {number} [options.port=25565] - Port server target
 * @param {string} options.botUsername - Nama bot yang dicari ('Bot_Petani_AI')
 * @param {number} [options.timeoutMs=5000] - Batas waktu timeout
 * @returns {Promise<{ isOnline: boolean, playerCount: number, inSample: boolean, sample: Array<Object>, latencyMs: number }>}
 */
async function verifyBotOnline({ host, port = 25565, botUsername, timeoutMs = 5000 });
```

#### B. Asersi & Kriteria Keberhasilan SLP
- `assert.ok(slpResult.players.online >= 1, 'Jumlah pemain aktif pada SLP harus minimal 1 (players.online >= 1).')`
- `assert.ok(slpResult.inSample === true, 'Nama bot harus terdaftar dalam daftar sampel pemain aktif (players.sample).')`
- `assert.equal(slpResult.version.protocol, 775, 'Protokol server yang dilaporkan SLP harus 775.')`
- `assert.ok(slpResult.latencyMs < 1000, 'Latensi respon SLP harus kurang dari 1000ms.')`

---

### 4.3 Modul 3: Persistent Presence, Zombie Farming & XP Engine (`src/tasks/zombieSpawnerTask.js`)

#### A. Kontrak Status & Siklus Hidup
```javascript
/**
 * Mengembalikan snapshot status aktivitas farming mob.
 * @returns {{ active: boolean, targetCoords: { x: number, y: number, z: number }, zombiesKilled: number, totalHits: number, xpGained: number, currentXP: number, currentLevel: number, inventoryLoot: Object.<string, number>, lastAttackTime: number }}
 */
function getTaskStatus();
```

#### B. Parameter Mekanika Pertarungan & Cooldown
- **Target Koordinat Spawner**: `x = -256, y = -20, z = -432` (Layer Deepslate Bawah Tanah).
- **Target Mob**: `zombie`, `zombie_villager`, `husk`, `drowned`.
- **Batas Jarak Serang**: $d \le 4.5$ meter.
- **Diamond Sword Cooldown**: $625$ milidetik (Pacing aman: $630$ ms).
- **Diamond Sword Damage**: $7$ HP per tebasan ($20$ HP zombie membutuhkan $3$ tebasan).
- **XP Yield**: $+5$ poin XP per zombie yang tereliminasi.
- **Kalkulasi Level**: $\text{level} = \lfloor \text{xp} / 7 \rfloor$.
- **Loot Drop**: `rotten_flesh` ($1 - 2$ buah), `iron_ingot` (rare drop $1$ buah).

#### C. Asersi Validasi Pertarungan & XP
- `assertAttackPacing(attackTimestamps, 625)`: Menolak penyerangan berulang dalam waktu $< 625$ ms.
- `assert.ok(xpGained > 0, 'Bot harus memperoleh kenaikan poin XP setelah mengeliminasi zombie.')`
- `assert.equal(zombiesKilled, expectedKills, 'Seluruh target zombie harus tereliminasi sempurna.')`

---

### 4.4 Modul 4: Web Dashboard & WebSocket Broadcaster (Port 8080)

#### A. REST API Endpoints Matrix
| Method | Endpoint | Request Body | Response Body | Deskripsi |
|---|---|---|---|---|
| `GET` | `/` | None | HTML Document (200 OK) | Menyajikan UI Dasbor Pengendali |
| `GET` | `/api/status` | None | `{ success: true, data: { bot, isRunningBenchmark, connectedClients, uptime } }` | Mengambil ringkasan status bot & server |
| `GET` | `/api/telemetry` | None | `{ success: true, data: { botStatus, lastUpdate } }` | Mengambil telemetri bot real-time |
| `GET` | `/api/benchmarks` | None | `{ success: true, data: [ ...results ] }` | Mengambil riwayat hasil pengujian |
| `POST` | `/api/command` | `{ action: "FARM_ZOMBIE" \| "SORT_CHESTS" \| ... }` | `{ success: true, data: { message, bot } }` | Memicu perintah langsung dari browser |
| `POST` | `/api/benchmark/start` | `{ level: 1 \| 2 \| 3 \| 4 }` | `{ success: true, data: { message } }` | Memulai pengujian tingkat tertentu |
| `POST` | `/api/ai/chat` | `{ prompt: string }` | `{ success: true, data: { message, toolCalls } }` | Mengirim prompt ke DeepSeek AI Brain |

#### B. WebSocket Broadcast Payloads Matrix
| Event Type | Trigger | Payload Structure |
|---|---|---|
| `CONNECTED` | Klien baru terhubung | `{ type: 'CONNECTED', data: { botStatus, benchmarks } }` |
| `TICK_UPDATE` | Detak telemetri (20 Hz / 1 Hz) | `{ type: 'TICK_UPDATE', data: { position, health, mode, velocity, xp, level, tick, timestamp } }` |
| `BENCHMARK_STATUS` | Perubahan status benchmark | `{ type: 'BENCHMARK_STATUS', data: { level, status: 'RUNNING'\|'SUCCESS'\|'FAILED', duration_ms, coordinateDelta } }` |
| `AI_ACTION_EVENT` | Eksekusi tugas AI / Perintah | `{ type: 'AI_ACTION_EVENT', data: { task, step, status: 'RUNNING'\|'SUCCESS'\|'STOPPED', details } }` |

#### C. Standar Lokalisasi & Desain UI
- **Font**: Google Fonts **Poppins** (`font-family: 'Poppins', sans-serif`).
- **Design Tokens (`AppColors`)**:
  - Background: `#13131A` (`--bg: #0F0F14` / `#13131A`)
  - Surface: `#1A1A24` (`--surface: #16161E` / `#1A1A24`)
  - Surface Alt: `#22222E` (`--surface-alt: #1C1C28` / `#22222E`)
  - Accent: `#6C63FF` (`--accent: #6C63FF`)
  - Text Primary: `#EAEAF0` (`--text-primary: #EAEAF0`)
  - Text Sub: `#9999B0` (`--text-sub: #9999B0`)
  - Text Muted: `#66667A` (`--text-muted: #66667A`)
  - Border: `#2A2A36` (`--border: #2A2A36`)
  - Status: Success `#4CAF50`, Danger `#EF5350`, Warning `#FF9800`
- **Lokalisasi Wajib Bahasa Indonesia**: Seluruh label navigasi, tombol kontrol, status badge, dan pesan kesalahan wajib dalam Bahasa Indonesia.

---

## 5. Matriks Asersi Uji Lengkap (Assertion & Test Specification Matrix)

### Matriks Pengujian Komprehensif

| ID Uji | Target Spesifikasi | Kondisi / Input | Asersi & Perilaku yang Diverifikasi | Pesan Kegagalan Asersi (Bahasa Indonesia) |
|---|---|---|---|---|
| **E2E-P01** | Handshake Protokol 775 | Hubungkan ke `atoms-girl.tun.ply.gg:25565` dengan protokol 775 | `client.state === 'play'`, `client.entityId !== undefined` | `"Gagal menyelesaikan siklus hidup Handshake Protokol 775 menuju State Play."` |
| **E2E-P02** | 28 Registry Data Packets | Parsing paket konfigurasi server 26.1.2 | `registriesReceived.length >= 28`, `tagsReceived === true` | `"Fase konfigurasi gagal memproses 28 paket registry data."` |
| **E2E-P03** | Keepalive Echo | Terima paket `keep_alive` dari server | Waktu respons $< 500$ms, `responseId === receivedId` | `"Gagal merespons detak jantung keepalive secara tepat waktu."` |
| **E2E-P04** | Teleport Confirmation | Terima paket posisi dengan `teleportId: 5` | Kirim `teleport_confirm: { teleportId: 5 }` sebelum update posisi | `"Konfirmasi teleportasi teleportId tidak sesuai dengan paket posisi server."` |
| **E2E-P05** | MovementFlags Format | Kirim update posisi bot ke server | Payload memuat `flags: { onGround: true, hasHorizontalCollision: false }` | `"Paket pergerakan tidak menggunakan skema MovementFlags Protokol 775."` |
| **E2E-S01** | SLP Query Response | Query SLP ke `atoms-girl.tun.ply.gg:25565` | `res.version.protocol === 775`, `typeof res.latencyMs === 'number'` | `"Respon SLP gagal mengembalikan data versi protokol 775."` |
| **E2E-S02** | SLP Player Count Active | Bot terhubung secara aktif di server | `res.players.online >= 1` | `"Verifikasi SLP gagal: Jumlah pemain aktif kurang dari 1 (players.online < 1)."` |
| **E2E-S03** | SLP Player Sample Match | Bot terhubung dengan username `Bot_Petani_AI` | `res.players.sample.some(p => p.name === 'Bot_Petani_AI') === true` | `"Nama bot tidak ditemukan pada daftar sampel pemain aktif (players.sample)."` |
| **E2E-C01** | 60s+ Persistent Presence | Jalankan bot di live server selama 60 detik | `durationMs >= 60000`, `disconnectCount === 0`, `kicked === false` | `"Bot gagal mempertahankan presensi stabil 60 detik tanpa disconnect/kick."` |
| **E2E-C02** | Target Spawner Farm | Rute menuju koordinat spawner farm | `assertCoordinateClose(pos, { x: -256, y: -20, z: -432 }, 0.5)` | `"Jarak koordinat bot melebihi batas toleransi dari target farm spawner."` |
| **E2E-C03** | Weapon Attack Cooldown | Serang 3 zombie berurutan dengan pedang berlian | `assertAttackPacing(timestamps, 625)` | `"Pelanggaran jeda serangan (Spam Attack terdeteksi! Interval < 625ms)."` |
| **E2E-C04** | XP Points & Level Gain | Eliminasi 3 zombie (drop 15 XP) | `xpGained >= 15`, `finalLevel === Math.floor(finalXP / 7)` | `"Perolehan poin XP atau kalkulasi level bot tidak sesuai setelah mengeliminasi zombie."` |
| **E2E-W01** | Web Dashboard Port 8080 | HTTP GET `http://localhost:8080/` | HTTP status 200 OK, `Content-Type: text/html` | `"Server web dasbor gagal merespons pada port 8080."` |
| **E2E-W02** | WebSocket Tick Broadcast | Dengarkan event WebSocket pada port 8080 | `assertWebSocketEvent(event, 'TICK_UPDATE', valFn)` | `"Event WebSocket TICK_UPDATE tidak diterima atau format data tidak valid."` |
| **E2E-W03** | Google Fonts Poppins | Periksa konten HTML dan CSS dasbor | `assertPoppinsFont(cssOrHtml)` | `"Tipografi Google Fonts Poppins tidak terdefinisi pada stylesheet dasbor."` |
| **E2E-W04** | Lokalisasi Bahasa Indonesia | Validasi teks antarmuka dan label status | `assertIndonesianLocalization(html, ['Status Karakter', 'Bantai Zombie'])` | `"Teks antarmuka dasbor tidak memenuhi aturan lokalisasi Bahasa Indonesia."` |
| **E2E-D01** | Telemetry DB Persistence | Rekam hasil uji combat farm ke PostgreSQL | `dbLogs.length >= 1`, `dbLogs[0].level === 'combat_farm'` | `"Telemetri perolehan XP dan loot gagal dicatat ke database PostgreSQL."` |

---

## 6. Standardisasi Lokalisasi Bahasa Indonesia

Sesuai dengan aturan global proyek (`RULE[user_global]`):
1. **Semua Pesan Asersi Uji**: Wajib menggunakan Bahasa Indonesia baku yang informatif, memuat nilai aktual vs nilai yang diharapkan (contoh: *"Verifikasi SLP gagal: Ditemukan 0 pemain aktif, diharapkan minimal 1 pemain."*).
2. **Komentar Kode & Dokumentasi**: Seluruh dokumentasi JSDoc, file header, dan komentar alur kerja ditulis dalam Bahasa Indonesia.
3. **Label Antarmuka Pengguna (UI)**: Seluruh tombol, header, kartu metrik, dan pesan modal ditulis dalam Bahasa Indonesia (contoh: *"Status Karakter / Bot"*, *"Metrik Operasi Otonom"*, *"Bantai Zombie & XP"*, *"Dasbor Pengendali"*).
4. **Log Sistem & Debug**: Diizinkan dalam Bahasa Inggris teknis atau Bahasa Indonesia.

---

## 7. Rencana Integrasi & Verifikasi Mandiri

Untuk memverifikasi spesifikasi ini pada implementasi aktual:
1. **Eksekusi SLP Verification Test**:
   ```bash
   node test/network/verify_slp.js
   ```
2. **Eksekusi Zombie Combat & XP Verification Test**:
   ```bash
   node test/e2e/test_zombie_combat_xp.js
   ```
3. **Eksekusi Master Test Runner 4-Tier**:
   ```bash
   node test/runner.js
   ```
4. **Eksekusi Pemeriksaan Lokalisasi & Tipografi**:
   ```bash
   node test/e2e/e2e_telemetry_test.js
   ```
