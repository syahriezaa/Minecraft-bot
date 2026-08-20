# Rencana Desain Harness Pengujian & Uji Standalone E2E
## Minecraft Autonomous Companion (NeoForge 26.1.2 / Protocol 775)

Dokumen ini memuat analisis mendalam dan spesifikasi arsitektur pengujian untuk sistem **Minecraft Autonomous Companion**, mencakup kemampuan uji mandiri (*standalone testability*), desain harness mock/oracle ganda (*dual-mode offline/live*), semantik eksekusi CLI master test runner, serta matriks perancangan kasus uji Tier 2 (Boundary & Corner), Tier 3 (Cross-Feature Pairwise), dan Tier 4 (Real-World Workloads).

---

## 1. Arsitektur Dual-Mode Test Runner & Mock/Oracle Harness

Sistem pengujian dirancang menggunakan pendekatan *opaque-box testing* berbasis Node.js native tanpa dependensi testing framework eksternal yang berat. Runner mendukung **dua mode eksekusi**:
1. **Mode Offline (In-Memory Mock / Simulated Socket)**: Untuk verifikasi cepat unit, integrasi komponen, dan seluruh suite Tier 1–4 tanpa memerlukan koneksi internet atau server Minecraft fisik.
2. **Mode Live (`atoms-girl.tun.ply.gg:25565`)**: Untuk validasi integrasi akhir langsung ke server nyata NeoForge 26.1.2.

```
+----------------------------------------------------------------------------------------------------+
|                      ARSITEKTUR DUAL-MODE TEST RUNNER & ORACLE HARNESS                             |
+----------------------------------------------------------------------------------------------------+
|                                                                                                    |
|                       ┌────────────────────────────────────────────────────┐                       |
|                       │        MASTER TEST RUNNER (test/runner.js)         │                       |
|                       │  Flags: --tier, --mode <offline|live>, --json, ... │                       |
|                       └─────────────────────────┬──────────────────────────┘                       |
|                                                 │                                                  |
|                        Mode Selector: process.env.TEST_MODE / CLI Flag                             |
|                                                 │                                                  |
|                   ┌─────────────────────────────┴─────────────────────────────┐                    |
|                   ▼                                                           ▼                    |
|   ┌──────────────────────────────────────────────┐     ┌───────────────────────────────────────┐   |
|   │         OFFLINE MOCK / ORACLE HARNESS        │     │         LIVE INTEGRATION HARNESS      │   |
|   │               (test/helpers/)                │     │            (src/network/)             │   |
|   ├──────────────────────────────────────────────┤     ├───────────────────────────────────────┤   |
|   │ • mockArenaHarness.js (Dunia Voxel In-Memory)│     │ • liveProtocolClient.js               │   |
|   │ • mockProtocolServer.js (Simulasi TCP 775)   │     │   (Koneksi Nyata Protocol 775)        │   |
|   │   - Handshake -> Login -> Config -> Play     │     │ • slpVerifier.js                      │   |
|   │   - 28 Registry Packets & Tags               │     │   (SLP Query ke atoms-girl.tun.ply.gg)│   │
|   │   - Keep-alive Ping/Pong Emulation           │     │ • 60s+ Persistent Heartbeat Loop      │   |
|   │ • mockSLPResponder.js (JSON Status Provider) │     │ • Spawner Task [-256, -20, -432]      │   |
|   │ • dbTestHelper.js (PostgreSQL Mock/Buffer)   │     │ • Live Telemetry Streamer             │   |
|   │ • wsTestHelper.js (Express/WS Port 8080-8085)│     │ • Web Dashboard Port 8080             │   |
|   │ • mockAIProvider.js (DeepSeek Brain Mock)    │     │ • PostgreSQL 17 Live Ingestion        │   |
|   └──────────────────────────────────────────────┘     └───────────────────────────────────────┘   |
|                                                                                                    |
+----------------------------------------------------------------------------------------------------+
```

### A. Mekanika Mode Offline (Fast In-Memory / Simulated Packets)
- **Simulasi Socket TCP Protocol 775**:
  - Mengemulasikan siklus hidup paket Protocol 775:
    1. *Handshake State (0x00)*: Menyetujui versi protokol 775.
    2. *Login State*: Menerima `login_start`, membalas `login_success` dengan UUID bot dan properti.
    3. *Configuration State*: Mengirimkan 28 paket `registry_data` (dimension_type, worldgen, chat_type, dll), paket `tags`, paket `known_packs`, serta bertukar `finish_configuration`.
    4. *Play State*: Mengirim `login (play)`, `teleport_confirm`, `player_loaded`, dan merespon `keep_alive` secara berkala.
  - Mengemulasikan entitas zombie di sekitar target spawner `[-256, -20, -432]` dan entitas bola XP (*experience orbs*).
- **Simulasi SLP (Server List Ping)**:
  - Menyediakan respons JSON SLP instan:
    ```json
    {
      "version": { "name": "NeoForge 1.21.1", "protocol": 775 },
      "players": {
        "max": 20,
        "online": 1,
        "sample": [{ "id": "00000000-0000-0000-0000-000000000001", "name": "Bot_Petani_AI" }]
      },
      "description": { "text": "A Minecraft Server" }
    }
    ```
- **Karakteristik Kunci**:
  - Nol ketergantungan jaringan luar.
  - Kecepatan eksekusi sangat tinggi (< 2 detik untuk seluruh suite).
  - Determinisme 100% dan bebas *race condition*.

### B. Mekanika Mode Live (`atoms-girl.tun.ply.gg:25565`)
- **Koneksi Jaringan Nyata**:
  - Menghubungkan bot via TCP socket ke host `atoms-girl.tun.ply.gg` port `25565`.
  - Melakukan handshake FML/NeoForge 26.1.2 (protokol 775) dan melewati fase konfigurasi dengan server produksi.
- **SLP Ping & Validasi Pemain Aktif**:
  - Mengirim packet SLP handshake & status request secara independen ke server.
  - Memvalidasi asersi `players.online >= 1`.
  - Memverifikasi keberadaan username bot pada daftar `players.sample`.
- **Ketahanan Live 60 Detik+**:
  - Menjaga koneksi bot aktif selama $\ge 60$ detik berturut-turut tanpa terkena kick, disconnect, atau timeout.
  - Melakukan farming zombie pada koordinat spawner `[-256, -20, -432]`, mengumpulkan XP, dan memancarkan data ke Web Dashboard port 8080.

---

## 2. Spesifikasi Perintah Eksekusi CLI & Semantik Pelari Uji (`test/runner.js`)

### A. Perintah Eksekusi CLI

```bash
# 1. Menjalankan seluruh 4 tier dalam mode default (offline/mock)
node test/runner.js

# 2. Menjalankan tier tertentu secara modular
node test/runner.js --tier 1
node test/runner.js --tier 2
node test/runner.js --tier 3
node test/runner.js --tier 4

# 3. Menjalankan kombinasi beberapa tier
node test/runner.js --tier 1,2
node test/runner.js --tier 3,4

# 4. Menjalankan dengan opsi berhenti pada kegagalan pertama (Fail-Fast / Bail)
node test/runner.js --bail

# 5. Menjalankan dengan filter ekspresi reguler (Regex Filter)
node test/runner.js --filter "spawner|cooldown|boundary"

# 6. Menjalankan dengan format output terstruktur JSON (untuk integrasi CI/CD)
node test/runner.js --json

# 7. Menjalankan dengan kustomisasi batas waktu (Timeout)
node test/runner.js --timeout 20000

# 8. Menjalankan uji live presence & SLP ke server nyata
node test/verify_slp.js
node src/connect_live_server.js
```

### B. Semantik Exit Code & Output Summary

| Exit Code | Kondisi | Keterangan |
|:---:|---|---|
| `0` | **100% Lulus (PASSED)** | Seluruh kasus uji pada tier yang dipilih berhasil lulus tanpa kegagalan (0 failed) dan total uji $> 0$. |
| `1` | **Ada Kegagalan (FAILED)** | Minimal 1 kasus uji gagal asersi, timeout, error runtime tak tertangani, atau zero tests dijalankan. |

#### Format Laporan Visual Konsol (Bahasa Indonesia):
```text
================================================================================
🚀 MINECRAFT AUTONOMOUS COMPANION — E2E MASTER TEST RUNNER
================================================================================
Node.js Version: v20.x.x | Target Tiers: [1, 2, 3, 4]
================================================================================

📦 MENJALANKAN TIER 1: FEATURE COVERAGE (70 KASUS UJI)
--------------------------------------------------------------------------------
  ✔ T1-F01-01: Inisialisasi Arena Headless pada Port 25565 (12ms)
  ✔ T1-F01-02: Konfigurasi Dunia Voxel dan Blok Spawner [-256, -20, -432] (8ms)
  ...
  ✔ T1-F14-05: Verifikasi Exit Code 0 pada Runner (5ms)

📦 MENJALANKAN TIER 2: BOUNDARY & CORNER CASES (70 KASUS UJI)
--------------------------------------------------------------------------------
  ✔ T2-F01-01: Konflik Port Server (Port Sudah Digunakan / EADDRINUSE) (15ms)
  ✔ T2-F01-02: Pembangkitan Arena di Koordinat Ekstrem Vertikal (Y < -64 atau Y > 320) (4ms)
  ...

📦 MENJALANKAN TIER 3: PAIRWISE CROSS-FEATURE INTERACTIONS (16 KASUS UJI)
--------------------------------------------------------------------------------
  ✔ T3-PAIR-01: Sinkronisasi Lifecycle Headless Arena & Inisialisasi Database (45ms)
  ✔ T3-PAIR-02: Paritas Metrik Real-Time Streaming WebSocket vs PostgreSQL Ingestion (62ms)
  ...

📦 MENJALANKAN TIER 4: REAL-WORLD WORKLOAD SCENARIOS (7 SKENARIO)
--------------------------------------------------------------------------------
  ✔ T4-SCEN-01: Progresi Penuh Kurikulum Benchmark Level 1–4 Otonom (1250ms)
  ✔ T4-SCEN-02: Pipeline Lengkap: Farming, Looting, Sorting & Incineration (820ms)
  ...

================================================================================
📊 RINGKASAN EKSEKUSI PENGUJIAN E2E
================================================================================
Total Pengujian : 163
Lulus (Pass)    : 163 ✔
Gagal (Fail)    : 0 ✖
Waktu Eksekusi  : 4.82 detik
--------------------------------------------------------------------------------
Status Akhir    : SEMUA SUITE LULUS 100% (PASSED) 🎉
================================================================================
```

---

## 3. Desain Kasus Batas & Anomali Tier 2 (Boundary & Corner Cases)

Tier 2 menguji seluruh aspek sistem pada kondisi batas ekstrem, masukan abnormal, kegagalan parsial, dan anomali jaringan/protokol:

| Kode Uji | Domain / Fitur | Skenario Batas (Boundary Case) | Kondisi Masukan Ekstrem | Ekspektasi & Perilaku Sistem | Pesan Asersi Gagal (Bahasa Indonesia) |
|---|---|---|---|---|---|
| **T2-NET-01** | Protocol 775 Handshake | Malformed VarInt / Packet Header Cacat | Paket TCP dengan panjang byte negatif atau VarInt overflow | Koneksi ditolak secara elegan tanpa menyebabkan crash pada event loop | *"Paket malformed gagal diisolasi oleh parser protokol."* |
| **T2-NET-02** | Configuration State | Registry Packets Terpotong (Truncated Registry) | Server/Mock hanya mengirim 14 dari 28 paket registri lalu berhenti | State machine mendeteksi ketidaklengkapan registri dan memicu timeout koneksi terkontrol | *"State machine konfigurasi tidak mendeteksi registri tidak lengkap."* |
| **T2-NET-03** | Port Validation | Port TCP Tidak Valid (< 0, > 65535, atau Port Terpakai) | Mencoba koneksi ke port `-1`, `70000`, atau port dengan konflik `EADDRINUSE` | Sistem melempar exception deskriptif dan menolak inisialisasi | *"Konflik atau port tidak valid tidak memicu error yang sesuai."* |
| **T2-NET-04** | Socket Disconnect | TCP Socket Terputus Tiba-tiba saat Login Phase | Socket mengirim `FIN`/`RST` segera setelah `login_start` | Event `end`/`error` tertangkap, bot beralih ke state `DISCONNECTED` | *"Socket terputus tiba-tiba memicu unhandled rejection."* |
| **T2-SLP-01** | SLP Ping | Daftar Sampel Pemain Kosong (`players.sample = []`) | Respons JSON SLP memiliki `players.online = 0` dan `sample = []` | Verifier mengembalikan `{ isOnline: false, inSample: false }` tanpa melempar TypeError | *"Penguraian sample kosong menyebabkan TypeError."* |
| **T2-SLP-02** | SLP Ping | Latensi Ekstrem / Socket Hanging (> 5000ms) | Server tidak merespon paket status SLP dalam batas timeout | Query SLP dibatalkan secara bersih oleh timeout guard | *"Timeout SLP tidak memutus koneksi socket yang menggantung."* |
| **T2-SLP-03** | SLP Ping | Payload JSON SLP Cacat / Non-JSON String | Server mengembalikan string HTML/teks mentah saat query SLP | Parser menangkap error JSON dan mengembalikan status kegagalan terstruktur | *"Payload SLP cacat menyebabkan crash parser."* |
| **T2-BOT-01** | Vitality Monitoring | Darah Bot Kritis ($HP < 6$) saat Pertarungan | Bot menerima damage hingga sisa HP = 4/20 | Bot menghentikan serangan dan memicu manuver mundur darurat (*emergency retreat*) | *"Bot tidak mundur darurat saat HP kritis di bawah 6."* |
| **T2-BOT-02** | Vitality Monitoring | Lapar Ekstrem ($Food \le 6$) & Auto-Eat | Food level turun ke 5/20 saat inventaris memiliki makanan | Bot otomatis mengonsumsi makanan hingga kenyang | *"Auto-eat tidak terpicu saat level lapar di bawah ambang batas."* |
| **T2-BOT-03** | Navigation | Koordinat Sasaran Jarak Nol ($\Delta d = 0$) | Titik awal bot = Titik target akhir (`[0, 64, 0] -> [0, 64, 0]`) | Status benchmark langsung `SUCCESS` instan dalam durasi $< 50$ms | *"Navigasi jarak nol tidak selesai secara instan."* |
| **T2-BOT-04** | Navigation | Elevasi Vertikal di Luar Batas Dunia ($Y < -64$ atau $Y > 320$) | Target koordinat memiliki $Y = -70$ atau $Y = 350$ | Validasi melempar error batas dunia Minecraft dalam Bahasa Indonesia | *"Koordinat vertikal di luar batas tidak ditolak."* |
| **T2-COMB-01** | Combat Pacing | Pelanggaran Jeda Serangan ($< 625$ms Spam Click) | Serangan dikirim dengan interval $100$ms, $200$ms, $300$ms | Asersi `assertAttackPacing` mendeteksi pelanggaran jeda cooldown pedang | *"Pelanggaran jeda serangan (Spam Attack terdeteksi)!"* |
| **T2-COMB-02** | Combat & Tools | Senjata Utama Patah / Rusak di Tengah Tugas | Durabilitas `iron_sword` habis (0), inventaris memiliki `diamond_sword` | Bot otomatis beralih (*auto-switch*) ke senjata cadangan dan melanjutkan pertarungan | *"Bot tidak beralih ke senjata cadangan saat senjata utama patah."* |
| **T2-CHEST-01**| Multi-Chest Sort | Peti Tujuan Penuh (27 Slot Terisi Penuh) | Seluruh slot pada peti target `chest_drops` terisi 64 item | Bot mengalihkan penyimpanan ke peti cadangan (*overflow chest*) | *"Peti penuh tidak memicu pengalihan ke peti cadangan."* |
| **T2-HAZ-01**  | Trash Disposal | Perimeter Bahaya Dilanggar ($d < 1.0$m dari Kolam Lava) | Posisi bot berada pada jarak $0.5$m dari blok lava | Safety guard mengoreksi posisi bot menjauh ke radius aman minimal $1.5$m | *"Pelanggaran batas perimeter bahaya! Jarak bot ke lava terlalu dekat."* |
| **T2-HAZ-02**  | Trash Disposal | Perlindungan Item Berharga dari Pembakaran | Perintah insinerasi menyertakan `diamond` dan `netherite` | Item berharga ditolak dari pembakaran dan tetap disimpan di tas | *"Item berharga dilindungi dari pembakaran!"* |
| **T2-DB-01**   | PostgreSQL Log | Lonjakan Log Ekstrem ($10.000$ logs/detik) | Buffer log menerima 500 tick pergerakan dalam 50ms | Buffer menguras data secara batch tanpa terjadi kehilangan data (*zero data loss*) | *"Lonjakan log menyebabkan buffer overflow atau data drop."* |
| **T2-DB-02**   | PostgreSQL Log | Proteksi SQL Injection pada Parameter JSONB | Metadata berisi `'); DROP TABLE telemetry_logs; --` | Parameter tersimpan aman sebagai literal JSON string | *"SQL injection berhasil lolos atau merusak skema database."* |
| **T2-WS-01**   | Web Dashboard | Payload WebSocket Cacat / Non-JSON | Klien mengirim string acak `INVALID_RAW_DATA` ke port 8080 | Server menangkap error parsing dan koneksi socket tetap stabil | *"Pesan WebSocket cacat menyebabkan server web crash."* |
| **T2-WS-02**   | Web Dashboard | Beban Klien Bersamaan (10+ WebSocket Klien) | 10 klien tersambung bersamaan dan meminta broadcast telemetri | Seluruh 10 klien menerima event `TICK_UPDATE` secara sinkron | *"Broadcast multi-klien gagal menyinkronkan seluruh klien."* |

---

## 4. Desain Interaksi Lintas Fitur Tier 3 (Cross-Feature Pairwise Interactions)

Tier 3 memvalidasi interaksi bersama (*concurrent & pairwise*) antara dua atau lebih subsistem yang beroperasi secara serentak:

```
+----------------------------------------------------------------------------------------------------+
|                         MATRIKS INTERAKSI LINTAS FITUR TIER 3 (PAIRWISE)                           |
+----------------------------------------------------------------------------------------------------+
|                                                                                                    |
|    [Farming Zombie] <─────── (Pacing & XP) ───────> [XP Orb Collection]                            |
|           │                                                 │                                      |
|   (Cooldown >= 625ms)                                (Level Increments)                            |
|           ▼                                                 ▼                                      |
|    [Live Protocol 775] <──── (Dual Socket Ping) ───> [SLP Ping Verifier]                           |
|           │                                                 │                                      |
|   (Persistent Socket)                                (players.online >= 1)                         |
|           ▼                                                 ▼                                      |
|    [PostgreSQL Buffer] <──── (Batch Ingestion) ────> [Express / WS Port 8080]                      |
|           │                                                 │                                      |
|   (Audit Logs & Path)                                (Dashboard UI Poppins)                        |
|           ▼                                                 ▼                                      |
|    [AI Brain Tool Calling] <── (Sort/Incinerate) ──> [Chest & Hazard Perimeter]                    |
|                                                                                                    |
+----------------------------------------------------------------------------------------------------+
```

### Matriks Rinci Interaksi Tier 3:

1. **T3-PAIR-01: Farming Zombie di Spawner [-256, -20, -432] + Polling Dashboard & WebSocket 20Hz**:
   - *Deskripsi*: Bot mengeksekusi loop pertarungan zombie dengan jeda senjata $\ge 625$ms sambil server web menyiarkan 20 tick per detik ke dashboard.
   - *Kondisi Uji*: 5 klien browser membuka dashboard, polling REST `/api/telemetry/live`, dan mendengarkan event `TICK_UPDATE`.
   - *Verifikasi*: Pacing serangan tetap patuh $\ge 625$ms, tidak ada lag pada frame WebSocket, dan status HP/XP terbarui real-time.

2. **T3-PAIR-02: Live Presence Bot (Protocol 775) + Concurrent SLP Ping Verification**:
   - *Deskripsi*: Bot mempertahankan koneksi TCP persisten di server `atoms-girl.tun.ply.gg:25565` sementara modul verifier SLP melakukan kueri status secara berkala dari koneksi terpisah.
   - *Kondisi Uji*: SLP diping setiap 2 detik selama bot aktif di dunia server.
   - *Verifikasi*: `players.online >= 1` konsisten bernilai benar, `players.sample` memuat nama bot, dan query SLP tidak mengganggu aliran paket keep-alive bot.

3. **T3-PAIR-03: Eliminasi Zombie + Pemungutan Bola XP Real-Time + Pencatatan PostgreSQL**:
   - *Deskripsi*: Setiap kali zombie terbunuh, entitas bola XP muncul pada koordinat spawner; bot bergerak memungut bola XP, menghitung kenaikan level, dan menyimpannya ke tabel `telemetry_logs`.
   - *Kondisi Uji*: 3 gelombang zombie dieliminasi (total 15 XP poin terkumpul).
   - *Verifikasi*: Level bot naik dari 0 menjadi 2 ($Level = \lfloor XP / 7 \rfloor$), dan rekaman telemetri di database memuat nilai XP akhir yang akurat.

4. **T3-PAIR-04: Navigasi Rute Spawner Menembus Lapisan Deepslate + Deteksi Macet 4-Fase**:
   - *Deskripsi*: Bot bergerak dari `[0, 64, 0]` menuju `[-256, -20, -432]`, melewati rintangan dinamis di elevasi negatif ($Y < 0$).
   - *Kondisi Uji*: Injeksi rintangan pada waypoint $X=-50, Y=10, Z=-150$.
   - *Verifikasi*: Detektor macet memicu Fase 2 (strafe detour) dan Fase 3 (re-route), mencapai spawner dengan toleransi $< 0.6$ meter.

5. **T3-PAIR-05: AI Task Planner + Penyortiran 4 Peti + Insinerasi Sampah ke Kolam Lava**:
   - *Deskripsi*: DeepSeek AI menerima perintah teks Bahasa Indonesia, merumuskan 4 langkah kerja, memisahkan drop senjata/mineral ke peti, dan membuang kentang beracun ke lava.
   - *Kondisi Uji*: Prompt *"Bersihkan farm zombie, rapikan peti, dan musnahkan sampah ke lava!"*.
   - *Verifikasi*: Diamond tersimpan di peti mineral, `poisonous_potato` hangus terbakar, jarak bot ke lava $\ge 1.8$m (HP bot tetap 20).

6. **T3-PAIR-06: Beban Ring Buffer PostgreSQL Ingestion vs Broadcast Multi-Klien Simultan**:
   - *Deskripsi*: Ingestion 100 log pergerakan per detik ke PostgreSQL bersamaan dengan broadcast ke 10 koneksi WebSocket.
   - *Kondisi Uji*: DB mengalami jeda latensi buatan 50ms.
   - *Verifikasi*: Buffer internal menampung data tanpa drop, database mencatat 100% data pasca-flush, dan klien menerima seluruh event.

---

## 5. Desain Skenario Beban Dunia Nyata Tier 4 (Real-World Workloads)

Tier 4 menguji sistem dalam skenario operasional terpadu yang menyerupai lingkungan produksi penuh:

```
+----------------------------------------------------------------------------------------------------+
|                         SKENARIO OPERASIONAL DUNIA NYATA TIER 4                                    |
+----------------------------------------------------------------------------------------------------+
|                                                                                                    |
|  [T4-SCEN-01] Kurikulum Penuh Level 1–4 Navigasi (5x L1, 1x L2, 1x L3, 1x L4)                     |
|  [T4-SCEN-02] Pipeline Otonom Penuh (Farming -> Looting -> Sorting -> Incineration)                |
|  [T4-SCEN-03] Navigasi Gua Bawah Tanah dengan Injeksi Rintangan Dinamis Bertingkat                |
|  [T4-SCEN-04] AI Multi-Task Planner dengan Simulasi Gangguan API Eksternal & Failover              |
|  [T4-SCEN-05] Endurance Telemetri Frekuensi Tinggi & Uji Ketahanan Putus Database Sementara       |
|  [T4-SCEN-06] Sesi Observasi & Kontrol Dasbor Web Multi-Klien Simultan (5 Klien)                  |
|  [T4-SCEN-07] Live Presence 60 Detik+ & Disaster Recovery Reconnect pada Server Nyata              |
|                                                                                                    |
+----------------------------------------------------------------------------------------------------+
```

### Rincian Skenario Beban Nyata:

### Skenario 1: T4-SCEN-01 (Kurikulum Penuh Level 1–4 Navigasi)
- **Tujuan**: Memvalidasi keandalan navigasi otonom di seluruh tingkat medan secara berurutan.
- **Alur Kerja**:
  1. *Level 1*: 5 kali lari medan datar 30m berturut-turut ($100\%$ success rate wajib).
  2. *Level 2*: 1 kali lari medan bergelombang 50m dengan rintangan dan elevasi $+1$Y.
  3. *Level 3*: 1 kali lari vertikal melintasi tangga balok, jembatan 1-blok 15m, dan tiang ladder $+10$Y/$-10$Y.
  4. *Level 4*: 1 kali penjelajahan jarak jauh menembus deepslate ke spawner `[-256, -20, -432]`.
- **Kriteria Kelulusan**: Seluruh 8 run menghasilkan status `SUCCESS`, delta koordinat $< 0.6$m, durasi tercatat positif di PostgreSQL.

### Skenario 2: T4-SCEN-02 (Pipeline Lengkap Farming, Looting, Sorting & Incineration)
- **Tujuan**: Memvalidasi siklus penuh tugas bot di area farm spawner.
- **Alur Kerja**:
  1. Bot menerima perintah via Terminal AI.
  2. Membunuh 3 zombie dengan jeda serangan pedang $\ge 625$ms.
  3. Memungut seluruh drop (`rotten_flesh`, `iron_ingot`, `iron_helmet`, bola XP).
  4. Bergerak ke area peti `[-256, -20, -429]` dan menyortir item sesuai kategori.
  5. Bergerak ke kolam lava `[-259, -20, -433]`, menjaga perimeter aman $\ge 1.8$m, dan membuang sampah kentang beracun.
- **Kriteria Kelulusan**: XP bot bertambah, peti memuat drop berharga, tas bot bersih dari sampah, HP bot tetap 20 (tanpa terkena luka bakar).

### Skenario 3: T4-SCEN-05 (Endurance Telemetri & Uji Ketahanan Putus Database)
- **Tujuan**: Memastikan integritas data telemetri saat terjadi pemutusan jaringan database sementara (*transient disconnect*).
- **Alur Kerja**:
  1. Bot mengalirkan 200 tick pergerakan ke client database.
  2. Jaringan PostgreSQL diputus sementara selama 150ms.
  3. 100 tick tambahan dikirim saat database offline (ditampung dalam shadow buffer in-memory).
  4. Jaringan database pulih kembali.
  5. Shadow buffer menguras seluruh antrean ke database.
- **Kriteria Kelulusan**: Total 300 tick telemetri tersimpan utuh di tabel `movement_action_logs` tanpa kehilangan data sama sekali (*zero data loss*).

### Skenario 4: T4-SCEN-07 (Live Presence 60 Detik+ & Disaster Recovery Reconnect)
- **Tujuan**: Memvalidasi kepatuhan R1, R2, dan R3 pada server nyata `atoms-girl.tun.ply.gg:25565`.
- **Alur Kerja**:
  1. Menjalankan query SLP awal (verifikasi baseline online count).
  2. Menghubungkan bot headless Protocol 775 ke server live.
  3. Melewati fase konfigurasi FML/NeoForge 26.1.2 dan masuk ke fase Play.
  4. Menjalankan query SLP kedua: memverifikasi `players.online >= 1` dan nama bot terdaftar pada `players.sample`.
  5. Mempertahankan koneksi aktif selama $\ge 60$ detik dengan merespon paket keep-alive secara tepat waktu.
  6. Menjalankan simulasi gangguan transient disconnect pada detik ke-25; bot mendeteksi disconnect dan melakukan reconnect otomatis via exponential backoff (1s, 2s).
  7. Melakukan farming zombie pada spawner `[-256, -20, -432]` dan menyinkronkan status ke Web Dashboard port 8080.
- **Kriteria Kelulusan**:
  - SLP query mengonfirmasi `players.online >= 1`.
  - Bot bertahan total waktu $\ge 60$ detik tanpa di-kick.
  - Web Dashboard menampilkan posisi real-time dan telemetry stream.

---

## 6. Ringkasan Kepatuhan Standar & Panduan Implementasi

1. **Bahasa & Komentar**:
   - Seluruh komentar kode, pesan kesalahan asersi pengujian (`assert`), dan label antarmuka web ditulis dalam **Bahasa Indonesia**.
   - Log sistem teknis dan trace diperbolehkan dalam Bahasa Inggris teknis baku.
2. **Desain UI & Tipografi**:
   - Menggunakan Google Fonts **Poppins** (`font-family: 'Poppins', sans-serif`).
   - Menerapkan design tokens **AppColors** (`--bg: #0F0F14`, `--surface: #16161E`, `--accent: #6C63FF`, dll).
3. **Eksekusi Mandiri & Kinerja**:
   - Test runner harus selalu mengembalikan exit code `0` saat semua uji lulus dan `1` jika terjadi kegagalan.
   - Eksekusi seluruh suite offline harus selesai dalam waktu singkat (< 5 detik) untuk mendukung *fast feedback loop*.
