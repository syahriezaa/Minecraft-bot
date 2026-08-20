/**
 * @file proposed_liveProtocolClient.js
 * @description Implementasi Klien Jaringan Protokol 775 Mandiri & Headless untuk Minecraft 26.1.2 / NeoForge.
 * Mendukung streaming TCP murni, packet framing, buffer accumulation, kompresi zlib,
 * transisi siklus hidup 4-state (Handshaking -> Login -> Configuration -> Play),
 * bitflags MovementFlags, respons keepalive instan, serta pemulihan koneksi otomatis.
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

const net = require('node:net');
const EventEmitter = require('node:events');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

// ==============================================================================
// 1. Konstanta Protokol & Status Siklus Hidup
// ==============================================================================

/**
 * Status Siklus Hidup Jaringan Protokol 775
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
  keepAliveResponseThresholdMs: 25000
});

// ==============================================================================
// 2. Utilitas Encoding & Decoding VarInt / VarLong
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

  // Jika byte ke-5 belum mengakhiri VarInt atau buffer terpotong di tengah jalan
  if ((b & 0x80) !== 0) {
    return null;
  }

  return { value, size };
}

/**
 * Menulis BigInt 64-bit ke dalam format VarLong Minecraft.
 * @param {bigint|number} value
 * @returns {Buffer}
 */
function writeVarLong(value) {
  let val = BigInt(value);
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
  let value = 0n;
  let size = 0;
  let b = 0;

  while (offset + size < buf.length && size < 10) {
    b = buf[offset + size];
    value |= BigInt(b & 0x7F) << BigInt(7 * size);
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
  const lenResult = readVarInt(buf, offset);
  if (!lenResult) return null;

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
// 5. LiveProtocolClient — Mesin Jaringan Protokol 775 Utama
// ==============================================================================

/**
 * @class LiveProtocolClient
 * @extends EventEmitter
 * @description Klien konektor live Minecraft Protokol 775 (Minecraft 26.1.2 / NeoForge)
 * yang mandiri dan headless. Menangani transisi state machine otomatis, detak jantung keepalive,
 * sinkronisasi posisi teleportasi, acknowledgements konfigurasi, dan pemulihan koneksi.
 */
class LiveProtocolClient extends EventEmitter {
  /**
   * @param {Partial<typeof DEFAULT_CLIENT_CONFIG>} [options={}]
   */
  constructor(options = {}) {
    super();

    // Gabungkan konfigurasi dengan nilai bawaan
    this.config = { ...DEFAULT_CLIENT_CONFIG, ...options };

    // Inisialisasi state internal
    this.protocolState = PROTOCOL_STATES.HANDSHAKING;
    this.connectionState = CONNECTION_STATES.DISCONNECTED;
    this.reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._keepAliveWatchdogTimer = null;
    this._lastKeepAliveTimestamp = Date.now();

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

    // Pemetaan ID paket Protokol 775 (Clientbound & Serverbound)
    this._initPacketMappings();
  }

  /**
   * Inisialisasi peta ID paket Protokol 775 untuk parsing cepat.
   * @private
   */
  _initPacketMappings() {
    // Packet ID untuk LOGIN state
    this.LOGIN_PACKETS_TO_CLIENT = {
      0x00: 'disconnect',
      0x01: 'encryption_begin',
      0x02: 'success',
      0x03: 'compress',
      0x04: 'login_plugin_request'
    };

    // Packet ID untuk CONFIGURATION state
    this.CONFIG_PACKETS_TO_CLIENT = {
      0x00: 'code_of_conduct',
      0x01: 'custom_payload',
      0x02: 'disconnect',
      0x03: 'finish_configuration',
      0x04: 'keep_alive',
      0x05: 'ping',
      0x06: 'reset_chat',
      0x07: 'registry_data',
      0x08: 'feature_flags',
      0x09: 'tags',
      0x0a: 'show_dialog'
    };

    // Packet ID untuk PLAY state (Kritis)
    this.PLAY_PACKETS_TO_CLIENT = {
      0x29: 'login', // join_game
      0x2b: 'keep_alive',
      0x40: 'position', // synchronize player position
      0x08: 'chunk_batch_start',
      0x0b: 'chunk_batch_finished',
      0x1b: 'disconnect',
      0x38: 'update_health'
    };
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

      this.emit('connecting', { host: this.config.host, port: this.config.port });
      console.log(`🌐 [Jaringan] Menghubungkan ke server ${this.config.host}:${this.config.port}...`);

      const socket = net.createConnection({
        host: this.config.host,
        port: this.config.port,
        timeout: this.config.socketTimeoutMs
      });

      this.socket = socket;
      socket.setNoDelay(true); // Nonaktifkan algoritma Nagle untuk latensi instan

      let isConnected = false;

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
        if (!isConnected) {
          reject(err);
        }
      });

      socket.on('timeout', () => {
        console.warn('⚠️ [Jaringan] Socket mengalami timeout tanpa aktivitas data.');
        this.emit('timeout');
        socket.destroy(new Error('Socket timeout'));
      });

      socket.on('close', (hadError) => {
        console.log(`🔌 [Jaringan] Koneksi socket terputus (hadError: ${hadError}).`);
        this.connectionState = CONNECTION_STATES.DISCONNECTED;
        this.emit('disconnect', { hadError });
        this.emit('end');

        if (this.config.autoReconnect) {
          this._scheduleReconnect();
        }
      });

      // Dengarkan event 'joined' untuk menyelesaikan promise connect()
      this.once('joined', () => {
        resolve();
      });
    });
  }

  /**
   * Menutup koneksi secara anggun (graceful disconnect).
   * @param {string} [reason='Client disconnected gracefully']
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
  // 6. Alur State Machine & Parsing Paket Inbound
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
   * Penanganan paket pada fase LOGIN.
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
      // UUID (16 bytes atau string UUID)
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
      // 0x00: Disconnect
      const reasonRes = readString(data, 0);
      const reason = reasonRes ? reasonRes.value : 'Alasan tidak diketahui';
      console.warn(`⚠️ [Autentikasi] Ditolak oleh server saat login: ${reason}`);
      this.emit('kicked', reason);
    }
  }

  /**
   * Penanganan paket pada fase CONFIGURATION.
   * @private
   */
  _handleConfigurationPacket(packetId, data) {
    if (packetId === 0x07) {
      // 0x07: Registry Data
      const regIdRes = readString(data, 0);
      if (regIdRes) {
        this.registries.set(regIdRes.value, true);
        this.emit('registry_data', { registry: regIdRes.value });
      }
    } else if (packetId === 0x04) {
      // 0x04: Keep Alive (Configuration)
      if (data.length >= 8) {
        const keepAliveId = data.readBigInt64BE(0);
        // Segera balas keepalive di fase konfigurasi (ID 0x03 pada config toServer)
        const respBuf = Buffer.alloc(8);
        respBuf.writeBigInt64BE(keepAliveId, 0);
        this._sendPacketRaw(PROTOCOL_STATES.CONFIGURATION, 0x03, respBuf);
        this.emit('keep_alive', keepAliveId);
      }
    } else if (packetId === 0x05) {
      // 0x05: Ping (Configuration)
      if (data.length >= 4) {
        const pingId = data.readInt32BE(0);
        // Balas pong (ID 0x04 pada config toServer)
        const respBuf = Buffer.alloc(4);
        respBuf.writeInt32BE(pingId, 0);
        this._sendPacketRaw(PROTOCOL_STATES.CONFIGURATION, 0x04, respBuf);
      }
    } else if (packetId === 0x03) {
      // 0x03: Finish Configuration dari Server
      console.log(`⚙️ [Konfigurasi] Fase konfigurasi selesai (Total ${this.registries.size} registri diterima). Mengirim konfirmasi...`);
      // Balas Finish Configuration (ID 0x02 pada config toServer)
      this._sendPacketRaw(PROTOCOL_STATES.CONFIGURATION, 0x02, Buffer.alloc(0));
      this._setState(PROTOCOL_STATES.PLAY);
      this.emit('configuration_finished');
    } else if (packetId === 0x02) {
      // 0x02: Disconnect (Configuration)
      const reasonRes = readString(data, 0);
      console.warn(`⚠️ [Konfigurasi] Terputus saat konfigurasi: ${reasonRes ? reasonRes.value : ''}`);
    }
  }

  /**
   * Penanganan paket pada fase PLAY.
   * @private
   */
  _handlePlayPacket(packetId, data) {
    if (packetId === 0x29) {
      // 0x29: Join Game / Login (Play)
      if (data.length >= 4) {
        this.entityId = data.readInt32BE(0);
        console.log(`🎮 [Play] Berhasil masuk ke dunia permainan! Entity ID: ${this.entityId}`);
        this.emit('joined', { entityId: this.entityId });
        this.emit('spawn');
      }
    } else if (packetId === 0x2b) {
      // 0x2b: Keep Alive (Play)
      if (data.length >= 8) {
        const keepAliveId = data.readBigInt64BE(0);
        this._lastKeepAliveTimestamp = Date.now();
        // Balas keepalive instan (ID 0x18 pada play toServer)
        const respBuf = Buffer.alloc(8);
        respBuf.writeBigInt64BE(keepAliveId, 0);
        this._sendPacketRaw(PROTOCOL_STATES.PLAY, 0x18, respBuf);
        this.emit('keep_alive', keepAliveId);
      }
    } else if (packetId === 0x40) {
      // 0x40: Synchronize Player Position (Teleport)
      if (data.length >= 40) {
        const x = data.readDoubleBE(0);
        const y = data.readDoubleBE(8);
        const z = data.readDoubleBE(16);
        const yaw = data.readFloatBE(24);
        const pitch = data.readFloatBE(28);
        // Baca teleportId VarInt pada offset tertentu
        const flags = data.readUInt8(32);
        const teleIdRes = readVarInt(data, 33);
        const teleportId = teleIdRes ? teleIdRes.value : 0;

        this.position = { x, y, z, yaw, pitch, onGround: true, hasHorizontalCollision: false };

        // Wajib balas teleport_confirm (ID 0x00 pada play toServer)
        const confirmBuf = writeVarInt(teleportId);
        this._sendPacketRaw(PROTOCOL_STATES.PLAY, 0x00, confirmBuf);

        // Kirim player_loaded (ID 0x28 pada play toServer)
        this._sendPacketRaw(PROTOCOL_STATES.PLAY, 0x28, Buffer.alloc(0));

        this.emit('teleport', { x, y, z, yaw, pitch, teleportId });
      }
    } else if (packetId === 0x08) {
      // 0x08: Chunk Batch Start
      this.emit('chunk_batch_start');
    } else if (packetId === 0x0b) {
      // 0x0b: Chunk Batch Finished
      // Balas chunk_batch_received dengan chunksPerTick = 10.0 (ID 0x07 pada play toServer)
      const ackBuf = Buffer.alloc(4);
      ackBuf.writeFloatBE(10.0, 0);
      this._sendPacketRaw(PROTOCOL_STATES.PLAY, 0x07, ackBuf);
      this.emit('chunk_batch_finished');
    } else if (packetId === 0x38) {
      // 0x38: Update Health
      if (data.length >= 8) {
        this.health = data.readFloatBE(0);
        const foodRes = readVarInt(data, 4);
        if (foodRes) this.food = foodRes.value;
        this.emit('health', { health: this.health, food: this.food });
      }
    }
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

  // ==============================================================================
  // 7. Pengiriman Paket Outbound (ToServer)
  // ==============================================================================

  /**
   * Memulai jabat tangan awal (Handshake) ke server.
   * @private
   */
  _startHandshake() {
    this._setState(PROTOCOL_STATES.HANDSHAKING);

    // Paket 0x00 Handshake: [Protocol Version (VarInt)] + [Server Host (String)] + [Server Port (u16)] + [NextState (VarInt: 2=Login)]
    const protoVerBuf = writeVarInt(this.config.protocolVersion);
    const hostBuf = writeString(this.config.host);
    const portBuf = Buffer.alloc(2);
    portBuf.writeUInt16BE(this.config.port, 0);
    const nextStateBuf = writeVarInt(2); // 2 = Login

    const handshakePayload = Buffer.concat([protoVerBuf, hostBuf, portBuf, nextStateBuf]);
    this._sendPacketRaw(PROTOCOL_STATES.HANDSHAKING, 0x00, handshakePayload);

    // Berpindah ke state LOGIN dan kirim Login Start
    this._setState(PROTOCOL_STATES.LOGIN);

    // Paket 0x00 Login Start: [Username (String)] + [UUID (16 bytes)]
    const usernameBuf = writeString(this.config.username);
    const uuidBuf = uuidToBuffer(this.uuid);
    const loginStartPayload = Buffer.concat([usernameBuf, uuidBuf]);
    this._sendPacketRaw(PROTOCOL_STATES.LOGIN, 0x00, loginStartPayload);
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

    this.socket.write(wireFrame);
  }

  /**
   * Mengirim pembaruan posisi pemain ke server menggunakan skema MovementFlags Protokol 775.
   * Paket ID: 0x1b (player_position_and_rotation) atau 0x1a (player_position)
   * @param {{ x: number, y: number, z: number, onGround?: boolean, hasHorizontalCollision?: boolean }} posData
   */
  sendPosition({ x, y, z, onGround = true, hasHorizontalCollision = false }) {
    if (this.protocolState !== PROTOCOL_STATES.PLAY) return;

    this.position.x = x;
    this.position.y = y;
    this.position.z = z;
    this.position.onGround = onGround;
    this.position.hasHorizontalCollision = hasHorizontalCollision;

    // Buffer posisi: x(f64) + y(f64) + z(f64) + flags(u8)
    const buf = Buffer.alloc(25);
    buf.writeDoubleBE(x, 0);
    buf.writeDoubleBE(y, 8);
    buf.writeDoubleBE(z, 16);
    buf.writeUInt8(encodeMovementFlags({ onGround, hasHorizontalCollision }), 24);

    this._sendPacketRaw(PROTOCOL_STATES.PLAY, 0x1a, buf);
  }

  /**
   * Mengirim pembaruan posisi dan rotasi pemain ke server dengan bitflags MovementFlags Protokol 775.
   * @param {{ x: number, y: number, z: number, yaw: number, pitch: number, onGround?: boolean, hasHorizontalCollision?: boolean }} data
   */
  sendPositionAndRotation({ x, y, z, yaw, pitch, onGround = true, hasHorizontalCollision = false }) {
    if (this.protocolState !== PROTOCOL_STATES.PLAY) return;

    this.position = { x, y, z, yaw, pitch, onGround, hasHorizontalCollision };

    // Buffer: x(f64) + y(f64) + z(f64) + yaw(f32) + pitch(f32) + flags(u8)
    const buf = Buffer.alloc(33);
    buf.writeDoubleBE(x, 0);
    buf.writeDoubleBE(y, 8);
    buf.writeDoubleBE(z, 16);
    buf.writeFloatBE(yaw, 24);
    buf.writeFloatBE(pitch, 28);
    buf.writeUInt8(encodeMovementFlags({ onGround, hasHorizontalCollision }), 32);

    this._sendPacketRaw(PROTOCOL_STATES.PLAY, 0x1b, buf);
  }

  /**
   * Mengirim pesan obrolan (chat) ke server.
   * @param {string} message
   */
  sendChat(message) {
    if (this.protocolState !== PROTOCOL_STATES.PLAY) return;
    // Paket chat player command / chat message
    const msgBuf = writeString(message);
    const timestampBuf = Buffer.alloc(8);
    timestampBuf.writeBigInt64BE(BigInt(Date.now()), 0);
    const saltBuf = Buffer.alloc(8);
    saltBuf.writeBigInt64BE(0n, 0);
    const signatureBuf = writeVarInt(0); // Tanpa signature enkripsi (offline mode)
    const ackCountBuf = writeVarInt(0);

    const payload = Buffer.concat([msgBuf, timestampBuf, saltBuf, signatureBuf, ackCountBuf]);
    this._sendPacketRaw(PROTOCOL_STATES.PLAY, 0x06, payload);
    console.log(`💬 [Chat] Mengirim pesan: "${message}"`);
  }

  /**
   * Mengirim perintah serangan interaksi entitas (Attack Entity).
   * @param {number} targetEntityId ID numerik entitas target
   */
  sendAttack(targetEntityId) {
    if (this.protocolState !== PROTOCOL_STATES.PLAY) return;
    // Paket 0x16 Interact: [Entity ID (VarInt)] + [Type = 1 Attack (VarInt)] + [Sneaking = false (u8)]
    const entityBuf = writeVarInt(targetEntityId);
    const typeBuf = writeVarInt(1); // 1 = ATTACK
    const sneakingBuf = Buffer.from([0]); // false

    const payload = Buffer.concat([entityBuf, typeBuf, sneakingBuf]);
    this._sendPacketRaw(PROTOCOL_STATES.PLAY, 0x16, payload);
  }
}

// Ekspor kelas dan utilitas
module.exports = {
  LiveProtocolClient,
  PacketFramer,
  CompressionHandler,
  PROTOCOL_STATES,
  CONNECTION_STATES,
  writeVarInt,
  readVarInt,
  writeVarLong,
  readVarLong,
  writeString,
  readString,
  encodeMovementFlags,
  decodeMovementFlags,
  generateOfflineUuid
};
