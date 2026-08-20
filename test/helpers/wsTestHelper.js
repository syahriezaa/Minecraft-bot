/**
 * Helper Pengujian Web Server & WebSocket untuk Minecraft Autonomous Companion.
 * Menyediakan server HTTP/WebSocket in-process untuk pengujian dashboard port 8080
 * dan klien uji WebSocket dengan antrean event asinkron.
 *
 * Mengimplementasikan protokol WebSocket native Node.js tanpa dependensi eksternal.
 * Dilengkapi dengan pelacakan soket aktif (socket tracking), penghancuran koneksi saat teardown,
 * dukungan port dinamis (port: 0 / ephemeral), serta mekanisme auto-retry / port increment jika EADDRINUSE.
 */

const http = require('node:http');
const EventEmitter = require('node:events');
const crypto = require('node:crypto');

class MockWebServer {
  /**
   * @param {number} [port=8080] - Port target (gunakan 0 untuk port dinamis ephemeral)
   * @param {Object} [options={}] - Opsi konfigurasi
   * @param {boolean} [options.autoRetry=false] - Otomatis mencoba port berikutnya jika EADDRINUSE
   * @param {number} [options.maxRetries=10] - Jumlah maksimal percobaan kenaikan port
   * @param {boolean} [options.fallbackToDynamic=false] - Fallback ke port 0 jika terjadi konflik
   */
  constructor(port = 8080, options = {}) {
    this.initialPort = port;
    this.port = port;
    this.options = {
      autoRetry: false,
      maxRetries: 10,
      fallbackToDynamic: false,
      ...options
    };
    this.server = null;
    this.sockets = new Set();  // Menyimpan seluruh active net.Socket (HTTP / TCP)
    this.clients = new Set();  // Menyimpan seluruh active WebSocket client wrapper
    this.auditLogs = [];
    this.lastState = {
      status: 'SIAP',
      level: 1,
      botPos: { x: 0, y: 64, z: 0 }
    };
  }

  getHttpUrl() {
    return `http://localhost:${this.port}`;
  }

  getWsUrl() {
    return `ws://localhost:${this.port}`;
  }

  getPort() {
    return this.port;
  }

  async start(overrideOptions = {}) {
    const opts = { ...this.options, ...overrideOptions };
    let attempt = 0;

    const tryListen = (portToTry) => {
      return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
          this._handleHttpRequest(req, res);
        });

        // Track semua incoming TCP sockets untuk pembersihan instan saat stop()
        server.on('connection', (socket) => {
          this.sockets.add(socket);
          socket.on('close', () => {
            this.sockets.delete(socket);
          });
          socket.on('error', () => {
            this.sockets.delete(socket);
          });
        });

        // Handle WebSocket upgrade
        server.on('upgrade', (req, socket, head) => {
          this._handleWsUpgrade(req, socket, head);
        });

        server.once('error', async (err) => {
          try {
            server.close();
          } catch (e) {}

          if (err.code === 'EADDRINUSE') {
            if (opts.autoRetry && attempt < opts.maxRetries) {
              attempt++;
              const nextPort = portToTry === 0 ? 0 : portToTry + 1;
              try {
                const res = await tryListen(nextPort);
                resolve(res);
              } catch (retryErr) {
                reject(retryErr);
              }
              return;
            } else if (opts.fallbackToDynamic && portToTry !== 0) {
              try {
                const res = await tryListen(0);
                resolve(res);
              } catch (dynamicErr) {
                reject(dynamicErr);
              }
              return;
            }
            reject(new Error(`Port ${portToTry} sudah digunakan oleh proses lain (EADDRINUSE).`));
          } else {
            reject(err);
          }
        });

        server.listen(portToTry, () => {
          this.server = server;
          const addr = server.address();
          if (addr && typeof addr === 'object') {
            this.port = addr.port;
          } else {
            this.port = portToTry;
          }
          resolve(this);
        });
      });
    };

    return tryListen(this.port);
  }

  _handleHttpRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <title>Minecraft Autonomous Companion - Dasbor Pengendali</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #13131A;
      --surface: #1A1A24;
      --surfaceAlt: #22222E;
      --accent: #6C63FF;
      --accentSoft: rgba(108, 99, 255, 0.15);
      --text-primary: #EAEAF0;
      --text-sub: #9999B0;
      --text-muted: #66667A;
      --border: #2A2A36;
      --success: #4CAF50;
      --danger: #EF5350;
      --warning: #FF9800;
    }
    body {
      font-family: 'Poppins', sans-serif;
      background-color: var(--bg);
      color: var(--text-primary);
      margin: 0;
      padding: 20px;
    }
    .header { font-size: 24px; font-weight: 700; margin-bottom: 20px; }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px; margin-bottom: 16px; }
    .btn { background: var(--accent); color: #fff; border: none; border-radius: 8px; padding: 10px 16px; font-family: 'Poppins', sans-serif; cursor: pointer; }
  </style>
</head>
<body>
  <div class="header">Dasbor Pengendali Bot Otonom</div>
  <div class="card">
    <h2>Status Sistem</h2>
    <div id="metric-status">Status: Siap Melayani</div>
    <div id="metric-speed">Kecepatan: 4.3 m/s</div>
    <div id="metric-recovery">Fase Pemulihan: 0 (Normal)</div>
    <button class="btn" id="btn-level-1">Mulai Tolak Ukur Level 1 (Medan Datar)</button>
    <button class="btn" id="btn-level-2">Mulai Tolak Ukur Level 2 (Rintangan)</button>
  </div>
  <div class="card">
    <h2>Terminal AI</h2>
    <div id="terminal-logs">Sistem AI siap menerima perintah dalam Bahasa Indonesia.</div>
  </div>
</body>
</html>`);
      return;
    }

    if (url.pathname === '/css/style.css') {
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
      res.end(`
        :root {
          --bg: #13131A;
          --surface: #1A1A24;
          --surfaceAlt: #22222E;
          --accent: #6C63FF;
          --text-primary: #EAEAF0;
        }
        body {
          font-family: 'Poppins', sans-serif;
          background-color: var(--bg);
          color: var(--text-primary);
        }
      `);
      return;
    }

    if (url.pathname === '/api/telemetry/live') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ sukses: true, data: this.lastState }));
      return;
    }

    if (url.pathname === '/api/telemetry/audit') {
      const actionFilter = url.searchParams.get('action');
      const filtered = actionFilter 
        ? this.auditLogs.filter(a => a.action === actionFilter)
        : this.auditLogs;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ sukses: true, data: filtered }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      sukses: false,
      error: {
        kode: 'TIDAK_DITEMUKAN',
        pesan: 'Endpoint tidak ditemukan pada server dasbor.'
      }
    }));
  }

  _handleWsUpgrade(req, socket, head) {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }

    const acceptKey = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`
    );

    const client = {
      socket,
      send: (data) => {
        const jsonStr = typeof data === 'string' ? data : JSON.stringify(data);
        const payload = Buffer.from(jsonStr, 'utf8');
        const len = payload.length;

        let header;
        if (len <= 125) {
          header = Buffer.from([0x81, len]);
        } else if (len <= 65535) {
          header = Buffer.alloc(4);
          header[0] = 0x81;
          header[1] = 126;
          header.writeUInt16BE(len, 2);
        } else {
          header = Buffer.alloc(10);
          header[0] = 0x81;
          header[1] = 127;
          header.writeBigUInt64BE(BigInt(len), 2);
        }

        try {
          if (!socket.destroyed) {
            socket.write(Buffer.concat([header, payload]));
          }
        } catch (e) {
          // ignore
        }
      }
    };

    this.clients.add(client);

    socket.on('data', (buf) => {
      this._handleWsFrame(buf, client);
    });

    socket.on('close', () => {
      this.clients.delete(client);
    });

    socket.on('error', () => {
      this.clients.delete(client);
    });
  }

  _handleWsFrame(buf, client) {
    if (buf.length < 2) return;
    const isMasked = Boolean(buf[1] & 0x80);
    let payloadLen = buf[1] & 0x7f;
    let offset = 2;

    if (payloadLen === 126) {
      payloadLen = buf.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLen === 127) {
      payloadLen = Number(buf.readBigUInt64BE(offset));
      offset += 8;
    }

    let mask = null;
    if (isMasked) {
      mask = buf.subarray(offset, offset + 4);
      offset += 4;
    }

    const payload = buf.subarray(offset, offset + payloadLen);
    if (mask) {
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= mask[i % 4];
      }
    }

    const msgStr = payload.toString('utf8');
    try {
      const parsed = JSON.parse(msgStr);
      if (parsed.action === 'START_BENCHMARK') {
        this.broadcast({
          type: 'BENCHMARK_STATUS',
          data: { level: parsed.level, status: 'RUNNING', progressPct: 0 }
        });
      } else if (parsed.action === 'SUBMIT_AI_COMMAND') {
        this.broadcast({
          type: 'AI_ACTION_EVENT',
          data: {
            task: 'EKSEKUSI_PERINTAH',
            step: 1,
            status: 'SUCCESS',
            details: 'Perintah berhasil diproses oleh AI Brain.'
          }
        });
      }
    } catch (e) {
      client.send({
        type: 'ERROR',
        data: { pesan: 'Format pesan WebSocket harus berupa JSON yang valid.' }
      });
    }
  }

  broadcast(message) {
    const data = typeof message === 'string' ? message : JSON.stringify(message);
    for (const client of this.clients) {
      client.send(data);
    }
  }

  recordAudit(action, item, count, chest_coord) {
    this.auditLogs.push({
      action,
      item,
      count,
      chest_coord,
      timestamp: new Date().toISOString()
    });
  }

  async stop() {
    // 1. Hancurkan semua soket WebSocket aktif
    for (const client of this.clients) {
      try {
        if (client.socket && !client.socket.destroyed) {
          client.socket.destroy();
        }
      } catch (e) {}
    }
    this.clients.clear();

    // 2. Hancurkan semua soket TCP/HTTP aktif (menghilangkan TIME_WAIT lingering)
    for (const socket of this.sockets) {
      try {
        if (!socket.destroyed) {
          socket.destroy();
        }
      } catch (e) {}
    }
    this.sockets.clear();

    // 3. Tutup server HTTP & putuskan koneksi tersisa
    if (this.server) {
      if (typeof this.server.closeAllConnections === 'function') {
        try {
          this.server.closeAllConnections();
        } catch (e) {}
      }
      await new Promise((resolve) => {
        this.server.close(() => resolve());
      });
      this.server = null;
    }
  }
}

class WsTestClient extends EventEmitter {
  /**
   * @param {string|number|MockWebServer} [target='ws://localhost:8080'] - URL WebSocket, nomor port, atau instance MockWebServer
   */
  constructor(target = 'ws://localhost:8080') {
    super();
    this.setUrl(target);
    this.ws = null;
    this.receivedEvents = [];
    // Default error listener agar tidak melempar ERR_UNHANDLED_ERROR
    this.on('error', () => {});
  }

  setUrl(target) {
    if (typeof target === 'string') {
      this.url = target.startsWith('ws://') || target.startsWith('wss://')
        ? target
        : `ws://${target}`;
    } else if (typeof target === 'number') {
      this.url = `ws://localhost:${target}`;
    } else if (target && typeof target.getWsUrl === 'function') {
      this.url = target.getWsUrl();
    } else if (target && typeof target.port === 'number') {
      this.url = `ws://localhost:${target.port}`;
    } else {
      this.url = 'ws://localhost:8080';
    }
    return this.url;
  }

  async connect() {
    return new Promise((resolve) => {
      try {
        this.ws = new WebSocket(this.url);

        this.ws.onopen = () => {
          resolve(this);
        };

        this.ws.onmessage = (event) => {
          try {
            const parsed = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
            this.receivedEvents.push(parsed);
            if (parsed && parsed.type) {
              this.emit(parsed.type, parsed.data);
            }
            this.emit('message', parsed);
          } catch (e) {
            // ignore non-json
          }
        };

        this.ws.onerror = (err) => {
          this.emit('ws_error', err);
        };

        this.ws.onclose = () => {
          this.emit('close');
        };

        setTimeout(() => {
          resolve(this);
        }, 500);
      } catch (err) {
        resolve(this);
      }
    });
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const payload = typeof data === 'string' ? data : JSON.stringify(data);
      this.ws.send(payload);
    }
  }

  async waitForEvent(type, timeoutMs = 5000) {
    const existing = this.receivedEvents.find(e => e.type === type);
    if (existing) return existing;

    return new Promise((resolve, reject) => {
      let timer = null;

      const onEvent = (data) => {
        if (timer) clearTimeout(timer);
        resolve({ type, data });
      };

      timer = setTimeout(() => {
        this.removeListener(type, onEvent);
        reject(new Error(`Timeout: Event "${type}" tidak diterima dalam ${timeoutMs}ms.`));
      }, timeoutMs);

      this.once(type, onEvent);
    });
  }

  async disconnect() {
    if (this.ws) {
      try {
        if (typeof this.ws.terminate === 'function') {
          this.ws.terminate();
        } else if (typeof this.ws.close === 'function') {
          this.ws.close();
        }
      } catch (e) {}
      this.ws = null;
    }
    this.removeAllListeners();
    this.on('error', () => {});
  }
}

module.exports = { MockWebServer, WsTestClient };
