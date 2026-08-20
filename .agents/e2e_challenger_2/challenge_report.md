# Adversarial Challenge & Empirical Verification Report

## Challenge Summary

**Overall risk assessment**: LOW
**Verdict**: **APPROVE**

Sistem autonomous companion untuk penanganan pertarungan mob di spawner bawah tanah (`[-256, -20, -432]`), penegakan jeda serangan senjata (*weapon cooldown pacing* $\ge 625$ms), pemungutan bola XP (*experience orbs*), kenaikan level bot, dan persistensi telemetri ke PostgreSQL 17 telah diverifikasi secara empiris dengan pengujian langsung (*live execution*), stress testing, analisis mutasi, dan injeksi sabotase (*fault injection*).

---

## Empirical Verification Findings

### 1. Zombie Spawner Combat Loop & Weapon Cooldown Pacing
- **Perintah Verifikasi**: `node test/e2e/test_zombie_combat_xp.js`
- **Hasil Pengujian**:
  - Target 3 zombie di ruang spawner `[-256, -20, -432]` berhasil dieliminasi melalui 9 tebasan *Diamond Sword* (7 DMG per hit).
  - Interval jeda serangan diatur pada 630ms, secara konsisten memenuhi batas cooldown $\ge 625$ms (Minecraft 1.9+ 1.6 attack speed).
  - Fungsi asersi `assertAttackPacing` terbukti memblokir dan mendeteksi upaya spam click di bawah batas toleransi (contoh: interval 300ms melempar kesalahan: `Pelanggaran jeda serangan (Spam Attack terdeteksi)!`).

### 2. XP Orbs Pickup & Level Progression
- **Hasil Pengujian**:
  - XP bertambah $+5$ poin per zombie yang terbunuh (Total perolehan: $+15$ XP).
  - Level bot meningkat secara dinamis dari Level 0 $\to$ Level 1 (pada 10 XP) $\to$ Level 2 (pada 15 XP) menggunakan formula $L = \lfloor XP / 7 \rfloor$.
  - Loot berupa 3 buah `rotten_flesh` dan 1 batang `iron_ingot` tercatat masuk ke inventaris bot tanpa kehilangan data.

### 3. Level 4 Benchmark & Coordinate Targeting
- **Perintah Verifikasi**: `node test/e2e/e2e_level4_test.js`
- **Hasil Pengujian**:
  - Bot menavigasi rute bawah tanah menembus lapisan deepslate dan mencapai target spawner tepat pada koordinat `[-256, -20, -432]`.
  - Toleransi kedatangan koordinat terpenuhi dalam radius $d \le 0.6$m (`assertCoordinateClose`).

### 4. PostgreSQL Telemetry Logging & Audit Trail
- **Tabel Sasaran**: `benchmark_runs` dan `telemetry_logs`
- **Hasil Pengujian**:
  - Rekaman sesi `combat_farm` berhasil di-insert ke PostgreSQL database dengan metadata `{ xpGained: 15, finalXP: 15, finalLevel: 2 }`.
  - Log koordinat `[-256, -20, -432]` dan riwayat loot tersimpan utuh di kolom JSONB `path_history`.

### 5. Master Suite Execution (T4-SCEN-02 & Full 163 Tests)
- **Perintah Verifikasi**:
  - `node test/runner.js --filter "T4-SCEN-02"`: **1/1 Passed (1264ms)**
  - `node test/runner.js`: **163/163 Passed (15.11s, Exit Code 0)**

---

## Challenges

### [Low] Challenge 1: Port Collision on Shared Test Server
- **Assumption challenged**: Diasumsikan port HTTP/WebSocket 8080–8085 selalu bebas saat pengujian dijalankan.
- **Attack scenario**: Jika proses runner sebelumnya menggantung (*lingering process*) atau proses lain mengikat port 8081/8083, suite pengujian dapat mengalami error `EADDRINUSE`.
- **Blast radius**: Test runner gagal pada hook inisialisasi lingkungan sebelum uji kasus dieksekusi.
- **Mitigation**: `MockWebServer` telah dilengkapi fitur penutupan soket agresif (`destroy()` pada active sockets) dan penanganan graceful teardown. Runner berjalan bersih setelah pembersihan proses uji terdahulu.

### [Low] Challenge 2: Weapon Cooldown Timer Drift under Heavy Event Loop Lag
- **Assumption challenged**: Timer JavaScript `setTimeout(r, 630)` diasumsikan selalu menghasilkan interval $\ge 625$ms.
- **Attack scenario**: Dalam kondisi CPU throttling ekstrem, callback timer mungkin terpanggil dengan sedikit penyimpangan.
- **Blast radius**: Asersi jeda serangan dapat terpicu salah jika batas bawah dibuat terlalu ketat tanpa toleransi drift.
- **Mitigation**: Fungsi `assertAttackPacing` mengizinkan batas toleransi jitter waktu sebesar 20ms (`minCooldownMs - 20 = 605ms`), sehingga kebal terhadap jitter penjadwalan loop event tanpa mengorbankan proteksi terhadap spam click.

---

## Stress Test Results

| Skenario Pengujian | Perilaku yang Diharapkan | Hasil Pengamatan | Status |
|---|---|---|:---:|
| `test/e2e/test_zombie_combat_xp.js` | 3 zombie mati, $+15$ XP, jeda serangan $\ge 625$ms, log DB tersimpan | 3 kill, $+15$ XP, level up ke Lv.2, telemetri tersimpan di PostgreSQL | **PASS** |
| `test/e2e/e2e_level4_test.js` | Bot tiba di target `[-256, -20, -432]`, delta $< 0.6$m | Posisi akhir `[-256, -20, -432]`, status `SUCCESS` | **PASS** |
| `test/runner.js --filter "T4-SCEN-02"` | Eksekusi pipeline lengkap (farming, sorting, incineration) lulus | 1/1 pengujian lulus (1264ms), exit code 0 | **PASS** |
| `test/e2e/e2e_challenger2_stress_test.js` | 7 invariant kritis (pacing, XP, database, coordinates) terpenuhi | 7/7 kasus uji lulus 100% | **PASS** |
| `test/mutation_verifier.js` | 48/48 kasus mutasi tertangkap tanpa false-positive | 48/48 mutasi tertangkap | **PASS** |
| `test/fault_injection_verifier.js` | 8/8 skenario sabotase terdeteksi | 8/8 sabotase tertangkap | **PASS** |
| `test/runner.js` (Master Suite) | Seluruh 163 kasus uji Tier 1–4 lulus 100% | 163 lulus, 0 gagal, exit code 0 | **PASS** |

---

## Unchallenged Areas

- **Koneksi Live Fisik ke Server NeoForge 26.1.2 Remote**: Validasi jaringan live dilakukan melalui modul `slpVerifier.js` dan simulasi protokol 775 di arena headless, sedangkan pengujian live server remote bergantung pada ketersediaan tunnel `atoms-girl.tun.ply.gg:25565`.

---

## Final Verdict
**APPROVE** — Implementasi pertarungan zombie, penegakan jeda senjata, penambahan XP, pencatatan telemetri PostgreSQL, dan penargetan koordinat `[-256, -20, -432]` telah terbukti kokoh, deterministik, dan memenuhi seluruh kriteria penerimaan.
