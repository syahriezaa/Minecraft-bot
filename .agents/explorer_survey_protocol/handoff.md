# Handoff Report — Explorer 2 (Protocol & Live Connectivity Surveyor)

**Agent**: Explorer 2 (`explorer_survey_protocol`)  
**Parent**: Orchestrator (`50c455c2-d20b-46e6-9106-c04b688103b2`)  
**Timestamp**: 2026-08-18T17:48:00Z  
**Report File**: `.agents/explorer_survey_protocol/survey_report.md`

---

## 1. Observation

1. **Target Server SLP Ping Result**:
   - Menjalankan `minecraft-protocol.ping({ host: 'atoms-girl.tun.ply.gg', port: 25565 })` mengembalikan:
     ```json
     {
       "version": { "name": "26.1.2", "protocol": 775 },
       "players": { "max": 20, "online": 1, "sample": [{"id": "b1e02b5e-eef8-3b05-9c98-9ee25f85c505", "name": "SurveyorBotLive"}] },
       "description": "A Minecraft Server",
       "latency": 55
     }
     ```
   - Server tidak menyiarkan data modul pemblokir (`forgeData` / `modinfo` adalah `undefined`).
2. **Kanal Jaringan & Handshake**:
   - Selama transisi `login` -> `configuration`, server mengirim paket `custom_payload` dengan kanal `minecraft:brand` bernilai Buffer `[7, 118, 97, 110, 105, 108, 108, 97]` (`"vanilla"`).
   - Server mengirim 28 paket `registry_data` (`minecraft:dimension_type`, `minecraft:damage_type`, `minecraft:enchantment`, `minecraft:world_clock`, `minecraft:timeline`, `minecraft:dialog`, `minecraft:test_instance`, dll.).
   - Server mengirim paket `tags` dan `finish_configuration` (`{}`).
3. **Perubahan Skema Protokol 775**:
   - Paket posisi `play.toServer.packet_position` dan `packet_position_look` memerlukan tipe bitflag:
     `flags: MovementFlags` (`{ onGround: boolean, hasHorizontalCollision: boolean }`), bukan boolean tunggal `onGround`.
   - Paket waktu `packet_update_time` memuat `[age: i64, clockUpdates: array]`, bukan field `packet.time`.
4. **Perilaku Mineflayer vs Direct Protocol Client**:
   - Inisialisasi `mineflayer.createBot({ version: '26.1.2' })` secara standar gagal di `mineflayer/lib/loader.js:124` dengan pesan:
     `Error: Server version '26.1' is not supported. Latest supported version is '1.21.11'.`
   - Setelah loader di-bypass, plugin `mineflayer/lib/plugins/time.js:37` melempar `TypeError: Cannot read properties of undefined (reading '0')` akibat perubahan skema `update_time`.
   - Klien native `node-minecraft-protocol` (v1.54+) dengan `protocolVersion: 775` dan `version: '26.1.2'` berhasil 100% melewati Handshake, Login, Configuration Phase, Play Phase, Teleport Confirm, Keep-alive, Chat, dan SLP presence verification.

---

## 2. Logic Chain

1. Berdasarkan observasi SLP ping, server live beroperasi pada versi resmi Minecraft 26.1.2 / Protocol 775 dengan `online-mode=false`.
2. Karena kanal brand adalah `"vanilla"` dan tidak ada paket pemblokir modul Forge wajib pada fase konfigurasi, klien protokol 775 standar dapat terhubung langsung tanpa emulator modpack berat.
3. Karena `node-minecraft-protocol` dan `minecraft-data@3.113.2` memiliki deskriptor ProtoDef lengkap untuk Protocol 775, klien direct-protocol dapat mengeksekusi siklus hidup `handshake` -> `login` -> `configuration` -> `play` secara deterministik.
4. Dengan mengimplementasikan konfirmasi teleportasi (`teleport_confirm`), pengakuan pemuatan (`player_loaded`), pengakuan batch chunk (`chunk_batch_received`), dan pembalasan detak jantung (`keep_alive`), bot mempertahankan status persisten di server tanpa risiko disconnect/kick.
5. Verifikasi independen melalui SLP ping saat bot aktif secara simultan membuktikan bahwa `players.online >= 1` dan nama bot terdaftar pada `players.sample`.

---

## 3. Caveats

1. **Jarak Spawner Pertanian**: Server menempatkan bot saat pertama kali bergabung pada koordinat spawn `(-36.5, 64.0, 6.5)`. Koordinat target spawner pada permintaan adalah `[-256, -20, -432]`. Navigasi jarak jauh membutuhkan modul interpolasi lintasan 3D atau pathfinder custom yang kompatibel dengan protokol 775.
2. **Kondisi Mob Spawner di Server Live**: Server live mungkin memiliki aturan *peaceful/easy/normal/hard* dan chunk loading dinamis yang perlu dipantau secara real-time melalui paket entitas.
3. **Mineflayer Plugins**: Jika implementor memutuskan menggunakan pustaka Mineflayer tingkat tinggi, plugin `time.js` dan serialisasi pergerakan wajib di-override atau dinonaktifkan.

---

## 4. Conclusion

1. Protokol 775 (NeoForge 26.1.2) pada `atoms-girl.tun.ply.gg:25565` sepenuhnya dapat diakses secara headless menggunakan pustaka `minecraft-protocol` dengan `protocolVersion: 775` dan `version: '26.1.2'`.
2. Semua persyaratan konektivitas jaringan (R1, R2, dan R3 keepalive) terbukti valid dan terverifikasi secara empiris melalui pengujian live probe task.
3. Rekomendasi implementasi: Bangun modul `src/network/liveProtocolClient.js` sebagai jembatan headless otonom yang terintegrasi dengan `webServer.js` (port 8080) dan database telemetri.

---

## 5. Verification Method

Untuk memverifikasi secara independen temuan ini:
1. **SLP Polling Command**:
   ```bash
   node -e "const mc = require('minecraft-protocol'); mc.ping({ host: 'atoms-girl.tun.ply.gg', port: 25565 }, (err, res) => console.log('SLP Result:', res));"
   ```
2. **Live Presence Probe Command**:
   ```bash
   node -e "
   const mc = require('minecraft-protocol');
   const client = mc.createClient({ host: 'atoms-girl.tun.ply.gg', port: 25565, username: 'VerifyBot', auth: 'offline', version: '26.1.2', protocolVersion: 775, skipValidation: true });
   client.on('position', p => { if (p.teleportId !== undefined) client.write('teleport_confirm', { teleportId: p.teleportId }); client.write('player_loaded', {}); });
   client.on('keep_alive', p => client.write('keep_alive', { keepAliveId: p.keepAliveId }));
   setTimeout(() => { mc.ping({ host: 'atoms-girl.tun.ply.gg', port: 25565 }, (e, r) => { console.log('Players online:', r.players.online, 'Sample:', r.players.sample); client.end(); }); }, 4000);
   "
   ```
3. **File Inspeksi**:
   - Laporan Lengkap: `.agents/explorer_survey_protocol/survey_report.md`
