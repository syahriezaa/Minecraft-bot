/**
 * @file slpVerifier.js
 * @description Mesin Verifikasi Server List Ping (SLP) Mandiri & Programatik untuk Minecraft 1.21.x / Protokol 775 (NeoForge 26.1.2).
 * Menggunakan streaming TCP murni (node:net) tanpa dependensi eksternal,
 * mendukung akumulasi buffer, fragmentasi paket biner, pengukuran latensi round-trip (RTT),
 * serta ekstraksi teks MOTD chat component.
 *
 * Aturan Tim: Semua komentar kode, error message, dan teks UI ditulis dalam Bahasa Indonesia.
 */

const net = require('node:net');

/**
 * Menulis integer 32-bit ke format VarInt Minecraft (LEB128).
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
 * Mengembalikan null jika buffer terpotong atau VarInt belum lengkap.
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
  return null;
}

/**
 * Menulis string UTF-8 diawali dengan VarInt panjang karakter.
 * @param {string} str
 * @returns {Buffer}
 */
function writeString(str) {
  const strBuf = Buffer.from(str, 'utf8');
  const lenBuf = writeVarInt(strBuf.length);
  return Buffer.concat([lenBuf, strBuf]);
}

/**
 * Membaca string UTF-8 dari buffer yang diawali VarInt panjang.
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
 * Mengekstrak teks polos dari objek Chat Component atau string MOTD Minecraft.
 * @param {any} description
 * @returns {string}
 */
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

/**
 * @class PacketFramer
 * @description Mengakumulasi aliran data TCP dan mengekstrak frame paket Minecraft secara presisi.
 */
class PacketFramer {
  constructor() {
    this._buffer = Buffer.alloc(0);
  }

  /**
   * Menambahkan potongan data chunk TCP ke dalam akumulator.
   * @param {Buffer} chunk
   */
  append(chunk) {
    if (!chunk || chunk.length === 0) return;
    this._buffer = Buffer.concat([this._buffer, chunk]);
  }

  /**
   * Mengekstrak paket utuh berikutnya jika sudah terakumulasi lengkap.
   * @returns {Buffer | null} Frame paket tanpa header panjang VarInt.
   */
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

  /**
   * Mengosongkan akumulator buffer.
   */
  clear() {
    this._buffer = Buffer.alloc(0);
  }

  /**
   * Panjang byte yang sedang berada dalam buffer.
   */
  get length() {
    return this._buffer.length;
  }
}

/**
 * Melakukan query Server List Ping (SLP) ke server Minecraft.
 * @param {Object} [options={}]
 * @param {string} [options.host='atoms-girl.tun.ply.gg'] - Hostname / IP target
 * @param {number} [options.port=25565] - Port server Minecraft
 * @param {number} [options.timeoutMs=5000] - Batas waktu timeout dalam milidetik
 * @param {number} [options.protocolVersion=775] - Versi protokol SLP (default: 775 untuk NeoForge 26.1.2)
 * @returns {Promise<{
 *   version: { name: string, protocol: number },
 *   players: { max: number, online: number, sample: Array<{ id: string, name: string }> },
 *   description: any,
 *   descriptionText: string,
 *   favicon?: string,
 *   latencyMs: number,
 *   rawStatus: object
 * }>}
 */
function querySLP({
  host = 'atoms-girl.tun.ply.gg',
  port = 25565,
  timeoutMs = 5000,
  protocolVersion = 775
} = {}) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const framer = new PacketFramer();
    let isSettled = false;
    let statusResult = null;
    let pingSentTime = 0;
    const pingPayload = BigInt(Date.now());

    const socket = net.createConnection({ host, port, timeout: timeoutMs });
    socket.setNoDelay(true);

    const cleanup = () => {
      if (!socket.destroyed) {
        socket.destroy();
      }
    };

    socket.once('connect', () => {
      // 1. Handshake Packet (ID 0x00, NextState = 1 / STATUS)
      const protoBuf = writeVarInt(protocolVersion);
      const hostBuf = writeString(host);
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(port, 0);
      const nextStateBuf = writeVarInt(1);

      const handshakePayload = Buffer.concat([writeVarInt(0x00), protoBuf, hostBuf, portBuf, nextStateBuf]);
      const handshakePacket = Buffer.concat([writeVarInt(handshakePayload.length), handshakePayload]);
      socket.write(handshakePacket);

      // 2. Status Request Packet (ID 0x00, Panjang payload = 0)
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
          // Status Response: [JSON String UTF-8]
          const jsonStrRes = readString(frame, idRes.size);
          if (jsonStrRes) {
            try {
              const parsed = JSON.parse(jsonStrRes.value);
              const initialLatency = Date.now() - startTime;
              const plainDesc = extractPlainText(parsed.description);

              statusResult = {
                version: parsed.version || { name: 'Unknown', protocol: protocolVersion },
                players: {
                  max: parsed.players?.max ?? 0,
                  online: parsed.players?.online ?? 0,
                  sample: Array.isArray(parsed.players?.sample) ? parsed.players.sample : []
                },
                description: parsed.description,
                descriptionText: plainDesc,
                favicon: parsed.favicon,
                latencyMs: initialLatency,
                rawStatus: parsed
              };

              // Kirim Ping Packet (ID 0x01) untuk pengukuran RTT presisi
              pingSentTime = Date.now();
              const pidBuf = writeVarInt(0x01);
              const pingBody = Buffer.alloc(pidBuf.length + 8);
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
          statusResult.latencyMs = pingRtt >= 0 ? pingRtt : statusResult.latencyMs;

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
 * @param {Object} [options={}]
 * @param {string} [options.host='atoms-girl.tun.ply.gg']
 * @param {number} [options.port=25565]
 * @param {string} [options.botUsername]
 * @param {number} [options.timeoutMs=5000]
 * @param {number} [options.protocolVersion=775]
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
async function verifyBotOnline({
  host = 'atoms-girl.tun.ply.gg',
  port = 25565,
  botUsername,
  timeoutMs = 5000,
  protocolVersion = 775
} = {}) {
  const status = await querySLP({ host, port, timeoutMs, protocolVersion });
  const playerCount = status.players.online;
  const maxPlayers = status.players.max;
  const rawSample = status.rawStatus?.players?.sample;
  const sampleOmitted = !Array.isArray(rawSample) || (playerCount > 0 && rawSample.length === 0);
  const sample = status.players.sample || [];

  let inSample = false;
  if (botUsername && sample.length > 0) {
    inSample = sample.some(
      (p) => p && p.name && p.name.trim().toLowerCase() === botUsername.trim().toLowerCase()
    );
  }

  // Jika botUsername dicari: dianggap online jika ditemukan dalam sampel atau jika sampel ditiadakan namun playerCount >= 1
  let isOnline = false;
  if (botUsername) {
    isOnline = inSample || (sampleOmitted && playerCount >= 1);
  } else {
    isOnline = playerCount >= 1;
  }

  return {
    isOnline,
    playerCount,
    maxPlayers,
    inSample,
    sampleOmitted,
    sample,
    version: status.version,
    descriptionText: status.descriptionText,
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
  readString,
  extractPlainText
};
