# Laporan Analisis Explorer 2: Spesifikasi Live Server, Struktur Status SLP JSON, dan Semantik Validasi `verifyBotOnline` (Milestone 2)

**Penulis**: Explorer 2 (Milestone 2 — Programmatic SLP Verification Engine)  
**Tanggal**: 2026-08-19  
**Target File**: `src/network/slpVerifier.js`, `test/verify_slp.js`, `src/config/constants.js`, `src/config/environment.js`  
**Host Target**: `atoms-girl.tun.ply.gg:25565` (Minecraft 26.1.2 / Protokol 775)

---

## 1. Ringkasan Eksekutif & Batasan Masalah

Tujuan utama Milestone 2 adalah menyediakan **mesin verifikasi Server List Ping (SLP) terprogram** yang mandiri, deterministik, dan dapat memvalidasi status server serta kehadiran bot di live server `atoms-girl.tun.ply.gg:25565` tanpa bergantung pada Mineflayer atau framework eksternal yang berat.

Explorer 2 bertugas menginvestigasi:
1. Kebutuhan live server dan integrasi dengan layer jaringan yang sudah ada (`src/config/constants.js`, `src/config/environment.js`, `src/network/liveProtocolClient.js`).
2. Analisis empiris live server `atoms-girl.tun.ply.gg:25565` dan skema detail respons SLP status JSON.
3. Pendefinisian semantik validasi yang kokoh untuk fungsi `verifyBotOnline({ host, port, botUsername, timeoutMs })`.

---

## 2. Analisis Konfigurasi & Layer Jaringan Eksisting

### 2.1 Konfigurasi Terpusat (`src/config/environment.js` & `src/config/constants.js`)
- Di dalam `src/config/environment.js`, variabel lingkungan Minecraft telah terdefinisi:
  ```javascript
  minecraft: {
    host: process.env.MC_HOST || '127.0.0.1',
    port: parseInt(process.env.MC_PORT || '25565', 10),
    version: process.env.MC_VERSION || '1.20.1',
    botUsername: process.env.MC_BOT_USERNAME || 'AutonomousCompanion'
  }
  ```
- Di dalam `src/network/liveProtocolClient.js`, konfigurasi bawaan live server diatur ke:
  ```javascript
  const DEFAULT_CLIENT_CONFIG = Object.freeze({
    host: 'atoms-girl.tun.ply.gg',
    port: 25565,
    username: 'Bot_AI_Companion',
    protocolVersion: 775,
    minecraftVersion: '26.1.2',
    ...
  });
  ```
- Di dalam `src/config/constants.js`, terdapat konstanta operasional sistem (koordinat spawner farm `[-256, -20, -432]`, weapon cooldowns, stuck detection). Disarankan untuk mengekspor konstanta default SLP (seperti `DEFAULT_SLP_PORT = 25565`, `DEFAULT_SLP_TIMEOUT_MS = 5000`, `PROTOCOL_VERSION_775 = 775`) agar konsisten di seluruh modul.

### 2.2 Hubungan `src/network/slpVerifier.js` dengan Komponen Lain
Arsitektur modul untuk Milestone 2:
- `src/network/slpVerifier.js` bertindak sebagai pustaka mandiri (zero external npm dependencies, hanya menggunakan `node:net` dan `node:buffer`).
- Menyediakan dua API utama:
  1. `querySLP({ host, port, timeoutMs, protocolVersion })`
  2. `verifyBotOnline({ host, port, botUsername, timeoutMs, protocolVersion })`
- `test/verify_slp.js` mengimpor `slpVerifier.js` sebagai utility CLI runner dan skrip verifikasi otomatis.
- `src/web/webServer.js` (Milestone 4) dapat mengimpor `querySLP` untuk menyajikan widget status live server di dashboard web.

---

## 3. Investigasi & Analisis Empiris Live Server `atoms-girl.tun.ply.gg:25565`

Pengujian kueri empiris langsung ke `atoms-girl.tun.ply.gg:25565` pada protokol 775 menghasilkan respons wire berikut:

```json
{
  "description": "A Minecraft Server",
  "players": {
    "max": 20,
    "online": 2,
    "sample": [
      {
        "id": "c40b6a6d-dc0a-3749-ad1d-5e811499d981",
        "name": "ExplorerSurvey"
      },
      {
        "id": "00000000-0000-0000-0000-000000000000",
        "name": "Anonymous Player"
      }
    ]
  },
  "version": {
    "name": "26.1.2",
    "protocol": 775
  },
  "favicon": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHe..."
}
```

### Karakteristik Live Server:
1. **Versi & Protokol**: `name: "26.1.2"`, `protocol: 775`. Server berjalan di atas stack Minecraft NeoForge 26.1.2 (berbasis Minecraft 1.21.1 / 1.21.x networking).
2. **Deskripsi (MOTD)**: Mengembalikan string `"A Minecraft Server"`. Namun protokol Minecraft juga mengizinkan objek Chat Component (`{ text: "...", extra: [...] }`), sehingga parser SLP wajib menangani kedua tipe (string maupun objek).
3. **Pemain Online**: Mengembalikan objek dengan properti `max: 20`, `online: 2`, dan array `sample` berisi objek `{ id: string, name: string }`.
4. **Favicon**: Mengembalikan string Base64 data URI (berawalan `data:image/png;base64,` dengan panjang ~12.882 karakter).
5. **Latensi Jaringan (RTT)**: Berdasarkan pengujian langsung, latensi berkisar antara 400ms – 1400ms karena koneksi melalui proxy tunnel ply.gg. Timeout default 5000ms – 10000ms sangat memadai.

---

## 4. Dekomposisi Struktur & Skema SLP Status JSON

Berdasarkan spesifikasi Minecraft Modern Protocol (1.21.x / Protokol 775), payload JSON dari Status Response Packet (ID 0x00) memiliki struktur sebagai berikut:

| Field | Tipe | Wajib/Opsional | Deskripsi |
|---|---|---|---|
| `version` | Object | Wajib | Informasi versi software server |
| `version.name` | String | Wajib | Nama versi (misal `"26.1.2"`, `"1.21.1"`) |
| `version.protocol` | Number | Wajib | ID numerik protokol (misal `775`) |
| `players` | Object | Wajib | Status populasi pemain |
| `players.max` | Number | Wajib | Jumlah slot pemain maksimal |
| `players.online` | Number | Wajib | Jumlah pemain yang sedang terhubung aktif |
| `players.sample` | Array<Object> | Opsional | Cuplikan daftar pemain: `[{ id: string, name: string }]` |
| `description` | String / Object | Wajib | MOTD server (teks biasa atau objek Chat Component) |
| `favicon` | String | Opsional | Ikon server dalam format Data URI PNG Base64 |
| `enforcesSecureChat` | Boolean | Opsional | Menunjukkan apakah server mewajibkan tanda tangan chat |
| `previewsChat` | Boolean | Opsional | Status fitur preview chat (fitur legacy 1.19+) |
| `forgeData` / `modinfo` | Object | Opsional | Informasi daftar mod pada server Forge/NeoForge |

### Normalisasi Objek Deskripsi (Chat Component MOTD):
Server Minecraft dapat mengirimkan `description` dalam dua bentuk:
1. **String**: `"Selamat datang di Server!"`
2. **Objek JSON Chat Component**:
   ```json
   {
     "text": "Selamat datang ",
     "extra": [
       { "text": "di Server!", "color": "gold", "bold": true }
     ]
   }
   ```
3. **Parser Helper Rekomendasi**:
   ```javascript
   function extractPlainText(description) {
     if (typeof description === 'string') return description;
     if (!description || typeof description !== 'object') return '';
     
     let text = description.text || '';
     if (Array.isArray(description.extra)) {
       for (const part of description.extra) {
         text += extractPlainText(part);
       }
     }
     return text;
   }
   ```

---

## 5. Detail Semantik & Logika Validasi `verifyBotOnline`

Fungsi `verifyBotOnline({ host, port, botUsername, timeoutMs })` dirancang untuk memverifikasi secara objektif apakah bot tertentu aktif di dalam server.

### 5.1 Definisi Antarmuka Kontrak (Interface Contract)

```javascript
/**
 * Memverifikasi status server dan kehadiran bot tertentu via SLP
 * @param {Object} options
 * @param {string} [options.host='atoms-girl.tun.ply.gg'] - Host target
 * @param {number} [options.port=25565] - Port server Minecraft
 * @param {string} [options.botUsername] - Nama bot yang ingin diverifikasi
 * @param {number} [options.timeoutMs=5000] - Batas waktu timeout (ms)
 * @param {number} [options.protocolVersion=775] - Versi protokol SLP
 * @returns {Promise<{
 *   isOnline: boolean,
 *   playerCount: number,
 *   maxPlayers: number,
 *   inSample: boolean,
 *   sampleOmitted: boolean,
 *   sample: Array<{ id: string, name: string }>,
 *   version: { name: string, protocol: number },
 *   descriptionText: string,
 *   latencyMs: number,
 *   rawStatus: object
 * }>}
 */
```

### 5.2 Evaluasi Logika Validasi Berdasarkan Skenario

1. **Skenario 1: Server Merespons & Bot Ditemukan di `players.sample`**
   - `players.online >= 1`
   - `players.sample` adalah array dan berisi elemen dengan `p.name === botUsername` (atau perbandingan case-insensitive `p.name.toLowerCase() === botUsername.toLowerCase()`).
   - **Hasil**:
     * `isOnline`: `true`
     * `playerCount`: `players.online` (misal `2`)
     * `inSample`: `true`
     * `sampleOmitted`: `false`

2. **Skenario 2: Server Merespons, Pemain Online >= 1, tetapi Bot TIDAK Ada di `players.sample`**
   - Kasus 2A: `players.sample.length === players.online` (Daftar sample mencakup seluruh pemain online).
     * Dapat dipastikan 100% bot **tidak terhubung**.
     * `inSample`: `false`
     * `isOnline`: `false` (karena bot spesifik yang dicari tidak online)
   - Kasus 2B: `players.sample.length < players.online` (Misal ada 50 pemain online, namun sample hanya mengembalikan 12 pemain acak).
     * Bot mungkin online tetapi tidak masuk dalam cuplikan sample.
     * `inSample`: `false`
     * `isOnline`: `false` (tidak dapat dibuktikan keberadaannya via SLP sample)
     * Catatan: Dalam pengujian kontrol Milestone 2 & 5, live server hanya memiliki 1–3 pemain, sehingga `sample.length` selalu memuat seluruh pemain.

3. **Skenario 3: Server Merespons, tetapi `players.sample` Ditiadakan (Omitted / Kosong)**
   - Beberapa konfigurasi server (seperti `hide-online-players=true` pada `server.properties` atau setting proxy Bungee/Velocity) tidak menyertakan field `sample` atau mengirim array kosong `[]`.
   - **Hasil**:
     * `sampleOmitted`: `true`
     * `inSample`: `false`
     * `isOnline`: Jika `botUsername` tidak diberikan, `isOnline = (players.online >= 1)`. Jika `botUsername` diberikan, `isOnline = (players.online >= 1)` dengan indikator `inSample = false` dan `sampleOmitted = true` sehingga pemanggil mengetahui bahwa nama bot tidak dapat diverifikasi secara individual namun server memiliki pemain aktif.

4. **Skenario 4: Server Merespons, tetapi `players.online === 0`**
   - Tidak ada pemain yang sedang terhubung ke server.
   - **Hasil**:
     * `isOnline`: `false`
     * `playerCount`: `0`
     * `inSample`: `false`
     * `sampleOmitted`: `false` (atau `true` jika sample tidak dikirim)

5. **Skenario 5: Server Mati / Timeout / Koneksi Ditolak (ECONNREFUSED / ETIMEDOUT)**
   - Socket mengalami error atau timeout sebelum menerima paket 0x00 Status Response.
   - `querySLP` dan `verifyBotOnline` harus menolak (reject) Promise dengan pesan error deskriptif dalam Bahasa Indonesia:
     * Timeout: `[SLP] Batas waktu permintaan SLP ke ${host}:${port} habis (${timeoutMs}ms)`
     * Connection Refused: `[SLP] Gagal terhubung ke ${host}:${port}: Koneksi ditolak oleh server`
     * Invalid JSON: `[SLP] Gagal mem-parsing respons JSON status server: ${error.message}`

---

## 6. Diagram Alir Keputusan `verifyBotOnline`

```
                         +-----------------------+
                         | verifyBotOnline(opts) |
                         +-----------+-----------+
                                     |
                                     v
                           +-------------------+
                           | querySLP(options) |
                           +---------+---------+
                                     |
                    +----------------+----------------+
                    |                                 |
              [Error/Timeout]                     [Success]
                    |                                 |
                    v                                 v
          +-------------------+             +-------------------+
          |  Reject Promise   |             | Ekstrak online,   |
          | (Bahasa Indonesia)|             | sample, version   |
          +-------------------+             +---------+---------+
                                                      |
                                    +-----------------+-----------------+
                                    |                                   |
                          [players.online == 0]               [players.online >= 1]
                                    |                                   |
                                    v                                   v
                          +-------------------+               +-------------------+
                          | isOnline: false   |               | Apakah sample     |
                          | inSample: false   |               | tersedia & array? |
                          | playerCount: 0    |               +---------+---------+
                          +-------------------+                         |
                                                      +-----------------+-----------------+
                                                      |                                   |
                                                   [Ya]                             [Tidak / null]
                                                      |                                   |
                                          +-----------+-----------+                       v
                                          | Cari botUsername di   |             +-------------------+
                                          | sample (case-insens.) |             | sampleOmitted: true|
                                          +-----------+-----------+             | inSample: false   |
                                                      |                         | isOnline: true*   |
                                        +-------------+-------------+           +-------------------+
                                        |                           |
                                    [Ditemukan]               [Tidak Ada]
                                        |                           |
                                        v                           v
                              +-------------------+       +-------------------+
                              | isOnline: true    |       | isOnline: false   |
                              | inSample: true    |       | inSample: false   |
                              | sampleOmitted: fls|       | sampleOmitted: fls|
                              +-------------------+       +-------------------+
```

---

## 7. Rekomendasi Teknis untuk Worker M2 & Reviewer M2

1. **Paket Biner Presisi**:
   - `writeVarInt` & `readVarInt` harus mendukung boundary check lengkap.
   - Handshake packet mengirimkan `nextState = 1` (Status), bukan `2` (Login).
   - Status Request packet adalah paket ID 0x00 dengan panjang payload 0.
2. **Ping / Pong RTT Opsional (ID 0x01)**:
   - Setelah menerima Status Response 0x00, klien dapat secara opsional mengirim paket Ping 0x01 dengan payload 64-bit Long (timestamp saat ini) dan membaca paket Pong 0x01 dari server untuk mengukur latensi RTT level TCP/wire yang sangat presisi.
3. **Pemberian Pesan & Penanganan Kesalahan**:
   - Sesuai `RULE[user_global]`, semua pesan error yang dikembalikan ke pemanggil / user harus ditulis dalam **Bahasa Indonesia**.
4. **Pembersihan Resource Soket**:
   - Pastikan setiap pembukaan soket TCP memiliki pembersihan (`cleanupSocket`) yang dipanggil pada event `close`, `error`, `timeout`, dan setelah status berhasil diterima, untuk mencegah memory leak atau hanging handles.
