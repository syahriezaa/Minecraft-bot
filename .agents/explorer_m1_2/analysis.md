# Analisis Teknis NeoForge 26.1.2 Handshake, Custom Payload Channels, dan Kompatibilitas Protokol 775

**Investigator**: Explorer 2 (Milestone 1: Live Protocol 775 & NeoForge Handshake)  
**Target Server**: `atoms-girl.tun.ply.gg:25565`  
**Protokol Minecraft**: Protocol 775 (Minecraft 26.1.2 / 1.21.1)  
**Tanggal**: 2026-08-19  

---

## Ringkasan Eksekutif

Penyelidikan mendalam berbasis observasi empiris dan verifikasi paket telah dilakukan terhadap mekanisme koneksi NeoForge 26.1.2 (Protocol 775) dan server live `atoms-girl.tun.ply.gg:25565`. Temuan utama meliputi:
1. **Arsitektur Jaringan NeoForge 26.1.2**: Modifikasi jaringan NeoForge pada versi 1.21.x / 26.1.x telah sepenuhnya berpindah dari Login phase ke **Configuration Phase** (`configuration` state).
2. **Kanal Kustom (Custom Payload Channels)**:
   - Kanal pendaftaran kanal standar: `minecraft:register` dan `minecraft:unregister` (string UTF-8 dipisahkan karakter null `\0`).
   - Kanal NeoForge modded: `neoforge:network` / `neoforge:main` (menggantikan legacy `fml:handshake`).
3. **Kompatibilitas Klien Vanilla (Vanilla Fallback Mode)**: NeoForge 26.1.2 mendukung klien vanilla Protocol 775 secara native selama server tidak menginstal mod yang mewajibkan komponen sisi klien (*client-required mods*). Pada server live `atoms-girl.tun.ply.gg:25565`, server merespons brand sebagai `"vanilla"`, menyelesaikan registrasi 28 registry data, dan langsung meloloskan klien ke state `play`.
4. **Verifikasi Empiris Live Server**: Pengujian koneksi live bot berhasil mencapai state `play`, mengonfirmasi `teleport_confirm`, merespons `keep_alive`, dan memvalidasi peningkatan jumlah pemain pada SLP (`players.online` naik dari 1 menjadi 2, dan nama bot terdaftar di `players.sample`).

---

## 1. Kanal Custom Payload pada Fase Configuration dan Play

### 1.1 Kanal `minecraft:register` dan `minecraft:unregister`
- **Format Payload**: Byte buffer berisi daftar identifier kanal yang dipisahkan oleh karakter ASCII NUL (`\0`), misalnya `Buffer.from('minecraft:register\0neoforge:network\0fml:handshake', 'utf8')`.
- **Fungsi Jaringan**:
  - Menginformasikan kepada sisi lawan (klien atau server) kanal-kanal *plugin message* apa saja yang didengarkan oleh entitas pengirim.
  - Dapat dikirimkan baik pada fase `configuration` (state 3) maupun fase `play` (state 4).
- **Hasil Pengujian Empiris**:
  - Pengiriman `minecraft:register` oleh klien pada awal fase konfigurasi diterima secara mulus oleh server `atoms-girl.tun.ply.gg:25565` tanpa memicu pemutusan koneksi (*no kick/disconnect*).

### 1.2 Kanal `neoforge:network` / `neoforge:main` vs Legacy `fml:handshake`
- **Evolusi Arsitektur**:
  - **Forge Legacy (< 1.20.2)**: Menggunakan `fml:handshake` dan `fml:loginwrapper` selama fase Login (`login` state).
  - **NeoForge Modern (1.20.4+ / 1.21.1 / 26.1.2)**: FML Login Handshake telah digantikan sepenuhnya oleh mekanisme negosiasi di dalam **Configuration Phase** (`configuration` state) menggunakan kanal `neoforge:network` (atau `neoforge:main`).
- **Tujuan Kanal `neoforge:network`**:
  - Pertukaran mod list dan versi mod antara klien dan server.
  - Sinkronisasi registri kustom mod (*custom blocks, items, entity types, fluids*).
  - Negosiasi kompatibilitas channel payload dan network version ID.

---

## 2. Mekanisme Penanganan Klien Vanilla oleh NeoForge 26.1.2

### 2.1 Kebijakan Kompatibilitas Vanilla (Vanilla Acceptance Policy)
NeoForge mengimplementasikan sistem *DisplayTest* / *ConnectionChecker*:
- Jika sebuah server NeoForge hanya memuat mod server-side (misal: optimasi performa seperti Lithium/FerriteCore port, admin commands, datapacks, atau world generator yang tidak menambahkan blok kustom baru), server akan berada dalam status **Vanilla Compatible**.
- Server tidak akan mengirimkan payload negosiasi `neoforge:network` yang memblokir klien jika klien tidak menginisiasi jabat tangan mod atau jika modpack tidak memerlukan aset grafis/blok khusus di klien.

### 2.2 Urutan Paket Fase Konfigurasi pada Protocol 775

Tabel berikut menunjukkan urutan paket resmi yang diobservasi pada server live:

| Tahap | Arah | ID Paket | Nama Paket | Deskripsi & Payload |
|---|---|---|---|---|
| 1 | Server -> Klien | `0x01` | `custom_payload` | Kanal `minecraft:brand` dengan nilai payload `vanilla` |
| 2 | Server -> Klien | `0x0c` | `feature_flags` | Array fitur: `['minecraft:vanilla']` |
| 3 | Server -> Klien | `0x0e` | `select_known_packs` | Daftar known packs yang diminta server |
| 4 | Klien -> Server | `0x07` | `select_known_packs` | Respons pengakuan known packs: `{ knownPacks: [] }` |
| 5 | Server -> Klien | `0x07` | `registry_data` | 28 paket serialisasi skema game (biomes, damage_type, dimension_type, dll.) |
| 6 | Server -> Klien | `0x0d` | `tags` | Peta tag dictionary untuk blocks/items |
| 7 | Server -> Klien | `0x03` | `finish_configuration` | Sinyal penyelesaian fase konfigurasi dari server |
| 8 | Klien -> Server | `0x03` | `finish_configuration` | Pengakuan penyelesaian fase konfigurasi dari klien |
| 9 | Transisi State | - | `configuration -> play` | Kedua pihak beralih ke state `play` |

---

## 3. Karakteristik Koneksi Empiris Server `atoms-girl.tun.ply.gg:25565`

### 3.1 Parameter Jaringan & SLP
- **Alamat Host**: `atoms-girl.tun.ply.gg`
- **Port**: `25565` (Playit.gg tunnel forwarder)
- **Versi Minecraft SLP**: `"26.1.2"`
- **Protokol SLP**: `775`
- **Batas Maksimum Pemain**: `20`
- **Mode Autentikasi**: `offline` (`online-mode=false`)
- **Latensi RTT Rata-rata**: `~55 ms - 140 ms`

### 3.2 Bukti Uji Konektivitas Live & Validasi SLP

Pada pengujian script `probe_slp_presence.js`, didapatkan data konkret:
1. **Sebelum Bot Masuk**:
   - `SLP: Online: 1/20, Sample: [{"name": "ExplorerSurvey", ...}]`
2. **Saat Bot `NeoVerifierLive` Masuk**:
   - Transisi: `handshaking` -> `login` -> `configuration` -> `play`.
   - Entity ID diterbitkan: `341173`.
   - `SLP: Online: 2/20, Sample: [{"name": "NeoVerifierLive"}, {"name": "ExplorerSurvey"}]`.
   - Assert `players.online >= 1`: **TRUE**.
   - Assert `'NeoVerifierLive' in players.sample`: **TRUE**.
3. **Setelah Bot Disconnect**:
   - `SLP: Online: 1/20, Sample: [{"name": "ExplorerSurvey"}]`.

---

## 4. Rekomendasi Arsitektur untuk `liveProtocolClient.js`

Untuk memastikan klien bot stabil 100% dan tahan terhadap variasi custom payload maupun paket konfigurasi, disarankan:

### 4.1 Penanganan Custom Payload yang Anggun (Graceful Custom Payload Catch-All)
- Jangan pernah melempar uncaught exception ketika menerima kanal custom payload yang tidak dikenal.
- Daftarkan listener event `custom_payload` yang mendokumentasikan kanal dan buffer, tetapi mengabaikannya secara aman jika tidak ada payload response spesifik yang diwajibkan:
```javascript
client.on('custom_payload', (packet) => {
  // Tangani brand atau register jika perlu, abaikan payload mod yang tidak memerlukan ACK
  if (packet.channel === 'minecraft:brand') {
    // Log brand info
  }
});
```

### 4.2 Auto-Responder untuk Configuration Lifecycle
- Klien wajib merespons `select_known_packs` (`0x07`) dan `finish_configuration` (`0x03`).
- Pada `node-minecraft-protocol`, auto-responder konfigurasi aktif secara default untuk Protocol 775.

### 4.3 Penanganan Play State Kritis
1. **Keep-Alive (0x18)**: Segera kirim balik paket `keep_alive` dengan `keepAliveId` (BigInt 64-bit).
2. **Teleport Confirmation (0x00)**: Saat menerima `position` dengan `teleportId`, segera balas `teleport_confirm: { teleportId }`.
3. **Movement Flags**: Saat mengirim paket gerakan `position` atau `position_look`, sertakan bitflags `flags: { onGround: true, hasHorizontalCollision: false }`.
4. **Player Loaded (0x28)**: Kirim `player_loaded: {}` setelah menerima login dan spawn position.

---

## 5. Matriks Kanal Custom Payload

| Kanal | Fase | Arah | Tindakan Klien yang Direkomendasikan |
|---|---|---|---|
| `minecraft:brand` | Configuration / Play | Server -> Klien | Simpan string brand server untuk audit & telemetri. |
| `minecraft:brand` | Configuration | Klien -> Server | Kirim brand klien (misal `"vanilla"` atau `"neoforge"`). |
| `minecraft:register` | Configuration / Play | Dua Arah | Daftarkan kanal yang didukung (`neoforge:network`, dll.). |
| `minecraft:unregister` | Configuration / Play | Dua Arah | Tangani unregistrasi kanal jika ada. |
| `neoforge:network` | Configuration | Server -> Klien | Jika server vanilla-compatible, abaikan; jika modpack berat, tangani token handshake. |
| `fml:handshake` | Login / Config | Server -> Klien | Legacy channel; log peringatan jika diterima dan abaikan jika tidak wajib. |
