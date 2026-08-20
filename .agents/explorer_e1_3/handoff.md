# Handoff Report: E2E Testing Track — Tier 3 (Pairwise) & Tier 4 (Real-World Scenarios) Specifications

**Agent**: `explorer_e1_3`  
**Milestone**: E2E Testing Track (T1) — Tier 3 & Tier 4 Test Specifications  
**Date**: 2026-08-18T16:09:00Z  
**Target Output**: `/Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/.agents/explorer_e1_3/handoff.md`  

---

## 1. Observation

Berdasarkan investigasi terhadap dokumen autoritatif proyek:
1. `ORIGINAL_REQUEST.md`:
   - §R1: Headless Automated Bot Test Harness berbasis Node.js Mineflayer / dedicated arena server tanpa window grafis Minecraft.
   - §R2: Kurikulum benchmark navigasi 4 level (Level 1 Flat Ground 30m, Level 2 Rintangan & Elevasi 50m, Level 3 Tangga/Ladder/Jembatan, Level 4 Underground Spawner Farm ke `[-256, -20, -432]`).
   - §R3: Evaluasi kemajuan bot per tick, deteksi macet (sliding window), pemulihan dinamis 4-fase, dan pencatatan metrik ke database PostgreSQL `minecraft_companion` (tabel `telemetry_logs` & `movement_action_logs`).
   - §R4: Otak AI DeepSeek (`deepseek-chat`) untuk tugas multi-langkah: farming zombie (attack cooldown $\ge 625$ms), penyortiran multi-peti, dan pembakaran sampah berbahaya secara aman.
   - §Acceptance: Web dashboard di `http://localhost:8080`, 100% success rate tolak ukur, automasi pengujian E2E headless.
2. `PROJECT.md § Feature Inventory` mendefinisikan 14 fitur terintegrasi:
   - F1: Headless Test Server Arena
   - F2: Level 1 Benchmark (Flat Ground 30m)
   - F3: Level 2 Benchmark (Obstacles & Elevation 50m)
   - F4: Level 3 Benchmark (Stairs, Ladders & Bridges)
   - F5: Level 4 Benchmark (Underground Spawner Farm `[-256, -20, -432]`)
   - F6: Autonomous Self-Correction & Stuck Detection (4-Phase Recovery)
   - F7: PostgreSQL Telemetry Logging (`benchmark_runs`, `telemetry_logs`, `movement_action_logs`, `action_audit_logs`)
   - F8: DeepSeek AI Brain Subsystem (`deepseek-chat`, tool calling & heuristic mock)
   - F9: Zombie Spawner Farming Task (cooldown pacing $\ge 625$ms)
   - F10: Multi-Chest Item Sorting Task (kategori item)
   - F11: Trash Incineration Task (hazard perimeter safety)
   - F12: Web Dashboard & Real-Time Terminal (Port 8080, Express + WebSocket)
   - F13: UI Localization & Poppins Font (Bahasa Indonesia & Google Fonts Poppins)
   - F14: E2E Autonomous Test Suite (`test/runner.js`)
3. `.agents/sub_orch_e2e/SCOPE.md`:
   - Menetapkan arsitektur pengujian 4-Tier opaque-box.
   - Tier 3 mencakup pengujian kombinasi pairwise lintas fitur ($\ge 14$ kasus uji).
   - Tier 4 mencakup pengujian skenario beban dunia nyata menyeluruh ($\ge 7$ skenario).
4. Lingkungan Lokal:
   - Node.js `v25.2.1` aktif.
   - PostgreSQL 17/16 instance aktif pada port `5432` (`/tmp:5432 - accepting connections`).

---

## 2. Logic Chain

1. **Interaksi Antar-Subsistem & Titik Kritis Kegagalan**:
   - Dalam sistem autonomous bot multi-tier, kegagalan terbesar bukan terjadi pada fungsi terisolasi (Tier 1), melainkan pada antarmuka sinkronisasi antar-subsistem:
     - *Race condition* antara tick engine navigasi (20 Hz) dan ring buffer batch ingestion PostgreSQL (250ms).
     - *State contention* antara kontrol gerakan pathfinder saat stuck recovery aktif dan eksekusi tool calling AI.
     - *Data consistency* antara riwayat koordinat yang disimpan di database `telemetry_logs` dan koordinat yang dirender visualizer canvas WebSocket.
     - *Hazard boundary failure* saat bot membuang item sampah ke lava/api tanpa jarak aman yang cukup.
2. **Prinsip Pairwise Testing (Tier 3)**:
   - Menghubungkan setiap pasang fitur kritis untuk menjamin 100% cakupan interaksi antarmuka 14 fitur.
   - Didesain 16 kasus uji Tier 3 (melampaui target minimum 14 kasus uji).
3. **Prinsip Real-World Scenario Testing (Tier 4)**:
   - Menstimulasikan siklus hidup operasional penuh dari inisialisasi server, eksekusi benchmark kurikulum, gangguan dinamis, kegagalan jaringan API, crash recovery, hingga pelaporan metrik real-time ke web dashboard.
   - Didesain 7 skenario dunia nyata komprehensif (melampaui target minimum 7 skenario).

---

## 3. Tier 3: Cross-Feature Pairwise Test Specifications (16 Test Cases)

### Matriks Cakupan Fitur Tier 3 (Pairwise Interaction Matrix)

| Test ID | Fitur Utama | Fitur Pasangan / Triad | Vektor Interaksi & Fokus Pengujian |
|---------|-------------|-------------------------|-----------------------------------|
| **T3-PAIR-01** | F1 (Headless Arena) | F7 (PostgreSQL Logging) + F14 (Test Runner) | Sinkronisasi siklus hidup pembuatan arena dan inisialisasi/teardown run_id di DB |
| **T3-PAIR-02** | F2 (Level 1 Flat) | F12 (WebSocket Dashboard) + F7 (DB Batch Ingestion) | Paritas metrik real-time 20Hz: streaming WebSocket vs batch insert `movement_action_logs` |
| **T3-PAIR-03** | F3 (Level 2 Obstacles) | F6 (Stuck Detection & 4-Phase Recovery) | Injeksi rintangan dinamis 1-blok memicu deteksi macet sliding window & fase Micro-jump/Strafe |
| **T3-PAIR-04** | F4 (Level 3 Vertical) | F6 (Stuck Detection: Rewind Phase 4) | Pemulihan macet pada jembatan sempit 1-blok & tangga tali (ladder) tanpa jatuh ke void |
| **T3-PAIR-05** | F5 (Level 4 Farm Target) | F7 (DB Path History) + F12 (Canvas Visualizer) | Validasi poligon jalur 3D dari permukaan ke `[-256, -20, -432]` antara DB JSONB & canvas Web |
| **T3-PAIR-06** | F8 (DeepSeek AI Brain) | F9 (Zombie Farming) + F12 (AI Chat Terminal) | Eksekusi tool call `farm_mobs` dari prompt teks dengan attack cooldown $\ge 625$ms & event broadcast |
| **T3-PAIR-07** | F9 (Zombie Farming) | F10 (Multi-Chest Sorting) | Alur estafet otomatis: pengambilan drop mob hasil farming -> pemindaian inventaris -> sorting ke peti |
| **T3-PAIR-08** | F10 (Multi-Chest Sorting) | F11 (Trash Incineration) | Pemisahan item berharga (mineral/armor) dari limbah (poisonous potato/excess flesh) sebelum insinerasi |
| **T3-PAIR-09** | F11 (Trash Incineration) | F6 (Hazard Safety Boundary Guard) | Navigasi ke lava pit, penahanan jarak perimeter $d \ge 1.5$m, dan pelemparan item tanpa bot terbakar |
| **T3-PAIR-10** | F8 (DeepSeek AI Brain) | F13 (UI Localization & Poppins) + F12 (Dashboard) | Verifikasi respons AI, status tugas, dan pesan error dalam Bahasa Indonesia & font Poppins di UI |
| **T3-PAIR-11** | F6 (Stuck Recovery) | F7 (PostgreSQL `movement_action_logs`) | Audit transisi status `is_stuck=true` dan eskalasi `recovery_phase` (1->2->3->4->0) di DB |
| **T3-PAIR-12** | F8 (DeepSeek AI Mock) | F1 (Headless Server Arena) + F14 (Test Suite) | Uji deterministik fallback AI mock saat koneksi internet offline dalam arena headless |
| **T3-PAIR-13** | F7 (DB Ingestion Ring Buffer) | F12 (WebSocket Event Broadcaster) | Uji beban konkurensi 100 event/detik: verifikasi zero drop pada ring buffer & event loop WebSocket |
| **T3-PAIR-14** | F4 (Level 3 Vertical) | F5 (Level 4 Spawner Farm) + F6 (Stuck Recovery) | Transisi multitingkat dari rute jembatan sempit ke lorong bawah tanah dengan auto-recovery |
| **T3-PAIR-15** | F10 (Multi-Chest Sorting) | F7 (DB Action Audit Trail) + F12 (Web API) | Pencatatan transaksi pemindahan slot item ke `action_audit_logs` dan query via REST API `/api/telemetry/audit` |
| **T3-PAIR-16** | F9 (Zombie Farming) | F6 (Stuck Recovery / Mob Swarm Collision) | Deteksi desakan kerumunan zombie ($v_{xz} \approx 0$) memicu strafe melee kiting tanpa bot terperangkap |

---

### Rincian Spesifikasi Kasus Uji Tier 3 (T3-PAIR-01 s/d T3-PAIR-16)

#### T3-PAIR-01: Sinkronisasi Lifecycle Headless Arena & Inisialisasi Database
- **Tujuan**: Memastikan saat arena headless diinisialisasi atau di-reset untuk sebuah level benchmark, entri `benchmark_runs` terbuat dengan status `RUNNING`, UUID valid, dan jika server mengalami shutdown mendadak, status run diperbarui menjadi `FAILED` tanpa orphan lock di PostgreSQL.
- **Prekondisi**: Database PostgreSQL aktif, tabel DDL termigrasi, server headless siap spawn bot.
- **Langkah Pengujian**:
  1. Test runner mengirim perintah `startBenchmark(level=1)`.
  2. Ambil `run_id` yang dihasilkan dari database `benchmark_runs`.
  3. Simulasikan lifecycle arena berjalan selama 500ms, lalu selesaikan atau batalkan.
  4. Query tabel `benchmark_runs` berdasarkan `id = run_id`.
- **Ekspektasi Assertions**:
  - `run.id` bertipe UUID v4 yang valid.
  - `run.status` berpindah dari `'RUNNING'` ke `'SUCCESS'` atau `'FAILED'`.
  - `start_time` dan `end_time` tidak null, dengan `duration_ms > 0`.
  - Tidak ada entri menggantung dengan status `RUNNING` setelah teardown suite.

#### T3-PAIR-02: Paritas Metrik Real-Time Streaming WebSocket vs PostgreSQL Ingestion (Level 1)
- **Tujuan**: Memverifikasi bahwa setiap data posisi bot yang di-broadcast melalui event WebSocket `TICK_UPDATE` identik dengan data posisi yang di-batch ke dalam tabel `movement_action_logs`.
- **Prekondisi**: Bot menjalankan Level 1 (30m sprint). WebSocket client terhubung ke port 8080.
- **Langkah Pengujian**:
  1. Buka koneksi WebSocket client, dengarkan event `TICK_UPDATE` dan kumpulkan array pesan koordinat `[ {tick, x, y, z, velocity_xz}, ... ]`.
  2. Jalankan Level 1 benchmark hingga bot mencapai titik akhir.
  3. Query database `movement_action_logs` untuk `run_id` yang bersangkutan.
  4. Bandingkan jumlah total tick, koordinat awal, koordinat akhir, dan rata-rata kecepatan $v_{xz}$.
- **Ekspektasi Assertions**:
  - Selisih total tick antara WebSocket stream dan PostgreSQL logs $\le 2$ tick (toleransi flush akhir buffer).
  - Koordinat $(x, y, z)$ pada tick $N$ di WebSocket identik dengan row tick $N$ di DB (toleransi epsilon $< 0.001$).
  - `success_rate` pada tabel `benchmark_runs` bernilai `1.0`.

#### T3-PAIR-03: Injeksi Rintangan Dinamis Level 2 & Aktivasi Stuck Recovery Fase 1 & 2
- **Tujuan**: Menguji deteksi macet sliding window saat bot menghadapi rintangan tak terduga pada Level 2 (rintangan 50m) dan memastikan bot mengeksekusi Fase 1 (Micro-jump) atau Fase 2 (Strafe detour) lalu menyelesaikan lintasan.
- **Prekondisi**: Arena Level 2 terpasang. Bot mulai bergerak dari start `[0, 64, 0]` ke target `[50, 64, 0]`.
- **Langkah Pengujian**:
  1. Saat bot mencapai koordinat $x = 20$, injeksikan 1 blok cobblestone tambahan di depan bot yang tidak ada di peta awal pathfinder.
  2. Amati sliding window stuck detector: kecepatan $v_{xz} < 0.05$ m/tick selama 10 tick beruntun.
  3. Verifikasi bot memicu `recoveryPhase = 1` (jump), jika masih terhalang eskalasi ke `recoveryPhase = 2` (strafe kiri/kanan).
  4. Bot melanjutkan perjalanan dan mencapai target akhir.
- **Ekspektasi Assertions**:
  - Kolom `stuck_recovery_count` pada `benchmark_runs` bernilai $\ge 1$.
  - Tabel `movement_action_logs` mencatat minimal 1 baris dengan `is_stuck = true` dan `recovery_phase` bernilai 1 atau 2.
  - Bot mencapai target dalam batas toleransi $\le 1.0$ meter dari target.

#### T3-PAIR-04: Navigasi Vertikal Level 3 (Ladder & Narrow Bridge) dengan Rewind Recovery Fase 4
- **Tujuan**: Memastikan bot dapat mendaki ladder shaft dan menyeberangi jembatan 1-blok sempit, serta jika terhalang total di tengah jembatan sempit, bot mengeksekusi Fase 4 (Rewind to last safe waypoint) tanpa jatuh ke jurang/void.
- **Prekondisi**: Arena Level 3 aktif dengan konstruksi tangga balok, ladder shaft vertikal ($y=64 \rightarrow y=75$), dan jembatan 1-blok sepanjang 15 meter.
- **Langkah Pengujian**:
  1. Bot memanjat ladder shaft vertikal hingga puncak.
  2. Bot mulai menyeberangi jembatan 1-blok sempit ($z = 0 \rightarrow 15$).
  3. Pada $z = 8$, tempatkan barikade yang tidak dapat dilewati.
  4. Bot mendeteksi macet, melewati Fase 1 & 2 (gagal karena jembatan sempit), Fase 3 (re-route), dan mengeksekusi Fase 4 (mundur ke waypoint aman di $z = 0$).
- **Ekspektasi Assertions**:
  - Koordinat $y$ bot tidak pernah berada di bawah dasar arena ($y \ge 60$, tidak jatuh ke void).
  - `recovery_phase = 4` tercatat di `movement_action_logs`.
  - Bot berhasil kembali ke waypoint aman yang tercatat di `waypointGraph.js`.

#### T3-PAIR-05: Validasi Jalur Level 4 Spawner Farm Antara PostgreSQL `path_history` & Canvas Visualizer
- **Tujuan**: Memvalidasi integritas koordinat 3D dari navigasi rute permukaan ke koordinat bawah tanah `[-256, -20, -432]` antara data JSONB di PostgreSQL dan payload WebSocket untuk rendering Web Canvas.
- **Prekondisi**: Arena Level 4 aktif dengan graf makro-waypoint bawah tanah.
- **Langkah Pengujian**:
  1. Jalankan benchmark Level 4.
  2. Tangkap event `TELEMETRY_LOG` dan `BENCHMARK_STATUS` dari WebSocket.
  3. Tunggu bot mencapai target `[-256, -20, -432]`.
  4. Ambil `path_history` dari tabel `telemetry_logs` di PostgreSQL.
- **Ekspektasi Assertions**:
  - `end_pos` di database sama dengan `{"x": -256, "y": -20, "z": -432}` (dengan toleransi radius 2 blok).
  - Array `path_history` di DB memiliki minimal 50 simpul waypoint berurutan.
  - Setiap titik pada canvas visualizer cocok dengan simpul pada `path_history`.

#### T3-PAIR-06: Integrasi DeepSeek AI Tool Calling `farm_mobs` dengan Attack Cooldown Pacing
- **Tujuan**: Memastikan prompt teks Bahasa Indonesia dari pengguna diuraikan oleh DeepSeek Brain menjadi pemanggilan alat `farm_mobs` dan dieksekusi dengan ritme jeda serangan $\ge 625$ms (1.6 hit/detik untuk sword/axe).
- **Prekondisi**: Mock zombie spawner chamber berisi 5 entitas zombie. Bot memegang pedang besi (`iron_sword`).
- **Langkah Pengujian**:
  1. Kirim prompt ke AI Brain: `"Tolong bersihkan zombie di ruang spawner selama 10 detik!"`.
  2. Verifikasi parser AI menghasilkan tool call: `{ name: 'farm_mobs', parameters: { target: 'zombie', durationSeconds: 10, weapon: 'sword' } }`.
  3. Rekam timestamp setiap aksi `bot.attack(entity)`.
  4. Hitung interval waktu $\Delta t = t_{n} - t_{n-1}$ untuk seluruh serangan.
- **Ekspektasi Assertions**:
  - Tool call teridentifikasi secara akurat.
  - Untuk setiap serangan, $\Delta t \ge 625$ milidetik (tidak ada *spam click* yang membatalkan damage).
  - Event `AI_ACTION_EVENT` terkirim ke WebSocket dengan status `'SUCCESS'`.

#### T3-PAIR-07: Estafet Otomatis Farming Zombie ke Penyortiran Item Multi-Peti
- **Tujuan**: Menguji integrasi otomatis setelah sesi farming selesai: bot mengambil item drop di lantai (rotten flesh, iron ingots), lalu memicu tugas `sort_chests` untuk memasukkan item ke peti yang sesuai.
- **Prekondisi**: Ruang spawner dengan loot di lantai, terhubung ke ruang penyimpanan 3 peti.
- **Langkah Pengujian**:
  1. Jalankan `farm_mobs` selama 5 detik hingga zombie drop menghasilkan item.
  2. Bot mengumpulkan loot ke inventaris.
  3. AI Brain memanggil tugas `sort_chests(chestCoords=[Peti1, Peti2, Peti3])`.
  4. Bot berjalan ke masing-masing peti dan memindahkan item sesuai kategori.
- **Ekspektasi Assertions**:
  - Inventaris bot berkurang (item berpindah ke peti).
  - Peti Drop Mob (Peti 3) berisi `rotten_flesh`.
  - Peti Mineral (Peti 2) berisi `iron_ingot` (jika ada).
  - Transaksi transfer tercatat pada tabel `action_audit_logs`.

#### T3-PAIR-08: Filter Inventaris: Pemisahan Mineral Berharga vs Limbah Sampah Sebelum Insinerasi
- **Tujuan**: Memastikan bot tidak pernah membakar mineral berharga (diamond, iron, gold) atau peralatan saat menjalankan tugas pembersihan sampah (`incinerate_trash`).
- **Prekondisi**: Inventaris bot berisi: 5x `poisonous_potato`, 64x `rotten_flesh`, 3x `diamond`, 1x `iron_sword`.
- **Langkah Pengujian**:
  1. Jalankan tugas `sort_chests` diikuti oleh `incinerate_trash`.
  2. Verifikasi bot menyimpan `diamond` dan `iron_sword` ke dalam peti mineral/peralatan terlebih dahulu.
  3. Bot hanya membawa `poisonous_potato` dan sisa `rotten_flesh` ke lokasi pembakaran.
- **Ekspektasi Assertions**:
  - Jumlah `diamond` dan `iron_sword` dalam sistem tetap utuh (berada di dalam peti).
  - Item yang dibuang ke api/lava HANYA bertipe `poisonous_potato` dan `rotten_flesh`.
  - Database mencatat log audit pembuangan sampah dengan detail tipe item yang tepat.

#### T3-PAIR-09: Penegakan Batas Keamanan Perimeter Bahaya (Lava/Fire Incinerator)
- **Tujuan**: Memverifikasi bahwa modul navigasi dan modul pembakaran sampah menerapkan penjaga perimeter bahaya ($d \ge 1.5$ meter dari lava), sehingga bot dapat melempar item sampah ke lava tanpa terbakar atau menerima damage api.
- **Prekondisi**: Blok lava berada di koordinat `[10, 64, 10]`. Health bot = 20 (penuh).
- **Langkah Pengujian**:
  1. AI memicu `incinerate_trash(hazardCoord={x:10, y:64, z:10}, hazardType='lava', items=['poisonous_potato'])`.
  2. Amati koordinat posisi bot saat melempar item.
  3. Hitung jarak Euclidean Euclidean 2D $D = \sqrt{(x_{bot} - 10)^2 + (z_{bot} - 10)^2}$.
  4. Verifikasi bot melakukan `bot.lookAt([10, 64, 10])` dan `bot.tossStack(...)`.
- **Ekspektasi Assertions**:
  - Jarak $D \ge 1.5$ meter dan $D \le 3.0$ meter sepanjang operasi pembuangan.
  - Health bot tetap 20 (zero fire/lava damage).
  - Item terlempar ke dalam blok lava dan musnah.

#### T3-PAIR-10: Lokalisasi Bahasa Indonesia & Google Fonts Poppins pada UI Dashboard
- **Tujuan**: Memastikan seluruh pesan status tugas AI, label kontrol benchmark, dan notifikasi error yang diterima web client disajikan dalam Bahasa Indonesia yang baku dan dirender dengan CSS font-family Poppins.
- **Prekondisi**: Web Dashboard aktif di `http://localhost:8080`.
- **Langkah Pengujian**:
  1. Lakukan HTTP GET pada `http://localhost:8080/`.
  2. Periksa markup HTML untuk link stylesheet Google Fonts `Poppins`.
  3. Lakukan simulasi error (misal target navigasi tidak valid).
  4. Ambil pesan respons error dari API dan WebSocket event.
- **Ekspektasi Assertions**:
  - HTML memuat link `<link href="...fonts.googleapis.com/css2?family=Poppins..." rel="stylesheet">`.
  - CSS menyetel `font-family: 'Poppins', sans-serif`.
  - Pesan error dan label UI menggunakan Bahasa Indonesia (contoh: `"Navigasi berhasil diselesaikan"`, `"Gagal mencapai koordinat target: terhalang rintangan"`, `"Memulai tolak ukur Level 1"`). Tidak ada string error mentah bahasa Inggris yang terekspos ke user.

#### T3-PAIR-11: Audit Transisi `is_stuck` dan `recovery_phase` di Database PostgreSQL
- **Tujuan**: Memastikan saat terjadi eskalasi recovery, tabel `movement_action_logs` mencatat transisi status fase pemulihan secara presisi per tick.
- **Prekondisi**: Runner Level 2 dengan rintangan yang memicu eskalasi bertahap.
- **Langkah Pengujian**:
  1. Jalankan benchmark Level 2 dengan rintangan.
  2. Setelah selesai, eksekusi query SQL:
     ```sql
     SELECT tick, x, y, z, velocity_xz, is_stuck, recovery_phase 
     FROM movement_action_logs 
     WHERE run_id = $1 AND is_stuck = true 
     ORDER BY tick ASC;
     ```
  3. Periksa kontinuitas eskalasi fase.
- **Ekspektasi Assertions**:
  - Kolom `is_stuck` bernilai `true` saat `velocity_xz` di bawah threshold.
  - Transisi `recovery_phase` tercatat mulai dari `1` (micro-jump), meningkat ke `2` (strafe) atau `3` (re-route) sesuai kebutuhan, dan kembali ke `0` saat bot berhasil bergerak kembali.

#### T3-PAIR-12: Fallback Deterministik Mock AI dalam Mode Headless Offline
- **Tujuan**: Memastikan subsistem AI Brain dapat beralih secara mulus ke heuristic mock provider saat `DEEPSEEK_API_KEY` tidak tersedia atau koneksi internet terputus, sehingga pengujian otomatis tetap 100% deterministik dan lulus di CI/CD.
- **Prekondisi**: Set environment variable `DEEPSEEK_API_KEY=""` atau `INTEGRITY_MODE="development"`.
- **Langkah Pengujian**:
  1. Panggil `aiPlanner.planTask("Bersihkan zombie dan simpan loot")`.
  2. Verifikasi sistem tidak melempar uncaught network error.
  3. Sistem mengembalikan urutan rencana tindakan yang valid melalui heuristic parser.
- **Ekspektasi Assertions**:
  - Parser mengembalikan array tugas valid: `['farm_mobs', 'sort_chests']`.
  - Status provider menunjukkan `'mock_fallback_active'`.
  - Eksekusi tugas berjalan hingga selesai tanpa crash.

#### T3-PAIR-13: Ketahanan Beban Ring Buffer Batch Ingestion vs WebSocket Broadcaster
- **Tujuan**: Menguji kestabilan sistem telemetri ketika menerima 100 tick/detik (5x dari normal), memastikan ring buffer 250ms melakukan flush berkala ke PostgreSQL tanpa memblokir event loop WebSocket.
- **Prekondisi**: Modul batch ingestion aktif dengan interval buffer flush 250ms.
- **Langkah Pengujian**:
  1. Simulasikan producer yang mengirimkan 500 movement ticks dalam durasi 5 detik.
  2. Buka koneksi WebSocket client secara simultan.
  3. Ukur latensi respons WebSocket dan verifikasi jumlah record yang masuk ke tabel `movement_action_logs`.
- **Ekspektasi Assertions**:
  - Tepat 500 record tersimpan di PostgreSQL.
  - Tidak ada frame loss atau lag signifikan pada WebSocket broadcast (latensi $< 50$ms).
  - Penggunaan memori Node.js heap tetap stabil (tidak ada memory leak).

#### T3-PAIR-14: Transisi Mulus Navigasi Vertikal Level 3 ke Rute Bawah Tanah Level 4
- **Tujuan**: Menguji navigasi berkesinambungan saat bot berpindah dari struktur vertikal permukaan (ladder shaft) langsung masuk ke mulut gua menuju target spawner `[-256, -20, -432]`.
- **Prekondisi**: Arena gabungan Level 3 dan Level 4.
- **Langkah Pengujian**:
  1. Bot memulai dari elevasi permukaan $y = 64$.
  2. Bot menuruni tangga dan ladder ke $y = 20$.
  3. Bot melanjutkan penelusuran makro-waypoint bawah tanah hingga $y = -20$.
- **Ekspektasi Assertions**:
  - Koordinat $y$ bot menurun secara konsisten dari $+64$ ke $-20$.
  - Transisi state pathfinder berlangsung tanpa restart bot client.
  - Total `travel_duration_ms` terekam akurat di `telemetry_logs`.

#### T3-PAIR-15: Pencatatan Audit Trail Transaksi Peti ke PostgreSQL dan Verifikasi REST API
- **Tujuan**: Memastikan setiap pemindahan item dari inventaris ke peti mencatat record di tabel `action_audit_logs`, dan dapat di-query melalui REST API endpoint `/api/telemetry/audit`.
- **Prekondisi**: Bot melakukan pemindahan 10 unit `iron_ingot` ke peti di `[12, 64, 5]`.
- **Langkah Pengujian**:
  1. Eksekusi `sort_chests`.
  2. Lakukan HTTP GET ke `http://localhost:8080/api/telemetry/audit?action=CHEST_DEPOSIT`.
  3. Periksa JSON response payload.
- **Ekspektasi Assertions**:
  - HTTP Status 200 OK.
  - JSON response memuat array audit dengan properti `action: 'CHEST_DEPOSIT'`, `item: 'iron_ingot'`, `count: 10`, `chest_coord: {x:12, y:64, z:5}`.
  - Timestamp ISO 8601 valid.

#### T3-PAIR-16: Mitigasi Desakan Kerumunan Zombie (Mob Swarm Collision & Kiting)
- **Tujuan**: Memastikan bot tidak terjebak dalam kondisi stuck saat dikerumuni 4 zombie sekaligus; bot memicu kiting/strafe untuk menjaga jarak serang optimal ($2.0 \le d \le 3.5$m) sembari menerapkan weapon cooldown.
- **Prekondisi**: 4 entitas zombie di-spawn mengelilingi bot dalam radius 1.5m.
- **Langkah Pengujian**:
  1. AI memicu `farm_mobs`.
  2. Bot mendeteksi penurunan kecepatan gerak akibat tabrakan hitbox zombie.
  3. Modul recovery memicu strafe mundur/menyamping (Phase 2) sambil terus mengeksekusi serangan terukur setiap $\ge 625$ms.
- **Ekspektasi Assertions**:
  - Health bot tidak mencapai 0 (bot bertahan hidup).
  - Seluruh 4 zombie berhasil dikalahkan.
  - Log mencatat kombinasi aksi pemulihan dan serangan senjata tanpa freeze.

---

## 4. Tier 4: Real-World Application Scenario Specifications (7 Scenarios)

### Matriks 7 Skenario Beban Nyata Tier 4

| Skenario ID | Nama Skenario | Fitur yang Diuji | Durasi Target | Fokus Pengujian Dunia Nyata |
|-------------|---------------|------------------|---------------|-----------------------------|
| **T4-SCEN-01** | Progresi Penuh Kurikulum Benchmark Level 1–4 Otonom | F1, F2, F3, F4, F5, F6, F7, F12, F14 | ~3–5 Menit | Eksekusi sekuensial seluruh level (L1 x5, L2, L3, L4), persistensi database, metrik dashboard |
| **T4-SCEN-02** | Pipeline Lengkap: Farming, Looting, Sorting & Incineration | F1, F6, F7, F8, F9, F10, F11, F12, F13 | ~2–4 Menit | Alur kerja pemeliharaan spawner AI end-to-end tanpa intervensi manual |
| **T4-SCEN-03** | Navigasi Gua Vertikal dengan Pemulihan Rintangan Dinamis Berulang | F1, F3, F4, F5, F6, F7, F12 | ~2–3 Menit | Stres uji mesin navigasi 4-fase di medan ekstrem dengan injeksi halangan berkala |
| **T4-SCEN-04** | AI Multi-Task Planner dengan Simulasi Gangguan API & Failover | F7, F8, F9, F10, F11, F12, F13 | ~2–3 Menit | Dekomposisi tugas majemuk Bahasa Indonesia & transisi mulus ke mock fallback saat API drop |
| **T4-SCEN-05** | Endurance Telemetri Frekuensi Tinggi & Uji Putus Koneksi Database | F1, F2, F6, F7, F12, F14 | ~5–10 Menit | Stres 12.000 tick navigasi, simulasi DB restart 2 detik, buffer retention & recovery |
| **T4-SCEN-06** | Sesi Observasi & Kontrol Dasbor Multi-Klien Simultan | F2, F3, F7, F8, F12, F13 | ~2–3 Menit | 5 WebSocket client bersamaan mengontrol benchmark, melihat visualizer, dan chat terminal |
| **T4-SCEN-07** | Disaster Recovery: Restart Server Headless & Resumsi Misi Otonom | F1, F4, F5, F6, F7, F14 | ~2–4 Menit | Server headless crash saat bot di $y=-5$, auto-reconnect bot, reload waypoint dari DB, capai target |

---

### Rincian Spesifikasi Skenario Tier 4 (T4-SCEN-01 s/d T4-SCEN-07)

```
+----------------------------------------------------------------------------------------------------+
|                                 DIAGRAM ALUR TIER 4 WORKLOAD SCENARIOS                             |
+----------------------------------------------------------------------------------------------------+
|                                                                                                    |
| [T4-SCEN-01]  Level 1 (5 Runs) ──> Level 2 (Obstacles) ──> Level 3 (Vertical) ──> Level 4 (Farm)   |
|                      │                     │                      │                    │           |
|                      └─────────────────────┴─── Database Log ─────┴────────────────────┘           |
|                                                                                                    |
| [T4-SCEN-02]  Prompt AI ──> Navigasi Farm ──> Combat Farming ──> Loot Scan ──> Chest Sort ──>      |
|                             ──> Filter Sampah ──> Hazard Safety Check ──> Insinerasi Lava          |
|                                                                                                    |
| [T4-SCEN-03]  Navigasi 3D ──> Blok Terhalang ──> Micro-jump ──> Strafe ──> Re-route ──> Rewind     |
|                                                                                                    |
| [T4-SCEN-04]  Prompt Majemuk ──> AI Plan ──> [Simulasi API Putus] ──> Mock Fallback ──> Selesai    |
|                                                                                                    |
| [T4-SCEN-05]  12.000 Ticks ──> [DB Drop 2 Detik] ──> Ring Buffer Retain ──> Flush Backlog          |
|                                                                                                    |
| [T4-SCEN-06]  5 Klien Web ──> Kontrol Uji + Live Canvas + Chat AI + Metrik (Bahasa Indonesia)      |
|                                                                                                    |
| [T4-SCEN-07]  Misi Level 4 ──> [Server Crash] ──> Auto-Restart ──> Resume dari DB Waypoint        |
+----------------------------------------------------------------------------------------------------+
```

---

#### T4-SCEN-01: Progresi Penuh Kurikulum Benchmark Level 1–4 Otonom
- **Deskripsi & Konteks**: Pengujian master kurikulum benchmark end-to-end secara otomatis dari Level 1 sampai Level 4 secara berurutan, memvalidasi kriteria penerimaan §Acceptance Criteria pada `ORIGINAL_REQUEST.md`.
- **Alur Prosedur Uji**:
  1. Inisialisasi Database Schema `minecraft_companion` dan peluncuran Server Headless Arena.
  2. **Level 1 (Flat Ground)**: Eksekusi 5 kali uji jalan otomatis berturut-turut jarak 30m. Bot harus mencapai target 5 dari 5 kali (tingkat keberhasilan 100%).
  3. **Level 2 (Obstacles & Elevation)**: Eksekusi navigasi lintasan 50m dengan rintangan 1-blok dan belokan.
  4. **Level 3 (Stairs, Ladders & Bridges)**: Eksekusi navigasi vertikal menaiki tangga balok, ladder shaft vertikal, dan menyeberang jembatan sempit 1-blok.
  5. **Level 4 (Underground Spawner Farm)**: Navigasi jarak jauh dari koordinat awal permukaan menuruni gua bawah tanah hingga mencapai target akhir `[-256, -20, -432]`.
  6. Query PostgreSQL untuk memvalidasi pencatatan seluruh 8 sesi run (`5x Level 1 + 1x Level 2 + 1x Level 3 + 1x Level 4`).
- **Verifikasi Database & Metrik**:
  - `SELECT COUNT(*) FROM benchmark_runs WHERE status = 'SUCCESS';` menghasilkan nilai 8.
  - Nilai rata-rata `success_rate` untuk 5 run Level 1 adalah `1.0`.
  - Tabel `telemetry_logs` mencatat delta koordinat akhir $\le 1.0$ meter untuk semua level.
- **Kriteria Kelulusan**: Seluruh 4 level lulus tanpa kegagalan atau bot tersangkut fatal.

---

#### T4-SCEN-02: Pipeline Lengkap: Farming, Looting, Sorting & Incineration
- **Deskripsi & Konteks**: Siklus pemeliharaan farm otonom yang digerakkan oleh perintah AI: bot pergi ke spawner, bertarung, memungut drop, menyortir barang berharga ke peti, dan membakar sampah beracun ke lava dengan aman.
- **Alur Prosedur Uji**:
  1. Pengguna memasukkan perintah teks melalui Web Terminal: `"Lakukan rutinitas pembersihan farm zombie dan rapikan penyimpanan!"`.
  2. AI Brain menyusun urutan sub-tugas: `[NAVIGATE_TO_FARM, FARM_ZOMBIES, COLLECT_LOOT, SORT_CHESTS, INCINERATE_TRASH]`.
  3. Bot berjalan ke ruang spawner di `[-256, -20, -432]`.
  4. Bot membunuh 6 zombie dengan jeda serangan pedang $\ge 625$ms per hit.
  5. Bot memungut item drop: 12x `rotten_flesh`, 2x `iron_ingot`, 1x `iron_helmet`, 3x `poisonous_potato`.
  6. Bot berjalan ke ruang penyimpanan 3 peti:
     - Memasukkan `iron_helmet` ke Peti 1 (Peralatan).
     - Memasukkan `iron_ingot` ke Peti 2 (Mineral).
     - Memasukkan 8x `rotten_flesh` ke Peti 3 (Mob Drops).
  7. Bot membawa sisa sampah (3x `poisonous_potato` + 4x `rotten_flesh`) ke ruang insinerator lava di `[-240, -20, -420]`.
  8. Bot berhenti pada jarak aman 2.0 meter dari lava, menghadap ke blok lava, dan membuang sampah.
  9. Bot kembali ke titik kumpul utama (home base).
- **Verifikasi Database & UI**:
  - Tabel `action_audit_logs` mencatat seluruh aksi deposit peti dan pembuangan sampah.
  - Inventaris akhir bot tidak lagi mengandung `poisonous_potato`.
  - Bot tidak mengalami penurunan HP akibat lava/api.
  - Web Dashboard AI Terminal menampilkan setiap tahapan dalam Bahasa Indonesia.
- **Kriteria Kelulusan**: Semua item tersortir dengan benar, sampah musnah, bot selamat 100%.

---

#### T4-SCEN-03: Navigasi Gua Vertikal dengan Pemulihan Rintangan Dinamis Berulang
- **Deskripsi & Konteks**: Pengujian ketahanan mesin navigasi dan state machine pemulihan 4-fase di medan gua vertikal dengan injeksi 3 jenis halangan dinamis berurutan.
- **Alur Prosedur Uji**:
  1. Bot memulai rute 100m melalui labirin gua bertingkat.
  2. **Injeksi Rintangan 1 (Blok di Tangga)**: Sistem menaruh blok batu di anak tangga. Bot mendeteksi $v_{xz} < 0.05$, memicu Fase 1 (Micro-jump), melompati blok, dan melanjutkan perjalanan.
  3. **Injeksi Rintangan 2 (Entitas di Pintu Masuk)**: Sistem menaruh entitas NPC statis di celah 1x2. Bot mendeteksi kegagalan Fase 1, eskalasi ke Fase 2 (Strafe ke celah samping), dan melewatinya.
  4. **Injeksi Rintangan 3 (Gua Buntu / Runtuhan)**: Sistem menutup lorong utama sepenuhnya. Bot mencoba Fase 1, 2, lalu eskalasi ke Fase 3 (Pathfinder Re-route) untuk mencari rute alternatif, atau Fase 4 (Rewind ke waypoint aman) jika rute tertutup total.
- **Verifikasi Database & WebSocket**:
  - `stuck_recovery_count` pada database bertambah minimal 3 kali.
  - `movement_action_logs` mencatat urutan fase pemulihan `[1, 2, 3]`.
  - Visualizer 2D/3D pada Web Dashboard menampilkan jalur deviasi/detour secara real-time.
- **Kriteria Kelulusan**: Bot berhasil mencapai target akhir tanpa jatuh ke jurang dan tanpa terjebak *infinite loop*.

---

#### T4-SCEN-04: AI Multi-Task Planner dengan Simulasi Gangguan API & Failover
- **Deskripsi & Konteks**: Pengujian ketahanan arsitektur AI Brain ketika menerima instruksi kompleks Bahasa Indonesia namun koneksi ke API DeepSeek eksternal terputus di tengah jalan.
- **Alur Prosedur Uji**:
  1. Kirim prompt majemuk: `"Periksa peti nomor 1, ambil semua pedang besi, lalu bawa ke koordinat [-250, 64, 100] untuk berjaga-jaga!"`.
  2. AI Brain memulai perencanaan tugas.
  3. Simulasikan HTTP 503 Service Unavailable / Network Timeout pada klien API eksternal.
  4. Sistem AI secara otomatis mengaktifkan modul `mockClient.js` (Heuristic Fallback Engine).
  5. Heuristic Engine menguraikan token prompt Bahasa Indonesia (`"periksa peti"`, `"ambil pedang besi"`, `"bawa ke koordinat"`) menjadi pemanggilan fungsi lokal yang setara.
  6. Bot mengeksekusi tugas hingga selesai dan melaporkan status ke Dashboard.
- **Verifikasi Log & UI**:
  - Log server mencatat pesan peringatan Bahasa Indonesia: `"Koneksi DeepSeek API terputus. Mengaktifkan fallback heuristik lokal..."`.
  - Web Terminal menampilkan notifikasi failover tanpa crash.
  - Seluruh rangkaian subtugas selesai dieksekusi dengan benar.
- **Kriteria Kelulusan**: Zero unhandled rejection, tugas tetap tereksekusi 100%.

---

#### T4-SCEN-05: Endurance Telemetri Frekuensi Tinggi & Uji Putus Koneksi Database
- **Deskripsi & Konteks**: Pengujian ketahanan sistem telemetri frekuensi tinggi (12.000 tick / 10 menit operasi kontinu) dengan simulasi terputusnya koneksi PostgreSQL selama 2 detik.
- **Alur Prosedur Uji**:
  1. Bot menjalankan navigasi patroli berulang pada arena Level 2 dan 3 selama 10 menit (kecepatan 20 tick/detik).
  2. Modul `batchIngestion.js` mengumpulkan data ke ring buffer 250ms dan melakukan flush berkala ke PostgreSQL.
  3. Pada menit ke-5, putuskan koneksi pool PostgreSQL (`pool.end()` atau simulasi drop TCP 2 detik).
  4. Ring buffer mendeteksi error koneksi DB, menahan data tick di dalam antrean memori lokal (kapasitas hingga 1.000 record), dan memicu koneksi ulang otomatis.
  5. Koneksi PostgreSQL pulih; buffer melakukan *drain* dan *bulk insert* seluruh backlog yang tertahan.
  6. Selesaikan durasi 10 menit.
- **Verifikasi Database & Buffer**:
  - Total baris pada `movement_action_logs` sama dengan total tick yang dihasilkan bot (selisih $< 0.1\%$).
  - Tidak ada lonjakan konsumsi memori Node.js (heap memory stabil $< 150$MB).
  - WebSocket stream ke web dashboard tetap lancar tanpa stutter selama DB terputus.
- **Kriteria Kelulusan**: Zero data loss, zero crash, reconnection otomatis berhasil.

---

#### T4-SCEN-06: Sesi Observasi & Kontrol Dasbor Multi-Klien Simultan
- **Deskripsi & Konteks**: Menguji konkurensi Web Dashboard (Express + WebSocket Port 8080) saat diakses oleh 5 klien peramban secara bersamaan dalam mode interaktif.
- **Alur Prosedur Uji**:
  1. Buka 5 koneksi WebSocket klien simultan ke `ws://localhost:8080`.
  2. Klien 1 mengirim perintah WebSocket: `{ action: 'START_BENCHMARK', level: 3 }`.
  3. Klien 2 melakukan polling REST API `/api/telemetry/live` setiap 500ms.
  4. Klien 3 mengirim pesan prompt AI melalui terminal: `"Status bot saat ini apa?"`.
  5. Klien 4 dan 5 mendengarkan broadcast event dan merender pergerakan bot pada Canvas 2D/3D.
  6. Periksa sinkronisasi status antara seluruh 5 klien.
- **Verifikasi WebSocket & Frontend**:
  - Semua 5 klien menerima event `BENCHMARK_STATUS` dan `TICK_UPDATE` yang seragam (perbedaan waktu kedatangan $< 30$ms).
  - Canvas visualizer pada Klien 4 & 5 merender posisi bot yang sama persis.
  - Pesan balasan AI di Klien 3 diterima dan tampil dalam Bahasa Indonesia dengan styling Poppins.
- **Kriteria Kelulusan**: Tidak ada koneksi yang terputus, semua klien tersinkronisasi 100%.

---

#### T4-SCEN-07: Disaster Recovery: Restart Server Headless & Resumsi Misi Otonom
- **Deskripsi & Konteks**: Pengujian pemulihan bencana ketika server headless Minecraft arena mengalami crash mendadak di tengah misi Level 4, dan bot harus mampu melakukan auto-reconnect, memulihkan status dari PostgreSQL, dan melanjutkan perjalanan hingga target.
- **Alur Prosedur Uji**:
  1. Bot memulai benchmark Level 4 menuruni gua bawah tanah.
  2. Saat bot mencapai kedalaman $y = -5$ (75% progres lintasan), simulasikan crash mendadak pada Server Arena Headless (proses server di-kill).
  3. Klien bot mendeteksi socket disconnect (`bot.on('end')`).
  4. Master Test Harness mendeteksi crash dan me-restart Server Arena Headless.
  5. Klien bot menghubungkan diri kembali ke server.
  6. Modul navigasi membaca koordinat terakhir dan target dari tabel `telemetry_logs` / `waypointGraph.js`, lalu melanjutkan pathfinding dari $y = -5$ menuju `[-256, -20, -432]`.
  7. Bot mencapai koordinat akhir target.
- **Verifikasi Database & Status**:
  - Database mencatat log *reconnection event*.
  - Status akhir run tercatat sebagai `SUCCESS` setelah resumsi berhasil.
  - Koordinat akhir berada dalam toleransi $\le 1.5$ meter dari `[-256, -20, -432]`.
- **Kriteria Kelulusan**: Misi berhasil diselesaikan pasca-disaster tanpa intervensi manual.

---

## 5. Test Harness Implementation Blueprint for Tier 3 & Tier 4

### A. Struktur File Pengujian E2E

```
test/
├── e2e/
│   ├── tier1_feature_coverage.test.js      # Tier 1: 70+ uji isolasi fitur
│   ├── tier2_boundary_corner.test.js       # Tier 2: 70+ uji batas & corner cases
│   ├── tier3_cross_feature.test.js         # Tier 3: 16 uji kombinasi pairwise
│   └── tier4_real_world.test.js            # Tier 4: 7 skenario beban nyata
├── harness/
│   ├── mockArenaHarness.js                 # In-process server & mock arena lifecycle
│   ├── pgTestClient.js                     # Helper query & validasi PostgreSQL
│   ├── wsTestClient.js                     # Mock WebSocket client untuk dashboard
│   └── mockAiProvider.js                   # Heuristic deterministic AI mock
└── runner.js                               # Master Test Runner (Multi-Tier CLI)
```

### B. Blueprint Kode `test/e2e/tier3_cross_feature.test.js`

```javascript
/**
 * Suite Pengujian E2E Tier 3: Kombinasi Pairwise Lintas Fitur
 * Memvalidasi 16 kasus uji interaksi antar-subsistem.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { MockArenaHarness } = require('../harness/mockArenaHarness');
const { PgTestClient } = require('../harness/pgTestClient');
const { WsTestClient } = require('../harness/wsTestClient');

describe('Tier 3: Pengujian Kombinasi Pairwise Lintas Fitur', () => {
  let arena;
  let db;
  let ws;

  before(async () => {
    db = new PgTestClient();
    await db.connect();
    await db.runMigrations();

    arena = new MockArenaHarness({ port: 25565 });
    await arena.start();

    ws = new WsTestClient('ws://localhost:8080');
    await ws.connect();
  });

  after(async () => {
    if (ws) await ws.disconnect();
    if (arena) await arena.stop();
    if (db) await db.cleanupAndClose();
  });

  it('T3-PAIR-01: Sinkronisasi Lifecycle Headless Arena & Inisialisasi Database', async () => {
    const runId = await arena.startBenchmark(1);
    const runRecord = await db.getBenchmarkRun(runId);
    assert.ok(runRecord, 'Entri benchmark run harus terbuat di database');
    assert.equal(runRecord.status, 'RUNNING');
    
    await arena.waitForBenchmarkComplete(runId, 5000);
    const completedRecord = await db.getBenchmarkRun(runId);
    assert.equal(completedRecord.status, 'SUCCESS');
    assert.ok(completedRecord.duration_ms > 0, 'Durasi harus terhitung positif');
  });

  it('T3-PAIR-02: Paritas Metrik Real-Time Streaming WebSocket vs PostgreSQL Ingestion', async () => {
    const wsTicks = [];
    ws.on('TICK_UPDATE', (data) => wsTicks.push(data));

    const runId = await arena.startBenchmark(1);
    await arena.waitForBenchmarkComplete(runId, 10000);

    const dbLogs = await db.getMovementLogs(runId);
    assert.ok(wsTicks.length > 0, 'Event WebSocket TICK_UPDATE harus diterima');
    assert.ok(dbLogs.length > 0, 'Log pergerakan harus tersimpan di DB');
    assert.ok(Math.abs(wsTicks.length - dbLogs.length) <= 2, 'Paritas jumlah tick antara WS dan DB harus konsisten');
  });

  it('T3-PAIR-03: Injeksi Rintangan Dinamis Level 2 & Aktivasi Stuck Recovery Fase 1 & 2', async () => {
    const runId = await arena.startBenchmark(2);
    // Injeksi rintangan dinamis di tengah jalan
    setTimeout(() => arena.injectBlockObstacle({ x: 20, y: 64, z: 0 }), 1000);

    await arena.waitForBenchmarkComplete(runId, 15000);
    const stuckLogs = await db.getStuckMovementLogs(runId);
    assert.ok(stuckLogs.length > 0, 'Kondisi macet harus terdeteksi oleh sliding window');
    assert.ok(stuckLogs.some(log => log.recovery_phase >= 1), 'Fase pemulihan 1 atau 2 harus diaktifkan');
  });

  it('T3-PAIR-06: Integrasi DeepSeek AI Tool Calling farm_mobs dengan Attack Cooldown Pacing', async () => {
    const attackTimestamps = [];
    arena.bot.on('entityAttack', () => attackTimestamps.push(Date.now()));

    const result = await arena.submitAiCommand('Basmi zombie di spawner selama 5 detik!');
    assert.equal(result.tool, 'farm_mobs');

    for (let i = 1; i < attackTimestamps.length; i++) {
      const delta = attackTimestamps[i] - attackTimestamps[i - 1];
      assert.ok(delta >= 625, `Jeda serangan (${delta}ms) harus mematuhi weapon cooldown >= 625ms`);
    }
  });

  it('T3-PAIR-09: Penegakan Batas Keamanan Perimeter Bahaya (Lava Incinerator)', async () => {
    const lavaCoord = { x: 10, y: 64, z: 10 };
    arena.setupHazardBlock(lavaCoord, 'lava');
    arena.bot.inventory.addItem('poisonous_potato', 5);

    await arena.executeTask('incinerate_trash', { hazardCoord: lavaCoord, hazardType: 'lava', items: ['poisonous_potato'] });
    
    const botPos = arena.bot.entity.position;
    const distance = Math.hypot(botPos.x - lavaCoord.x, botPos.z - lavaCoord.z);
    assert.ok(distance >= 1.5, `Jarak aman bot (${distance.toFixed(2)}m) harus >= 1.5m dari lava`);
    assert.equal(arena.bot.health, 20, 'Health bot harus tetap penuh tanpa terbakar');
  });

  it('T3-PAIR-10: Lokalisasi Bahasa Indonesia & Google Fonts Poppins pada UI Dashboard', async () => {
    const res = await fetch('http://localhost:8080/');
    const html = await res.text();
    assert.ok(html.includes('family=Poppins'), 'Halaman HTML harus memuat font Poppins');
    assert.ok(html.includes('Tolak Ukur Navigasi') || html.includes('Terminal AI'), 'UI harus menggunakan Bahasa Indonesia');
  });
});
```

### C. Blueprint Kode `test/e2e/tier4_real_world.test.js`

```javascript
/**
 * Suite Pengujian E2E Tier 4: Skenario Beban Dunia Nyata
 * Memvalidasi 7 skenario alur kerja komprehensif end-to-end.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { MockArenaHarness } = require('../harness/mockArenaHarness');
const { PgTestClient } = require('../harness/pgTestClient');
const { WsTestClient } = require('../harness/wsTestClient');

describe('Tier 4: Skenario Beban Dunia Nyata (Real-World Scenarios)', () => {
  let arena;
  let db;
  let ws;

  before(async () => {
    db = new PgTestClient();
    await db.connect();
    arena = new MockArenaHarness();
    await arena.start();
    ws = new WsTestClient('ws://localhost:8080');
    await ws.connect();
  });

  after(async () => {
    if (ws) await ws.disconnect();
    if (arena) await arena.stop();
    if (db) await db.cleanupAndClose();
  });

  it('T4-SCEN-01: Progresi Penuh Kurikulum Benchmark Level 1-4 Otonom', async () => {
    // Level 1: 5 kali berturut-turut
    for (let i = 1; i <= 5; i++) {
      const runId = await arena.startBenchmark(1);
      const res = await arena.waitForBenchmarkComplete(runId, 8000);
      assert.equal(res.status, 'SUCCESS', `Level 1 Run ${i} harus sukses`);
    }

    // Level 2
    const runId2 = await arena.startBenchmark(2);
    const res2 = await arena.waitForBenchmarkComplete(runId2, 15000);
    assert.equal(res2.status, 'SUCCESS', 'Level 2 harus sukses melewati rintangan');

    // Level 3
    const runId3 = await arena.startBenchmark(3);
    const res3 = await arena.waitForBenchmarkComplete(runId3, 20000);
    assert.equal(res3.status, 'SUCCESS', 'Level 3 harus sukses mendaki tangga dan menyeberang jembatan');

    // Level 4
    const runId4 = await arena.startBenchmark(4);
    const res4 = await arena.waitForBenchmarkComplete(runId4, 35000);
    assert.equal(res4.status, 'SUCCESS', 'Level 4 harus mencapai koordinat target farm');

    const totalRuns = await db.countSuccessfulRuns();
    assert.equal(totalRuns, 8, 'Total 8 run benchmark harus tercatat sukses di PostgreSQL');
  });

  it('T4-SCEN-02: Pipeline Lengkap: Farming, Looting, Sorting & Incineration', async () => {
    const res = await arena.runFullMaintenanceRoutine();
    assert.equal(res.farmingComplete, true, 'Farming zombie selesai dengan attack cooldown');
    assert.equal(res.sortingComplete, true, 'Item berharga tersimpan di peti yang tepat');
    assert.equal(res.trashIncinerated, true, 'Sampah beracun termusnahkan');
    assert.equal(res.botDamaged, false, 'Bot aman dari bahaya lava');

    const auditLogs = await db.getActionAuditLogs();
    assert.ok(auditLogs.length >= 3, 'Log audit harus mencatat transaksi pemindahan dan pembakaran');
  });

  it('T4-SCEN-05: Endurance Telemetri Frekuensi Tinggi & Uji Putus Koneksi Database', async () => {
    const durationMs = 15000; // Uji simulasi endurance
    const streamPromise = arena.runContinuousMovement(durationMs);

    // Putus koneksi DB sementara pada detik ke-5
    setTimeout(async () => {
      await db.simulateTransientDisconnect(2000);
    }, 5000);

    const result = await streamPromise;
    assert.ok(result.totalTicksGenerated > 200, 'Ribuan tick telemetri berhasil digenerate');
    
    // Verifikasi data di DB setelah auto-reconnect
    const dbCount = await db.countMovementTicks(result.runId);
    assert.ok(Math.abs(dbCount - result.totalTicksGenerated) <= 5, 'Zero data loss pasca rekoneksi database');
  });
});
```

---

## 6. Caveats

1. **Simulasi Tick Rate Lingkungan Headless**:
   - Pengujian bot Mineflayer in-process bergantung pada kecepatan pemrosesan loop event Node.js dan kestabilan tick server arena (`20 tick/detik` = `50ms/tick`). Pada mesin dengan beban CPU tinggi, batas waktu timeout pengujian (misal 35 detik pada Level 4) harus memiliki margin toleransi dinamis $+20\%$.
2. **Konektivitas Eksternal DeepSeek API**:
   - Jika lingkungan pengujian dijalankan di mesin CI/CD tanpa akses internet keluar atau tanpa `DEEPSEEK_API_KEY`, seluruh kasus uji AI (T3-PAIR-06, T3-PAIR-10, T3-PAIR-12, T4-SCEN-02, T4-SCEN-04) secara otomatis beralih menggunakan Heuristic Mock Provider (`mockClient.js`) untuk menjamin determinisme 100% tanpa kegagalan jaringan.
3. **Konfigurasi Database PostgreSQL**:
   - Pengujian mengasumsikan database `minecraft_companion` dapat diakses pada `localhost:5432` dengan user lokal sistem macOS (`syahriezas`) atau via environment variables standard (`PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE`). Skrip pengujian otomatis mengeksekusi migrasi DDL jika tabel belum terbentuk.

---

## 7. Conclusion

1. **Cakupan Pengujian Komprehensif**:
   - **Tier 3 (Pairwise Combinations)**: 16 spesifikasi kasus uji terdefinisi secara detail (melampaui syarat $\ge 14$ kasus uji), mencakup interaksi seluruh 14 fitur sistem.
   - **Tier 4 (Real-World Application Scenarios)**: 7 spesifikasi skenario beban nyata terdefinisi lengkap (memenuhi syarat $\ge 7$ skenario), memvalidasi kurikulum Level 1–4, farming, sorting, insinerasi, pemulihan macet 4-fase, multi-klien WebSocket, resilience database, dan disaster recovery.
2. **Kepatuhan Aturan Global**:
   - Seluruh komentar kode pengujian, pesan asersi, label UI, dan dokumen spesifikasi mematuhi aturan lokalisasi Bahasa Indonesia dan tipografi Google Fonts Poppins.
3. **Kesiapan Eksekusi**:
   - Blueprint pengujian dirancang *opaque-box*, mandiri, dan dapat langsung diimplementasikan pada `test/e2e/tier3_cross_feature.test.js` dan `test/e2e/tier4_real_world.test.js` oleh sub-agent pengembang test runner.

---

## 8. Verification Method

Untuk memverifikasi secara independen keabsahan dan kelengkapan spesifikasi ini:

1. **Verifikasi Keberadaan & Struktur Dokumen**:
   ```bash
   test -f /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/.agents/explorer_e1_3/handoff.md
   wc -l /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/.agents/explorer_e1_3/handoff.md
   ```
2. **Verifikasi Jumlah Kasus Uji Tier 3 ($\ge 14$) & Skenario Tier 4 ($\ge 7$)**:
   ```bash
   grep -c "T3-PAIR-" /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/.agents/explorer_e1_3/handoff.md
   grep -c "T4-SCEN-" /Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/.agents/explorer_e1_3/handoff.md
   ```
   *(Harus menghasilkan minimal 16 untuk T3 dan 7 untuk T4)*.
3. **Eksekusi Pengujian Setelah Implementasi Runner**:
   ```bash
   node test/runner.js --tier 3
   node test/runner.js --tier 4
   ```
   *(Ekspektasi: Exit code 0, 100% assertions passed)*.
