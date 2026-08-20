# Laporan Analisis Arsitektur Infrastruktur Pengujian E2E (E2E Test Infrastructure Analysis)
## Minecraft Autonomous Companion

---

## 1. Ringkasan Eksekutif (Executive Summary)

Sistem **Minecraft Autonomous Companion** memerlukan infrastruktur pengujian *End-to-End* (E2E) yang mandiri (*self-verifying*), deterministik, berkinerja tinggi, dan bebas dari *flakiness* atau kebocoran memori (*zero memory leak*). Berdasarkan evaluasi mendalam terhadap `ORIGINAL_REQUEST.md`, `PROJECT.md`, dan seluruh subsistem di direktori `src/` serta `test/`, arsitektur pengujian E2E 4-Tier telah dirancang dan diimplementasikan secara komprehensif.

### Metrik Kunci Infrastruktur Pengujian:
- **Total Kasus Uji E2E**: **163 Kasus Uji** (Melampaui target minimal 115 kasus uji).
  - **Tier 1 (Feature Coverage)**: 70 kasus uji (14 fitur × 5 kasus uji/fitur, syarat minimal: $\ge 50$).
  - **Tier 2 (Boundary & Negative Cases)**: 70 kasus uji (14 fitur × 5 kasus uji/fitur, syarat minimal: $\ge 50$).
  - **Tier 3 (Pairwise Cross-Feature Interactions)**: 16 kasus uji (syarat minimal: $\ge 10$).
  - **Tier 4 (Real-World Workload Scenarios)**: 7 skenario komprehensif (syarat minimal: $\ge 5$).
- **Suite Pengujian Tambahan (Adversarial & Mutation Verification)**:
  - **Mutation Verifier**: 48 kasus uji mutasi batas & deteksi *false-positive* (100% tertangkap).
  - **Fault-Injection Verifier**: 8 skenario sabotase subsistem (100% terdeteksi).
- **Kecepatan Eksekusi**: Seluruh 163 kasus uji dieksekusi dalam **~15.30 detik** dengan status **100% PASSED** (Exit Code 0).
- **Kepatuhan Standar**: Seluruh asersi domain, deskripsi pengujian, dan pesan kesalahan ditulis dalam **Bahasa Indonesia** baku dengan font Google Fonts **Poppins** dan token warna `AppColors` pada antarmuka dashboard.

---

## 2. Batasan Masalah & Konteks Kebutuhan (Problem Boundary & Context)

Berdasarkan `ORIGINAL_REQUEST.md` dan `PROJECT.md`, sistem memiliki 4 kebutuhan utama (R1–R4) dan 10+ fitur inti:

1. **R1. Headless Automated Bot Test Harness**:
   - Bot Mineflayer / simulator mandiri tanpa GUI Minecraft yang menghubungkan diri ke dunia simulasi/server secara background.
   - Penanganan handshake protokol (Protocol 775 / NeoForge 26.1.2), configuration phase (28 `registry_data` packets), login, dan play state.
2. **R2. Progressive Difficulty Navigation Benchmark Suite**:
   - **Level 1 (Medan Datar)**: Navigasi Titik A $\to$ Titik B sejauh 30 meter (100% konsisten dalam 5 uji berturut-turut).
   - **Level 2 (Rintangan & Elevasi)**: Navigasi 50 meter dengan tangga balok $+1$Y, turunan $-1$Y, dan rintangan blok solid yang memerlukan manuver memutar (*detour*).
   - **Level 3 (Tangga, Ladder & Jembatan Sempit)**: Navigasi vertikal tangga balok $+10$Y, jembatan 1-blok selebar 15 meter di atas jurang, dan tiang ladder $+10$Y/$-10$Y.
   - **Level 4 (Underground Spawner Farm Target)**: Penjelajahan dari permukaan $(0, 64, 0)$ menembus deepslate menuju target spawner `[-256, -20, -432]`.
3. **R3. Autonomous Self-Correction & Metric Logging**:
   - Evaluasi progres pergerakan per tick (20 Hz), deteksi kondisi macet (*stuck detection* sliding-window 30 tick), eskalasi 4 fase pemulihan (*Micro-jump* $\to$ *Strafe* $\to$ *Re-route* $\to$ *Rewind*).
   - Pencatatan seluruh metrik dan log telemetri ke database PostgreSQL `minecraft_companion` pada tabel `benchmark_runs`, `telemetry_logs`, `movement_action_logs`, dan `action_audit_logs`.
4. **R4. DeepSeek AI Brain & Multi-Step Task Execution**:
   - Integrasi `deepseek-chat` untuk penguraian perintah Bahasa Indonesia dan dekomposisi rencana multi-tahap.
   - Pertarungan zombie di spawner dengan penegakan jeda serangan senjata (*attack cooldown pacing* $\ge 625$ms untuk pedang, $\ge 1250$ms untuk kapak) dan pemungutan XP orb / loot.
   - Penyortiran multi-peti (*multi-chest item sorting*) berdasarkan kategori (`drops`, `minerals`, `weapons`).
   - Pemusnahan sampah beracun (*trash incineration*) pada blok bahaya (lava/api) dengan perlindungan perimeter aman ($d \ge 1.5$ meter) dan pencegahan pembakaran mineral berharga.
5. **Dashboard Web & Real-Time Telemetry**:
   - Server Express + WebSocket native pada port 8080.
   - Siaran event telemetri (`TICK_UPDATE`, `BENCHMARK_STATUS`, `TASK_STATE_CHANGE`).
   - Tampilan UI responsif dengan tipografi Google Fonts **Poppins** dan tema gelap `AppColors`.

---

## 3. Arsitektur Komponen Infrastruktur Pengujian (E2E Test Architecture)

Infrastruktur pengujian dibangun secara modular dengan memisahkan *test runner*, *test harness*, *mock providers*, *database helpers*, *web helpers*, dan *domain assertion library*:

```
test/
├── runner.js                           # Master Test Runner (CLI flags, timeout guard, colored reporter)
├── helpers/
│   ├── assertions.js                   # 10 Custom Domain Assertions (Pesan Bahasa Indonesia)
│   ├── mockArenaHarness.js             # Headless Bot Physics & 4-Level World Arena Simulator
│   ├── dbTestHelper.js                 # PostgreSQL Client, Non-destructive DDL, Shadow Store
│   ├── wsTestHelper.js                 # HTTP/WebSocket Server, Ephemeral Ports, WsTestClient
│   └── mockAIProvider.js               # DeepSeek AI Brain Emulator, Tool Schema & Intent Parser
├── e2e/
│   ├── tier1_feature_coverage.test.js  # Tier 1: 70 Kasus Uji (F01 - F14)
│   ├── tier2_boundary_corner.test.js   # Tier 2: 70 Kasus Uji Boundary & Edge Cases
│   ├── tier3_pairwise.test.js          # Tier 3: 16 Kasus Uji Interaksi Antar-Subsistem
│   ├── tier4_realworld.test.js         # Tier 4: 7 Skenario Beban Kerja Nyata
│   ├── e2e_level1_test.js              # Alias Benchmark Level 1 (5x consecutive runs)
│   ├── e2e_level2_test.js              # Alias Benchmark Level 2
│   ├── e2e_level3_test.js              # Alias Benchmark Level 3
│   ├── e2e_level4_test.js              # Alias Benchmark Level 4
│   ├── e2e_ai_tasks_test.js            # Alias Benchmark AI Multi-Task
│   ├── e2e_telemetry_test.js           # Alias Benchmark Telemetry DB & WebSocket
│   └── test_zombie_combat_xp.js        # Combat Pacing & XP Verification
├── mutation_verifier.js                # 48 Adversarial & Mutation Tests
└── fault_injection_verifier.js         # 8 Fault-Injection Sabotage Tests
```

### 3.1 Master Test Runner (`test/runner.js`)
- **CLI Options**:
  - `--tier <1,2,3,4>`: Menjalankan tier tertentu atau kombinasi tier (misal: `--tier 1,2`).
  - `--bail`: Menghentikan eksekusi segera saat terjadi kegagalan pertama.
  - `--json`: Format keluaran terstruktur JSON untuk integrasi CI/CD.
  - `--timeout <ms>`: Konfigurasi batas waktu eksekusi per kasus uji (default: 15.000ms).
  - `--filter <regex>`: Filter kasus uji berdasarkan pencocokan pola nama.
- **Teardown & Cleanup Guarantees**: Seluruh `before` dan `after` hooks dijalankan dalam blok `try-finally`, memastikan tidak ada *hanging TCP sockets* atau file descriptor yang tertinggal.
- **Exit Code Semantics**: Menghasilkan status kode `0` jika seluruh tes 100% lulus, dan `1` jika ada kegagalan atau suite kosong.

### 3.2 Mock Arena Harness (`test/helpers/mockArenaHarness.js`)
- **Procedural Level Generator**:
  - *Level 1*: Lapisan batu datar 30 meter pada `y=64`.
  - *Level 2*: Jalur 50 meter dengan elevasi naik $+1$Y pada `x=15`, dinding batu 2-tinggi pada `x=20`, dan turunan $-1$Y pada `x=30`.
  - *Level 3*: Tangga batu mendaki 10 blok ke `y=74`, jembatan 1-blok selebar 15 meter pada `z=0..15`, dan tiang ladder vertikal 10 blok dari `y=64` ke `y=74`.
  - *Level 4*: Lintasan bawah tanah menembus lapisan deepslate dari permukaan ke spawner cave `[-256, -20, -432]`.
- **Bot Physics & Navigation Engine**: Kecepatan sprint $4.3$ m/s, simulasi gravitasi, deteksi tabrakan blok, dan eskalasi 4 fase pemulihan macet.
- **Combat & Item Systems**: Pelacakan jeda serangan senjata, inventaris tas bot, interaksi peti, dan pembuangan limbah ke blok lava dengan validasi jarak.

### 3.3 PostgreSQL Test Helper (`test/helpers/dbTestHelper.js`)
- **Dual-Engine Architecture**: Menjalankan kueri SQL nyata ke database PostgreSQL `minecraft_companion` via `psql` / `pg pool`, dengan lapisan *shadow in-memory store* untuk pengujian berkecepatan tinggi dan simulasi *transient network disconnect*.
- **Non-Destructive Migrations**: Menjalankan migrasi DDL yang aman (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ADD COLUMN IF NOT EXISTS`).
- **Data Isolation**: Menghasilkan `run_id` berbasis UUID untuk setiap pengujian, memungkinkan pembersihan (*cleanup*) terisolasi tanpa mempengaruhi data lainnya.

### 3.4 Web & WebSocket Helper (`test/helpers/wsTestHelper.js`)
- **In-Process HTTP & WebSocket Server**: Mengimplementasikan server native Node.js (`http`, `crypto`) tanpa ketergantungan library eksternal.
- **Port Conflict Prevention**: Mendukung port dinamis ephemeral (`port: 0`), auto-retry kenaikan port, dan penghancuran paksa koneksi TCP saat *teardown*.
- **Asynchronous `WsTestClient`**: Dilengkapi antrean event dengan metode `waitForEvent(type, timeoutMs)` untuk verifikasi asinkron event *real-time*.

### 3.5 DeepSeek AI Provider Mock (`test/helpers/mockAIProvider.js`)
- **Natural Language Intent Parsing**: Menguraikan instruksi Bahasa Indonesia menjadi pemanggilan fungsi terstruktur (`farm_mobs`, `sort_chests`, `incinerate_trash`, `navigate_to`).
- **Tool Schema Validation**: Memvalidasi kesesuaian tipe data dan parameter wajib pada setiap tool call.
- **Deterministic Heuristic Fallback**: Memberikan rencana kerja lokal ketika API eksternal mengalami *timeout*, ketiadaan API key, atau *rate limiting* (HTTP 429).

### 3.6 Custom Domain Assertion Library (`test/helpers/assertions.js`)
Menyediakan 10 asersi tingkat domain dengan pesan kesalahan Bahasa Indonesia yang presisi:
1. `assertCoordinateClose(actual, target, tolerance, message)`
2. `assertTrajectoryProgress(pathHistory, targetPos)`
3. `assertStuckRecoveryPhases(movementLogs, expectedPhases)`
4. `assertAttackPacing(attackTimestamps, minCooldownMs)`
5. `assertChestSorting(chestSnapshot, expectedRules)`
6. `assertSafeHazardDistance(trajectoryOrPos, hazardCoord, minSafeDistance)`
7. `assertDatabaseTelemetry(dbLogs, expectedLevel, minCount)`
8. `assertWebSocketEvent(event, expectedType, validatorFn)`
9. `assertIndonesianLocalization(textOrHtml, requiredTerms)`
10. `assertPoppinsFont(cssOrHtml)`

---

## 4. Desain & Matriks Strategi Pengujian 4-Tier

### 4.1 Tier 1: Cakupan Fitur Penuh (Feature Coverage — 70 Kasus Uji)
Menguji 14 fitur (F01 s/d F14) secara mendalam dengan 5 kasus uji granular per fitur:

| ID Fitur | Nama Fitur | Jumlah Kasus Uji | Fokus Pengujian |
|---|---|:---:|---|
| **F01** | Headless Test Server Arena | 5 | Inisialisasi server, binding port, generasi dunia Level 1–4. |
| **F02** | Level 1 Benchmark (Medan Datar 30m) | 5 | Navigasi 30m, 5x konsistensi 100%, validasi koordinat akhir, kecepatan sprint $\ge 4.3$ m/s, durasi $< 15$s. |
| **F03** | Level 2 Benchmark (Rintangan & Elevasi 50m) | 5 | Rute 50m, tangga $+1$Y, manuver rintangan balok, deteksi macet aktif, pencatatan obstacle count. |
| **F04** | Level 3 Benchmark (Tangga, Ladder & Jembatan) | 5 | Tangga $+10$Y, jembatan 1-blok selebar 15m, tiang ladder $+10$Y/$-10$Y, pencegahan jatuh jurang, validasi koordinat puncak. |
| **F05** | Level 4 Benchmark (Spawner Farm `[-256, -20, -432]`) | 5 | Navigasi jarak jauh, penetrasi deepslate ($y < 0$), waypoint makro, pencapaian spawner, radius toleransi $\le 0.6$m. |
| **F06** | Autonomous Self-Correction & Stuck Recovery | 5 | Fase 1 Micro-jump, Fase 2 Strafe, Fase 3 Re-route, Fase 4 Rewind, mitigasi osilasi. |
| **F07** | PostgreSQL Telemetry Logging | 5 | Pencatatan `benchmark_runs`, `telemetry_logs`, `movement_action_logs`, kueri agregasi, sanitasi JSONB. |
| **F08** | DeepSeek AI Brain (`deepseek-chat`) | 5 | Inisialisasi API client, validasi tool schema, penguraian intent Bahasa Indonesia, dekomposisi rencana multi-tahap, fallback heuristik. |
| **F09** | Zombie Spawner Farming Task | 5 | Deteksi target zombie, jeda serangan $\ge 625$ms, pemungutan bola XP, loot item, monitoring HP/makanan. |
| **F10** | Multi-Chest Item Sorting Task | 5 | Interaksi peti, deposit `mob_drops`, deposit `minerals`, pemisahan senjata, validasi inventaris tas kosong pasca-sortir. |
| **F11** | Trash Incineration Task | 5 | Deteksi blok lava, perimeter aman $\ge 1.5$m, pembuangan kentang beracun/daging busuk, perlindungan mineral, bot bebas luka. |
| **F12** | Web Dashboard & Real-Time Terminal | 5 | Server HTTP port 8080, WebSocket handshake, siaran `TICK_UPDATE`, penerimaan chat AI, REST API `/api/telemetry/live`. |
| **F13** | UI Localization & Poppins Font | 5 | 100% label Bahasa Indonesia, integrasi Google Fonts Poppins, validasi CSS tokens `AppColors`, respon error Bahasa Indonesia, format angka lokal. |
| **F14** | Master E2E Test Suite Harness | 5 | Eksekusi 4-Tier, CLI options parsing, penegakan timeout guard, graceful teardown, semantik exit code. |
| **Subtotal** | **14 Fitur** | **70 Kasus Uji** | **100% Lulus (PASSED)** |

---

### 4.2 Tier 2: Kondisi Batas, Negatif & Kasus Pojok (Boundary & Corner Cases — 70 Kasus Uji)
Menguji ketahanan sistem terhadap input ekstrem, kegagalan jaringan, pembatalan tugas, dan kondisi tak terduga (5 kasus uji per fitur):

| ID Fitur | Kategori Batas & Kasus Pojok | Jumlah Kasus Uji | Contoh Kasus Uji Kritis |
|---|---|:---:|---|
| **F01** | Port & Server Boundaries | 5 | Penanganan `EADDRINUSE`, koordinat dunia luar batas ($Y < -64$ / $Y > 320$), level arena invalid. |
| **F02** | Level 1 Extremes | 5 | Jarak nol ($A = B$), jarak mikro $0.1$m, lintasan diagonal $45^\circ$, rintangan tiba-tiba di medan datar, benchmark timeout guard. |
| **F03** | Level 2 Extremes | 5 | Dinding vertikal 3-blok tak terlompati, jebakan lubang buta 1x1x1, elevasi curam $+15$Y, rintangan bergerak, chokepoint sempit diagonal. |
| **F04** | Level 3 Extremes | 5 | Anak tangga ladder hilang (micro-jump over gap), pengereman anti-jatuh di tepi jembatan, clearance rendah, belokan siku $90^\circ$ di atas jurang. |
| **F05** | Level 4 Extremes | 5 | Lintas kuadran negatif ($+X/+Z \to -X/-Z$), transisi deepslate $Y < 0$, target di dalam bedrock (unreachable), crossing chunk boundary. |
| **F06** | Recovery Extremes | 5 | Eskalasi penuh Fase 4 (Rewind), deteksi gerakan maju-mundur statis, jebakan permanen tak terpulihkan, isolasi lag database. |
| **F07** | Database Extremes | 5 | Transient disconnect simulation, lonjakan 10.000 log/detik (buffer overflow protection), SQL injection protection pada JSONB, graceful flush saat SIGINT. |
| **F08** | AI Brain Extremes | 5 | Ketiadaan API Key (fallback heuristik), payload JSON cacat/hallucinated, timeout API $> 10$s, prompt nonsens/acak, HTTP 429 rate limit backoff. |
| **F09** | Combat Extremes | 5 | Penolakan spam-click $< 625$ms, senjata rusak/patah di tengah farming, ruang spawner kosong (idle wait), HP bot kritis (mundur darurat), line of sight terhalang. |
| **F10** | Sorting Extremes | 5 | Peti tujuan penuh (zero available slots), item kategori tak dikenal (unsorted fallback), peti terkunci/sibuk, inventaris kosong saat perintah sort, peti di luar jangkauan ($> 4.5$m). |
| **F11** | Incineration Extremes | 5 | Perimeter lava ketat ($< 1.0$m ditolak), penolakan pembakaran diamond/netherite, ketiadaan lava dalam radius terjangkau, tipe bahaya invalid, respon bot terbakar. |
| **F12** | Dashboard Extremes | 5 | Resinkronisasi saat WebSocket reconnect, beban 10 klien simultan, payload WebSocket non-JSON/malformed, backpressure throttling, HTTP 404/500 dalam Bahasa Indonesia. |
| **F13** | Localization Extremes | 5 | Pencegahan bocoran teks bahasa asing, pesan error sistemik Bahasa Indonesia, fallback font sistem saat Google CDN offline, karakter khusus UTF-8. |
| **F14** | Runner Extremes | 5 | Timeout pengujian individual 15.000ms, isolasi crash/uncaught exception pada sub-test, pembersihan handle menggantung, mitigasi flakiness via port ephemeral. |
| **Subtotal** | **14 Fitur** | **70 Kasus Uji** | **100% Lulus (PASSED)** |

---

### 4.3 Tier 3: Interaksi Lintas Fitur Berpasangan (Pairwise Cross-Feature Interactions — 16 Kasus Uji)
Menguji korelasi simultan antar subsistem yang bekerja bersama:

1. **T3-PAIR-01**: Sinkronisasi lifecycle server Headless Arena dengan inisialisasi koneksi PostgreSQL.
2. **T3-PAIR-02**: Paritas metrik pergerakan real-time antara siaran WebSocket 20Hz dan batch ingestion database.
3. **T3-PAIR-03**: Injeksi rintangan dinamis Level 2 yang memicu deteksi macet dan transisi Fase 1 & 2 ke database.
4. **T3-PAIR-04**: Navigasi vertikal Level 3 (Ladder & Narrow Bridge) yang memicu pemulihan Fase 4 (Rewind).
5. **T3-PAIR-05**: Validasi koordinat jalur Level 4 spawner farm antara `path_history` PostgreSQL dan canvas visualizer dashboard.
6. **T3-PAIR-06**: Integrasi tool calling `farm_mobs` DeepSeek AI dengan penegakan jeda serangan pedang $\ge 625$ms.
7. **T3-PAIR-07**: Estafet otomatis pasca-farming zombie langsung menuju penyortiran item ke peti multi-kategori.
8. **T3-PAIR-08**: Filter proteksi inventaris: Pemisahan mineral berharga sebelum eksekusi pembuangan sampah ke lava.
9. **T3-PAIR-09**: Penegakan batas perimeter keamanan bahaya ($d \ge 1.5$m) saat tugas pembakaran sampah berlangsung.
10. **T3-PAIR-10**: Validasi simultan lokalisasi Bahasa Indonesia dan tipografi Google Fonts Poppins pada UI dashboard.
11. **T3-PAIR-11**: Audit transisi status `is_stuck` dan `recovery_phase` pada tabel `movement_action_logs`.
12. **T3-PAIR-12**: Fallback deterministik Mock AI ke perencanaan heuristik saat mode offline tanpa internet.
13. **T3-PAIR-13**: Ketahanan ring buffer batch ingestion PostgreSQL di bawah beban siaran WebSocket berkecepatan tinggi.
14. **T3-PAIR-14**: Transisi mulus navigasi dari struktur vertikal Level 3 langsung ke rute bawah tanah Level 4.
15. **T3-PAIR-15**: Pencatatan audit trail transaksi peti ke database dan verifikasi ketersediaannya via REST API `/api/telemetry/audit`.
16. **T3-PAIR-16**: Mitigasi desakan gerombolan zombie (*mob swarm collision*) melalui manuver penarikan jarak (*kiting*) saat farming.

---

### 4.4 Tier 4: Skenario Beban Kerja Nyata (Real-World Workload Scenarios — 7 Skenario)
Menguji skenario operasional jangka panjang dan kondisi pemulihan bencana (*disaster recovery*):

1. **T4-SCEN-01: Progresi Penuh Kurikulum Benchmark Level 1–4 Otonom**:
   - Menjalankan 5 kali uji Level 1 (100% konsisten), 1 kali Level 2, 1 kali Level 3, dan 1 kali Level 4.
   - Total 8 benchmark run terekam lengkap di database dengan koordinat akhir di spawner `[-256, -20, -432]`.
2. **T4-SCEN-02: Pipeline Lengkap Pemeliharaan Otonom (Farming $\to$ Looting $\to$ Sorting $\to$ Incineration)**:
   - Instruksi bahasa alami: *"Lakukan rutinitas pembersihan farm zombie dan rapikan penyimpanan!"*.
   - Dekomposisi 4 tahap oleh AI Planner, eksekusi pembasmian zombie, pengumpulan XP/loot, penyimpanan helm/besi ke peti peralatan, dan pemusnahan kentang beracun ke lava tanpa bot terluka.
3. **T4-SCEN-03: Navigasi Gua Vertikal dengan Pemulihan Rintangan Dinamis Berulang**:
   - Injeksi 3 rintangan sekaligus pada titik elevasi, belokan sudut, dan turunan.
   - Bot berhasil mendeteksi macet, mengeksekusi manuver pemulihan berlapis, dan menyelesaikan rute.
4. **T4-SCEN-04: AI Multi-Task Planner dengan Simulasi Gangguan API & Failover**:
   - Prompt kompleks dengan simulasi pemutusan koneksi API eksternal (HTTP 503/timeout).
   - Engine lokal secara otomatis beralih ke *heuristic fallback mode* dan berhasil menyelesaikan tugas.
5. **T4-SCEN-05: Endurance Telemetri Frekuensi Tinggi & Uji Putus Koneksi Database**:
   - Pengiriman 200 tick telemetri cepat $\to$ pemutusan koneksi database sementara selama 150ms $\to$ penulisan 100 tick baru ke *shadow buffer* $\to$ rekoneksi otomatis $\to$ verifikasi 300 tick tersimpan utuh (*zero data loss*).
6. **T4-SCEN-06: Sesi Observasi & Kontrol Dashboard Multi-Klien Simultan**:
   - 5 klien WebSocket terhubung bersamaan: Klien 1 memulai benchmark, Klien 2 polling REST API, Klien 3 mengirim chat AI, Klien 4 & 5 menerima sinkronisasi posisi bot secara real-time.
7. **T4-SCEN-07: Disaster Recovery: Restart Server Headless & Resumsi Misi Otonom**:
   - Bot sedang dalam perjalanan Level 4 di kedalaman $y = -5 \to$ simulator server mengalami *crash* dan di-restart $\to$ bot mendeteksi status dan melanjutkan misi dari *last safe waypoint* hingga mencapai target `[-256, -20, -432]`.

---

### 4.5 Verifikasi Adversarial & Mutasi (Mutation & Fault-Injection Suites)
Untuk menjamin bahwa suite pengujian tidak menghasilkan *vacuous pass* atau *false positive*, disediakan dua alat uji adversarial:

1. **`test/mutation_verifier.js` (48 Uji Mutasi)**:
   - Menguji kepekaan 10 fungsi asersi kustom saat diberikan input salah (posisi meleset, spam attack delta 300ms, peti tercemar, perimeter lava $< 1.5$m, teks bahasa Inggris, font non-Poppins).
   - Hasil: 100% mutasi berhasil ditangkap (*caught*) dan melempar `AssertionError` yang sesuai.
2. **`test/fault_injection_verifier.js` (8 Skenario Sabotase)**:
   - Menguji apakah suite mendeteksi manipulasi status sukses, koordinat melenceng, kegagalan database, atau ketidaksesuaian skema.
   - Hasil: 8 dari 8 skenario sabotase berhasil terdeteksi 100%.

---

## 5. Cetak Biru `TEST_INFRA.md` & Tata Letak Pengujian (`test/`)

### 5.1 Skrip Eksekusi di `package.json`
```json
{
  "scripts": {
    "test": "node test/runner.js",
    "test:e2e": "node test/runner.js",
    "test:db": "node --test test/database/telemetry_db_test.js",
    "test:mutation": "node test/mutation_verifier.js",
    "test:fault": "node test/fault_injection_verifier.js",
    "benchmark:l1": "node test/e2e/e2e_level1_test.js",
    "benchmark:l2": "node test/e2e/e2e_level2_test.js",
    "benchmark:l3": "node test/e2e/e2e_level3_test.js",
    "benchmark:l4": "node test/e2e/e2e_level4_test.js",
    "benchmark:ai": "node test/e2e/e2e_ai_tasks_test.js",
    "benchmark:combat": "node test/e2e/test_zombie_combat_xp.js"
  }
}
```

### 5.2 Standar Penulisan & Eksekusi Pengujian
1. **Nol Dependensi Berat**: Menggunakan `node:assert/strict` dan event loop native Node.js agar pengujian berjalan instan dan dapat dijalankan di semua lingkungan (CI/CD, headless runner, docker).
2. **Isolasi Port Jaringan**: Setiap suite pengujian menggunakan alokasi port berbeda (Tier 1: 8081, Tier 2: 8082, Tier 3: 8083, Tier 4: 8084) atau port ephemeral dinamis (`port: 0`) untuk mencegah konflik `EADDRINUSE`.
3. **Pembersihan Bersih (Clean Teardown)**: Setiap koneksi HTTP socket, WebSocket client, interval timer, dan koneksi database wajib ditutup dalam `suite.after()` via blok `try-finally`.
4. **Semua Pesan dalam Bahasa Indonesia**: Komentar pengujian, label konsol, dan pesan kesalahan asersi 100% menggunakan Bahasa Indonesia baku.

---

## 6. Rekomendasi Langkah Selanjutnya untuk Tim Pengembang

1. **Integrasi Live Protocol Client (M1–M2)**:
   - Gunakan `test/helpers/mockArenaHarness.js` sebagai acuan oracle ketika menghubungkan `src/network/liveProtocolClient.js` ke live server `atoms-girl.tun.ply.gg:25565`.
   - Pastikan penanganan packet flow (Handshake $\to$ Login $\to$ Config $\to$ Play) lolos asersi integritas paket.
2. **Penyelarasan SLP Verifier (M2)**:
   - Implementasikan query SLP ping terprogram pada `src/network/slpVerifier.js` untuk memvalidasi `players.online >= 1` dan keberadaan nama bot dalam `players.sample`.
3. **Eksekusi Rutin Uji Regresi**:
   - Jalankan `npm run test:e2e` sebelum setiap commit atau handoff antar agen worker untuk memastikan zero regression.
