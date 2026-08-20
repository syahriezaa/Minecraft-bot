# Laporan Handoff Explorer 3 (Milestone 3: System Integration, AI Planner & Test Verification)

## 1. Observation (Pengamatan Empiris)

1. **Struktur Codebase AI & Perencanaan Tugas**:
   - Berkas `src/ai/taskPlanner.js` (baris 1–255) mendefinisikan kelas `TaskPlanner` dengan metode `attach(bot, movementController)`, `executeToolCalls(toolCalls)`, `_executeNavigate(args)`, `_executeFarmMobs(args)`, `_executeSortChests(args)`, dan `_executeIncinerateThrash(args)`.
   - `TaskPlanner` menggunakan konstanta `WEAPON_COOLDOWNS_MS` dari `src/config/constants.js` (baris 88–97: `sword: 625ms`, `axe: 1250ms`, `default: 625ms`).
   - Saat ini `_executeFarmMobs` di `taskPlanner.js` (baris 121–149) masih berupa implementasi monolitik dasar berbasis `bot.nearestEntity` dan `bot.attack` tanpa modul khusus `ZombieSpawnerTask`.

2. **Kebutuhan Modul Baru Milestone 3 (`SCOPE.md` & `PROJECT.md`)**:
   - `src/tasks/zombieSpawnerTask.js`:
     * Target spawner di `TARGET_SPAWNER_COORDINATES = { x: -256, y: -20, z: -432 }` (`src/config/constants.js:63-67`).
     * Pacing senjata $\ge 625$ms untuk pedang.
     * Pelacakan XP dan kenaikan level (`experience.points` dan `experience.level`).
     * Manajemen vitalitas (makan otomatis jika lapar/darah turun, mundur jika HP $< 6$).
     * Interface status `getTaskStatus()`.
   - `src/tasks/persistentCompanion.js`:
     * Supervisi siklus hidup bot dan penjagaan kehadiran $\ge 60$ detik pada server live `atoms-girl.tun.ply.gg:25565`.
     * Loop anti-AFK micro-motion / micro-rotation (penyesuaian yaw/pitch berkala dan koordinat mikro via bitflags `MovementFlags`).
     * Watchdog keepalive paket protokol 775 (Play 0x1c -> respons Play 0x1c).
     * State machine rekoneksi otomatis dengan exponential backoff dan jitter.
     * Kompatibilitas ganda: `LiveProtocolClient` (live server) dan `MockArenaHarness` (test harness).

3. **Infrastruktur Persistensi & Telemetri**:
   - `src/database/telemetryRepository.js` (baris 1–575): Menyediakan fungsi penyimpanan PostgreSQL `createBenchmarkRun`, `updateBenchmarkRunStatus`, `logTelemetrySummary`, `logMovementActionBatch` (via UNNEST), dan `logActionAudit`.
   - `src/database/batchIngestion.js` (baris 1–319): Mengelola buffer memori (kapasitas 5000 item), interval flush timer 250ms, ambang batas batch 50 item, dan mekanisme shadow retention buffer dengan exponential backoff saat database terputus.
   - `test/helpers/dbTestHelper.js` & `src/config/database.js`: Mengelola koneksi database PostgreSQL 17 port 5432 ke database `minecraft_companion`.

4. **Infrastruktur Pengujian yang Sudah Ada**:
   - `test/runner.js`: Master test runner mandiri dengan dukungan flag `--tier`, `--bail`, `--json`, `--timeout`, dan `--filter`.
   - `test/e2e/test_zombie_combat_xp.js`: Verifikasi eksekusi pertarungan 3 zombie di spawner `[-256, -20, -432]`, verifikasi jeda 630ms $\ge 625$ms, $+15$ XP, level up ke Level 2, dan persistensi log ke PostgreSQL.
   - Status pengujian eksisting: `node test/runner.js` mengeksekusi 163/163 kasus uji (Tier 1: 70, Tier 2: 70, Tier 3: 16, Tier 4: 7) dengan kelulusan 100% dalam waktu 15.38 detik.
   - `test/mutation_verifier.js` & `test/fault_injection_verifier.js`: Membuktikan asersi bebas dari false-positive dan vacuous pass (100% mutasi dan sabotase tertangkap).

---

## 2. Logic Chain (Rantai Penalaran & Desain Integrasi)

1. **Rantai Integrasi AI Brain ↔ Spawner Task ↔ Persistent Companion**:
   - *Langkah 1*: `PersistentCompanion` bertindak sebagai orchestrator runtime level bot. Ia memegang instance klien jaringan (`LiveProtocolClient` atau Mock Bot) dan menginisialisasi `TaskPlanner` serta `ZombieSpawnerTask`.
   - *Langkah 2*: Ketika `TaskPlanner` menerima tool call `farm_mobs` (dari DeepSeek AI Brain atau REST API), `TaskPlanner` mendelegasikan eksekusi langsung ke instance `ZombieSpawnerTask`.
   - *Langkah 3*: `ZombieSpawnerTask` mengarahkan bot menuju `TARGET_SPAWNER_COORDINATES` `[-256, -20, -432]`, mengunci entitas zombie di kill chamber, melakukan serangan dengan penegakan cooldown 625ms, memungut drop loot dan XP orbs, serta memantau HP/food.
   - *Langkah 4*: Selama proses farming berlangsung, `PersistentCompanion` menjalankan background watchdog untuk memastikan keep-alive dijawab tepat waktu dan melakukan anti-AFK micro-rotation ketika bot berada dalam status IDLE menunggu spawn mob.
   - *Langkah 5*: Event yang dipancarkan oleh `ZombieSpawnerTask` (`mob_attacked`, `mob_killed`, `xp_collected`, `vitality_warning`) ditangkap oleh `PersistentCompanion`, yang kemudian merelay event tersebut ke `BatchIngestionService` (PostgreSQL) dan `webServer` (WebSocket port 8080 untuk dashboard).

2. **Rantai Persistensi Telemetri & Ketahanan Jaringan**:
   - *Langkah 1*: Setiap tick 50ms (20 Hz) dan setiap aksi audit (serangan, kill, xp, loot) dikirim ke `BatchIngestionService.ingestTick()` dan `telemetryRepository.logActionAudit()`.
   - *Langkah 2*: `BatchIngestionService` menampung data dalam antrean memori FIFO. Jika jumlah antrean $\ge 50$ item atau timer 250ms tercapai, data di-flush ke PostgreSQL via query `UNNEST` berkecepatan tinggi.
   - *Langkah 3*: Jika koneksi PostgreSQL putus, `BatchIngestionService` mempertahankan data dalam *shadow ring buffer* (maks 5000 item), mengaktifkan retry exponential backoff (500ms hingga 5000ms), dan melakukan flush otomatis begitu koneksi pulih tanpa ada data yang hilang (*zero data loss*).

3. **Strategi Desain Pengujian Komprehensif Milestone 3**:
   - **Unit Testing `zombieSpawnerTask.test.js`**:
     * *UT-ZST-01*: Validasi koordinat spawner tepat di `[-256, -20, -432]`.
     * *UT-ZST-02*: Penegakan cooldown serangan senjata (pedang berlian $\ge 625$ms, kapak $\ge 1250$ms, penolakan spam serangan $< 625$ms).
     * *UT-ZST-03*: Akumulasi XP dan kalkulasi level Minecraft pasca pembunuhan mob (Level 1 pada 7 XP, Level 2 pada 16 XP).
     * *UT-ZST-04*: Pemungutan loot inventaris (`rotten_flesh`, `iron_ingot`).
     * *UT-ZST-05*: Mekanika vitalitas & auto-retreat saat HP kritis ($< 6$).
     * *UT-ZST-06*: Interface pelaporan `getTaskStatus()`.
   - **Unit Testing `persistentCompanion.test.js`**:
     * *UT-PC-01*: Verifikasi keberlangsungan hidup bot $\ge 60$ detik tanpa disconnect/kick.
     * *UT-PC-02*: Eksekusi anti-AFK micro-rotation (variasi pitch/yaw tanpa mengganggu pergerakan).
     * *UT-PC-03*: Watchdog keep-alive (respons instan terhadap packet keepalive ID).
     * *UT-PC-04*: Auto-reconnect state machine saat socket error atau disconnect tidak terduga.
     * *UT-PC-05*: Adaptasi dual-mode (`LiveProtocolClient` vs `MockArenaHarness`).
   - **Integration Testing `ai_taskPlanner_integration.test.js`**:
     * *IT-M3-01*: Alur perintah DeepSeek AI `farm_mobs` $\to$ delegasi ke `ZombieSpawnerTask` $\to$ pemenuhan target farming.
     * *IT-M3-02*: Aliran telemetri real-time: `ZombieSpawnerTask` $\to$ `PersistentCompanion` $\to$ `BatchIngestionService` (PostgreSQL) & WebSocket broadcaster.
     * *IT-M3-03*: Transisi multi-tugas: Farming $\to$ Sorting Peti $\to$ Insinerasi Sampah.

---

## 3. Caveats (Batasan & Asumsi)

1. **Ketersediaan Server Live**:
   - Pengujian live server bergantung pada status server NeoForge 26.1.2 di `atoms-girl.tun.ply.gg:25565`. Jika server sedang offline, pengujian unit dan integrasi offline dijalankan menggunakan `MockArenaHarness` yang 100% deterministik.
2. **Koneksi Database PostgreSQL**:
   - Sistem memiliki fallback in-memory shadow buffer jika PostgreSQL port 5432 tidak aktif, namun untuk pengujian telemetri penuh, PostgreSQL 17 direkomendasikan tetap aktif.
3. **Standar Bahasa & Tipografi**:
   - Semua pesan error user, log, dan komentar kode diwajibkan menggunakan Bahasa Indonesia baku sesuai `RULE[user_global]`.

---

## 4. Conclusion (Kesimpulan & Rekomendasi Implementasi)

1. **Pemisahan Modul Bersih**:
   - Buat direktori `src/tasks/` dengan dua file utama:
     * `src/tasks/zombieSpawnerTask.js`: Mengisolasi logika farming, cooldown senjata, targeting, perolehan XP/loot, dan status `getTaskStatus()`.
     * `src/tasks/persistentCompanion.js`: Mengisolasi lifecycle bot, watchdog keepalive, anti-AFK micro-motion, auto-reconnect, dan event relay.
2. **Penyelarasan `src/ai/taskPlanner.js`**:
   - Hubungkan `TaskPlanner` dengan `ZombieSpawnerTask` pada metode `_executeFarmMobs()` agar mendelegasikan tugas ke modul spesialis alih-alih mengeksekusi logika pertarungan mentah secara langsung.
3. **Penyelarasan Suite Pengujian**:
   - Buat suite pengujian baru di `test/unit/` atau perluas `test/e2e/` untuk memverifikasi secara khusus fitur-fitur Milestone 3 (Farming spawner, weapon cooldowns, perolehan XP, anti-AFK micro-rotation, 60s+ persistent presence, dan integrasi AI Planner).
   - Seluruh suite pengujian harus terintegrasi dengan `test/runner.js` dan menjamin kelulusan 100% (exit code 0).

---

## 5. Verification Method (Metode Verifikasi Independen)

Untuk memverifikasi secara independen kebenaran investigasi dan rancangan pengujian ini, jalankan perintah berikut:

1. **Jalankan Master E2E Test Runner**:
   ```bash
   node test/runner.js
   ```
   *Ekspektasi*: 163/163 kasus uji lulus 100% (exit code 0).

2. **Jalankan Verifikasi Pertarungan Zombie & Perolehan XP**:
   ```bash
   node test/e2e/test_zombie_combat_xp.js
   ```
   *Ekspektasi*: Pacing serangan 630ms $\ge 625$ms, $+15$ XP terakumulasi, Level naik ke Level 2, dan log tercatat di database (exit code 0).

3. **Jalankan Verifikasi Mutasi & Adversarial**:
   ```bash
   node test/mutation_verifier.js
   ```
   *Ekspektasi*: 48/48 kasus mutasi tertangkap (100% caught, exit code 0).

4. **Kondisi Invalidasi (Invalidation Conditions)**:
   - Terjadi pelanggaran jeda serangan senjata ($< 625$ms untuk pedang).
   - Kegagalan pencatatan XP dan loot pada bot saat zombie mati.
   - Kegagalan menjaga koneksi $\ge 60$ detik pada server live.
   - Kegagalan penanganan disconnect pada `BatchIngestionService` yang menyebabkan data telemetri hilang.
