/**
 * @file liveProtocolClient.js
 * @description Implementasi Klien Jaringan Protokol 775 Mandiri & Headless untuk Minecraft 26.1.2 / NeoForge.
 * Mendukung streaming TCP murni, packet framing, buffer accumulation, kompresi Zlib,
 * transisi siklus hidup 4-state (Handshaking -> Login -> Configuration -> Play),
 * bitflags MovementFlags, respons keepalive instan, konfirmasi teleportasi & muat pemain,
 * pengakuan chunk batch, kueri Server List Ping (SLP), serta pemulihan koneksi otomatis.
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

const net = require('node:net');
const EventEmitter = require('node:events');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { decodeChunkDataPacket } = require('./chunkDecoder.js');
const {
  decodeSpawnEntity,
  decodeEntityDestroy,
  resolveEntityTypeName,
  isHostileEntityName
} = require('./entityDecoder.js');

// ==============================================================================
// 1. Konstanta Protokol & Status Siklus Hidup
// ==============================================================================

/**
 * Status Siklus Hidup Jaringan Protokol 775 (NeoForge 26.1.2)
 */
const PROTOCOL_STATES = Object.freeze({
  HANDSHAKING: 'handshaking',
  STATUS: 'status',
  LOGIN: 'login',
  CONFIGURATION: 'configuration',
  PLAY: 'play'
});

/**
 * Status Koneksi Socket Internal Klien
 */
const CONNECTION_STATES = Object.freeze({
  DISCONNECTED: 'DISCONNECTED',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  RECONNECTING: 'RECONNECTING'
});

/**
 * Konfigurasi Baku Klien Jaringan
 */
const DEFAULT_CLIENT_CONFIG = Object.freeze({
  host: 'atoms-girl.tun.ply.gg',
  port: 25565,
  username: 'Bot_AI_Companion',
  protocolVersion: 775,
  minecraftVersion: '26.1.2',
  authMode: 'offline',
  autoReconnect: true,
  maxReconnectAttempts: 10,
  reconnectBaseDelayMs: 1000,
  reconnectMaxDelayMs: 30000,
  backoffMultiplier: 1.8,
  socketTimeoutMs: 30000,
  keepAliveResponseThresholdMs: 25000,
  movementHeartbeatEnabled: true,
  movementHeartbeatIntervalMs: 1000,
  movementCorrectionPauseMs: 750,
  autoConfirmTeleport: true,
  autoSendPlayerLoaded: true,
  autoRespawn: true,
  respawnDelayMs: 250,
  worldMinY: -64,
  // Radius chunk yang DIMINTA klien (1-32, dikirim lewat Client Information). Server berhak
  // membatasi ke nilai lebih kecil dari config server-nya sendiri - nilai ini cuma permintaan,
  // bukan jaminan. Lihat catatan di _sendClientInformation.
  viewDistance: 10
});

const DEFAULT_PACKET_IDS = Object.freeze({
  configuration: Object.freeze({
    toServer: Object.freeze({
      settings: 0x00,
      finishConfiguration: 0x03,
      keepAlive: 0x04,
      pong: 0x05,
      selectKnownPacks: 0x07
    })
  }),
  play: Object.freeze({
    toClient: Object.freeze({
      keepAlive: 0x2c,
      updateHealth: 0x68
    }),
    toServer: Object.freeze({
      teleportConfirm: 0x00,
      chatMessage: 0x09,
      clientCommand: 0x0c,
      settings: 0x0e,
      useEntity: 0x1a,
      keepAlive: 0x1c,
      position: 0x1e,
      positionLook: 0x1f,
      flying: 0x21,
      playerLoaded: 0x2c
    })
  })
});

// ==============================================================================
// 2. Utilitas Encoding & Decoding VarInt / VarLong / String / UUID / MovementFlags
// ==============================================================================

/**
 * Menulis integer 32-bit bertanda/tak bertanda ke dalam format VarInt Minecraft.
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
 * Membaca nilai VarInt dari buffer pada offset tertentu.
 * @param {Buffer} buf
 * @param {number} [offset=0]
 * @returns {{ value: number, size: number } | null} Mengembalikan nilai dan ukuran byte, atau null jika buffer belum lengkap.
 */
function readVarInt(buf, offset = 0) {
  if (!buf || offset >= buf.length) {
    return null;
  }

  let value = 0;
  let size = 0;

  while (offset + size < buf.length && size < 5) {
    const b = buf[offset + size];
    value |= (b & 0x7F) << (7 * size);
    size++;
    if ((b & 0x80) === 0) {
      return { value, size };
    }
  }

  return null;
}

/**
 * Menulis BigInt 64-bit ke dalam format VarLong Minecraft.
 * @param {bigint|number} value
 * @returns {Buffer}
 */
function writeVarLong(value) {
  let val = BigInt.asUintN(64, BigInt(value));
  const bytes = [];
  while (true) {
    if ((val & ~0x7Fn) === 0n) {
      bytes.push(Number(val));
      break;
    } else {
      bytes.push(Number((val & 0x7Fn) | 0x80n));
      val >>= 7n;
    }
  }
  return Buffer.from(bytes);
}

/**
 * Membaca nilai VarLong dari buffer.
 * @param {Buffer} buf
 * @param {number} [offset=0]
 * @returns {{ value: bigint, size: number } | null}
 */
function readVarLong(buf, offset = 0) {
  if (!buf || offset >= buf.length) {
    return null;
  }

  let value = 0n;
  let size = 0;

  while (offset + size < buf.length && size < 10) {
    const b = buf[offset + size];
    value |= BigInt(b & 0x7F) << BigInt(7 * size);
    size++;
    if ((b & 0x80) === 0) {
      return { value: BigInt.asIntN(64, value), size };
    }
  }

  return null;
}

/**
 * Menulis string UTF-8 yang diawali dengan VarInt panjang karakter.
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
  if (!buf || offset >= buf.length) {
    return null;
  }

  const lenResult = readVarInt(buf, offset);
  if (!lenResult || lenResult.value < 0) return null;

  const start = offset + lenResult.size;
  const end = start + lenResult.value;
  if (buf.length < end) return null;

  const value = buf.toString('utf8', start, end);
  return { value, size: lenResult.size + lenResult.value };
}

/**
 * Menghasilkan UUID offline v3 deterministik berbasis username pemain.
 * @param {string} username
 * @returns {string} UUID string dalam format 8-4-4-4-12
 */
function generateOfflineUuid(username) {
  const hash = crypto.createHash('md5').update('OfflinePlayer:' + username).digest();
  // Set version ke 3 (UUID berbasis MD5)
  hash[6] = (hash[6] & 0x0f) | 0x30;
  // Set variant ke RFC 4122
  hash[8] = (hash[8] & 0x3f) | 0x80;

  const hex = hash.toString('hex');
  return `${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20, 32)}`;
}

/**
 * Mengubah string UUID menjadi Buffer 16-byte.
 * @param {string} uuidStr
 * @returns {Buffer}
 */
function uuidToBuffer(uuidStr) {
  const cleanHex = uuidStr.replace(/-/g, '');
  return Buffer.from(cleanHex, 'hex');
}

/**
 * Mengubah bitflags pergerakan pemain (MovementFlags) Protokol 775 ke dalam 1 byte integer.
 * Bit 0: onGround (0x01)
 * Bit 1: hasHorizontalCollision (0x02)
 * @param {{ onGround?: boolean, hasHorizontalCollision?: boolean }} flags
 * @returns {number}
 */
function encodeMovementFlags({ onGround = false, hasHorizontalCollision = false } = {}) {
  let byte = 0;
  if (onGround) byte |= 0x01;
  if (hasHorizontalCollision) byte |= 0x02;
  return byte;
}

/**
 * Mendekode 1 byte integer menjadi objek MovementFlags Protokol 775.
 * @param {number} byte
 * @returns {{ onGround: boolean, hasHorizontalCollision: boolean }}
 */
function decodeMovementFlags(byte) {
  return {
    onGround: (byte & 0x01) !== 0,
    hasHorizontalCollision: (byte & 0x02) !== 0
  };
}

// ==============================================================================
// 3. Packet Framer & Buffer Accumulator (TCP Stream Reassembly)
// ==============================================================================

/**
 * @class PacketFramer
 * @description Mengakumulasi byte stream dari TCP socket, menangani packet fragmentation
 * (pecahan paket antar frame TCP) dan coalescing (beberapa paket dalam 1 frame TCP),
 * serta mengembalikan frame paket individual secara presisi.
 */
class PacketFramer {
  constructor() {
    this._buffer = Buffer.alloc(0);
  }

  /**
   * Menambahkan bongkahan data TCP mentah ke akumulator.
   * @param {Buffer} chunk
   */
  append(chunk) {
    if (!chunk || chunk.length === 0) return;
    this._buffer = Buffer.concat([this._buffer, chunk]);
  }

  /**
   * Mengambil paket lengkap berikutnya dari buffer jika tersedia.
   * @returns {Buffer|null} Buffer payload paket (termasuk Packet ID & data), atau null jika belum lengkap.
   */
  readNextFrame() {
    if (this._buffer.length === 0) return null;

    // Baca VarInt panjang paket
    const lenResult = readVarInt(this._buffer, 0);
    if (!lenResult) {
      // VarInt panjang belum lengkap
      return null;
    }

    const { value: packetLength, size: varIntSize } = lenResult;
    const totalFrameSize = varIntSize + packetLength;

    if (this._buffer.length < totalFrameSize) {
      // Seluruh isi paket belum tiba di buffer
      return null;
    }

    // Ekstrak payload frame paket
    const packetFrame = this._buffer.subarray(varIntSize, totalFrameSize);
    // Pangkas buffer akumulator
    this._buffer = this._buffer.subarray(totalFrameSize);

    return packetFrame;
  }

  /**
   * Membersihkan seluruh isi buffer akumulator.
   */
  clear() {
    this._buffer = Buffer.alloc(0);
  }

  /**
   * Mendapatkan ukuran buffer akumulator saat ini dalam byte.
   * @returns {number}
   */
  get size() {
    return this._buffer.length;
  }
}

// ==============================================================================
// 4. Compression Handler (Zlib Deflate / Inflate)
// ==============================================================================

/**
 * @class CompressionHandler
 * @description Menangani pembungkusan kompresi paket Minecraft (Zlib) berdasarkan
 * ambang batas (threshold) yang dikonfigurasi oleh server melalui paket 0x03 Set Compression.
 */
class CompressionHandler {
  constructor() {
    /** @type {number} -1 jika kompresi non-aktif, >= 0 jika aktif */
    this.threshold = -1;
  }

  /**
   * Mengatur ambang batas kompresi.
   * @param {number} threshold
   */
  setThreshold(threshold) {
    this.threshold = threshold;
  }

  /**
   * Membungkus buffer payload paket menjadi format wire (dengan atau tanpa kompresi).
   * @param {Buffer} uncompressedPayload Buffer yang berisi [Packet ID + Fields]
   * @returns {Buffer} Frame data lengkap siap kirim ke TCP Socket
   */
  compress(uncompressedPayload) {
    if (this.threshold < 0) {
      // Kompresi non-aktif: [Packet Length (VarInt)] + [Uncompressed Payload]
      const lengthVarInt = writeVarInt(uncompressedPayload.length);
      return Buffer.concat([lengthVarInt, uncompressedPayload]);
    }

    if (uncompressedPayload.length < this.threshold) {
      // Ukuran di bawah ambang batas: DataLength = 0 (tidak di-deflate)
      // Format: [Packet Length (VarInt)] + [Data Length = 0 (VarInt)] + [Uncompressed Payload]
      const dataLengthVarInt = writeVarInt(0);
      const body = Buffer.concat([dataLengthVarInt, uncompressedPayload]);
      const packetLengthVarInt = writeVarInt(body.length);
      return Buffer.concat([packetLengthVarInt, body]);
    }

    // Ukuran mencapai/melebihi ambang batas: Deflate payload
    const deflatedPayload = zlib.deflateSync(uncompressedPayload);
    const dataLengthVarInt = writeVarInt(uncompressedPayload.length);
    const body = Buffer.concat([dataLengthVarInt, deflatedPayload]);
    const packetLengthVarInt = writeVarInt(body.length);
    return Buffer.concat([packetLengthVarInt, body]);
  }

  /**
   * Membuka kompresi dari frame paket yang diekstrak oleh PacketFramer.
   * @param {Buffer} packetFrame Buffer yang diterima dari PacketFramer
   * @returns {Buffer} Buffer uncompressed berisi [Packet ID + Fields]
   */
  decompress(packetFrame) {
    if (this.threshold < 0) {
      // Kompresi non-aktif: seluruh frame adalah uncompressed payload
      return packetFrame;
    }

    // Baca Data Length VarInt
    const dataLenResult = readVarInt(packetFrame, 0);
    if (!dataLenResult) {
      throw new Error('[Kompresi] Gagal membaca VarInt Data Length pada frame kompresi');
    }

    const { value: dataLength, size: varIntSize } = dataLenResult;
    const remainingData = packetFrame.subarray(varIntSize);

    if (dataLength === 0) {
      // Data tidak dikompresi
      return remainingData;
    }

    // Data dikompresi: Lakukan inflate sinkron
    const inflated = zlib.inflateSync(remainingData);
    if (inflated.length !== dataLength) {
      throw new Error(`[Kompresi] Ukuran dekompresi tidak cocok: diharapkan ${dataLength}, diperoleh ${inflated.length}`);
    }

    return inflated;
  }
}

// ==============================================================================
// 5. Server List Ping (SLP) Standalone Engine
// ==============================================================================

/**
 * Melakukan kueri Server List Ping (SLP) ke server Minecraft untuk mendapatkan status live dan pemain online.
 * @param {{ host: string, port?: number, timeoutMs?: number, protocolVersion?: number }} options
 * @returns {Promise<{ version: { name: string, protocol: number }, players: { online: number, max: number, sample?: Array<{ id: string, name: string }> }, description: any, latencyMs: number, rawJson: any }>}
 */
function querySLP({ host = 'atoms-girl.tun.ply.gg', port = 25565, timeoutMs = 10000, protocolVersion = 775 } = {}) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const socket = net.createConnection({ host, port, timeout: timeoutMs });
    const framer = new PacketFramer();
    let isSettled = false;

    const cleanup = () => {
      if (!socket.destroyed) {
        socket.destroy();
      }
    };

    socket.once('connect', () => {
      // 1. Kirim Handshake packet untuk Status (NextState = 1)
      const protoVerBuf = writeVarInt(protocolVersion);
      const hostBuf = writeString(host);
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(port, 0);
      const nextStateBuf = writeVarInt(1); // 1 = Status

      const handshakePayload = Buffer.concat([writeVarInt(0x00), protoVerBuf, hostBuf, portBuf, nextStateBuf]);
      const handshakeFrame = Buffer.concat([writeVarInt(handshakePayload.length), handshakePayload]);
      socket.write(handshakeFrame);

      // 2. Kirim Status Request (Packet ID = 0x00)
      const statusReqPayload = writeVarInt(0x00);
      const statusReqFrame = Buffer.concat([writeVarInt(statusReqPayload.length), statusReqPayload]);
      socket.write(statusReqFrame);
    });

    socket.on('data', (chunk) => {
      framer.append(chunk);
      const frame = framer.readNextFrame();
      if (!frame || isSettled) return;

      const idRes = readVarInt(frame, 0);
      if (!idRes) return;

      const packetId = idRes.value;
      if (packetId === 0x00) {
        // Status Response: [JSON String]
        const jsonStrRes = readString(frame, idRes.size);
        if (jsonStrRes) {
          isSettled = true;
          const latencyMs = Date.now() - startTime;
          cleanup();
          try {
            const parsed = JSON.parse(jsonStrRes.value);
            resolve({
              version: parsed.version || { name: 'Unknown', protocol: protocolVersion },
              players: parsed.players || { online: 0, max: 0, sample: [] },
              description: parsed.description,
              latencyMs,
              rawJson: parsed
            });
          } catch (e) {
            reject(new Error(`[SLP] Gagal mem-parsing respons JSON status server: ${e.message}`));
          }
        }
      }
    });

    socket.on('error', (err) => {
      if (!isSettled) {
        isSettled = true;
        cleanup();
        reject(err);
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
 * Memverifikasi apakah bot tertentu terdaftar aktif di server melalui Server List Ping.
 * @param {{ host?: string, port?: number, botUsername: string, timeoutMs?: number }} options
 * @returns {Promise<{ isOnline: boolean, playerCount: number, inSample: boolean, sample: Array<{ id: string, name: string }> }>}
 */
async function verifyBotOnline({ host = 'atoms-girl.tun.ply.gg', port = 25565, botUsername, timeoutMs = 10000 }) {
  const status = await querySLP({ host, port, timeoutMs });
  const onlineCount = status.players?.online || 0;
  const sample = status.players?.sample || [];
  const inSample = sample.some(p => p.name === botUsername);

  return {
    isOnline: onlineCount >= 1,
    playerCount: onlineCount,
    inSample,
    sample
  };
}

// ==============================================================================
// 6. LiveProtocolClient — Mesin Jaringan Protokol 775 Utama
// ==============================================================================

/**
 * @class LiveProtocolClient
 * @extends EventEmitter
 * @description Klien konektor live Minecraft Protokol 775 (Minecraft 26.1.2 / NeoForge)
 * yang mandiri dan headless. Menangani transisi state machine otomatis, detak jantung keepalive,
 * sinkronisasi posisi teleportasi, acknowledgements konfigurasi, kanal custom payload,
 * dan pemulihan koneksi.
 */
class LiveProtocolClient extends EventEmitter {
  /**
   * @param {Partial<typeof DEFAULT_CLIENT_CONFIG>} [options={}]
   */
  constructor(options = {}) {
    super();

    // Gabungkan konfigurasi dengan nilai bawaan
    this.config = { ...DEFAULT_CLIENT_CONFIG, ...options };
    this.packetIds = {
      configuration: {
        toServer: {
          ...DEFAULT_PACKET_IDS.configuration.toServer,
          ...(options.packetIds?.configuration?.toServer || {})
        }
      },
      play: {
        toClient: {
          ...DEFAULT_PACKET_IDS.play.toClient,
          ...(options.packetIds?.play?.toClient || {})
        },
        toServer: {
          ...DEFAULT_PACKET_IDS.play.toServer,
          ...(options.packetIds?.play?.toServer || {})
        }
      }
    };

    // Pastikan username tidak melebihi batas 16 karakter standar Minecraft
    if (this.config.username && this.config.username.length > 16) {
      this.config.username = this.config.username.substring(0, 16);
    }

    // Inisialisasi status siklus hidup internal
    this.protocolState = PROTOCOL_STATES.HANDSHAKING;
    this.connectionState = CONNECTION_STATES.DISCONNECTED;
    this.reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._keepAliveWatchdogTimer = null;
    this._movementHeartbeatTimer = null;
    this._lastKeepAliveTimestamp = Date.now();
    this._playerLoadedSent = false;
    this._lastTeleportId = null;
    this._teleportsReceived = 0;
    this._movementPausedUntil = 0;

    // Inisialisasi komponen pembantu
    this.framer = new PacketFramer();
    this.compression = new CompressionHandler();
    this.socket = null;

    // Data entitas & lingkungan bot
    this.entityId = null;
    this.uuid = this.config.uuid || generateOfflineUuid(this.config.username);
    this.position = { x: 0, y: 64, z: 0, yaw: 0, pitch: 0, onGround: true, hasHorizontalCollision: false };
    this.health = 20;
    this.food = 20;
    this.registries = new Map();

    // World model dari Chunk Data packet nyata (0x2d) - lihat chunkDecoder.js
    this.chunkCache = new Map(); // key "cx,cz" -> array Int32Array/Array block state ID per section (bawah ke atas)
    this._blockDataProvider = null; // lazy-load minecraft-data untuk terjemahan ID -> nama blok vanilla

    // Tracking entity nyata dari spawn_entity/entity_destroy (0x01/0x4d) - lihat entityDecoder.js.
    // Posisi entity TIDAK di-update real-time (rel_entity_move belum diidentifikasi dengan andal,
    // lihat catatan di _handlePlayPacket) - cukup untuk retreat kasar, belum untuk tracking presisi.
    this.entities = new Map(); // entityId -> { entityId, typeId, name, x, y, z }

    // Reactive hazard learning: ditemukan bug live nyata di mana blok yang ter-resolve sebagai
    // "glow_lichen" (harusnya tidak berbahaya di Minecraft vanilla) ternyata membunuh bot berulang
    // kali di server modded ini - root cause pastinya (ID registry bergeser akibat mod, atau trap
    // datapack custom) tidak bisa dipastikan tanpa akses data mod server. Solusinya: belajar dari
    // damage nyata (2x damage berturut-turut di blok sama, tanpa mob hostile di dekatnya) alih-alih
    // menebak nama blok spesifik yang bisa salah untuk server modded lain.
    this.learnedHazardStateIds = new Set();
    this._hazardTracking = { lastDamageBlockKey: null, consecutiveNoMobDamage: 0 };
  }

  /**
   * Memulai koneksi TCP ke server live Minecraft.
   * @returns {Promise<void>}
   */
  connect() {
    return new Promise((resolve, reject) => {
      if (this.connectionState === CONNECTION_STATES.CONNECTED) {
        return resolve();
      }

      this._cleanupSocket();
      this.connectionState = CONNECTION_STATES.CONNECTING;
      this.protocolState = PROTOCOL_STATES.HANDSHAKING;
      this.framer.clear();
      this.compression.setThreshold(-1);
      this._playerLoadedSent = false;
      this._lastTeleportId = null;
      this._teleportsReceived = 0;
      this._movementPausedUntil = 0;

      this.emit('connecting', { host: this.config.host, port: this.config.port });
      console.log(`🌐 [Jaringan] Menghubungkan ke server ${this.config.host}:${this.config.port}...`);

      const socket = net.createConnection({
        host: this.config.host,
        port: this.config.port,
        timeout: this.config.socketTimeoutMs
      });

      this.socket = socket;
      socket.setNoDelay(true); // Nonaktifkan algoritma Nagle untuk latensi transmisi instan

      let isConnected = false;
      let hasJoinedPlay = false;
      let kickReason = null;

      this.once('kicked', (reason) => {
        kickReason = reason;
      });

      socket.once('connect', () => {
        isConnected = true;
        this.connectionState = CONNECTION_STATES.CONNECTED;
        this.reconnectAttempts = 0;
        this.emit('connect');
        console.log('🔌 [Jaringan] TCP Socket berhasil terhubung!');

        // Mulai jabat tangan Protokol 775
        this._startHandshake();
      });

      socket.on('data', (chunk) => {
        this._handleIncomingData(chunk);
      });

      socket.on('error', (err) => {
        console.error(`❌ [Jaringan] Kesalahan socket: ${err.message}`);
        this.emit('error', err);
        if (!hasJoinedPlay) {
          reject(err);
        }
      });

      socket.on('timeout', () => {
        console.warn('⚠️ [Jaringan] Socket mengalami timeout tanpa aktivitas data.');
        this.emit('timeout');
        socket.destroy(new Error('Batas waktu socket habis'));
      });

      socket.on('close', (hadError) => {
        console.log(`🔌 [Jaringan] Koneksi socket terputus (hadError: ${hadError}).`);
        if (this._movementHeartbeatTimer) {
          clearInterval(this._movementHeartbeatTimer);
          this._movementHeartbeatTimer = null;
        }
        this.connectionState = CONNECTION_STATES.DISCONNECTED;
        this.emit('disconnect', { hadError });
        this.emit('close', { hadError });
        this.emit('end');

        if (!hasJoinedPlay) {
          reject(new Error(kickReason || `Koneksi terputus sebelum mencapai Play state (hadError: ${hadError})`));
        }

        if (this.config.autoReconnect) {
          this._scheduleReconnect();
        }
      });

      // Dengarkan event 'joined' untuk menyelesaikan promise connect()
      this.once('joined', () => {
        hasJoinedPlay = true;
        resolve();
      });
    });
  }

  /**
   * Menutup koneksi secara anggun (graceful disconnect).
   * @param {string} [reason='Klien memutuskan koneksi secara normal']
   */
  disconnect(reason = 'Klien memutuskan koneksi secara normal') {
    this.config.autoReconnect = false; // Matikan auto-reconnect saat disconnect eksplisit
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._keepAliveWatchdogTimer) {
      clearInterval(this._keepAliveWatchdogTimer);
      this._keepAliveWatchdogTimer = null;
    }
    if (this._movementHeartbeatTimer) {
      clearInterval(this._movementHeartbeatTimer);
      this._movementHeartbeatTimer = null;
    }

    if (this.socket && !this.socket.destroyed) {
      console.log(`🛑 [Jaringan] Memutuskan koneksi bot: ${reason}`);
      this.socket.end();
      this.socket.destroy();
    }

    this._cleanupSocket();
    this.connectionState = CONNECTION_STATES.DISCONNECTED;
  }

  /**
   * Membersihkan referensi socket dan timer internal.
   * @private
   */
  _cleanupSocket() {
    if (this.socket) {
      this.socket.removeAllListeners();
      if (!this.socket.destroyed) {
        this.socket.destroy();
      }
      this.socket = null;
    }
  }

  /**
   * Menjadwalkan koneksi ulang dengan exponential backoff dan jitter acak.
   * @private
   */
  _scheduleReconnect() {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      console.error(`💥 [Pemulihan] Batas maksimum percobaan koneksi ulang (${this.config.maxReconnectAttempts}) tercapai.`);
      this.emit('reconnect_failed');
      return;
    }

    this.reconnectAttempts++;
    this.connectionState = CONNECTION_STATES.RECONNECTING;

    // Hitung delay eksponensial: base * (multiplier ^ attempts)
    const baseDelay = this.config.reconnectBaseDelayMs * Math.pow(this.config.backoffMultiplier, this.reconnectAttempts - 1);
    const cappedDelay = Math.min(baseDelay, this.config.reconnectMaxDelayMs);
    // Tambahkan jitter 10% - 20%
    const jitter = cappedDelay * (0.1 + Math.random() * 0.1);
    const finalDelay = Math.round(cappedDelay + jitter);

    console.log(`🔄 [Pemulihan] Percobaan koneksi ulang #${this.reconnectAttempts} dalam ${finalDelay}ms...`);
    this.emit('reconnecting', { attempt: this.reconnectAttempts, delayMs: finalDelay });

    this._reconnectTimer = setTimeout(() => {
      this.connect().catch((err) => {
        console.warn(`⚠️ [Pemulihan] Percobaan koneksi ulang gagal: ${err.message}`);
      });
    }, finalDelay);
  }

  // ==============================================================================
  // 7. Alur State Machine & Parsing Paket Inbound (Protokol 775 / 26.1.2)
  // ==============================================================================

  /**
   * Menangani data mentah yang masuk dari socket TCP.
   * @private
   * @param {Buffer} chunk
   */
  _handleIncomingData(chunk) {
    this.framer.append(chunk);

    while (true) {
      const packetFrame = this.framer.readNextFrame();
      if (!packetFrame) break; // Tunggu sisa pecahan paket jika belum lengkap

      try {
        const uncompressedPayload = this.compression.decompress(packetFrame);
        this._dispatchPacket(uncompressedPayload);
      } catch (err) {
        console.error(`❌ [Protokol] Kesalahan saat mendispatch paket: ${err.message}`);
        this.emit('error', err);
      }
    }
  }

  /**
   * Mendispatch paket yang telah didekompresi berdasarkan state protokol saat ini.
   * @private
   * @param {Buffer} payload
   */
  _dispatchPacket(payload) {
    if (payload.length === 0) return;

    const idResult = readVarInt(payload, 0);
    if (!idResult) return;

    const packetId = idResult.value;
    const dataBuf = payload.subarray(idResult.size);

    this.emit('packet_raw', { packetId, buffer: dataBuf, state: this.protocolState });

    switch (this.protocolState) {
      case PROTOCOL_STATES.LOGIN:
        this._handleLoginPacket(packetId, dataBuf);
        break;
      case PROTOCOL_STATES.CONFIGURATION:
        this._handleConfigurationPacket(packetId, dataBuf);
        break;
      case PROTOCOL_STATES.PLAY:
        this._handlePlayPacket(packetId, dataBuf);
        break;
      default:
        break;
    }
  }

  /**
   * Penanganan paket pada fase LOGIN (Protokol 775).
   * @private
   */
  _handleLoginPacket(packetId, data) {
    if (packetId === 0x03) {
      // 0x03: Set Compression
      const thresholdRes = readVarInt(data, 0);
      if (thresholdRes) {
        this.compression.setThreshold(thresholdRes.value);
        console.log(`🗜️ [Kompresi] Server mengaktifkan kompresi Zlib (Ambang batas: ${thresholdRes.value} bytes).`);
      }
    } else if (packetId === 0x02) {
      // 0x02: Login Success
      let offset = 0;
      let playerUuid = '';
      if (data.length >= 16) {
        playerUuid = data.subarray(0, 16).toString('hex');
        offset += 16;
      }
      const usernameRes = readString(data, offset);
      const username = usernameRes ? usernameRes.value : this.config.username;

      console.log(`✅ [Autentikasi] Login Berhasil! Pemain: ${username} (UUID: ${playerUuid})`);
      this.emit('login', { username, uuid: playerUuid });

      // Kirim pengakuan login (Login Acknowledged ID 0x03 pada Protokol 775)
      this._sendPacketRaw(PROTOCOL_STATES.LOGIN, 0x03, Buffer.alloc(0));
      this._setState(PROTOCOL_STATES.CONFIGURATION);
    } else if (packetId === 0x00) {
      // 0x00: Disconnect (Login)
      const reasonRes = readString(data, 0);
      const reason = reasonRes ? reasonRes.value : 'Alasan tidak diketahui';
      console.warn(`⚠️ [Autentikasi] Ditolak oleh server saat login: ${reason}`);
      this.emit('kicked', reason);
    }
  }

  /**
   * Penanganan paket pada fase CONFIGURATION (Protokol 775 / 26.1.2).
   * @private
   */
  _handleConfigurationPacket(packetId, data) {
    if (packetId === 0x01) {
      // 0x01: Custom Payload (Config toClient)
      const channelRes = readString(data, 0);
      if (channelRes) {
        const channelName = channelRes.value;
        const payloadBuf = data.subarray(channelRes.size);
        this.emit('packet', 'custom_payload', { channel: channelName, data: payloadBuf }, PROTOCOL_STATES.CONFIGURATION);
      }
    } else if (packetId === 0x0c) {
      // 0x0c: Feature Flags
      this.emit('packet', 'feature_flags', { data }, PROTOCOL_STATES.CONFIGURATION);
    } else if (packetId === 0x0e) {
      // 0x0e: Select Known Packs (Serverbound ack: 0x07 dengan count = 0)
      const ackKnownPacks = writeVarInt(0); // 0 known packs
      this._sendPacketRaw(PROTOCOL_STATES.CONFIGURATION, 0x07, ackKnownPacks);
      this.emit('packet', 'select_known_packs', {}, PROTOCOL_STATES.CONFIGURATION);
    } else if (packetId === 0x07) {
      // 0x07: Registry Data (28 paket registri)
      const regIdRes = readString(data, 0);
      if (regIdRes) {
        this.registries.set(regIdRes.value, true);
        this.emit('registry_data', { registry: regIdRes.value });
        this.emit('packet', 'registry_data', { registry: regIdRes.value }, PROTOCOL_STATES.CONFIGURATION);
      }
    } else if (packetId === 0x0d) {
      // 0x0d: Update Tags
      this.emit('packet', 'tags', { data }, PROTOCOL_STATES.CONFIGURATION);
    } else if (packetId === 0x04) {
      // 0x04: Keep Alive (Config toClient -> Config toServer ID 0x04)
      if (data.length >= 8) {
        const keepAliveId = data.readBigInt64BE(0);
        const respBuf = Buffer.alloc(8);
        respBuf.writeBigInt64BE(keepAliveId, 0);
        this._sendPacketRaw(PROTOCOL_STATES.CONFIGURATION, 0x04, respBuf);
        this.emit('keep_alive', keepAliveId);
      }
    } else if (packetId === 0x05) {
      // 0x05: Ping (Config toClient)
      this.emit('packet', 'ping', {}, PROTOCOL_STATES.CONFIGURATION);
    } else if (packetId === 0x03) {
      // 0x03: Finish Configuration dari Server
      console.log(`⚙️ [Konfigurasi] Fase konfigurasi selesai (Total ${this.registries.size} registri diterima). Mengirim konfirmasi...`);
      // Balas Finish Configuration (ID 0x03 pada config toServer)
      this._sendPacketRaw(PROTOCOL_STATES.CONFIGURATION, 0x03, Buffer.alloc(0));
      this._setState(PROTOCOL_STATES.PLAY);
      this.emit('configuration_finished');
    } else if (packetId === 0x02) {
      // 0x02: Disconnect (Configuration)
      const reasonRes = readString(data, 0);
      console.warn(`⚠️ [Konfigurasi] Terputus saat konfigurasi: ${reasonRes ? reasonRes.value : ''}`);
      this.emit('kicked', reasonRes ? reasonRes.value : 'Terputus pada konfigurasi');
    }
  }

  _sendClientInformation(state = PROTOCOL_STATES.CONFIGURATION) {
    // Paket Client Information: Configuration 0x00 / Play 0x0a (Protokol 775 / 26.1.2)
    const packetId = state === PROTOCOL_STATES.CONFIGURATION ? 0x00 : 0x0a;
    const localeBuf = writeString('en_us');
    const viewDistBuf = Buffer.from([Math.max(1, Math.min(32, this.config.viewDistance))]);
    const chatModeBuf = writeVarInt(0); // 0 = enabled
    const chatColorsBuf = Buffer.from([1]); // true
    const skinPartsBuf = Buffer.from([0x7f]); // 127 = all skin parts visible (jacket, sleeves, pants, hat)
    const mainHandBuf = writeVarInt(1); // 1 = right hand
    const textFilteringBuf = Buffer.from([0]); // false
    const allowListingsBuf = Buffer.from([1]); // true
    // Field terakhir (particleStatus) tidak ada di dokumentasi protokol lama yang jadi acuan awal -
    // dikonfirmasi lewat protocol.json referensi 1.21.11/774: packet_common_settings punya 1 field
    // lagi setelah enableServerListing. Tanpa ini payload lebih pendek dari yang server harapkan.
    const particleStatusBuf = writeVarInt(0); // 0 = all particles

    const payload = Buffer.concat([
      localeBuf,
      viewDistBuf,
      chatModeBuf,
      chatColorsBuf,
      skinPartsBuf,
      mainHandBuf,
      textFilteringBuf,
      allowListingsBuf,
      particleStatusBuf
    ]);

    this._sendPacketRaw(state, packetId, payload);
    console.log(`👤 [Avatar 3D] Mengirim Client Information & Skin Parts (0x7F) pada state ${state}`);
  }

  /**
   * Penanganan paket pada fase PLAY (Protokol 775 / 26.1.2).
   * @private
   */
  _handlePlayPacket(packetId, data) {
    if (packetId === 0x31) {
      // 0x31: Login / Join Game (Play toClient 26.1.2)
      if (data.length >= 4) {
        this.entityId = data.readInt32BE(0);
        console.log(`🎮 [Play] Berhasil masuk ke dunia permainan! Entity ID: ${this.entityId}`);

        this.emit('joined', { entityId: this.entityId });
        this.emit('spawn');
        this.emit('packet', 'join_game', { entityId: this.entityId }, PROTOCOL_STATES.PLAY);
        this._startMovementHeartbeat();
      }
    } else if (packetId === this.packetIds.play.toClient.keepAlive) {
      if (data.length === 8) {
        const keepAliveId = data.readBigInt64BE(0);
        const respBuf = Buffer.alloc(8);
        respBuf.writeBigInt64BE(keepAliveId, 0);
        this._sendPacketRaw(PROTOCOL_STATES.PLAY, this.packetIds.play.toServer.keepAlive, respBuf);
        this._lastKeepAliveTimestamp = Date.now();
        this.emit('keep_alive', keepAliveId);
      } else {
        this.emit('packet', 'malformed_keep_alive', { data }, PROTOCOL_STATES.PLAY);
      }
    } else if (packetId === 0x35 || packetId === 0x3d) {
      // 0x35: Ping (Play toClient 1.21.1)
      this.emit('packet', 'ping', {}, PROTOCOL_STATES.PLAY);
    } else if (packetId === 0x48) {
      // 0x48: Synchronize Player Position (Teleport 26.1.2)
      const teleIdRes = readVarInt(data, 0);
      if (teleIdRes) {
        const teleportId = teleIdRes.value;
        let offset = teleIdRes.size;
        let x = 0;
        let y = 0;
        let z = 0;
        let yaw = 0;
        let pitch = 0;

        if (data.length >= offset + 24) {
          x = data.readDoubleBE(offset);
          y = data.readDoubleBE(offset + 8);
          z = data.readDoubleBE(offset + 16);
          offset += 24;
        }
        if (data.length >= offset + 24) {
          offset += 24;
        }
        if (data.length >= offset + 8) {
          yaw = data.readFloatBE(offset);
          pitch = data.readFloatBE(offset + 4);
          offset += 8;
        }

        const previousPosition = { ...this.position };
        const isServerCorrection = this._teleportsReceived > 0 || this._playerLoadedSent;

        this.position = { x, y, z, yaw, pitch, onGround: true, hasHorizontalCollision: false };
        this._lastTeleportId = teleportId;
        this._teleportsReceived++;

        if (this.config.autoConfirmTeleport) {
          this.sendTeleportConfirm(teleportId);
        }

        if (this.config.autoSendPlayerLoaded && !this._playerLoadedSent) {
          this.sendPlayerLoaded();
        }

        if (isServerCorrection) {
          const correction = {
            teleportId,
            from: previousPosition,
            to: this.position,
            distance: Math.hypot(
              this.position.x - previousPosition.x,
              this.position.y - previousPosition.y,
              this.position.z - previousPosition.z
            )
          };
          this._movementPausedUntil = Date.now() + Math.max(0, this.config.movementCorrectionPauseMs);
          this.emit('movement_correction', correction);
        }

        this.emit('teleport', { x, y, z, yaw, pitch, teleportId });
        this.emit('packet', 'teleport', { x, y, z, yaw, pitch, teleportId }, PROTOCOL_STATES.PLAY);
      }
    } else if (packetId === 0x0c) {
      // 0x0c: Chunk Batch Start (26.1.2)
      this.emit('chunk_batch_start');
      this.emit('packet', 'chunk_batch_start', {}, PROTOCOL_STATES.PLAY);
    } else if (packetId === 0x0b) {
      // 0x0b: Chunk Batch Finished (26.1.2)
      this.emit('chunk_batch_finished');
      this.emit('packet', 'chunk_batch_finished', {}, PROTOCOL_STATES.PLAY);
    } else if (packetId === this.packetIds.play.toClient.updateHealth) {
      // Update Health. Packet ID default mengikuti data vanilla 1.21.1; server NeoForge bisa override lewat config.packetIds.
      if (data.length >= 4) {
        const previousHealth = this.health;
        this.health = data.readFloatBE(0);
        const foodRes = readVarInt(data, 4);
        if (foodRes) this.food = foodRes.value;
        this.emit('health', { health: this.health, food: this.food });
        this.emit('packet', 'update_health', { health: this.health, food: this.food }, PROTOCOL_STATES.PLAY);

        this._trackHazardLearning(previousHealth);

        if (this.health <= 0) {
          this.emit('dead', { health: this.health, food: this.food });
          this._movementPausedUntil = Date.now() + Math.max(0, this.config.respawnDelayMs + 2000);
          if (this.config.autoRespawn) {
            setTimeout(() => this.sendRespawn(), this.config.respawnDelayMs);
          }
        }
      }
    } else if (packetId === 0x1d) {
      // 0x1d: Kick / Disconnect (Play toClient 26.1.2)
      const reasonRes = readString(data, 0);
      const reason = reasonRes ? reasonRes.value : 'Terputus dari server play';
      console.warn(`⚠️ [Play] Terputus dari server: ${reason}`);
      this.emit('kicked', reason);
    } else if (packetId === 0x20) {
      // 0x20: Explosion (Play toClient 26.1.2) - Jangan disconnect saat ada ledakan!
      this.emit('packet', 'explosion', { data }, PROTOCOL_STATES.PLAY);
    } else if (packetId === 0x2d) {
      // 0x2d: Chunk Data and Update Light - satu-satunya sumber data terrain nyata dari server.
      try {
        const { chunkX, chunkZ, sections } = decodeChunkDataPacket(data);
        this.chunkCache.set(`${chunkX},${chunkZ}`, sections.map((s) => s.blockStates));
        this.emit('chunk_loaded', { chunkX, chunkZ, sectionCount: sections.length });
        this.emit('packet', 'chunk_data', { chunkX, chunkZ, sectionCount: sections.length }, PROTOCOL_STATES.PLAY);
      } catch (err) {
        console.error(`❌ [Play] Gagal mendekode Chunk Data: ${err.message}`);
      }
    } else if (packetId === 0x01) {
      // 0x01: Spawn Entity - dikonfirmasi lewat capture live (entity type 10/41/32/150 cocok
      // persis bat/enderman/creeper/zombie di tabel minecraft-data), dasar hostile awareness.
      try {
        const e = decodeSpawnEntity(data);
        const name = resolveEntityTypeName(e.type);
        // lastSeenAt: entity yang sama bisa "terlihat lagi" (spawn_entity kedua kalinya) kalau
        // sempat keluar-masuk render distance klien ini - dipakai untuk agregasi lintas-bot
        // (swarm coordinator menggabungkan sighting dari semua bot, ambil yang paling baru).
        this.entities.set(e.entityId, { entityId: e.entityId, typeId: e.type, name, x: e.x, y: e.y, z: e.z, lastSeenAt: Date.now() });
        this.emit('entity_spawned', { entityId: e.entityId, name, x: e.x, y: e.y, z: e.z });
      } catch (err) {
        console.error(`❌ [Play] Gagal mendekode Spawn Entity: ${err.message}`);
      }
    } else if (packetId === 0x4d) {
      // 0x4d: Entity Destroy - dikonfirmasi lewat capture live (entityId selalu cocok dengan yang pernah di-spawn).
      try {
        const { entityIds } = decodeEntityDestroy(data);
        for (const id of entityIds) this.entities.delete(id);
        this.emit('entities_removed', { entityIds });
      } catch (err) {
        console.error(`❌ [Play] Gagal mendekode Entity Destroy: ${err.message}`);
      }
      // Catatan: packet update posisi entity berjalan (rel_entity_move) BELUM disambungkan di sini.
      // ID 0x63 sempat dicoba tapi hasil decode live tidak konsisten (kemungkinan itu sebenarnya
      // entity_velocity yang struktur wire-nya kebetulan mirip, bukan rel_entity_move sungguhan) -
      // daripada memaksa dengan tebakan yang terbukti tidak reliabel, posisi entity untuk sementara
      // hanya di-update lewat spawn_entity (posisi awal) sampai destroy (dihapus). Cukup untuk
      // kebutuhan retreat kasar (radius bahaya), tapi belum akurat untuk mob yang aktif bergerak jauh.
    }
  }

  /**
   * Mengambil global block state ID nyata dari world model hasil decode Chunk Data.
   * Mengembalikan null jika chunk terkait belum pernah diterima dari server.
   */
  getBlockStateId(x, y, z) {
    const chunkX = Math.floor(x / 16);
    const chunkZ = Math.floor(z / 16);
    const sections = this.chunkCache.get(`${chunkX},${chunkZ}`);
    if (!sections) return null;

    const sectionIndex = Math.floor((y - this.config.worldMinY) / 16);
    const section = sections[sectionIndex];
    if (!section) return null;

    const localX = ((x % 16) + 16) % 16;
    const localY = ((y - this.config.worldMinY) % 16 + 16) % 16;
    const localZ = ((z % 16) + 16) % 16;
    const localIndex = (localY * 16 * 16) + (localZ * 16) + localX;

    return section[localIndex] ?? null;
  }

  /**
   * Menerjemahkan global block state ID menjadi nama blok vanilla lewat minecraft-data.
   * Catatan: server modded (NeoForge) bisa menyisipkan blok custom yang menggeser ID,
   * sehingga hasil untuk blok non-vanilla tidak terjamin akurat.
   */
  getBlockName(x, y, z) {
    const stateId = this.getBlockStateId(x, y, z);
    if (stateId === null) return null;

    // Blok yang sudah dipelajari berbahaya secara empiris (lihat _trackHazardLearning) - override
    // nama aslinya, apapun itu, karena kita tahu dari damage nyata ini berbahaya untuk dilewati.
    if (this.learnedHazardStateIds.has(stateId)) return '__reactive_hazard__';

    if (!this._blockDataProvider) {
      // this.config.minecraftVersion menyimpan versi NeoForge (mis. "26.1.2"), bukan versi Minecraft dasar.
      this._blockDataProvider = require('minecraft-data')('1.21.1');
    }

    const block = this._blockDataProvider.blocksByStateId?.[stateId];
    return block ? block.name : `unknown_state_${stateId}`;
  }

  /**
   * Reactive hazard learning - lihat catatan di constructor. Dipanggil tiap kali packet
   * update_health diterima. Kalau HP turun 2x berturut-turut di posisi blok yang sama TANPA ada
   * mob hostile di dekatnya, tandai blok itu (via global block state ID) sebagai bahaya.
   * @private
   */
  _trackHazardLearning(previousHealth) {
    if (previousHealth === undefined || this.health >= previousHealth) return;

    const bx = Math.floor(this.position.x);
    const by = Math.floor(this.position.y);
    const bz = Math.floor(this.position.z);

    const nearbyHostile = this.getNearbyHostiles(this.position, 4).length > 0;
    if (nearbyHostile) {
      this._hazardTracking.consecutiveNoMobDamage = 0;
      this._hazardTracking.lastDamageBlockKey = null;
      return;
    }

    const key = `${bx},${by},${bz}`;
    if (this._hazardTracking.lastDamageBlockKey === key) {
      this._hazardTracking.consecutiveNoMobDamage++;
    } else {
      this._hazardTracking.consecutiveNoMobDamage = 1;
      this._hazardTracking.lastDamageBlockKey = key;
    }

    if (this._hazardTracking.consecutiveNoMobDamage >= 2) {
      const stateId = this.getBlockStateId(bx, by, bz);
      if (stateId !== null && !this.learnedHazardStateIds.has(stateId)) {
        this.learnedHazardStateIds.add(stateId);
        this.emit('hazard_learned', { stateId, x: bx, y: by, z: bz });
      }
    }
  }

  /**
   * Mengambil daftar mob hostile (Creeper, Zombie, Skeleton, dll - lihat isHostileEntityName)
   * dalam radius maxDistance dari suatu posisi, diurutkan dari yang terdekat. Dasar untuk
   * hostile awareness (deteksi & hindari ancaman) - tanpa ini bot buta terhadap keberadaan mob.
   */
  getNearbyHostiles(fromPos, maxDistance = 32) {
    const result = [];
    for (const entity of this.entities.values()) {
      if (!isHostileEntityName(entity.name)) continue;
      const distance = Math.hypot(entity.x - fromPos.x, entity.y - fromPos.y, entity.z - fromPos.z);
      if (distance <= maxDistance) {
        result.push({ ...entity, distance });
      }
    }
    result.sort((a, b) => a.distance - b.distance);
    return result;
  }

  /**
   * Mengambil seluruh mob hostile yang di-track klien ini tanpa filter jarak/posisi acuan.
   * Dipakai untuk agregasi lintas-bot (multi-anchor): swarm coordinator menggabungkan hasil
   * ini dari beberapa client/bot sekaligus, jadi threat yang dilihat satu bot tetap bisa
   * mempengaruhi keputusan bot lain yang mungkin tidak melihatnya sendiri.
   */
  getAllHostiles() {
    const result = [];
    for (const entity of this.entities.values()) {
      if (isHostileEntityName(entity.name)) result.push({ ...entity });
    }
    return result;
  }

  /**
   * Mengubah status protokol internal klien.
   * @private
   * @param {string} newState
   */
  _setState(newState) {
    const oldState = this.protocolState;
    this.protocolState = newState;
    console.log(`🔄 [Protokol] Berpindah status: ${oldState} ➔ ${newState}`);
    this.emit('stateChanged', { oldState, newState });
  }

  /**
   * Menjaga state on-ground pemain tetap segar tanpa mengirim posisi absolut.
   * @private
   */
  _startMovementHeartbeat() {
    if (!this.config.movementHeartbeatEnabled || this._movementHeartbeatTimer) return;

    this._movementHeartbeatTimer = setInterval(() => {
      this.sendFlying({
        onGround: this.position.onGround !== false,
        hasHorizontalCollision: Boolean(this.position.hasHorizontalCollision)
      });
    }, this.config.movementHeartbeatIntervalMs);

    if (typeof this._movementHeartbeatTimer.unref === 'function') {
      this._movementHeartbeatTimer.unref();
    }
  }

  // ==============================================================================
  // 8. Pengiriman Paket Outbound (ToServer Protokol 775 / 26.1.2)
  // ==============================================================================

  /**
   * Memulai jabat tangan awal (Handshake) ke server.
   * @private
   */
  _startHandshake() {
    this._setState(PROTOCOL_STATES.HANDSHAKING);

    const protoVerBuf = writeVarInt(this.config.protocolVersion);
    const hostBuf = writeString(this.config.host);
    const portBuf = Buffer.alloc(2);
    portBuf.writeUInt16BE(this.config.port, 0);
    const nextStateBuf = writeVarInt(2); // 2 = Login

    const handshakePayload = Buffer.concat([protoVerBuf, hostBuf, portBuf, nextStateBuf]);
    this._sendPacketRaw(PROTOCOL_STATES.HANDSHAKING, 0x00, handshakePayload);

    this._setState(PROTOCOL_STATES.LOGIN);

    const username = this.config.username.substring(0, 16);
    const usernameBuf = writeString(username);
    const uuidBuf = uuidToBuffer(this.uuid);

    const loginPayload = Buffer.concat([usernameBuf, uuidBuf]);
    this._sendPacketRaw(PROTOCOL_STATES.LOGIN, 0x00, loginPayload);
  }

  /**
   * Mengirim frame biner paket mentah melalui TCP Socket dengan kompresi dan framing.
   * @private
   * @param {string} state
   * @param {number} packetId
   * @param {Buffer} payloadBuffer
   */
  _sendPacketRaw(state, packetId, payloadBuffer) {
    if (!this.socket || this.socket.destroyed) {
      console.warn('⚠️ [Jaringan] Gagal mengirim paket: socket tidak aktif.');
      return;
    }

    const idBuf = writeVarInt(packetId);
    const uncompressed = Buffer.concat([idBuf, payloadBuffer]);
    const wireFrame = this.compression.compress(uncompressed);

    console.log(`[RAW SEND OUTBOUND] State: ${state}, Packet ID: 0x${packetId.toString(16).padStart(2, '0')}, Len: ${payloadBuffer.length}`);
    this.socket.write(wireFrame);
  }

  /**
   * Mengirim paket posisi pemain ke server (ID 0x1a pada 1.21.1)
   */
  sendPosition(posOrX, maybeY, maybeZ, maybeOnGround = true) {
    if (this.protocolState !== PROTOCOL_STATES.PLAY) return;

    let x, y, z, onGround = true;
    if (typeof posOrX === 'object' && posOrX !== null) {
      x = posOrX.x;
      y = posOrX.y;
      z = posOrX.z;
      if (posOrX.onGround !== undefined) onGround = Boolean(posOrX.onGround);
    } else {
      x = posOrX;
      y = maybeY;
      z = maybeZ;
      if (maybeOnGround !== undefined) onGround = Boolean(maybeOnGround);
    }

    if (isNaN(x) || isNaN(y) || isNaN(z)) return;

    this.position.x = x;
    this.position.y = y;
    this.position.z = z;
    this.position.onGround = onGround;

    const buf = Buffer.alloc(25);
    buf.writeDoubleBE(x, 0);
    buf.writeDoubleBE(y, 8);
    buf.writeDoubleBE(z, 16);
    buf.writeUInt8(encodeMovementFlags({
      onGround,
      hasHorizontalCollision: Boolean(posOrX?.hasHorizontalCollision)
    }), 24);

    this._sendPacketRaw(PROTOCOL_STATES.PLAY, this.packetIds.play.toServer.position, buf);
  }

  /**
   * Mengirim pembaruan posisi dan rotasi pemain ke server (ID 0x1b pada 1.21.1)
   */
  sendPositionAndRotation(posOrX, maybeY, maybeZ, maybeYaw = 0, maybePitch = 0, maybeOnGround = true) {
    if (this.protocolState !== PROTOCOL_STATES.PLAY) return;

    let x, y, z, yaw = 0, pitch = 0, onGround = true, hasHorizontalCollision = false;
    if (typeof posOrX === 'object' && posOrX !== null) {
      x = posOrX.x;
      y = posOrX.y;
      z = posOrX.z;
      yaw = posOrX.yaw || 0;
      pitch = posOrX.pitch || 0;
      if (posOrX.onGround !== undefined) onGround = Boolean(posOrX.onGround);
      hasHorizontalCollision = Boolean(posOrX.hasHorizontalCollision);
    } else {
      x = posOrX;
      y = maybeY;
      z = maybeZ;
      yaw = maybeYaw || 0;
      pitch = maybePitch || 0;
      if (maybeOnGround !== undefined) onGround = Boolean(maybeOnGround);
    }

    if (isNaN(x) || isNaN(y) || isNaN(z) || isNaN(yaw) || isNaN(pitch)) return;

    this.position = { x, y, z, yaw, pitch, onGround, hasHorizontalCollision };

    const buf = Buffer.alloc(33);
    buf.writeDoubleBE(x, 0);
    buf.writeDoubleBE(y, 8);
    buf.writeDoubleBE(z, 16);
    buf.writeFloatBE(yaw, 24);
    buf.writeFloatBE(pitch, 28);
    buf.writeUInt8(encodeMovementFlags({ onGround, hasHorizontalCollision }), 32);

    this._sendPacketRaw(PROTOCOL_STATES.PLAY, this.packetIds.play.toServer.positionLook, buf);
  }

  /**
   * Mengirim ack teleport server agar sinkronisasi posisi awal dianggap selesai.
   * @param {number} teleportId
   */
  sendTeleportConfirm(teleportId) {
    if (this.protocolState !== PROTOCOL_STATES.PLAY) return;
    if (!Number.isInteger(teleportId)) return;

    this._sendPacketRaw(
      PROTOCOL_STATES.PLAY,
      this.packetIds.play.toServer.teleportConfirm,
      writeVarInt(teleportId)
    );
    this.emit('teleport_confirmed', { teleportId });
  }

  /**
   * Memberi tahu server bahwa terrain sudah dimuat dari sisi client.
   */
  sendPlayerLoaded() {
    if (this.protocolState !== PROTOCOL_STATES.PLAY) return;

    this._sendPacketRaw(PROTOCOL_STATES.PLAY, this.packetIds.play.toServer.playerLoaded, Buffer.alloc(0));
    this._playerLoadedSent = true;
    this.emit('player_loaded');
  }

  /**
   * Mengirim satu langkah kecil seperti hasil input WASD client vanilla.
   * @param {{ yaw?: number, pitch?: number, distance?: number, strafe?: number, forward?: number, onGround?: boolean, hasHorizontalCollision?: boolean }} [movement={}]
   */
  sendWalkingStep(movement = {}) {
    if (this.protocolState !== PROTOCOL_STATES.PLAY) return;
    if (Date.now() < this._movementPausedUntil) return;

    const yaw = Number.isFinite(movement.yaw) ? movement.yaw : (this.position.yaw || 0);
    const pitch = Number.isFinite(movement.pitch) ? movement.pitch : (this.position.pitch || 0);
    const distance = Number.isFinite(movement.distance) ? movement.distance : 0.1;
    const forward = Number.isFinite(movement.forward) ? movement.forward : 1;
    const strafe = Number.isFinite(movement.strafe) ? movement.strafe : 0;
    const magnitude = Math.hypot(forward, strafe) || 1;
    const yawRad = yaw * Math.PI / 180;
    const forwardNorm = forward / magnitude;
    const strafeNorm = strafe / magnitude;
    const dx = ((-Math.sin(yawRad) * forwardNorm) + (Math.cos(yawRad) * strafeNorm)) * distance;
    const dz = ((Math.cos(yawRad) * forwardNorm) + (Math.sin(yawRad) * strafeNorm)) * distance;

    this.sendPositionAndRotation({
      x: this.position.x + dx,
      y: this.position.y,
      z: this.position.z + dz,
      yaw,
      pitch,
      onGround: movement.onGround !== false,
      hasHorizontalCollision: Boolean(movement.hasHorizontalCollision)
    });
  }

  /**
   * Mengirim heartbeat pergerakan ringan tanpa koordinat absolut.
   */
  sendFlying(flags = {}) {
    if (this.protocolState !== PROTOCOL_STATES.PLAY) return;
    const payload = Buffer.from([encodeMovementFlags({
      onGround: flags.onGround !== false,
      hasHorizontalCollision: Boolean(flags.hasHorizontalCollision)
    })]);
    this._sendPacketRaw(PROTOCOL_STATES.PLAY, this.packetIds.play.toServer.flying, payload);
  }

  /**
   * Mengirim pesan obrolan (chat) ke server.
   * Paket ID baku 1.21.1: 0x06 (chat_message). Bisa dioverride lewat config.packetIds.
   * @param {string} message
   */
  sendChat(message) {
    if (this.protocolState !== PROTOCOL_STATES.PLAY) return;
    const msgBuf = writeString(message);
    const timestampBuf = Buffer.alloc(8);
    timestampBuf.writeBigInt64BE(BigInt(Date.now()), 0);
    const saltBuf = Buffer.alloc(8);
    saltBuf.writeBigInt64BE(0n, 0);
    const signatureBuf = writeVarInt(0); // Tanpa signature enkripsi (offline mode)
    const ackCountBuf = writeVarInt(0);

    const payload = Buffer.concat([msgBuf, timestampBuf, saltBuf, signatureBuf, ackCountBuf]);
    this._sendPacketRaw(PROTOCOL_STATES.PLAY, this.packetIds.play.toServer.chatMessage, payload);
    console.log(`💬 [Chat] Mengirim pesan: "${message}"`);
  }

  /**
   * Meminta server melakukan respawn setelah bot mati.
   * Paket Client Command, action 0 = Perform Respawn.
   */
  sendRespawn() {
    if (this.protocolState !== PROTOCOL_STATES.PLAY) return;
    const payload = writeVarInt(0);
    this._sendPacketRaw(PROTOCOL_STATES.PLAY, this.packetIds.play.toServer.clientCommand, payload);
    console.log('💚 [Respawn] Mengirim permintaan respawn setelah health mencapai 0.');
  }

  /**
   * Mengirim perintah serangan interaksi entitas (Attack Entity).
   * Paket ID baku 1.21.1: 0x16 (use_entity). Bisa dioverride lewat config.packetIds.
   * @param {number} targetEntityId ID numerik entitas target
   */
  sendAttack(targetEntityId) {
    if (this.protocolState !== PROTOCOL_STATES.PLAY) return;
    // Paket use_entity: [Entity ID (VarInt)] + [Type = 1 Attack (VarInt)] + [Sneaking = false (u8)]
    const entityBuf = writeVarInt(targetEntityId);
    const typeBuf = writeVarInt(1); // 1 = ATTACK
    const sneakingBuf = Buffer.from([0]); // false

    const payload = Buffer.concat([entityBuf, typeBuf, sneakingBuf]);
    this._sendPacketRaw(PROTOCOL_STATES.PLAY, this.packetIds.play.toServer.useEntity, payload);
  }
}

/**
 * Factory helper untuk membuat instance LiveProtocolClient baru.
 * @param {Partial<typeof DEFAULT_CLIENT_CONFIG>} [options={}]
 * @returns {LiveProtocolClient}
 */
function createLiveClient(options = {}) {
  return new LiveProtocolClient(options);
}

// Ekspor modul
module.exports = {
  LiveProtocolClient,
  createLiveClient,
  PacketFramer,
  CompressionHandler,
  querySLP,
  verifyBotOnline,
  PROTOCOL_STATES,
  CONNECTION_STATES,
  DEFAULT_CLIENT_CONFIG,
  DEFAULT_PACKET_IDS,
  writeVarInt,
  readVarInt,
  writeVarLong,
  readVarLong,
  writeString,
  readString,
  encodeMovementFlags,
  decodeMovementFlags,
  generateOfflineUuid,
  uuidToBuffer
};
