# Handoff Report: E2E Tier 1 & Tier 2 Test Specification & Catalog
**Agent**: `explorer_e1_2` (E2E Testing Track)
**Date**: 2026-08-18
**Milestone**: E2E Tier 1 (Feature Coverage) & Tier 2 (Boundary & Corner Cases) Specification
**Target Audience**: `sub_orch_e2e`, `explorer_e1_1`, `explorer_e1_3`, and downstream test implementers.

---

## 1. Observation

Berdasarkan investigasi menyeluruh terhadap artefak proyek:
1. **`ORIGINAL_REQUEST.md`**:
   - **R1 (§13-14)**: Headless automated bot test harness berbasis Node.js/Mineflayer tanpa window grafis Minecraft.
   - **R2 (§16-22)**: 4 level kurikulum navigasi: Level 1 (Flat 30m), Level 2 (Obstacles & Elevation 50m), Level 3 (Stairs, Ladders & Bridges), Level 4 (Underground Spawner Farm `[-256, -20, -432]`).
   - **R3 (§23-25)**: Evaluasi per tick, sliding-window stuck detector, dynamic recovery, PostgreSQL logging ke `minecraft_companion` (`telemetry_logs`, `movement_action_logs`).
   - **R4 (§26-28)**: DeepSeek AI (`deepseek-chat`) untuk tugas multi-langkah (farming zombie dengan jeda serangan senjata $\ge 625$ms, penyortiran multi-peti, pembakaran sampah aman).
   - **Acceptance (§29-41)**: 5 kali berturut-turut sukses 100% pada Level 1, web dashboard di `http://localhost:8080` dengan visualizer, kontrol uji, dan AI terminal.
2. **`PROJECT.md`**:
   - **§55-73**: Mendefinisikan **14 Fitur Utama** dalam *Feature Inventory*.
   - **§97-124**: Mendefinisikan kontrak interface database PostgreSQL 17 (`benchmark_runs`, `telemetry_logs`, `movement_action_logs`, `action_audit_logs`), WebSocket protocol (Port 8080: `TICK_UPDATE`, `BENCHMARK_STATUS`, `AI_ACTION_EVENT`, `TELEMETRY_LOG`), dan AI Tool Calling schemas (`farm_mobs`, `sort_chests`, `incinerate_trash`, `navigate_to`).
   - **§126-183**: Layout kode terstruktur di `src/` (`config/`, `database/`, `server/`, `navigation/`, `ai/`, `benchmark/`, `web/`) dan `test/e2e/`.
3. **`RULE[user_global]`**:
   - Bahasa Indonesia untuk semua label UI, error message untuk user, dan komentar kode.
   - Google Fonts Poppins untuk tipografi UI.
   - Design tokens AppColors (`bg: #13131A`, `surface: #1A1A24`, `accent: #6C63FF`, dll).
4. **`.agents/sub_orch_e2e/SCOPE.md`**:
   - Memetakan 14 fitur ke 4 tier pengujian E2E opaque-box.
   - Mengalokasikan tanggung jawab Tier 1 (Coverage $\ge 70$ kasus) dan Tier 2 (Boundary & Corner $\ge 70$ kasus) ke `explorer_e1_2`.

---

## 2. Logic Chain

### 2.1 Metodologi Category-Partition & Boundary Value Analysis
Untuk memastikan 100% feature coverage dan ketahanan terhadap kondisi ekstrem, dilakukan dua pendekatan formal:
1. **Category-Partition Method (Ostrand & Balcer)**:
   - Setiap fitur dari 14 fitur dianalisis ke dalam parameter input, state lingkungan, precondition, dan kategori output.
   - Kategori dibagi menjadi partisi ekuivalensi (valid/nominal untuk Tier 1, invalid/ekstrem untuk Tier 2).
   - Dihasilkan minimal 5 kombinasi representatif per fitur untuk Tier 1 ($14 \times 5 = 70$ test cases).
2. **Boundary Value Analysis (BVA)**:
   - Identifikasi titik batas numerik, temporal, spasial, dan struktural:
     - **Spasial**: Jarak $\Delta d = 0$, $\Delta d = 0.1$, $\Delta d = 30$, $\Delta d = 50$, koordinat negatif ekstrem `[-256, -20, -432]`, batas vertikal $Y = -64$ s.d. $Y = 320$, perimeter bahaya lava $\le 1.0$m (bahaya) vs $\ge 2.0$m (aman).
     - **Temporal**: Weapon attack cooldown $< 625$ms (spam tidak sah), $= 625$ms (batas valid sword), $\ge 1000$ms (axe), sliding window stuck threshold 30 ticks (1.5s).
     - **Volumetrik / Kapasitas**: Buffer telemetri 0 record, 1 record, 10.000 records (burst), inventaris penuh/kosong, slot peti penuh (overflow).
     - **Resiliensi Jaringan / DB**: Disconnect seketika, reconnect state-sync, HTTP 429 rate limit, WebSocket backpressure.
     - **Lokalisasi**: String null, missing key fallback, UTF-8 non-ASCII characters, strict Bahasa Indonesia assertions.
   - Dihasilkan minimal 5 kasus uji batas & kegagalan per fitur untuk Tier 2 ($14 \times 5 = 70$ test cases).

---

## 3. Complete Test Catalog: Tier 1 (Feature Coverage — 70 Test Cases)

Berikut katalog lengkap 70 kasus uji Tier 1 yang mencakup seluruh 14 fitur secara granular:

### Fitur 1: Headless Test Server Arena (`F01`)
| Test ID | Nama Kasus Uji | Prekondisi & Input | Langkah Eksekusi | Ekspektasi & Assertion |
|---|---|---|---|---|
| `T1-F01-01` | Inisialisasi Server Headless & Binding Port | Port 25565 bebas, Node.js runtime aktif | Jalankan `testServer.start({ port: 25565, headless: true })` | Server listen pada port 25565, `server.isRunning === true`, tidak ada window GUI yang dibuka |
| `T1-F01-02` | Pembangkitan Arena Level 1 (Flat Ground 30m) | Server aktif, arena builder ready | Panggil `arenaBuilder.generateLevel(1)` | Blok grass/stone terbentang dari `(0,4,0)` ke `(30,4,0)`, elevasi $Y=4$ konstan, perimeter berpagar |
| `T1-F01-03` | Pembangkitan Arena Level 2 (Rintangan & Elevasi 50m) | Server aktif, arena builder ready | Panggil `arenaBuilder.generateLevel(2)` | Blok rintangan 1-tinggi, elevasi bertahap, dan dinding pemutar arah 50m terbentuk valid |
| `T1-F01-04` | Pembangkitan Arena Level 3 (Tangga, Ladder, Jembatan) | Server aktif, arena builder ready | Panggil `arenaBuilder.generateLevel(3)` | Tangga oak/stone, tiang vertikal ladder, dan jembatan sempit 1-blok selebar 15m terpasang |
| `T1-F01-05` | Pembangkitan Arena Level 4 (Spawner Cave `[-256,-20,-432]`) | Server aktif, arena builder ready | Panggil `arenaBuilder.generateLevel(4)` | Struktur koridor gua bawah tanah terbentuk hingga target ruangan spawner pada `[-256,-20,-432]` |

### Fitur 2: Level 1 Benchmark (Flat Ground) (`F02`)
| Test ID | Nama Kasus Uji | Prekondisi & Input | Langkah Eksekusi | Ekspektasi & Assertion |
|---|---|---|---|---|
| `T1-F02-01` | Navigasi Lurus Medan Datar 30m (Single Run) | Bot spawn di `(0,4,0)`, target `(30,4,0)` | Trigger `benchmarkRunner.run(1)` | Bot mencapai target, `travel_duration_ms < 10000`, status `SUCCESS`, delta koordinat $\le 0.5$m |
| `T1-F02-02` | 5 Kali Uji Berturut-turut Tingkat Keberhasilan 100% | Bot ready, reset arena antar run | Eksekusi loop 5x iterasi Level 1 benchmark | 5/5 run berstatus `SUCCESS`, `success_rate === 1.0`, rata-rata durasi tercatat konsisten |
| `T1-F02-03` | Transisi Status Event Benchmark & Database Logging | WebSocket listener & DB pool aktif | Jalankan Level 1 run | Menerima event WS `BENCHMARK_STATUS` (RUNNING -> SUCCESS) dan tercatat di tabel `benchmark_runs` |
| `T1-F02-04` | Presisi Kedatangan Titik Koordinat Akhir | Target `(30,4,0)` dengan toleransi 0.5m | Selesaikan Level 1 | Posisi akhir bot `dist(end_pos, target) <= 0.5`, tidak ada overshoot |
| `T1-F02-05` | Profiling Kecepatan Lari Maju Bot ($v_{xz} \ge 4.3$ m/s) | Bot sprint lurus tanpa rintangan | Rekam telemetri kecepatan selama navigasi | Nilai $v_{xz}$ rata-rata $\ge 4.3$ m/s, tidak ada trigger `is_stuck` |

### Fitur 3: Level 2 Benchmark (Obstacles & Elevation) (`F03`)
| Test ID | Nama Kasus Uji | Prekondisi & Input | Langkah Eksekusi | Ekspektasi & Assertion |
|---|---|---|---|---|
| `T1-F03-01` | Penjelajahan Langkah Naik 1-Blok (+1 Y) | Step setinggi 1 blok di depan bot | Bot bergerak maju melewati step | Bot melakukan auto-jump/step-up mulus, koordinat Y bertambah $+1$, navigasi berlanjut |
| `T1-F03-02` | Penjelajahan Langkah Turun 1-Blok (-1 Y) | Step menurun 1 blok di depan bot | Bot melangkah turun | Bot turun tanpa jatuh atau terjebak, koordinat Y berkurang $-1$, tidak ada fall damage |
| `T1-F03-03` | Detour Mengitari Dinding Solid 2-Blok | Dinding penghalang $2 \times 3$ blok melintang | Bot mencapai dinding | Pathfinder menghitung rute alternatif ke samping kiri/kanan dan mengitari dinding |
| `T1-F03-04` | Navigasi Kontinu Medan Bergelombang 50m | Arena Level 2 terpasang lengkap | Jalankan Level 2 benchmark | Bot tiba di target 50m, status `SUCCESS`, durasi $< 25000$ms |
| `T1-F03-05` | Pencatatan Penghitung Rintangan Telemetri | 6 rintangan pada lintasan 50m | Jalankan Level 2 hingga selesai | Field `obstacle_count >= 6` tercatat di `telemetry_logs` dan `benchmark_runs` |

### Fitur 4: Level 3 Benchmark (Stairs, Ladders & Bridges) (`F04`)
| Test ID | Nama Kasus Uji | Prekondisi & Input | Langkah Eksekusi | Ekspektasi & Assertion |
|---|---|---|---|---|
| `T1-F04-01` | Menaiki Tangga Balok Kontinu (+10 Y) | Tangga balok kayu/batu terpasang | Bot mendaki deretan tangga | Bot menaiki tangga tanpa lompat macet, koordinat Y naik $+10$, kecepatan stabil |
| `T1-F04-02` | Memanjat Tiang Tangga Vertikal (Ladder +10 Y) | Dinding dengan tangga ladder | Bot mendekati dan memanjat ladder | Bot menempel ke ladder, bergerak vertikal ke atas $+10$ blok hingga platform atas |
| `T1-F04-03` | Menuruni Tiang Tangga Vertikal (Ladder -10 Y) | Bot di platform atas ladder | Bot menuruni ladder ke bawah | Bot turun dengan kecepatan terkontrol, tiba di lantai bawah tanpa damage |
| `T1-F04-04` | Menyeberangi Jembatan Sempit 1-Blok (15m) | Jembatan selebar 1 blok di atas jurang | Bot menyeberang jembatan | Bot menggunakan safe-walk/sneak alignment, tidak terjatuh ke sisi kiri/kanan |
| `T1-F04-05` | Traversal Terpadu (Tangga $\rightarrow$ Jembatan $\rightarrow$ Ladder) | Lintasan majemuk Level 3 lengkap | Jalankan Level 3 benchmark | Bot menyelesaikan ketiga segmen berturut-turut, tiba di target dengan status `SUCCESS` |

### Fitur 5: Level 4 Benchmark (Underground Spawner Farm Target) (`F05`)
| Test ID | Nama Kasus Uji | Prekondisi & Input | Langkah Eksekusi | Ekspektasi & Assertion |
|---|---|---|---|---|
| `T1-F05-01` | Pembangkitan Graf Waypoint Makro ke `[-256,-20,-432]` | Definisi node makro rute gua | Panggil `waypointGraph.buildRoute(start, target)` | Menghasilkan daftar node berurutan yang valid dan terhubung ke `[-256,-20,-432]` |
| `T1-F05-02` | Navigasi Masuk Mulut Gua Permukaan ke Bawah | Bot di permukaan `(0,64,0)` | Eksekusi navigasi segmen 1 | Bot menuruni lorong masuk gua hingga kedalaman $Y=30$ mengikuti waypoint |
| `T1-F05-03` | Penjelajahan Koridor Gua Berkelok Bawah Tanah | Bot di koridor $Y=10$ | Eksekusi navigasi segmen 2 | Bot bermanuver di kelokan koridor gua tanpa menabrak dinding batu |
| `T1-F05-04` | Masuk ke Ruang Spawner & Kedatangan Koordinat Akhir | Bot di lorong akhir $Y=-15$ | Bot menuju `[-256,-20,-432]` | Bot tiba di dalam ruangan spawner farm, delta jarak $\le 1.0$m dari koordinat target |
| `T1-F05-05` | Eksekusi Penuh Rute Jarak Jauh Permukaan ke Farm | Arena Level 4 aktif lengkap | Jalankan Level 4 benchmark | Bot menyelesaikan seluruh perjalanan jarak jauh, status `SUCCESS`, tercatat di database |

### Fitur 6: Autonomous Self-Correction & Stuck Detection (`F06`)
| Test ID | Nama Kasus Uji | Prekondisi & Input | Langkah Eksekusi | Ekspektasi & Assertion |
|---|---|---|---|---|
| `T1-F06-01` | Monitoring Sliding-Window Pergerakan Normal | Bot bergerak lancar ($v_{xz} > 1.0$) | Evaluasi sliding-window 30 tick | `stuckDetector.isStuck === false`, tidak ada pemulihan yang dipicu |
| `T1-F06-02` | Deteksi Macet saat Posisi Statis (< 0.1m selama 30 tick) | Bot tertahan oleh rintangan tak terduga | Bot mencoba maju selama 30 tick | `stuckDetector.isStuck === true`, event macet dipicu, recovery state machine aktif |
| `T1-F06-03` | Eksekusi Pemulihan Fase 1 (Micro-Jump) | Bot terdeteksi macet | Jalankan `recoveryStateMachine.step()` | Bot mengeksekusi micro-jump (fase 1), berhasil melompati rintangan kecil |
| `T1-F06-04` | Eksekusi Pemulihan Fase 2 (Lateral Strafe) | Fase 1 gagal membebaskan bot | Jalankan `recoveryStateMachine.step()` | Bot berpindah ke fase 2 (strafe kiri/kanan), berhasil bergeser dari sudut jebakan |
| `T1-F06-05` | Eksekusi Pemulihan Fase 3 (Re-route Lokal A*) | Fase 2 gagal membebaskan bot | Jalankan `recoveryStateMachine.step()` | Bot memicu perhitungan ulang jalur A* lokal mengabaikan blok yang memblokir |

### Fitur 7: PostgreSQL Telemetry Logging (`F07`)
| Test ID | Nama Kasus Uji | Prekondisi & Input | Langkah Eksekusi | Ekspektasi & Assertion |
|---|---|---|---|---|
| `T1-F07-01` | Inisialisasi Pool Database & Verifikasi Skema DDL | PostgreSQL 17 aktif, db `minecraft_companion` | Jalankan `migrations.run()` | Tabel `benchmark_runs`, `telemetry_logs`, `movement_action_logs`, `action_audit_logs` tercipta |
| `T1-F07-02` | Siklus Hidup Pencatatan `benchmark_runs` | Benchmark dijalankan | Catat start run, lalu update hasil akhir | Record run ID UUID valid, status terupdate dari `RUNNING` menjadi `SUCCESS` dengan durasi |
| `T1-F07-03` | Batch Ingestion Buffer Ring Telemetri 20 Hz (250ms) | Bot memancarkan data tiap tick | Simpan 20 record ke buffer ring | Buffer menguras (flush) setiap 250ms ke tabel `telemetry_logs` secara batch |
| `T1-F07-04` | Pencatatan Aksi Pergerakan ke `movement_action_logs` | Bot bergerak aktif | Batch insert log pergerakan | Data koordinat $(x,y,z)$, kecepatan $v_{xz}$, flag `is_stuck`, dan `recovery_phase` tersimpan |
| `T1-F07-05` | Pengambilan Metrik Riwayat Benchmark via Repository | Database terisi data run | Panggil `telemetryRepository.getLatestRuns(5)` | Mengembalikan array 5 run terakhir dengan struktur JSON lengkap dan terurut waktu |

### Fitur 8: DeepSeek AI Brain (`deepseek-chat`) (`F08`)
| Test ID | Nama Kasus Uji | Prekondisi & Input | Langkah Eksekusi | Ekspektasi & Assertion |
|---|---|---|---|---|
| `T1-F08-01` | Inisialisasi Klien DeepSeek & Konfigurasi Model | API Key terpasang / Mock active | Panggil `deepseekClient.init({ model: 'deepseek-chat' })` | Klien terkonfigurasi dengan endpoint valid dan model identifier `deepseek-chat` |
| `T1-F08-02` | Dekomposisi Perintah Teks Alami Menjadi Tool Call | Prompt: "Bunuh zombie di farm selama 30 detik" | Panggil `promptEngine.parseIntent(prompt)` | Menghasilkan tool call `farm_mobs` dengan parameter `{ target: 'zombie', durationSeconds: 30 }` |
| `T1-F08-03` | Mode Mock AI Provider untuk Pengujian Deterministik | Mode mock diaktifkan (`USE_MOCK_AI=true`) | Kirim prompt standar multi-langkah | Mengembalikan payload rencana tugas terstruktur instan tanpa panggilan jaringan eksternal |
| `T1-F08-04` | Validasi Skema Argumen Alat DeepSeek | Payload tool call dari AI | Panggil validator skema alat | Memvalidasi tipe data `farm_mobs`, `sort_chests`, `incinerate_trash`, `navigate_to` sesuai kontrak |
| `T1-F08-05` | Eksekusi Alur Kerja Rencana Tugas Multi-Langkah | Rencana: `[navigate_to, farm_mobs, sort_chests]` | Jalankan `taskPlanner.executePlan(plan)` | Menjalankan tugas secara sekuensial, memicu event audit log untuk setiap langkah |

### Fitur 9: Zombie Spawner Farming Task (`F09`)
| Test ID | Nama Kasus Uji | Prekondisi & Input | Langkah Eksekusi | Ekspektasi & Assertion |
|---|---|---|---|---|
| `T1-F09-01` | Deteksi & Penguncian Target Zombie di Kill Chamber | Zombie berada dalam radius 3m dari bot | Panggil `zombieFarmingTask.findTarget()` | Bot mendeteksi entity zombie terdekat dan mengunci target untuk serangan |
| `T1-F09-02` | Pacing Jeda Serangan Pedang Berlian ($\ge 625$ms) | Bot memegang pedang (Diamond Sword) | Bot menyerang target secara berkala | Interval antar serangan terukur $\ge 625$ms, menghasilkan damage multiplier penuh 100% |
| `T1-F09-03` | Pacing Jeda Serangan Senjata Kapak ($\ge 1000$ms) | Bot memegang kapak (Iron Axe) | Bot menyerang target secara berkala | Interval antar serangan terukur $\ge 1000$ms sesuai attack speed kapak |
| `T1-F09-04` | Eksekusi Loop Farming Zombie Selama Durasi Tertentu | Target zombie terus mengalir selama 10 detik | Jalankan tugas farming durasi 10 detik | Bot menyerang berkala hingga timer habis, status tugas selesai `SUCCESS` |
| `T1-F09-05` | Pengumpulan Drop Loot Daging Busuk & XP | Zombie tereliminasi di chamber | Bot mengumpulkan loot di area drop | Daging busuk (`rotten_flesh`) dan XP masuk ke inventaris bot, tercatat di audit log |

### Fitur 10: Multi-Chest Item Sorting Task (`F10`)
| Test ID | Nama Kasus Uji | Prekondisi & Input | Langkah Eksekusi | Ekspektasi & Assertion |
|---|---|---|---|---|
| `T1-F10-01` | Penemuan Spasial & Registrasi Koordinat Peti | 3 peti terpasang di sekitar bot | Panggil `chestSortingTask.scanChests()` | Bot mendeteksi dan mencatat koordinat ketiga peti (Peti A, B, C) |
| `T1-F10-02` | Klasifikasi Kategori Item Inventaris | Inventaris: sword, rotten_flesh, iron_ingot | Panggil `chestSortingTask.categorizeItems()` | Item terklasifikasi ke kategori: Senjata, Drop Mob, dan Mineral Berharga |
| `T1-F10-03` | Pemindahan Item Tunggal ke Peti Sesuai Kategori | Bot di depan Peti Drop Mob | Pindahkan `rotten_flesh` ke peti | Item berpindah ke slot peti, slot inventaris bot berkurang sesuai jumlah |
| `T1-F10-04` | Penyortiran Multi-Peti Lengkap Berurutan | 3 peti untuk 3 kategori berbeda | Jalankan `chestSortingTask.executeSort()` | Bot mendatangi tiap peti dan mendepositkan item yang sesuai ke masing-masing peti |
| `T1-F10-05` | Audit Integritas Inventaris Pascakategori | Jumlah awal item 64 total | Selesaikan penyortiran | Total item di bot + peti tetap persis 64 (zero item loss guarantee) |

### Fitur 11: Trash Incineration Task (`F11`)
| Test ID | Nama Kasus Uji | Prekondisi & Input | Langkah Eksekusi | Ekspektasi & Assertion |
|---|---|---|---|---|
| `T1-F11-01` | Identifikasi Item Sampah Otomatis | Inventaris: `poisonous_potato`, `diamond`, 128 `rotten_flesh` | Evaluasi daftar item sampah | `poisonous_potato` dan kelebihan `rotten_flesh` teridentifikasi sebagai sampah; `diamond` aman |
| `T1-F11-02` | Pendekatan Aman ke Kolam Lava (Perimeter $\ge 2.0$m) | Kolam lava di koordinat `(10,4,10)` | Bot mendekati kolam lava | Bot berhenti pada jarak aman 2.0m dari tepi lava, tidak menginjak blok lava |
| `T1-F11-03` | Pembuangan Item ke Lava & Verifikasi Kehancuran Item | Bot di perimeter aman lava | Bot melemparkan `poisonous_potato` ke lava | Item terlempar ke dalam lava dan hancur, HP bot tetap penuh 20/20 |
| `T1-F11-04` | Pembuangan Sampah Menggunakan Blok Api (Fire) | Blok api di koordinat `(12,4,10)` | Bot membuang sampah ke api | Item terbakar habis, bot menjaga jarak aman dan tidak terkena efek terbakar |
| `T1-F11-05` | Pembuangan Sampah Menggunakan Blok Kaktus (Cactus) | Blok kaktus di koordinat `(14,4,10)` | Bot membuang sampah ke kaktus | Item hancur saat bersentuhan dengan kaktus, bot tidak menerima damage duri |

### Fitur 12: Web Dashboard & Real-Time Terminal (`F12`)
| Test ID | Nama Kasus Uji | Prekondisi & Input | Langkah Eksekusi | Ekspektasi & Assertion |
|---|---|---|---|---|
| `T1-F12-01` | Inisialisasi Server Express & Penyajian Statis Port 8080 | Port 8080 bebas | Jalankan `webServer.start(8080)` | HTTP GET `/` mengembalikan status 200 OK dengan HTML dasbor lengkap |
| `T1-F12-02` | Handshake Koneksi WebSocket Client | Web server aktif | Buka koneksi WS ke `ws://localhost:8080` | Handshake sukses, event `connection` terpicu di server, readyState `OPEN` |
| `T1-F12-03` | Penyiaran Event `TICK_UPDATE` Real-Time ke Dashboard | Bot aktif bergerak | Server broadcast `TICK_UPDATE` | Client WS menerima payload: `{ tick, position, velocity, isStuck, recoveryPhase }` |
| `T1-F12-04` | Pemicuan Uji Benchmark via Pesan WebSocket | Client WS mengirim `START_BENCHMARK` (Level 1) | Server menerima pesan WS | Server memulai benchmark Level 1 dan memancarkan pembaruan status berkala |
| `T1-F12-05` | Terminal AI Interaktif & Streaming Respons Perintah | Client mengirim `SUBMIT_AI_COMMAND` | Server meneruskan ke AI Engine | Client menerima event `AI_ACTION_EVENT` berisi progres eksekusi langkah per langkah |

### Fitur 13: UI Localization & Poppins Font (`F13`)
| Test ID | Nama Kasus Uji | Prekondisi & Input | Langkah Eksekusi | Ekspektasi & Assertion |
|---|---|---|---|---|
| `T1-F13-01` | Deklarasi Google Fonts Poppins pada CSS Dashboard | File `style.css` & `index.html` | Periksa link font dan aturan CSS | URL Google Fonts Poppins termuat, CSS berisi `font-family: 'Poppins', sans-serif;` |
| `T1-F13-02` | Lokalisasi Bahasa Indonesia pada Header & Navigasi Utama | DOM `index.html` termuat | Evaluasi teks navigasi dan header | Teks menampilkan "Dasbor Pengendali", "Status Sistem", "Terminal AI" dalam Bahasa Indonesia |
| `T1-F13-03` | Lokalisasi Tombol Kontrol Benchmark Level 1-4 | Elemen tombol uji pada UI | Evaluasi label tombol | Tombol bertuliskan "Mulai Tolak Ukur Level 1 (Medan Datar)", "Level 2 (Rintangan)", dll |
| `T1-F13-04` | Lokalisasi Kartu Metrik Telemetri Real-Time | Kartu informasi telemetri | Evaluasi judul dan status metrik | Label menampilkan "Kecepatan", "Durasi", "Status", "Rintangan", "Fase Pemulihan" |
| `T1-F13-05` | Integritas Variabel CSS Design Tokens AppColors | File `style.css` | Verifikasi deklarasi CSS root variables | Terdefinisi `--bg: #13131A`, `--surface: #1A1A24`, `--accent: #6C63FF`, `--text-primary: #EAEAF0` |

### Fitur 14: E2E Autonomous Test Suite (`F14`)
| Test ID | Nama Kasus Uji | Prekondisi & Input | Langkah Eksekusi | Ekspektasi & Assertion |
|---|---|---|---|---|
| `T1-F14-01` | Eksekusi Master Test Runner CLI & Discovery Otomatis | Runner `test/runner.js` ready | Jalankan `node test/runner.js` | Menemukan dan menjalankan seluruh file pengujian di folder `test/e2e/` |
| `T1-F14-02` | Filter Eksekusi Berdasarkan Flag Tier (`--tier 1`) | Runner CLI ready | Jalankan `node test/runner.js --tier 1` | Hanya mengeksekusi test case Tier 1, mengabaikan tier lainnya |
| `T1-F14-03` | Filter Eksekusi Berdasarkan Flag Fitur (`--feature F01`) | Runner CLI ready | Jalankan `node test/runner.js --feature F01` | Hanya mengeksekusi suite uji fitur Headless Server Arena |
| `T1-F14-04` | Output Laporan Uji Terstruktur (Pass/Fail & Durasi) | Suite uji selesai dieksekusi | Evaluasi format output konsol | Menampilkan ringkasan tabel: Total Tests, Passed, Failed, Duration, dan rincian per kasus |
| `T1-F14-05` | Semantik Exit Code Runner (0 untuk Lulus, 1 untuk Gagal) | Suite uji selesai | Periksa `process.exitCode` | Mengembalikan status code `0` saat 100% lulus, dan `1` jika ada assertion gagal |

---

## 4. Complete Test Catalog: Tier 2 (Boundary & Corner Cases — 70 Test Cases)

Berikut katalog lengkap 70 kasus uji batas, nilai ekstrem, anomali jaringan, dan penanganan error:

### Fitur 1: Headless Test Server Arena (`F01`) — Boundary & Corner
| Test ID | Nama Kasus Uji | Kelas Batas / Kondisi Ekstrem | Langkah Eksekusi | Ekspektasi & Penanganan Error |
|---|---|---|---|---|
| `T2-F01-01` | Konflik Port Server (Port Sudah Digunakan) | Port 25565 telah dipakai proses lain | Inisialisasi `testServer.start({ port: 25565 })` | Server menangkap `EADDRINUSE`, mencoba port cadangan atau melempar error informatif dalam Bahasa Indonesia |
| `T2-F01-02` | Pembangkitan Arena di Koordinat Ekstrem Vertikal | Elevasi di luar batas dunia ($Y < -64$ atau $Y > 320$) | Panggil builder pada $Y = -70$ | Builder menolak koordinat di luar rentang valid dunia dengan pesan validasi yang jelas |
| `T2-F01-03` | Disconnect & Reconnect Cepat Bot Saat Tick Loop | Loop server berjalan pada 20 Hz | Putuskan koneksi client dan reconnect dalam 50ms | Server membersihkan entity state lama tanpa crash, bot baru berhasil join kembali |
| `T2-F01-04` | Batas Memori / Anti-Leak saat Regenerasi Arena Berulang | Regenerasi arena 10x berturut-turut | Jalankan loop `arenaBuilder.generateLevel()` 10x | Penggunaan memori heap Node.js tetap stabil ($< 250$ MB), buffer chunk lama dibersihkan via GC |
| `T2-F01-05` | Penanganan Deskriptor Level Tidak Dikenal (Invalid Level) | Level input: `999` atau `null` | Panggil `arenaBuilder.generateLevel(999)` | Melempar error terkontrol: "Tingkat level arena tidak valid", tidak terjadi unhandled rejection |

### Fitur 2: Level 1 Benchmark (Flat Ground) (`F02`) — Boundary & Corner
| Test ID | Nama Kasus Uji | Kelas Batas / Kondisi Ekstrem | Langkah Eksekusi | Ekspektasi & Penanganan Error |
|---|---|---|---|---|
| `T2-F02-01` | Navigasi Jarak Nol (Titik Start = Titik Target) | Start `(0,4,0)`, Target `(0,4,0)` | Jalankan Level 1 | Bot langsung mendeteksi sudah di target dalam 1 tick, status `SUCCESS`, durasi $\approx 0$ms |
| `T2-F02-02` | Navigasi Jarak Mikro Sub-Blok ($\Delta d = 0.1$m) | Start `(0,4,0)`, Target `(0.1,4,0)` | Jalankan Level 1 | Bot melakukan penyesuaian posisi halus tanpa overshoot atau loop osilasi |
| `T2-F02-03` | Lintasan Datar Diagonal Sudut 45° (30m Euclidean) | Start `(0,4,0)`, Target `(21.21,4,21.21)` | Jalankan Level 1 diagonal | Bot menghitung vektor diagonal $X/Z$ seimbang dan tiba di target dalam toleransi $\le 0.5$m |
| `T2-F02-04` | Rintangan Dinamis Tiba-tiba Muncul di Tengah Lintasan Datar | Blok diletakkan langsung di depan bot saat lari | Tempatkan blok saat $t=2$s | Bot mendeteksi penurunan kecepatan, mengaktifkan pemulihan dinamis atau melompatinya |
| `T2-F02-05` | Batas Anggaran Waktu Habis (Benchmark Timeout Guard) | Bot dipaksa diam tanpa bergerak | Jalankan benchmark dengan timeout 15s | Runner menghentikan uji saat timeout habis, mencatat status `FAILED` dengan alasan "Batas waktu terlampaui" |

### Fitur 3: Level 2 Benchmark (Obstacles & Elevation) (`F03`) — Boundary & Corner
| Test ID | Nama Kasus Uji | Kelas Batas / Kondisi Ekstrem | Langkah Eksekusi | Ekspektasi & Penanganan Error |
|---|---|---|---|---|
| `T2-F03-01` | Dinding Vertikal 3-Blok Tak Terlompati | Dinding solid setinggi 3 blok menghalangi | Bot mencoba navigasi lurus | Bot mengenali rintangan melebihi tinggi lompat 1-blok dan segera mencari rute memutar (detour) |
| `T2-F03-02` | Jebakan Lubang Buta 1-Blok (Pitfall 1x1x1) | Lubang 1 blok di jalur bot | Bot jatuh ke dalam lubang | Stuck detector aktif, bot melompat keluar dari lubang dan melanjutkan jalur |
| `T2-F03-03` | Elevasi Ekstrem Batas Kemiringan Curam (1:1 hingga +15 Y) | Tangga berundak naik terjal 15 tingkat | Bot mendaki undakan curam | Bot mempertahankan momentum lompat berturut-turut tanpa terpeleset mundur |
| `T2-F03-04` | Rintangan Penghalang Bergerak (Spawning Block Ahead) | Blok tercipta 1 blok di depan bot saat bergerak | Bot menabrak blok baru | Bot segera berhenti, membatalkan path lama, dan melakukan kalkulasi ulang jalur dalam $< 200$ms |
| `T2-F03-05` | Chokepoint Sempit 1-Blok Diagonal | Celah sempit 1 blok dengan orientasi diagonal | Bot melintasi celah | Bot menyelaraskan sumbu tubuh dengan tepat untuk menembus celah tanpa tersangkut di sudut blok |

### Fitur 4: Level 3 Benchmark (Stairs, Ladders & Bridges) (`F04`) — Boundary & Corner
| Test ID | Nama Kasus Uji | Kelas Batas / Kondisi Ekstrem | Langkah Eksekusi | Ekspektasi & Penanganan Error |
|---|---|---|---|---|
| `T2-F04-01` | Celah Anak Tangga Ladder Hilang (Missing Rung) | 1 blok ladder hilang di tengah tiang panjat | Bot memanjat ladder | Bot mendeteksi kekosongan pijakan, melakukan micro-jump untuk meraih anak tangga berikutnya |
| `T2-F04-02` | Pendekatan Kecepatan Tinggi ke Tepi Jembatan Sempit | Bot berlari kencang menuju jembatan 1-blok | Bot mencapai awal jembatan | Sistem anti-fall langsung mengerem dan mengaktifkan mode sneak di bibir jurang |
| `T2-F04-03` | Hambatan Ruang Kepala pada Tangga (Low Clearance) | Blok langit-langit rendah menghalangi kepala | Bot menaiki tangga sempit | Bot menunduk (crouch) atau mencari sudut melangkah tanpa terjepit di antara blok |
| `T2-F04-04` | Transisi Keluar Ladder ke Platform Lantai Atas | Puncak tiang ladder sejajar lantai | Bot tiba di ujung atas ladder | Bot melangkah maju ke permukaan lantai horizontal tanpa terjatuh kembali ke poros ladder |
| `T2-F04-05` | Jembatan Sempit dengan Belokan Siku 90° di Atas Jurang | Jembatan 1-blok berbelok 90 derajat | Bot berbelok di sudut jembatan | Bot berhenti sejenak, memutar orientasi yaw 90°, lalu melanjutkan langkah lurus di segmen kedua |

### Fitur 5: Level 4 Benchmark (Underground Spawner Farm Target) (`F05`) — Boundary & Corner
| Test ID | Nama Kasus Uji | Kelas Batas / Kondisi Ekstrem | Langkah Eksekusi | Ekspektasi & Penanganan Error |
|---|---|---|---|---|
| `T2-F05-01` | Navigasi Lintas Kuadran Negatif ($+X/+Z \rightarrow -X/-Z$) | Start `(10,64,10)`, Target `[-256,-20,-432]` | Jalankan navigasi jarak jauh | Perhitungan koordinat dan sudut yaw tidak mengalami kesalahan tanda polaritas saat melintasi $X=0, Z=0$ |
| `T2-F05-02` | Penjelajahan Menembus Lapisan Deepslate ($Y < 0$ hingga $Y = -20$) | Transisi dari batu biasa ke deepslate | Bot melintasi $Y=0$ ke bawah | Navigasi tetap konsisten pada elevasi negatif di bawah batas dunia $Y=0$ lama Minecraft |
| `T2-F05-03` | Rute Waypoint Makro Terblokir Total (Reroute Dinamis) | Salah satu gua utama runtuh/tertutup | Blokir waypoint 3 pada graf | Graf makro mendeteksi kegagalan segmen dan mengalihkan bot ke rute cabang alternatif |
| `T2-F05-04` | Target Berada di Dalam Blok Padat Bedrock (Unreachable Target) | Target `[-256,-20,-432]` diganti blok solid | Jalankan navigasi ke target padat | Pathfinder mendeteksi target tidak dapat dihuni, berhenti pada titik terdekat aman dan melapor status |
| `T2-F05-05` | Simulasi Batas Chunk (Chunk Boundary Crossing) | Perjalanan melintasi 20+ batas chunk | Bot melintasi chunk yang belum dimuat | Sistem menunggu chunk selesai dimuat sebelum melanjutkan pergerakan ke depan |

### Fitur 6: Autonomous Self-Correction & Stuck Detection (`F06`) — Boundary & Corner
| Test ID | Nama Kasus Uji | Kelas Batas / Kondisi Ekstrem | Langkah Eksekusi | Ekspektasi & Penanganan Error |
|---|---|---|---|---|
| `T2-F06-01` | Eskalasi Penuh Fase 4 (Rewind / Mundur ke Waypoint Aman) | Bot terkurung 360° di jalan buntu | Bot gagal di fase 1, 2, 3 | Bot mengeksekusi fase 4 (rewind): berbalik 180° dan mundur ke waypoint aman sebelumnya |
| `T2-F06-02` | Deteksi Osilasi Frekuensi Tinggi (Maju-Mundur Statis) | Bot bergerak maju-mundur cepat ($\Delta d_{net} \approx 0$) | Bot terjebak dalam loop osilasi | Stuck detector mendeteksi perpindahan netto nol meskipun kecepatan $> 0$, lalu memicu recovery |
| `T2-F06-03` | Jebakan Permanen Tak Terpulihkan (Graceful Failure Transition) | Bot dikelilingi bedrock di semua sisi | Jalankan 3 siklus eskalasi penuh | Sistem menghentikan siklus pemulihan setelah batas maksimal (3x Fase 4), mencatat status `FAILED` |
| `T2-F06-04` | Pencegahan False-Positive saat Bot Berhenti Sengaja | Bot sengaja berhenti untuk komputasi rute | Bot diam selama 15 tick | Sistem memeriksa state internal `isComputingPath`, tidak memicu status macet prematur |
| `T2-F06-05` | Integritas Logging Pemulihan saat Database Mengalami Lag | DB pool delay $> 500$ms saat recovery | Bot memicu event pemulihan | Event diantrekan di memory ring buffer tanpa memblokir thread eksekusi pergerakan bot |

### Fitur 7: PostgreSQL Telemetry Logging (`F07`) — Boundary & Corner
| Test ID | Nama Kasus Uji | Kelas Batas / Kondisi Ekstrem | Langkah Eksekusi | Ekspektasi & Penanganan Error |
|---|---|---|---|---|
| `T2-F07-01` | Ketahanan saat Koneksi Database Terputus Sementara | Matikan koneksi DB selama 3 detik | Kirim log telemetri saat DB mati | Buffer ring menahan log di RAM, melakukan reconnect otomatis, dan menguras antrean log setelah pulih |
| `T2-F07-02` | Proteksi Buffer Overflow pada Lonjakan Log Tinggi (10.000 logs/s) | Kirim 10.000 entri log per detik | Uji batas kapasitas buffer | Buffer melakukan backpressure batching tanpa crash `Out of Memory`, seluruh data tersimpan |
| `T2-F07-03` | Penanganan Pelanggaran Foreign Key / Record Tidak Valid | Insert log dengan `run_id` tidak terdaftar | Panggil insert log tidak valid | Menangkap error foreign key secara elegan, mencatat error ke audit log internal |
| `T2-F07-04` | Proteksi SQL Injection pada Parameter Metadata JSONB | Input: `'); DROP TABLE telemetry_logs; --` | Masukkan string jahat ke metadata | Query parameterized mengeksekusi input sebagai teks JSON murni tanpa celah SQL injection |
| `T2-F07-05` | Pengurasan Buffer saat Graceful Shutdown Aplikasi | Aplikasi menerima sinyal `SIGINT` | Jalankan proses shutdown server | Handler `SIGINT` memanggil `batchIngestion.flushSync()` memastikan sisa buffer di-drain ke DB |

### Fitur 8: DeepSeek AI Brain (`deepseek-chat`) (`F08`) — Boundary & Corner
| Test ID | Nama Kasus Uji | Kelas Batas / Kondisi Ekstrem | Langkah Eksekusi | Ekspektasi & Penanganan Error |
|---|---|---|---|---|
| `T2-F08-01` | Penanganan API Key Tidak Valid / Hilang (Fallback Heuristik) | `DEEPSEEK_API_KEY` kosong atau invalid | Jalankan perintah tugas AI | Sistem otomatis beralih ke engine fallback heuristik lokal tanpa menghentikan tugas |
| `T2-F08-02` | Pemulihan dari Output JSON Tool Call Cacat / Hallucinated | Respons AI berupa JSON terpotong / sintaks rusak | Parsing respons AI | Parser menangkap exception sintaks JSON, meminta retry atau menggunakan default fallback |
| `T2-F08-03` | Timeout Panggilan Jaringan API DeepSeek ($> 10$s) | Simulasi delay jaringan API 15 detik | Kirim permintaan prompt | Klien memicu timeout pada 10s, melakukan 1x retry, lalu beralih ke fallback deterministik |
| `T2-F08-04` | Penanganan Perintah Tidak Jelas / Nonsens (Nonsensical Prompt) | Prompt: "Blabla xyz 123 @#$%" | Proses prompt di AI engine | Mengembalikan respons ramah dalam Bahasa Indonesia: "Perintah tidak dikenali atau di luar domain tugas." |
| `T2-F08-05` | Penanganan HTTP 429 Rate Limit dari API Provider | API mengembalikan HTTP status 429 | Kirim rentetan prompt cepat | Klien menerapkan Exponential Backoff dengan Jitter sebelum mencoba kembali |

### Fitur 9: Zombie Spawner Farming Task (`F09`) — Boundary & Corner
| Test ID | Nama Kasus Uji | Kelas Batas / Kondisi Ekstrem | Langkah Eksekusi | Ekspektasi & Penanganan Error |
|---|---|---|---|---|
| `T2-F09-01` | Penolakan Spam Serangan Senjata ($< 625$ms) | Panggilan `attack()` pada interval 200ms | Kirim perintah serang beruntun | Pacer serangan memblokir serangan prematur hingga cooldown senjata terpenuhi penuh |
| `T2-F09-02` | Senjata Rusak / Patah di Tengah Tugas Farming | Pedang mencapai durabilitas 0 (patah) | Bot menyerang saat pedang rusak | Bot mendeteksi senjata rusak, otomatis melengkapi pedang cadangan dari inventaris |
| `T2-F09-03` | Ruang Spawner Kosong (Nol Target Zombie Tersedia) | Tidak ada zombie yang spawn | Jalankan tugas farming 5s | Bot masuk ke mode siaga (idle wait), tidak melakukan serangan sia-sia, mencatat status di audit |
| `T2-F09-04` | Darah Bot Kritis ($HP < 6$) — Mundur Darurat | Zombie berhasil mengenai bot ($HP = 4$) | Bot mendeteksi pengurangan darah | Bot membatalkan serangan, mundur 5 blok ke zona aman, dan memicu status bahaya |
| `T2-F09-05` | Garis Pandang (Line of Sight) Target Terhalang Blok | Blok solid berada di antara bot dan zombie | Bot mencoba menyerang | Raycast mendeteksi pandangan terhalang, bot reposisi sudut pandang sebelum menyerang |

### Fitur 10: Multi-Chest Item Sorting Task (`F10`) — Boundary & Corner
| Test ID | Nama Kasus Uji | Kelas Batas / Kondisi Ekstrem | Langkah Eksekusi | Ekspektasi & Penanganan Error |
|---|---|---|---|---|
| `T2-F10-01` | Peti Tujuan Penuh (Zero Available Slots Overflow) | Peti Kategori Drop Mob terisi penuh 27 slot | Bot mencoba deposit `rotten_flesh` | Bot mendeteksi peti penuh, mengalihkan sisa item ke Peti Cadangan / Overflow |
| `T2-F10-02` | Penanganan Item Kustom / Kategori Tidak Dikenal | Item berupa `dragon_egg` atau `debug_stick` | Bot memproses item tak dikenal | Item dialokasikan ke Peti Kategori "Lain-lain / Unsorted" tanpa menyebabkan crash |
| `T2-F10-03` | Interupsi Interaksi Peti (Peti Terkunci / Terbuka oleh Lain) | Peti terkunci atau sibuk | Bot mencoba membuka peti | Bot melakukan retry 2x, jika tetap gagal melompat ke peti berikutnya dengan pesan peringatan |
| `T2-F10-04` | Inventaris Bot Kosong saat Perintah Sort Diterima | Bot tidak memiliki item di tas | Jalankan perintah penyortiran | Sistem langsung selesai (no-op) dengan pesan: "Inventaris kosong, tidak ada item untuk disortir." |
| `T2-F10-05` | Peti Terletak di Luar Jangkauan Interaksi (> 4.5m) | Koordinat peti berjarak 8m dari bot | Jalankan instruksi sort | Bot otomatis berjalan mendekati peti hingga jarak $< 3.5$m sebelum mengirim paket interaksi buka |

### Fitur 11: Trash Incineration Task (`F11`) — Boundary & Corner
| Test ID | Nama Kasus Uji | Kelas Batas / Kondisi Ekstrem | Langkah Eksekusi | Ekspektasi & Penanganan Error |
|---|---|---|---|---|
| `T2-F11-01` | Penjagaan Perimeter Bahaya Ketat (Mencegah Jarak $< 1.0$m) | Perintah memaksa bot mendekat ke jarak 0.5m | Bot menghitung posisi lempar | Safety clamp membatasi jarak minimum pada 1.8m, menolak mendekat lebih lanjut ke lava |
| `T2-F11-02` | Penolakan Pembakaran Item Berharga (Whitelisted Protect) | Perintah membakar `diamond_block` atau `netherite` | Kirim perintah buang item berharga | Modul menolak pembakaran item berharga dengan notifikasi: "Item berharga dilindungi dari pembakaran." |
| `T2-F11-03` | Tidak Ada Bahaya (Lava/Api) dalam Radius Terjangkau | Area tidak memiliki blok lava atau api | Jalankan tugas incinerate | Tugas dibatalkan secara aman dengan peringatan: "Tidak ditemukan area pembuangan sampah yang aman." |
| `T2-F11-04` | Penanganan Tipe Hazard Tidak Valid (e.g. 'water') | Parameter tool: `hazardType: 'water'` | Panggil `incinerate_trash` | Validator menolak tipe hazard: "Tipe bahaya 'water' tidak valid untuk pembakaran sampah." |
| `T2-F11-05` | Respon Darurat Saat Bot Terkena Efek Terbakar (Fire Tick) | Simulasi bot terkena api ($damage > 0$) | Bot menerima damage terbakar | Bot segera mundur darurat 3 blok ke arah berlawanan dari bahaya dan mencari air jika ada |

### Fitur 12: Web Dashboard & Real-Time Terminal (`F12`) — Boundary & Corner
| Test ID | Nama Kasus Uji | Kelas Batas / Kondisi Ekstrem | Langkah Eksekusi | Ekspektasi & Penanganan Error |
|---|---|---|---|---|
| `T2-F12-01` | Resinkronisasi State saat WebSocket Putus dan Sambung Ulang | Putuskan koneksi WS client lalu sambungkan | Reconnect client WS | Server mengirimkan snapshot state terkini (`BENCHMARK_STATUS` & metrik terakhir) secara instan |
| `T2-F12-02` | Beban Multi-Klien Simultan (10 WebSocket Klien) | 10 client browser terhubung bersamaan | Server menyiarkan update 20 Hz | Seluruh 10 client menerima paket broadcast tanpa lag atau kebocoran memori di server |
| `T2-F12-03` | Penanganan Pesan Masuk WebSocket Cacat / Non-JSON | Client mengirimkan payload biner / string rusak | Server memproses pesan WS | Server menangkap error parsing JSON tanpa crash dan membalas event error berformat valid |
| `T2-F12-04` | Penanganan Backpressure & Throttling Pesan Cepat | Client mengirim 100 perintah per detik | Uji batas rate limit WS | Server membatasi pemrosesan (rate limiting) dan membalas peringatan: "Terlalu banyak permintaan." |
| `T2-F12-05` | Respons HTTP 404 / 500 Terstruktur dalam Bahasa Indonesia | Request GET ke URL tidak ada `/api/unknown` | Panggil endpoint tidak valid | Server mengembalikan JSON `{ sukses: false, pesan: "Endpoint tidak ditemukan" }` dengan status 404 |

### Fitur 13: UI Localization & Poppins Font (`F13`) — Boundary & Corner
| Test ID | Nama Kasus Uji | Kelas Batas / Kondisi Ekstrem | Langkah Eksekusi | Ekspektasi & Penanganan Error |
|---|---|---|---|---|
| `T2-F13-01` | Pencegahan Bocoran Kunci Translasi / Teks Bahasa Asing | Uji seluruh elemen teks di UI | Scan seluruh teks DOM | Tidak ditemukan placeholder mentah seperti `{{key}}`, `undefined`, atau string Bahasa Inggris yang belum diterjemahkan |
| `T2-F13-02` | Lokalisasi Pesan Kesalahan Sistemik (System Error Messages) | Simulasi kegagalan koneksi DB / Server | Tampilkan notifikasi error di UI | Pesan error tertulis: "Koneksi basis data terputus", "Target tidak dapat dijangkau", dll |
| `T2-F13-03` | Fallback Font Sistem saat CDN Google Fonts Offline | Blokir akses jaringan ke `fonts.googleapis.com` | Muat dasbor web | UI tetap terbaca rapi menggunakan fallback `system-ui, -apple-system, sans-serif` tanpa layout broken |
| `T2-F13-04` | Keamanan Karakter UTF-8 & Simbol Bahasa Indonesia | String dengan tanda baca dan aksen khusus | Render teks di terminal & status | Karakter teks Bahasa Indonesia ter-render sempurna tanpa tanda tanya (`?`) atau karakter aneh (mojibake) |
| `T2-F13-05` | Penegakan Bahasa Indonesia pada Respons Streaming AI | AI menghasilkan token respons tugas | Pantau output terminal AI | Log progres tugas tertulis: "Memulai tugas...", "Navigasi menuju target...", "Penyortiran selesai." |

### Fitur 14: E2E Autonomous Test Suite (`F14`) — Boundary & Corner
| Test ID | Nama Kasus Uji | Kelas Batas / Kondisi Ekstrem | Langkah Eksekusi | Ekspektasi & Penanganan Error |
|---|---|---|---|---|
| `T2-F14-01` | Penegakan Timeout Kasus Uji Individu (15.000ms Budget) | Kasus uji yang mengalami infinite loop | Eksekusi test runner | Runner membatalkan kasus uji yang menggantung setelah 15s, menandai `FAILED: Timeout`, dan melanjutkan test berikutnya |
| `T2-F14-02` | Isolasi Crash Proses / Uncaught Exception pada Sub-Test | Kasus uji melempar `process.exit(1)` liar | Eksekusi runner multi-process | Master runner menangkap kegagalan worker tanpa menghentikan eksekusi suite pengujian lainnya |
| `T2-F14-03` | Pembersihan Handle Terbuka & Socket Menggantung (Teardown) | Test selesai namun koneksi DB masih terbuka | Runner menyelesaikan suite | Blok teardown global menutup seluruh pool DB, port HTTP, dan WebSocket sehingga proses exit bersih |
| `T2-F14-04` | Mitigasi Flakiness via Isolasi Port & Port Ephemeral | Eksekusi 2 runner secara paralel | Jalankan 2 instance runner | Masing-masing instance menggunakan port server unik sehingga tidak terjadi tabrakan port antar runner |
| `T2-F14-05` | Penanganan Argumen CLI Tidak Valid | Jalankan `node test/runner.js --invalid-flag` | Periksa respons konsol | Menampilkan panduan bantuan (usage help) dalam Bahasa Indonesia dan exit code 1 |

---

## 5. Summary Matrix & Coverage Breakdown

| # | Feature Name | Tier 1 Cases (Coverage) | Tier 2 Cases (Boundary & Corner) | Total Test Cases |
|---|---|---|---|---|
| 1 | Headless Test Server Arena (`F01`) | 5 (`T1-F01-01` .. `T1-F01-05`) | 5 (`T2-F01-01` .. `T2-F01-05`) | **10** |
| 2 | Level 1 Benchmark (Flat Ground) (`F02`) | 5 (`T1-F02-01` .. `T1-F02-05`) | 5 (`T2-F02-01` .. `T2-F02-05`) | **10** |
| 3 | Level 2 Benchmark (Obstacles & Elevation) (`F03`) | 5 (`T1-F03-01` .. `T1-F03-05`) | 5 (`T2-F03-01` .. `T2-F03-05`) | **10** |
| 4 | Level 3 Benchmark (Stairs, Ladders & Bridges) (`F04`) | 5 (`T1-F04-01` .. `T1-F04-05`) | 5 (`T2-F04-01` .. `T2-F04-05`) | **10** |
| 5 | Level 4 Benchmark (Underground Spawner Farm) (`F05`) | 5 (`T1-F05-01` .. `T1-F05-05`) | 5 (`T2-F05-01` .. `T2-F05-05`) | **10** |
| 6 | Autonomous Self-Correction & Stuck Detection (`F06`) | 5 (`T1-F06-01` .. `T1-F06-05`) | 5 (`T2-F06-01` .. `T2-F06-05`) | **10** |
| 7 | PostgreSQL Telemetry Logging (`F07`) | 5 (`T1-F07-01` .. `T1-F07-05`) | 5 (`T2-F07-01` .. `T2-F07-05`) | **10** |
| 8 | DeepSeek AI Brain (`deepseek-chat`) (`F08`) | 5 (`T1-F08-01` .. `T1-F08-05`) | 5 (`T2-F08-01` .. `T2-F08-05`) | **10** |
| 9 | Zombie Spawner Farming Task (`F09`) | 5 (`T1-F09-01` .. `T1-F09-05`) | 5 (`T2-F09-01` .. `T2-F09-05`) | **10** |
| 10 | Multi-Chest Item Sorting Task (`F10`) | 5 (`T1-F10-01` .. `T1-F10-05`) | 5 (`T2-F10-01` .. `T2-F10-05`) | **10** |
| 11 | Trash Incineration Task (`F11`) | 5 (`T1-F11-01` .. `T1-F11-05`) | 5 (`T2-F11-01` .. `T2-F11-05`) | **10** |
| 12 | Web Dashboard & Real-Time Terminal (`F12`) | 5 (`T1-F12-01` .. `T1-F12-05`) | 5 (`T2-F12-01` .. `T2-F12-05`) | **10** |
| 13 | UI Localization & Poppins Font (`F13`) | 5 (`T1-F13-01` .. `T1-F13-05`) | 5 (`T2-F13-01` .. `T2-F13-05`) | **10** |
| 14 | E2E Autonomous Test Suite (`F14`) | 5 (`T1-F14-01` .. `T1-F14-05`) | 5 (`T2-F14-01` .. `T2-F14-05`) | **10** |
| **TOTAL** | **14 Fitur Lengkap** | **70 Kasus Uji** | **70 Kasus Uji** | **140 Kasus Uji** |

---

## 6. Caveats

1. **Dependensi Eksternal API Key DeepSeek**:
   - Pengujian `F08` (DeepSeek AI) pada lingkungan CI/CD tanpa internet atau tanpa `DEEPSEEK_API_KEY` aktif bergantung pada implementasi `mockClient.js` atau fallback heuristik deterministik untuk memastikan zero flakiness.
2. **Ketersediaan Layanan PostgreSQL 17**:
   - Pengujian `F07` membutuhkan instance PostgreSQL lokal atau in-memory mock PG engine (misal `pg-mem`) saat dijalankan pada container isolasi yang tidak memiliki port DB aktif.
3. **Headless Minecraft Engine**:
   - Pengujian bot di `F01-F05` dirancang berbasis in-process server (seperti `flying-squid` atau mock bot harness arena) untuk menghindari overhead Java JVM eksternal.
4. **Alokasi Port Dinamis**:
   - Jika port default 25565 atau 8080 terpakai, test runner harus mendukung penetapan port dinamis via environment variable (`TEST_BOT_PORT`, `TEST_WEB_PORT`).

---

## 7. Conclusion

Katalog pengujian Tier 1 (70 kasus uji) dan Tier 2 (70 kasus uji) telah selesai dirancang secara lengkap dengan total **140 kasus uji spesifik** yang mencakup seluruh 14 fitur dari `PROJECT.md`.
Setiap kasus uji dilengkapi dengan ID unik, deskripsi kondisi input, langkah eksekusi, serta assertion spesifik dan aturan penanganan error dalam Bahasa Indonesia sesuai `RULE[user_global]`.

Katalog ini siap digunakan oleh `explorer_e1_1` untuk implementasi harness dan master runner, serta `explorer_e1_3` untuk perancangan uji Tier 3 & Tier 4.

---

## 8. Verification Method

Untuk memverifikasi keabsahan katalog pengujian ini dan menjalankannya secara independen:
1. **Pemeriksaan Dokumen Spesifikasi**:
   - Periksa file `.agents/explorer_e1_2/handoff.md` untuk memastikan seluruh 140 kasus uji terdaftar dan terpetakan rapi.
2. **Perintah Eksekusi Pengujian (Setelah Implementasi Runner Master)**:
   - Menjalankan seluruh kasus uji Tier 1:
     ```bash
     node test/runner.js --tier 1
     ```
   - Menjalankan seluruh kasus uji Tier 2:
     ```bash
     node test/runner.js --tier 2
     ```
   - Menjalankan pengujian spesifik per fitur:
     ```bash
     node test/runner.js --feature F01 --tier 1
     node test/runner.js --feature F09 --tier 2
     ```
3. **Kondisi Invalidasi**:
   - Jika ada fitur dari 14 fitur di `PROJECT.md` yang memiliki $< 5$ kasus uji Tier 1 atau $< 5$ kasus uji Tier 2.
   - Jika ada assertion error handling yang menggunakan bahasa selain Bahasa Indonesia untuk label UI atau pesan error pengguna.
