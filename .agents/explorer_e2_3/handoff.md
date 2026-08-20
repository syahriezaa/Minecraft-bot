# Handoff Report — explorer_e2_3
## Investigasi & Blueprint Solusi: Socket / Port Contention (Finding 4)

**Agent**: `explorer_e2_3` (Explorer / Read-Only Investigator)  
**Track**: E2E Testing Track (E2E Hardening Phase)  
**Milestone**: E2E Test Infra Hardening & Port Resilience  
**Working Directory**: `/Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/.agents/explorer_e2_3`  
**Artifacts**:
- `proposed_wsTestHelper.js`: `/Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/.agents/explorer_e2_3/proposed_wsTestHelper.js`
- `wsTestHelper.patch`: `/Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/.agents/explorer_e2_3/wsTestHelper.patch`

---

## 1. Observation

### A. Kondisi Aktual `test/helpers/wsTestHelper.js`

1. **Pelacakan Soket Tidak Lengkap (`MockWebServer` baris 13–24 & 291–302)**:
   ```javascript
   // test/helpers/wsTestHelper.js:17
   this.clients = new Set();
   
   // test/helpers/wsTestHelper.js:291-301
   async stop() {
     for (const client of this.clients) {
       try { client.socket.destroy(); } catch (e) {}
     }
     this.clients.clear();

     if (this.server) {
       await new Promise(r => this.server.close(r));
       this.server = null;
     }
   }
   ```
   - **Observasi**: `this.clients` hanya mencatat soket WebSocket yang berhasil melalui event `'upgrade'` (baris 142–204). Seluruh koneksi TCP HTTP biasa (misalnya dari `fetch('http://localhost:8081/')` atau `fetch('/api/telemetry/live')`) yang berada dalam status HTTP keep-alive tidak dicatat dalam koleksi apapun.
   - Pada pemanggilan `server.close()`, Node.js secara default membiarkan koneksi TCP keep-alive yang sudah ada tetap terbuka hingga timeout, menahan soket lokal dalam status `TIME_WAIT` atau `ESTABLISHED`, dan berpotensi memicu `listen EADDRINUSE: address already in use :::8081` pada eksekusi cepat berikutnya.

2. **Ketiadaan Dukungan Port Ephemeral Dinamis (`port = 0`) & Auto-Retry (`MockWebServer.prototype.start` baris 26–218)**:
   ```javascript
   // test/helpers/wsTestHelper.js:206-217
   this.server.on('error', (err) => {
     if (err.code === 'EADDRINUSE') {
       reject(new Error(`Port ${this.port} sudah digunakan oleh proses lain (EADDRINUSE).`));
     } else {
       reject(err);
     }
   });

   this.server.listen(this.port, () => {
     resolve(this);
   });
   ```
   - **Observasi**: Jika `port = 0` diberikan, kernel OS mengalokasikan ephemeral port acak (misal `54321`), tetapi properti `this.port` tidak diperbarui dari `this.server.address().port`, sehingga `this.port` tetap bernilai `0`.
   - Tidak ada mekanisme fallback port offset (misal mencoba `port + 1`, `port + 2`) atau fallback ke port dinamis (`port = 0`) jika port yang diminta mengalami bentrokan port/`EADDRINUSE`.

3. **Interaksi dengan Uji Negatif Boundary `T2-F01-01` (`test/e2e/tier2_boundary_corner.test.js` baris 60–67)**:
   ```javascript
   // test/e2e/tier2_boundary_corner.test.js:60-67
   suite.test('T2-F01-01: Konflik Port Server (Port Sudah Digunakan / EADDRINUSE)', async () => {
     const conflictingServer = new MockWebServer(8082);
     await rejects(
       conflictingServer.start(),
       /EADDRINUSE|sudah digunakan/i,
       'Harus menangkap error port konflik secara terkontrol.'
     );
   });
   ```
   - **Observasi**: Uji `T2-F01-01` secara eksplisit memverifikasi bahwa server menolak (`reject`) dengan error pesan `/EADDRINUSE|sudah digunakan/i` ketika terjadi konflik port. Oleh karena itu, opsi `autoRetry` tidak boleh mematikan kapabilitas penolakan error eksplisit saat mode default/strict diaktifkan.

4. **Kekakuan Konstruktor dan Target URL pada `WsTestClient` (`test/helpers/wsTestHelper.js` baris 304–313)**:
   ```javascript
   // test/helpers/wsTestHelper.js:304-308
   class WsTestClient extends EventEmitter {
     constructor(url = 'ws://localhost:8080') {
       super();
       this.url = url;
       this.ws = null;
   ```
   - **Observasi**: `WsTestClient` hanya menerima string URL statis. Jika `MockWebServer` beralih ke port dinamis atau port hasil auto-increment, instansiasi klien harus mengonstruksi ulang URL secara manual tanpa helper resolusi instans server (`new WsTestClient(webServer)` atau `wsClient.setUrl(target)`).

---

## 2. Logic Chain

1. **Premis A (Pembersihan Soket Komprehensif)**:
   - Berdasarkan Observasi 1.A.1, permintaan HTTP `fetch()` mempertahankan TCP keep-alive sockets yang tidak terlacak oleh `this.clients`.
   - Dengan menambahkan `this.sockets = new Set()` dan menyadap event `server.on('connection', (socket) => ...)`, setiap TCP socket dapat dipaksa putus via `socket.destroy()` serta memanggil `server.closeAllConnections()` saat `stop()`.
   - **Inferensi**: Ini mengeliminasi delay `TIME_WAIT` TCP kernel pada macOS/BSD/Linux dan menjamin pelepasan port segera secara deterministik.

2. **Premis B (Penyesuaian Ephemeral Port & Auto-Retry Terkontrol)**:
   - Berdasarkan Observasi 1.A.2, saat `server.listen(port)` berhasil dijalankan, membaca `this.server.address().port` akan mengaktualisasikan `this.port` ke port nyata (terutama saat `port = 0`).
   - Berdasarkan Observasi 1.A.3, agar `T2-F01-01` tetap lulus 100%, konfigurasi default `autoRetry` adalah `false`. Pengguna atau suite yang menginginkan auto-recovery terhadap `EADDRINUSE` dapat mengaktifkan opsi `{ autoRetry: true, maxRetries: 10, fallbackToDynamic: true }`.
   - **Inferensi**: Arsitektur opsi ini memberikan fleksibilitas penuh: deterministic test case boundary (`T2-F01-01`) tetap memvalidasi error handling, sementara eksekusi yang rentan port contention dapat mengaktifkan auto-fallback.

3. **Premis C (Polimorfisme Resolusi URL `WsTestClient`)**:
   - Berdasarkan Observasi 1.A.4, memperluas `WsTestClient.prototype.setUrl` untuk menerima `string`, `number` (port), atau `MockWebServer` (via method `getWsUrl()`) memastikan interoperabilitas mulus baik untuk pengujian port statis maupun port dinamis acak.

---

## 3. Caveats

1. **Batasan Investigasi (Read-Only)**:
   - Sesuai instruksi sistem dan peran `explorer`, tidak ada file produksi atau helper di `test/helpers/wsTestHelper.js` yang dimodifikasi langsung.
   - Seluruh artefak usulan solusi telah disiapkan secara lengkap dan presisi dalam direktori `.agents/explorer_e2_3/`:
     - Berkas pengganti: `.agents/explorer_e2_3/proposed_wsTestHelper.js`
     - Berkas diff patch: `.agents/explorer_e2_3/wsTestHelper.patch`
2. **Kesesuaian dengan Port Arena Headless**:
   - Port server Minecraft arena (`25565`–`25568`) pada `test/helpers/mockArenaHarness.js` adalah simulasi in-process berbasis event (`EventEmitter`), sehingga tidak mengikat soket raw TCP OS secara langsung dan tidak mengalami konflik soket OS. Masalah contention murni berpusat pada HTTP & WebSocket server di `test/helpers/wsTestHelper.js`.

---

## 4. Conclusion & Fix Blueprint

### A. Ringkasan Perubahan Desain

| Komponen | Implementasi Saat Ini | Blueprint Perbaikan Baru |
|---|---|---|
| **Pelacakan Soket** | Hanya `this.clients` (WS upgraded) | `this.sockets = new Set()` (Semua TCP/HTTP) + `this.clients = new Set()` (WS) |
| **Teardown `stop()`** | `client.socket.destroy()`, lalu `server.close()` | `client.socket.destroy()` + `socket.destroy()` + `server.closeAllConnections()` + `server.close()` |
| **Binding Port Ephemeral** | `this.port` tidak diperbarui saat `port = 0` | `this.port = this.server.address().port` |
| **Penanganan `EADDRINUSE`** | Rejection kaku tanpa opsi retry | Dukungan opsi configurable `{ autoRetry: false, maxRetries: 10, fallbackToDynamic: false }` |
| **Resolusi URL `WsTestClient`** | String URL kaku | `setUrl(target)` menerima string URL, nomor port, atau instance `MockWebServer` |
| **Helper URL Server** | Tidak ada | `getHttpUrl()`, `getWsUrl()`, `getPort()` |

---

### B. Blueprint Kode Terperinci

#### 1. `MockWebServer` (Kelas Server HTTP & WebSocket):
```javascript
class MockWebServer {
  constructor(port = 8080, options = {}) {
    this.initialPort = port;
    this.port = port;
    this.options = {
      autoRetry: false,          // Default false untuk kompatibilitas uji boundary T2-F01-01
      maxRetries: 10,            // Maksimum percobaan kenaikan port
      fallbackToDynamic: false,  // Fallback ke port ephemeral (0) jika port bentrok
      ...options
    };
    this.server = null;
    this.sockets = new Set();    // Pelacakan semua soket TCP/HTTP aktif
    this.clients = new Set();    // Pelacakan semua wrapper klien WebSocket
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

        // Track semua incoming TCP sockets untuk penghancuran instan saat stop()
        server.on('connection', (socket) => {
          this.sockets.add(socket);
          socket.on('close', () => this.sockets.delete(socket));
          socket.on('error', () => this.sockets.delete(socket));
        });

        // Upgrade listener untuk WebSocket
        server.on('upgrade', (req, socket, head) => {
          this._handleWsUpgrade(req, socket, head);
        });

        server.once('error', async (err) => {
          try { server.close(); } catch (e) {}

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

  async stop() {
    // 1. Hancurkan seluruh soket WebSocket aktif
    for (const client of this.clients) {
      try {
        if (client.socket && !client.socket.destroyed) {
          client.socket.destroy();
        }
      } catch (e) {}
    }
    this.clients.clear();

    // 2. Hancurkan seluruh soket TCP/HTTP aktif (membersihkan HTTP keep-alive)
    for (const socket of this.sockets) {
      try {
        if (!socket.destroyed) {
          socket.destroy();
        }
      } catch (e) {}
    }
    this.sockets.clear();

    // 3. Tutup server dan putuskan koneksi tersisa
    if (this.server) {
      if (typeof this.server.closeAllConnections === 'function') {
        try { this.server.closeAllConnections(); } catch (e) {}
      }
      await new Promise(r => this.server.close(r));
      this.server = null;
    }
  }
}
```

#### 2. `WsTestClient` (Klien Uji WebSocket Fleksibel):
```javascript
class WsTestClient extends EventEmitter {
  constructor(target = 'ws://localhost:8080') {
    super();
    this.setUrl(target);
    this.ws = null;
    this.receivedEvents = [];
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
```

---

## 5. Verification Method

### Langkah Verifikasi Penerapan:

1. **Inspeksi Berkas Usulan**:
   - Periksa `.agents/explorer_e2_3/proposed_wsTestHelper.js` dan `.agents/explorer_e2_3/wsTestHelper.patch`.
2. **Penerapan Patch**:
   ```bash
   patch -p0 test/helpers/wsTestHelper.js < .agents/explorer_e2_3/wsTestHelper.patch
   # atau salin proposed_wsTestHelper.js ke test/helpers/wsTestHelper.js
   ```
3. **Eksekusi Pengujian Penuh (Regression & Boundary Verification)**:
   ```bash
   # Verifikasi seluruh 163 kasus uji tetap 100% lulus
   node test/runner.js
   
   # Verifikasi khusus Tier 2 boundary kasus konflik port (T2-F01-01)
   node test/runner.js --tier 2 --filter "T2-F01-01"
   
   # Verifikasi Tier 2 multi-klien dan penutupan socket simultan (T2-F12-02, T2-F14-03)
   node test/runner.js --tier 2 --filter "T2-F12-02"
   node test/runner.js --tier 2 --filter "T2-F14-03"
   
   # Verifikasi eksekusi cepat berulang tanpa TIME_WAIT hang
   for i in {1..3}; do node test/e2e/e2e_telemetry_test.js; done
   ```
4. **Kondisi Invalidasi**:
   - Jika `T2-F01-01` gagal karena port otomatis berpindah saat uji konflik port dijalankan (dihindari dengan `autoRetry: false` secara default).
   - Jika proses pengujian menyisakan socket yang menggantung setelah teardown (dihindari dengan pemusnahan total `sockets.forEach(s => s.destroy())`).
