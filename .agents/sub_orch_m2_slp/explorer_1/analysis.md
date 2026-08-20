# Laporan Analisis Teknis: Spesifikasi Protokol SLP & Arsitektur Mesin Verifikasi (Milestone 2)

**Penulis**: Explorer 1 (Tim Rekayasa Perangkat Lunak Antigravity)  
**Target Milestone**: Milestone 2 — Programmatic SLP Verification Engine  
**Modul Target**: `src/network/slpVerifier.js` & `test/verify_slp.js`  
**Target Server**: `atoms-girl.tun.ply.gg:25565` (NeoForge 26.1.2 / Protokol 775)  
**Bahasa & Konvensi**: Bahasa Indonesia (Komentar & Pesan Error), Native `node:net` murni.

---

## 1. Ringkasan Eksekutif & Gambaran Protokol

Protokol Server List Ping (SLP) adalah mekanisme ringan berbasis TCP yang digunakan oleh klien Minecraft untuk mengkueri status metadata server secara publik tanpa perlu melakukan proses login pemain penuh (autentikasi akun, pemuatan chunk, alokasi memori dunia). Pada Minecraft modern (1.21.x / NeoForge 26.1.2 / Protokol 775), alur SLP beroperasi dalam sub-status **STATUS (State 1)**.

### Diagram Alur Pertukaran Paket SLP (Wire Flow)

```
Klien (slpVerifier)                                Server Minecraft (Protokol 775)
       │                                                          │
       ├────────────── 1. TCP 3-Way Handshake (SYN/ACK) ─────────┤
       │                                                          │
       ├────────────── 2. Handshake Packet (ID 0x00) ────────────> (State transisi ke STATUS)
       │                  Protocol: 775, Host, Port, NextState=1  │
       │                                                          │
       ├────────────── 3. Status Request Packet (ID 0x00) ───────> (Meminta JSON metadata)
       │                  Payload: 0 bytes                        │
       │                                                          │
       │<───────────── 4. Status Response Packet (ID 0x00) ───────┤ (Mengembalikan JSON status)
       │                  VarInt len + UTF-8 JSON String          │
       │                                                          │
       ├────────────── 5. Ping Request Packet (ID 0x01) ─────────> (Opsional: uji RTT latensi)
       │                  Payload: 8-byte 64-bit BigInt timestamp │
       │                                                          │
       │<───────────── 6. Pong Response Packet (ID 0x01) ─────────┤ (Mengembalikan payload identik)
       │                  Payload: 8-byte 64-bit BigInt timestamp │
       │                                                          │
       └────────────── 7. TCP Connection Teardown (FIN/RST) ──────┘
```

---

## 2. Rincian Encoding & Decoding Paket Biner

### 2.1 Algoritma VarInt & VarLong (LEB128 7-Bit)

Minecraft menggunakan format kompresi integer variabel panjang LEB128:
- Setiap byte memiliki 7-bit payload data (bit 0–6) dan 1-bit Continuation Flag (bit 7, mask `0x80`).
- Jika bit 7 bernilai `1`, byte berikutnya merupakan bagian dari angka yang sama.
- VarInt maksimal berukuran 5 byte (32-bit integer).
- VarLong maksimal berukuran 10 byte (64-bit integer).

#### Implementasi Presisi:
```javascript
/**
 * Menulis integer 32-bit ke dalam format VarInt.
 * @param {number} value
 * @returns {Buffer}
 */
function writeVarInt(value) {
  const bytes = [];
  let val = value >>> 0;
  while (true) {
    if ((val & ~0x7F) === 0) {
      bytes.push(val);
      break;
    } else {
      bytes.push((val & 0x7F) | 0x80);
      val >>>= 7;
    }
  }
  return Buffer.from(bytes);
}

/**
 * Membaca nilai VarInt dari buffer.
 * Mengembalikan null jika buffer terpotong (fragmented).
 * @param {Buffer} buf
 * @param {number} [offset=0]
 * @returns {{ value: number, size: number } | null}
 */
function readVarInt(buf, offset = 0) {
  let value = 0;
  let size = 0;
  let b = 0;

  while (offset + size < buf.length && size < 5) {
    b = buf[offset + size];
    value |= (b & 0x7F) << (7 * size);
    size++;
    if ((b & 0x80) === 0) {
      return { value, size };
    }
  }

  // Jika byte ke-5 belum mengakhiri VarInt atau buffer belum lengkap
  if ((b & 0x80) !== 0) {
    return null;
  }

  return { value, size };
}
```

---

### 2.2 Paket 1: Handshake Packet (Client ➔ Server)

- **State Asal**: `HANDSHAKING` (State 0)
- **Packet ID**: `0x00` (VarInt)
- **Struktur Field**:
  1. `Protocol Version`: VarInt (contoh: `775` untuk 26.1.2)
  2. `Server Address`: String (VarInt panjang karakter + UTF-8 string)
  3. `Server Port`: Unsigned Short (2 byte Big-Endian UInt16BE)
  4. `Next State`: VarInt (`1` untuk STATUS, `2` untuk LOGIN)

#### Wire Byte Layout (Contoh: `host="atoms-girl.tun.ply.gg"`, `port=25565`, `protocol=775`):
```
[Packet Length: VarInt]  -> Panjang seluruh body paket (0x21 / 33 bytes)
[Packet ID: 0x00]        -> 1 byte
[Protocol Version: 775]  -> 0x87 0x06 (2 bytes VarInt)
[Host Length: VarInt]    -> 0x17 (23 bytes)
[Host Bytes]             -> "atoms-girl.tun.ply.gg" (23 bytes ASCII/UTF-8)
[Port: 25565]            -> 0x63 0xDD (2 bytes UInt16BE)
[Next State: 1]          -> 0x01 (1 byte VarInt)
```

---

### 2.3 Paket 2: Status Request Packet (Client ➔ Server)

- **State**: `STATUS` (State 1)
- **Packet ID**: `0x00` (VarInt)
- **Payload**: 0 bytes (Kosong)
- **Wire Framing Lengkap**:
```
0x01 0x00
(Panjang Paket = 1, Packet ID = 0x00)
```

---

### 2.4 Paket 3: Status Response Packet (Server ➔ Client)

- **State**: `STATUS` (State 1)
- **Packet ID**: `0x00` (VarInt)
- **Payload**: String UTF-8 berisi JSON Status (diawali VarInt panjang string)
- **Wire Framing Lengkap**:
```
[Packet Length: VarInt]
[Packet ID: 0x00]
[JSON String Length: VarInt]
[JSON UTF-8 Payload]
```

#### Struktur JSON Status Server Live (`atoms-girl.tun.ply.gg:25565`):
Berdasarkan hasil uji langsung pada server target:
```json
{
  "version": {
    "name": "26.1.2",
    "protocol": 775
  },
  "players": {
    "max": 20,
    "online": 1,
    "sample": [
      {
        "id": "c40b6a6d-dc0a-3749-ad1d-5e811499d981",
        "name": "ExplorerSurvey"
      }
    ]
  },
  "description": "A Minecraft Server",
  "favicon": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHe..."
}
```
*Catatan*: Ukuran JSON response dengan favicon berkisar antara **10 KB hingga 35 KB**. Hal ini **pasti** terfragmentasi di layer TCP (melebihi standar Ethernet MTU 1500 bytes / MSS 1460 bytes).

---

### 2.5 Paket 4 & 5: Ping Request & Pong Response (Client ⇄ Server)

Untuk mengukur latensi Round-Trip Time (RTT) jaringan murni pada layer protokol Minecraft:

- **Ping Packet (Client ➔ Server)**:
  - Packet ID: `0x01` (VarInt)
  - Payload: 8-byte 64-bit integer (`BigInt64BE`), misal `BigInt(Date.now())` atau payload acak `1234567890123456789n`.
  - Wire Frame: `0x09 0x01 [8 bytes BigInt64BE]` (Total 10 bytes).

- **Pong Packet (Server ➔ Client)**:
  - Packet ID: `0x01` (VarInt)
  - Payload: 8-byte 64-bit integer (`BigInt64BE`) yang bernilai identik dengan yang dikirim.
  - Latensi dihitung: `latencyMs = Number(BigInt(Date.now()) - pingSentTime)`.

---

## 3. Desain Arsitektur Modul `src/network/slpVerifier.js`

Modul ini dirancang dengan prinsip **Zero Dependency** (hanya menggunakan bawaan Node.js `node:net`), thread-safe, dan memiliki penanganan timeout dan socket lifecycle yang bersih.

### 3.1 Komponen & Fungsi Utama

1. **`PacketFramer`**:
   - Akumulator stream TCP yang menangani fragmentasi paket (potongan data tersebar di beberapa event `'data'`) dan coalescing (beberapa paket dalam 1 frame TCP).
2. **`querySLP(options)`**:
   - Menghubungkan socket TCP ke server target.
   - Mengirim Handshake (`NextState=1`) + Status Request (`0x00`).
   - Menerima Status Response (`0x00`), mem-parse JSON status.
   - Secara opsional mengirim Ping (`0x01`) dan menunggu Pong (`0x01`) untuk kalkulasi RTT latensi presisi.
   - Menutup socket secara aman dan mengembalikan objek status terstruktur.
3. **`verifyBotOnline(options)`**:
   - Memanggil `querySLP`.
   - Memverifikasi apakah `players.online >= 1`.
   - Memeriksa apakah `botUsername` terdapat pada `players.sample`.
   - Mengembalikan ringkasan verifikasi objektif.

---

## 4. Analisis Kasus Batas (Edge Cases) & Ketahanan Jaringan

| Kasus Batas / Skenario | Dampak Potensial | Solusi & Penanganan di `slpVerifier.js` |
|---|---|---|
| **1. Fragmentasi TCP (Large Favicon)** | JSON berukuran ~13KB+ terbagi menjadi 8–10 paket TCP. Pembacaan langsung pada `data` event pertama akan gagal parse JSON. | Gunakan `PacketFramer` dengan loop `readNextFrame()` yang memverifikasi `acc.length >= varIntSize + packetLength` sebelum memotong payload. |
| **2. VarInt Terpotong di Batas Chunk** | Byte VarInt continuation bit (`0x80`) berada di akhir chunk TCP 1, sedangkan byte penutup berada di awal chunk TCP 2. | `readVarInt` mengembalikan `null` jika VarInt belum lengkap, membiarkan buffer mengakumulasi chunk berikutnya tanpa melempar exception prematur. |
| **3. Server Offline / Firewall Hang** | Socket TCP menggantung tanpa batas waktu jika server mati atau port diblokir. | Konfigurasi `socket.setTimeout(timeoutMs)` dan bersihkan socket dengan `socket.destroy()` saat event `timeout` atau `error`. |
| **4. `players.sample` Undefined / Kosong** | Server dengan 0 pemain atau server yang menonaktifkan player sample tidak menyertakan key `sample`. | Berikan fallback aman: `const sample = rawJson.players?.sample || []`. |
| **5. Deskripsi Chat Format Objek** | Deskripsi server bukan string murni, melainkan format JSON Text Component `{ text: "...", extra: [...] }`. | Ekstrak teks deskripsi: `typeof desc === 'string' ? desc : (desc?.text || JSON.stringify(desc))`. |
| **6. Ping Pong Timeout / Disconnect** | Beberapa server vanilla menutup socket segera setelah mengirim Status Response tanpa membalas Pong. | Fallback ke RTT waktu respons Status Response jika paket Pong tidak direspons sebelum socket ditutup. |

---

## 5. Cetak Biru Implementasi Lengkap (Reference Blueprint)

### Blueprint `src/network/slpVerifier.js`

```javascript
/**
 * @file slpVerifier.js
 * @description Mesin Verifikasi Server List Ping (SLP) Mandiri & Programatik untuk Minecraft 1.21.x / Protokol 775.
 * Menggunakan streaming TCP murni (node:net) tanpa dependensi eksternal,
 * mendukung akumulasi buffer, fragmentasi paket biner, dan pengukuran latensi round-trip.
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

const net = require('node:net');

/**
 * Menulis integer 32-bit ke format VarInt Minecraft.
 * @param {number} value
 * @returns {Buffer}
 */
function writeVarInt(value) {
  const bytes = [];
  let val = value >>> 0;
  while (true) {
    if ((val & ~0x7F) === 0) {
      bytes.push(val);
      break;
    } else {
      bytes.push((val & 0x7F) | 0x80);
      val >>>= 7;
    }
  }
  return Buffer.from(bytes);
}

/**
 * Membaca nilai VarInt dari buffer.
 * @param {Buffer} buf
 * @param {number} [offset=0]
 * @returns {{ value: number, size: number } | null}
 */
function readVarInt(buf, offset = 0) {
  let value = 0;
  let size = 0;
  let b = 0;

  while (offset + size < buf.length && size < 5) {
    b = buf[offset + size];
    value |= (b & 0x7F) << (7 * size);
    size++;
    if ((b & 0x80) === 0) {
      return { value, size };
    }
  }

  if ((b & 0x80) !== 0) {
    return null;
  }

  return { value, size };
}

/**
 * Menulis string UTF-8 diawali dengan VarInt panjang.
 * @param {string} str
 * @returns {Buffer}
 */
function writeString(str) {
  const strBuf = Buffer.from(str, 'utf8');
  const lenBuf = writeVarInt(strBuf.length);
  return Buffer.concat([lenBuf, strBuf]);
}

/**
 * Membaca string UTF-8 dari buffer.
 * @param {Buffer} buf
 * @param {number} [offset=0]
 * @returns {{ value: string, size: number } | null}
 */
function readString(buf, offset = 0) {
  const lenRes = readVarInt(buf, offset);
  if (!lenRes) return null;

  const start = offset + lenRes.size;
  const end = start + lenRes.value;
  if (buf.length < end) return null;

  const value = buf.toString('utf8', start, end);
  return { value, size: lenRes.size + lenRes.value };
}

/**
 * @class PacketFramer
 * @description Mengakumulasi aliran data TCP dan mengekstrak frame paket Minecraft secara presisi.
 */
class PacketFramer {
  constructor() {
    this._buffer = Buffer.alloc(0);
  }

  append(chunk) {
    if (!chunk || chunk.length === 0) return;
    this._buffer = Buffer.concat([this._buffer, chunk]);
  }

  readNextFrame() {
    if (this._buffer.length === 0) return null;

    const lenRes = readVarInt(this._buffer, 0);
    if (!lenRes) return null;

    const { value: packetLen, size: varIntSize } = lenRes;
    const totalFrameSize = varIntSize + packetLen;

    if (this._buffer.length < totalFrameSize) {
      return null;
    }

    const frame = this._buffer.subarray(varIntSize, totalFrameSize);
    this._buffer = this._buffer.subarray(totalFrameSize);
    return frame;
  }

  clear() {
    this._buffer = Buffer.alloc(0);
  }
}

/**
 * Melakukan query Server List Ping (SLP) ke Minecraft server
 * @param {Object} [options={}]
 * @param {string} [options.host='atoms-girl.tun.ply.gg'] - Hostname / IP target
 * @param {number} [options.port=25565] - Port server Minecraft
 * @param {number} [options.timeoutMs=5000] - Batas waktu timeout dalam milidetik
 * @param {number} [options.protocolVersion=775] - Versi protokol SLP
 * @returns {Promise<{
 *   version: { name: string, protocol: number },
 *   players: { max: number, online: number, sample: Array<{ id: string, name: string }> },
 *   description: any,
 *   favicon?: string,
 *   latencyMs: number,
 *   rawStatus: object
 * }>}
 */
function querySLP({ host = 'atoms-girl.tun.ply.gg', port = 25565, timeoutMs = 5000, protocolVersion = 775 } = {}) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const socket = net.createConnection({ host, port, timeout: timeoutMs });
    socket.setNoDelay(true);

    const framer = new PacketFramer();
    let isSettled = false;
    let statusResult = null;
    let pingSentTime = 0;
    const pingPayload = BigInt(Date.now());

    const cleanup = () => {
      if (!socket.destroyed) {
        socket.destroy();
      }
    };

    socket.once('connect', () => {
      // 1. Handshake Packet (State = 1 / STATUS)
      const protoBuf = writeVarInt(protocolVersion);
      const hostBuf = writeString(host);
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(port, 0);
      const nextStateBuf = writeVarInt(1);

      const handshakePayload = Buffer.concat([writeVarInt(0x00), protoBuf, hostBuf, portBuf, nextStateBuf]);
      const handshakePacket = Buffer.concat([writeVarInt(handshakePayload.length), handshakePayload]);
      socket.write(handshakePacket);

      // 2. Status Request Packet (ID 0x00)
      const statusReqPayload = writeVarInt(0x00);
      const statusReqPacket = Buffer.concat([writeVarInt(statusReqPayload.length), statusReqPayload]);
      socket.write(statusReqPacket);
    });

    socket.on('data', (chunk) => {
      framer.append(chunk);

      while (true) {
        const frame = framer.readNextFrame();
        if (!frame) break;

        const idRes = readVarInt(frame, 0);
        if (!idRes) continue;

        const packetId = idRes.value;

        if (packetId === 0x00 && !statusResult) {
          // Status Response: [JSON String]
          const jsonStrRes = readString(frame, idRes.size);
          if (jsonStrRes) {
            try {
              const parsed = JSON.parse(jsonStrRes.value);
              const initialLatency = Date.now() - startTime;

              statusResult = {
                version: parsed.version || { name: 'Unknown', protocol: protocolVersion },
                players: {
                  max: parsed.players?.max ?? 0,
                  online: parsed.players?.online ?? 0,
                  sample: parsed.players?.sample || []
                },
                description: parsed.description,
                favicon: parsed.favicon,
                latencyMs: initialLatency,
                rawStatus: parsed
              };

              // Kirim Ping Packet (ID 0x01) untuk pengukuran RTT akurat
              pingSentTime = Date.now();
              const pingBody = Buffer.alloc(writeVarInt(0x01).length + 8);
              const pidBuf = writeVarInt(0x01);
              pidBuf.copy(pingBody, 0);
              pingBody.writeBigInt64BE(pingPayload, pidBuf.length);

              const pingPacket = Buffer.concat([writeVarInt(pingBody.length), pingBody]);
              socket.write(pingPacket);
            } catch (err) {
              if (!isSettled) {
                isSettled = true;
                cleanup();
                reject(new Error(`[SLP] Gagal mem-parsing respons JSON status: ${err.message}`));
              }
              return;
            }
          }
        } else if (packetId === 0x01 && statusResult) {
          // Pong Response: [8 bytes payload]
          const pingRtt = Date.now() - pingSentTime;
          statusResult.latencyMs = pingRtt > 0 ? pingRtt : statusResult.latencyMs;

          if (!isSettled) {
            isSettled = true;
            cleanup();
            resolve(statusResult);
          }
          return;
        }
      }
    });

    socket.on('close', () => {
      if (!isSettled) {
        isSettled = true;
        if (statusResult) {
          resolve(statusResult);
        } else {
          reject(new Error(`[SLP] Koneksi terputus dari ${host}:${port} sebelum respons status diterima`));
        }
      }
    });

    socket.on('error', (err) => {
      if (!isSettled) {
        isSettled = true;
        cleanup();
        reject(new Error(`[SLP] Kesalahan koneksi ke ${host}:${port}: ${err.message}`));
      }
    });

    socket.on('timeout', () => {
      if (!isSettled) {
        isSettled = true;
        cleanup();
        reject(new Error(`[SLP] Batas waktu permintaan SLP ke ${host}:${port} habis (${timeoutMs}ms)`));
      }
    });
  });
}

/**
 * Melakukan verifikasi apakah bot dengan username tertentu sedang online di server.
 * @param {Object} options
 * @param {string} [options.host='atoms-girl.tun.ply.gg']
 * @param {number} [options.port=25565]
 * @param {string} [options.botUsername]
 * @param {number} [options.timeoutMs=5000]
 * @param {number} [options.protocolVersion=775]
 * @returns {Promise<{
 *   isOnline: boolean,
 *   playerCount: number,
 *   inSample: boolean,
 *   sample: Array<{ id: string, name: string }>,
 *   latencyMs: number,
 *   rawStatus: object
 * }>}
 */
async function verifyBotOnline({ host = 'atoms-girl.tun.ply.gg', port = 25565, botUsername, timeoutMs = 5000, protocolVersion = 775 } = {}) {
  const status = await querySLP({ host, port, timeoutMs, protocolVersion });
  const playerCount = status.players.online;
  const sample = status.players.sample || [];
  const inSample = botUsername ? sample.some(p => p.name === botUsername) : false;

  return {
    isOnline: playerCount >= 1,
    playerCount,
    inSample,
    sample,
    latencyMs: status.latencyMs,
    rawStatus: status.rawStatus
  };
}

module.exports = {
  querySLP,
  verifyBotOnline,
  PacketFramer,
  writeVarInt,
  readVarInt,
  writeString,
  readString
};
```

---

### Blueprint CLI Runner `test/verify_slp.js`

```javascript
#!/usr/bin/env node
/**
 * @file verify_slp.js
 * @description Alat Baris Perintah (CLI) dan runner pengujian mandiri untuk verifikasi Server List Ping (SLP).
 *
 * Penggunaan:
 *   node test/verify_slp.js [--host <host>] [--port <port>] [--bot <username>] [--timeout <ms>] [--json]
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

const { querySLP, verifyBotOnline } = require('../src/network/slpVerifier.js');

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    host: 'atoms-girl.tun.ply.gg',
    port: 25565,
    botUsername: null,
    timeoutMs: 5000,
    json: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--host' && args[i + 1]) options.host = args[++i];
    else if (arg === '--port' && args[i + 1]) options.port = parseInt(args[++i], 10);
    else if (arg === '--bot' && args[i + 1]) options.botUsername = args[++i];
    else if (arg === '--timeout' && args[i + 1]) options.timeoutMs = parseInt(args[++i], 10);
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(`
Penggunaan: node test/verify_slp.js [OPSI]

Opsi:
  --host <string>      Hostname server target (default: atoms-girl.tun.ply.gg)
  --port <number>      Port server target (default: 25565)
  --bot <string>       Nama bot yang ingin diverifikasi keberadaannya
  --timeout <number>   Batas waktu timeout dalam ms (default: 5000)
  --json               Keluarkan hasil hanya dalam format JSON murni
  -h, --help           Tampilkan petunjuk penggunaan ini
      `);
      process.exit(0);
    }
  }

  return options;
}

async function main() {
  const opts = parseArgs();

  try {
    if (opts.botUsername) {
      const result = await verifyBotOnline(opts);
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log('====================================================');
        console.log('       HASIL VERIFIKASI PEMAIN AKTIF (SLP)          ');
        console.log('====================================================');
        console.log(`📡 Server Target  : ${opts.host}:${opts.port}`);
        console.log(`⚡ Latensi (RTT)  : ${result.latencyMs} ms`);
        console.log(`👥 Pemain Online  : ${result.playerCount}`);
        console.log(`🤖 Bot Dicari     : ${opts.botUsername}`);
        console.log(`🔍 Ditemukan Sample: ${result.inSample ? '✅ YA' : '❌ TIDAK'}`);
        console.log(`📋 Daftar Sample  : ${JSON.stringify(result.sample)}`);
        console.log('====================================================');
      }

      if (!result.isOnline) {
        console.error(`❌ [Gagal] Server tidak memiliki pemain aktif (online = 0).`);
        process.exit(1);
      }
    } else {
      const status = await querySLP(opts);
      if (opts.json) {
        console.log(JSON.stringify(status, null, 2));
      } else {
        console.log('====================================================');
        console.log('           STATUS SERVER LIST PING (SLP)            ');
        console.log('====================================================');
        console.log(`📡 Host Server    : ${opts.host}:${opts.port}`);
        console.log(`🏷️  Nama Versi     : ${status.version.name} (Protokol ${status.version.protocol})`);
        console.log(`👥 Jumlah Pemain  : ${status.players.online} / ${status.players.max}`);
        console.log(`⚡ Latensi (RTT)  : ${status.latencyMs} ms`);
        console.log(`📝 Deskripsi MOTD : ${typeof status.description === 'string' ? status.description : JSON.stringify(status.description)}`);
        if (status.players.sample && status.players.sample.length > 0) {
          console.log(`📋 Sample Pemain  : ${status.players.sample.map(p => `${p.name} (${p.id})`).join(', ')}`);
        }
        console.log('====================================================');
      }
    }

    process.exit(0);
  } catch (err) {
    if (opts.json) {
      console.log(JSON.stringify({ error: err.message, success: false }));
    } else {
      console.error(`💥 [Error] ${err.message}`);
    }
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
```

---

## 6. Kesimpulan & Rekomendasi untuk Worker M2

1. **Implementasi Mandiri**: File `src/network/slpVerifier.js` dan `test/verify_slp.js` harus mandiri dan zero-dependency, mengekspor `querySLP`, `verifyBotOnline`, `PacketFramer`, serta codec `writeVarInt`, `readVarInt`, `writeString`, `readString`.
2. **Pengujian Unit & Integrasi**:
   - Uji unit menguji codec VarInt, string UTF-8, framer fragmentasi TCP, mock server response.
   - Uji live integrasi menguji koneksi langsung ke `atoms-girl.tun.ply.gg:25565`.
3. **Pemberitahuan Tim**: Laporan ini lengkap dan siap dioper ke Sub-Orchestrator M2 dan Worker M2 untuk implementasi kode.
