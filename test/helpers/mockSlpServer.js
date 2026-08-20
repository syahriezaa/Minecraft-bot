/**
 * @file mockSlpServer.js
 * @description Mock Server TCP Minecraft Server List Ping (SLP) Deterministik untuk Pengujian Unit & Integrasi.
 * Mengemulasikan protokol SLP Minecraft (Handshake 0x00 State 1, Status Request 0x00, Status Response 0x00,
 * Ping/Pong 0x01) dengan dukungan injeksi perilaku jaringan (delay, malformed JSON, drop socket, fragmentasi TCP).
 *
 * Aturan Tim: Semua komentar kode, error message, dan teks UI ditulis dalam Bahasa Indonesia.
 */

const net = require('node:net');
const EventEmitter = require('node:events');

/**
 * Mode Perilaku Mock Server untuk Pengujian Edge Cases
 */
const MOCK_BEHAVIORS = Object.freeze({
  NORMAL: 'NORMAL',
  DELAYED: 'DELAYED',
  HANG: 'HANG',
  DROP_ON_CONNECT: 'DROP_ON_CONNECT',
  DROP_ON_HANDSHAKE: 'DROP_ON_HANDSHAKE',
  DROP_ON_STATUS_REQUEST: 'DROP_ON_STATUS_REQUEST',
  DROP_AFTER_STATUS: 'DROP_AFTER_STATUS',
  MALFORMED_JSON: 'MALFORMED_JSON',
  TCP_FRAGMENTED: 'TCP_FRAGMENTED'
});

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
  if ((b & 0x80) !== 0) return null;
  return { value, size };
}

/**
 * Menulis string UTF-8 diawali VarInt panjang.
 * @param {string} str
 * @returns {Buffer}
 */
function writeString(str) {
  const strBuf = Buffer.from(str, 'utf8');
  const lenBuf = writeVarInt(strBuf.length);
  return Buffer.concat([lenBuf, strBuf]);
}

class MockSlpServer extends EventEmitter {
  /**
   * @param {Object} [options={}]
   * @param {number} [options.port=0]
   * @param {Object} [options.status]
   * @param {string} [options.behavior='NORMAL']
   * @param {number} [options.delayMs=0]
   */
  constructor(options = {}) {
    super();
    this.port = options.port || 0;
    this.behavior = options.behavior || MOCK_BEHAVIORS.NORMAL;
    this.delayMs = options.delayMs || 0;

    // Status respons bawaan
    this.statusPayload = {
      version: {
        name: 'NeoForge 26.1.2 (Mock)',
        protocol: 775
      },
      players: {
        max: 20,
        online: 1,
        sample: [
          { name: 'Bot_AI_Companion', id: 'e9a03c3b-58bb-3746-81c8-dbfa74b1e5a1' }
        ]
      },
      description: { text: 'Server Minecraft Uji Deterministik' },
      favicon: null,
      ...options.status
    };

    this.server = null;
    this.sockets = new Set();
    this.queryHistory = [];
  }

  /**
   * Memulai server TCP mock pada host 127.0.0.1.
   * @param {number} [port=this.port]
   * @returns {Promise<number>} Mengembalikan nomor port yang dialokasikan OS.
   */
  start(port = this.port) {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.sockets.add(socket);
        let buffer = Buffer.alloc(0);
        let state = 'HANDSHAKING';

        if (this.behavior === MOCK_BEHAVIORS.DROP_ON_CONNECT) {
          socket.destroy();
          return;
        }

        socket.on('data', async (chunk) => {
          buffer = Buffer.concat([buffer, chunk]);

          while (true) {
            if (buffer.length === 0) break;
            const lenRes = readVarInt(buffer, 0);
            if (!lenRes) break;

            const packetLen = lenRes.value;
            const totalFrameSize = lenRes.size + packetLen;
            if (buffer.length < totalFrameSize) break;

            const frame = buffer.subarray(lenRes.size, totalFrameSize);
            buffer = buffer.subarray(totalFrameSize);

            const idRes = readVarInt(frame, 0);
            if (!idRes) continue;

            const packetId = idRes.value;
            const payload = frame.subarray(idRes.size);

            if (state === 'HANDSHAKING' && packetId === 0x00) {
              // Parse Handshake Packet
              const protoRes = readVarInt(payload, 0);
              let offset = protoRes ? protoRes.size : 0;
              const hostLen = readVarInt(payload, offset);
              let hostStr = '';
              if (hostLen) {
                offset += hostLen.size;
                hostStr = payload.toString('utf8', offset, offset + hostLen.value);
                offset += hostLen.value;
              }
              const clientPort = payload.length >= offset + 2 ? payload.readUInt16BE(offset) : 0;
              offset += 2;
              const nextStateRes = readVarInt(payload, offset);
              const nextState = nextStateRes ? nextStateRes.value : 1;

              this.queryHistory.push({
                timestamp: Date.now(),
                protocolVersion: protoRes ? protoRes.value : 0,
                host: hostStr,
                port: clientPort,
                nextState
              });

              if (this.behavior === MOCK_BEHAVIORS.DROP_ON_HANDSHAKE) {
                socket.destroy();
                return;
              }

              state = nextState === 1 ? 'STATUS' : 'OTHER';
            } else if (state === 'STATUS' && packetId === 0x00) {
              // Status Request Packet
              if (this.behavior === MOCK_BEHAVIORS.DROP_ON_STATUS_REQUEST) {
                socket.destroy();
                return;
              }

              if (this.behavior === MOCK_BEHAVIORS.HANG) {
                // Diam tanpa mengirim respon apa pun
                return;
              }

              if (this.delayMs > 0) {
                await new Promise((r) => setTimeout(r, this.delayMs));
              }

              let jsonString = '';
              if (this.behavior === MOCK_BEHAVIORS.MALFORMED_JSON) {
                jsonString = '{"version": {"name": "Broken", "protocol": 775}, "players": INVALID_JSON_PAYLOAD}';
              } else {
                jsonString = JSON.stringify(this.statusPayload);
              }

              const jsonBuf = writeString(jsonString);
              const respPacketPayload = Buffer.concat([writeVarInt(0x00), jsonBuf]);
              const fullResponse = Buffer.concat([writeVarInt(respPacketPayload.length), respPacketPayload]);

              if (this.behavior === MOCK_BEHAVIORS.TCP_FRAGMENTED) {
                // Kirim byte demi byte untuk menguji akumulasi PacketFramer
                for (let i = 0; i < fullResponse.length; i++) {
                  if (socket.destroyed) break;
                  socket.write(fullResponse.subarray(i, i + 1));
                  await new Promise((r) => setTimeout(r, 2));
                }
              } else {
                socket.write(fullResponse);
              }

              if (this.behavior === MOCK_BEHAVIORS.DROP_AFTER_STATUS) {
                // Segera tutup socket setelah mengirim status response
                socket.end();
                return;
              }
            } else if (state === 'STATUS' && packetId === 0x01) {
              // Ping Packet (Echo kembali 8-byte payload)
              const pongPayload = Buffer.concat([writeVarInt(0x01), payload]);
              const pongFrame = Buffer.concat([writeVarInt(pongPayload.length), pongPayload]);
              socket.write(pongFrame);
            }
          }
        });

        socket.on('close', () => {
          this.sockets.delete(socket);
        });

        socket.on('error', () => {
          this.sockets.delete(socket);
        });
      });

      this.server.listen(port, '127.0.0.1', () => {
        const addr = this.server.address();
        this.port = typeof addr === 'object' && addr !== null ? addr.port : port;
        this.emit('listening', this.port);
        resolve(this.port);
      });

      this.server.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * Menghentikan server dan menutup semua koneksi soket aktif.
   * @returns {Promise<void>}
   */
  stop() {
    return new Promise((resolve) => {
      for (const socket of this.sockets) {
        socket.destroy();
      }
      this.sockets.clear();

      if (this.server) {
        this.server.close(() => {
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Alias untuk stop().
   * @returns {Promise<void>}
   */
  close() {
    return this.stop();
  }

  /**
   * Memperbarui payload status respons.
   * @param {Object} partialStatus
   */
  setStatus(partialStatus) {
    this.statusPayload = {
      ...this.statusPayload,
      ...partialStatus
    };
  }

  /**
   * Mengatur data pemain online, maksimal, dan daftar sampel secara cepat.
   * @param {number} online
   * @param {number} [max=20]
   * @param {Array<{ name: string, id: string }>} [sample=[]]
   */
  setPlayers(online, max = 20, sample = []) {
    this.statusPayload.players = { online, max, sample };
  }

  /**
   * Mengubah mode perilaku simulasi mock server.
   * @param {string} behavior
   * @param {Object} [options={}]
   */
  setBehavior(behavior, options = {}) {
    this.behavior = behavior;
    if (options.delayMs !== undefined) {
      this.delayMs = options.delayMs;
    }
  }

  /**
   * Mengambil riwayat kueri yang diterima server.
   * @returns {Array<Object>}
   */
  getQueryHistory() {
    return [...this.queryHistory];
  }

  /**
   * Membersihkan riwayat kueri.
   */
  clearHistory() {
    this.queryHistory = [];
  }
}

module.exports = {
  MockSlpServer,
  MOCK_BEHAVIORS,
  writeVarInt,
  readVarInt,
  writeString
};
