# Master Plan: Minecraft Autonomous Companion

## Objective
Membangun sistem AI otonom Minecraft yang mandiri, self-verifying, dengan uji coba otomatis headless (Level 1-4), logging telemetri PostgreSQL (`minecraft_companion`), integrasi DeepSeek AI brain (`deepseek-chat`), dan dasbor web real-time di `http://localhost:8080` (Bahasa Indonesia & Google Fonts Poppins).

## Milestones & Tracks

### Track 1: Implementation Track
- [ ] **M1: Database Schema & Telemetry Service**
  - Buat skrip migrasi tabel (`benchmark_runs`, `telemetry_logs`, `movement_action_logs`, `action_audit_logs`).
  - Implementasikan connection pool PostgreSQL dan batch ingestion ring buffer 20 Hz.
  - Implementasikan repository query telemetri.
- [ ] **M2: Headless Minecraft Server Arena & Bot Test Harness**
  - Implementasikan server headless Node.js in-process (`flying-squid` / mock arena).
  - Bangun generator arena 4-level (Flat 30m, Obstacles & Elevation 50m, Stairs/Ladders/Bridges, Underground Spawner Farm `[-256, -20, -432]`).
- [ ] **M3: Autonomous Navigation & Self-Correction Engine**
  - Buat wrapper Mineflayer bot dan konfigurasi pathfinding.
  - Implementasikan sliding-window stuck detector ($\Delta D_{20} < 0.2\text{m}$, $V_{xz} < 0.03\text{ m/tick}$).
  - Implementasikan mesin pemulihan 4-fase dinamis (Micro-jump -> Strafe/Backoff -> Re-route -> Rewind).
  - Implementasikan orkestrator runner tolak ukur Level 1-4.
- [ ] **M4: DeepSeek AI Brain & Multi-Step Task Execution**
  - Implementasikan klien DeepSeek AI (`deepseek-chat`) dengan skema tool calling.
  - Implementasikan tugas Farming Zombie (dengan pacer jeda serangan $\ge 625$ms & safe reach).
  - Implementasikan tugas Penyortiran Multi-Peti (taksonomi item & iterasi kontainer).
  - Implementasikan tugas Pembakaran Sampah (hazard perimeter safety & verifikasi pembuangan).
  - Implementasikan fallback parser & mock client untuk uji deterministik.
- [ ] **M5: Web Server & Interactive Real-Time Dashboard**
  - Implementasikan server Express HTTP & WebSocket server pada port 8080.
  - Bangun visualizer 2D/3D Canvas navigasi bot.
  - Bangun kontrol eksekusi tolak ukur kurikulum Level 1-4.
  - Bangun terminal interaktif DeepSeek AI Brain.
  - Terapkan Google Fonts Poppins, desain dark theme (AppColors), dan Bahasa Indonesia.
- [ ] **M6: Final Acceptance & Integration Verification**
  - Eksekusi 100% test suite E2E otomatis.
  - Verifikasi seluruh kriteria penerimaan R1–R4.

### Track 2: E2E Testing Track (Parallel)
- [ ] **T1: E2E Test Suite Infrastructure & Test Cases (Tiers 1-4)**
  - Tulis `TEST_INFRA.md`.
  - Buat runner pengujian E2E otomatis.
  - Buat kasus uji Tier 1 (Feature Coverage $\ge 5$ per feature), Tier 2 (Boundary & Corner $\ge 5$ per feature), Tier 3 (Cross-feature), Tier 4 (Real-world scenarios).
  - Publikasikan `TEST_READY.md`.
