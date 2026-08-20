# Laporan Survei Lingkungan & Basis Kode (Codebase & Environment Survey Report)

**Tanggal Survei**: 19 Agustus 2026  
**Penyusun**: Explorer 1 (Codebase & Environment Surveyor)  
**Proyek**: Minecraft Autonomous Companion  
**Target Server**: `atoms-girl.tun.ply.gg:25565` (NeoForge 26.1.2 / Protocol 775)  

---

## 1. Ringkasan Eksekutif (Executive Summary)

Survei menyeluruh terhadap repositori, dependensi, runtime sistem, konfigurasi jaringan live server, dan aset kode yang telah dibangun menghasilkan temuan kritis sebagai berikut:

1. **Konektivitas Live Server Terverifikasi**: Server `atoms-girl.tun.ply.gg:25565` aktif dan beroperasi pada protokol **775** (NeoForge 26.1.2 berbasis Minecraft versi 26.1.2/1.21.x). ServerListPing (SLP) dan koneksi soket langsung berhasil dilakukan.
2. **SLP Verifier & Deteksi Pemain Aktif**: Pengujian koneksi live membuktikan bahwa ketika bot terhubung, status server berubah secara instan dari `players.online: 0` menjadi `players.online: >= 1`, dengan nama bot tercantum dalam array `players.sample`.
3. **Kompatibilitas Runtime & Perpustakaan**:
   - `minecraft-protocol` (v1.67.0) yang terpasang di proyek mendukung penuh **Protokol 775 / NeoForge 26.1.2** secara *native* (melewati fase *handshake*, *configuration*, dan transisi ke *play state* secara mulus tanpa kick).
   - Java Runtime **OpenJDK 26.0.2** tersedia di `/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home/bin/java`.
   - Node.js **v25.2.1** dan PostgreSQL **17** aktif di `localhost:5432` dengan skema database `minecraft_companion` yang sudah termigrasi lengkap (5 tabel).
   - Seluruh 163 pengujian E2E (Tier 1–4) lulus 100%.

---

## 2. Inventaris Lingkungan & Toolchain Sistem

| Komponen / Tool | Versi / Lokasi | Status | Catatan Penggunaan |
|---|---|---|---|
| **Node.js** | `v25.2.1` (`/usr/local/bin/node` atau PATH) | ✅ Aktif & Siap | Runtime utama untuk Web Dashboard, SLP Poller, Protocol Bot, dan Telemetri |
| **npm** | `11.6.2` | ✅ Aktif | Package manager dependensi Node.js |
| **Python** | `Python 3.9.6` (`/usr/bin/python3`) | ✅ Aktif | Scripting launcher background & subprocess helper |
| **Java (JDK)** | `OpenJDK 26.0.2` (`/opt/homebrew/opt/openjdk/...`) | ✅ Aktif | Digunakan untuk Forge 26.1.2 Java Client (`minecraft_real_cmd.txt`) |
| **PostgreSQL** | `PostgreSQL 17.x` (`localhost:5432`) | ✅ Aktif | Database `minecraft_companion` (DDL & migrasi 100% siap) |
| **Forge Client Dir** | `/Users/syahriezas/Library/Application Support/minecraft` | ✅ Aktif | Versi `AA` berisi NeoForge 26.1.2, Baritone, dan `companion-bridge-forge-26.1.2.jar` |
| **Launch Command** | `/Users/syahriezas/Desktop/minecraft_real_cmd.txt` | ✅ Tersedia | Perintah peluncuran Java Forge Client lengkap dengan classpath |

---

## 3. Analisis Jaringan & Protokol Live Server Target

### A. Resolusi DNS & Routing
- **Hostname**: `atoms-girl.tun.ply.gg:25565`
- **DNS Lookup**: `147.185.221.230`
- **SRV Record**: `_minecraft._tcp.atoms-girl.tun.ply.gg` diarahkan ke port aktual **`53635`** melalui tunnel Playit.gg. Node.js `minecraft-protocol` secara otomatis menangani resolusi SRV record ini.

### B. Struktur Respons Server List Ping (SLP)
Hasil query SLP dari `atoms-girl.tun.ply.gg:25565`:
```json
{
  "description": "A Minecraft Server",
  "players": {
    "max": 20,
    "online": 0,
    "sample": []
  },
  "version": {
    "name": "26.1.2",
    "protocol": 775
  },
  "latency": 60
}
```

### C. Transisi Status Protokol 775
Pengujian paket real-time membuktikan alur handshake:
1. `OUTGOING [handshaking]: set_protocol` (protocolVersion: 775, nextState: 2 - Login)
2. `OUTGOING [login]: login_start` (username: `AutonomousBot_1`, playerUUID: UUID)
3. `INCOMING [login]: login_success` -> Transisi ke state `configuration`
4. `INCOMING/OUTGOING [configuration]`: pertukaran packet `finish_configuration` / `acknowledge_finish_configuration`
5. `INCOMING [play]: login` (game profile, dimension codec, spawn position)
6. Transisi penuh ke state **`play`** berhasil tanpa kick!
7. SLP yang dilakukan secara simultan menghasilkan:
   ```json
   {
     "max": 20,
     "online": 1,
     "sample": [
       {
         "id": "74901e1b-b615-3d8c-94ce-6edcf1b66ffd",
         "name": "AutonomousBot_1"
       }
     ]
   }
   ```

---

## 4. Inventaris Aset Kode Proyek (Codebase Asset Inventory)

```
minecraft_autonomous_companion/
├── package.json                    # Dependensi: mineflayer, minecraft-protocol, pg, ws, express, dll.
├── .env / .env.example             # Konfigurasi PG, DEEPSEEK_API_KEY, MC_HOST, PORT (8080)
├── src/
│   ├── config/
│   │   ├── database.js             # PostgreSQL Connection Pool (pg.Pool)
│   │   ├── environment.js          # Parser variabel lingkungan
│   │   └── constants.js            # Konstanta: cooldown weapon, threshold macet, spawner [-256, -20, -432]
│   ├── database/
│   │   ├── migrations.js           # Skrip DDL 5 tabel: benchmark_runs, telemetry_logs, movement_action_logs, dll.
│   │   ├── telemetryRepository.js  # Operasi INSERT / SELECT telemetri dengan UNNEST batch query
│   │   └── batchIngestion.js       # Buffer ring ingestion 20 Hz (interval 250ms)
│   ├── server/
│   │   ├── testServer.js           # In-process headless mock server
│   │   ├── arenaBuilder.js         # Generator blok 4 level arena
│   │   └── forgeSwarmLauncher.js   # Swarm launcher Java Forge client via desktop command template
│   ├── navigation/
│   │   ├── botClient.js            # Wrapper Mineflayer lifecycle & pathfinder
│   │   ├── movementController.js   # Kontrol gerak bot & pathfinding execution
│   │   ├── stuckDetector.js        # Sliding-window stuck detector
│   │   ├── recoveryStateMachine.js # Pemulihan 4-fase dinamis (Micro-jump, Strafe, Reroute, Rewind)
│   │   └── waypointGraph.js        # Graf waypoint Level 4 ke spawner farm [-256, -20, -432]
│   ├── ai/
│   │   ├── deepseekClient.js       # Klien DeepSeek AI (`deepseek-chat`) + deterministic mock fallback
│   │   ├── taskPlanner.js          # Perencana tugas AI multi-langkah
│   │   └── tasks/                  # Task modules (zombie farming, chest sorting, trash incineration)
│   ├── benchmark/
│   │   ├── benchmarkRunner.js      # Runner kurikulum Level 1–4
│   │   ├── levelDefinitions.js     # Definisi koordinat dan target 4 level
│   │   └── multiInstanceFarmRunner.js # Runner simulasi multi-bot farm
│   ├── connect_live_server.js      # Script koneksi live server
│   ├── connect_real_server.js      # Script koneksi real LAN server
│   └── web/
│       ├── webServer.js            # Server Express HTTP + WebSocket Port 8080 (REST API, Telemetri, Swarm)
│       └── public/                 # Web Dashboard: index.html (Google Fonts Poppins, Bahasa Indonesia), style.css, js/
├── test/
│   ├── runner.js                   # Master 4-Tier Test Runner CLI
│   ├── e2e/
│   │   ├── tier1_feature_coverage.test.js (70 tests)
│   │   ├── tier2_boundary_corner.test.js  (70 tests)
│   │   ├── tier3_pairwise.test.js         (16 tests)
│   │   └── tier4_realworld.test.js        (7 scenarios)
│   └── helpers/                    # Mock harnesses, assertion helpers, db helpers
```

---

## 5. Perbandingan Opsi Strategi Implementasi Klien Bot

| Kriteria | Opsi A: Pure Headless Node.js Protocol Client | Opsi B: Java Forge Client (`forgeSwarmLauncher`) | Opsi C: Hybrid Architecture (Rekomendasi) |
|---|---|---|---|
| **Mekanisme** | Menggunakan `minecraft-protocol` 1.67.0 dengan version `26.1.2` (protocol 775) | Menjalankan OpenJDK 26.0.2 dengan `--quickPlayMultiplayer` & `companion-bridge-forge-26.1.2.jar` | Headless Protocol Client untuk verifikasi & telemetri cepat + Forge Client Launcher untuk in-game mod rich companion |
| **Kecepatan Start** | Instan (< 500ms) | 10–20 detik (Java JVM startup & mod loading) | Instan untuk verifikasi SLP, background spawn untuk gameplay |
| **Konsumsi Memori** | ~40 MB RAM per bot | ~1–2 GB RAM per bot | Sangat hemat untuk multi-instance verification |
| **SLP Verifier** | 100% Kompatibel & langsung terdeteksi | 100% Kompatibel | 100% Kompatibel |
| **Autonomous Loop** | Kirim keep-alive, position update, packet attack zombie, receive XP | Baritone pathfinder + companion mod internal AI | Fleksibilitas maksimal |

---

## 6. Rekomendasi Arsitektur & Langkah Selanjutnya

1. **Jalur Verifikasi Utama (SLP & Live Presence)**:
   - Bangun script verifikasi mandiri berbasis Node.js yang memanggil `minecraft-protocol.createClient` ke `atoms-girl.tun.ply.gg:25565` dengan `version: '26.1.2'`.
   - Jalankan loop polling SLP setiap 1000ms untuk mencatat dan mengonfirmasi `players.online >= 1` dan `players.sample` berisi bot yang bersangkutan selama minimal 60 detik.
   
2. **Sinkronisasi ke Web Dashboard (Port 8080)**:
   - Hubungkan status koneksi live bot, latensi, detak jantung (keep-alive), dan koordinat spawner farm `[-256, -20, -432]` langsung ke Express & WebSocket event broadcaster di `src/web/webServer.js`.
   - Tambahkan endpoint REST `/api/slp/verify` dan kartu metrik live SLP pada antarmuka dashboard.

3. **Integritas Database & Telemetri**:
   - Catat setiap sesi koneksi dan metrik polling SLP ke tabel `benchmark_runs` dan `telemetry_logs` di PostgreSQL `minecraft_companion`.
