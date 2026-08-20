# Original User Request

## 2026-08-18T17:43:36Z

Menghubungkan bot pemain otonom secara live dan stabil ke server Minecraft NeoForge 26.1.2 (atoms-girl.tun.ply.gg:25565) hingga terverifikasi memiliki pemain aktif (players.online >= 1).

Working directory: ~/teamwork_projects/minecraft_autonomous_companion
Integrity mode: development

## Requirements

### R1. Modded NeoForge 26.1.2 Handshake & Live Connection
Membangun jembatan koneksi headless / Forge launcher yang mampu melewati fase konfigurasi jaringan Modded NeoForge 26.1.2 (neoforge:network / fml:handshake protokol 775) dan memasukkan bot pemain ke dalam dunia server atoms-girl.tun.ply.gg:25565.

### R2. Programmatic Verification of Active Player Count
Sistem harus secara otomatis melakukan polling Server List Ping (SLP) ke atoms-girl.tun.ply.gg:25565 dan memverifikasi secara objektif bahwa jumlah pemain aktif berubah dari 0/20 menjadi minimal 1/20 (players.online >= 1).

### R3. Persistent Presence & Autonomous Task Loop
Bot yang terhubung harus tetap bertahan di dalam server tanpa terputus (no disconnect/kick), merespon detak jantung (keep-alive), melakukan farming zombie di spawner [-256, -20, -432], memungut bola XP, dan menyinkronkan status ke Web Dashboard http://localhost:8080.

## Acceptance Criteria

### Server Connectivity & Player Verification
- [ ] Script SLP ping ke atoms-girl.tun.ply.gg:25565 mengembalikan players.online >= 1.
- [ ] Daftar pemain aktif (players.sample) memuat nama bot yang terhubung.
- [ ] Bot bertahan di dalam server selama minimal 60 detik tanpa terkena disconnect/kick.
- [ ] Web Dashboard http://localhost:8080 menampilkan status live bot di server nyata.
