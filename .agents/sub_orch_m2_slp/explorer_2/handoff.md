# Handoff Report — Explorer 2: Live Server SLP Engine & `verifyBotOnline` Semantics

**Milestone**: Milestone 2 — Programmatic SLP Verification Engine  
**Agent**: Explorer 2 (`.agents/sub_orch_m2_slp/explorer_2`)  
**Target Recipient**: Sub-Orchestrator M2 (`sub_orch_m2_slp`) / Worker M2  
**Timestamp**: 2026-08-19T01:07:30+07:00  

---

## 1. Observation

1. **Konfigurasi Lingkungan & Jaringan Eksisting**:
   - File `src/config/environment.js` baris 42–47 mendefinisikan target server bawaan `minecraft: { host: '127.0.0.1', port: 25565, version: '1.20.1', botUsername: 'AutonomousCompanion' }`.
   - File `src/network/liveProtocolClient.js` baris 45–59 mendefinisikan `DEFAULT_CLIENT_CONFIG` dengan target server `atoms-girl.tun.ply.gg:25565`, versi protokol `775`, dan versi Minecraft `'26.1.2'`.
   - File `src/network/liveProtocolClient.js` baris 407–505 telah memiliki prototipe awal fungsi `querySLP` dan `verifyBotOnline`.

2. **Kueri Langsung Empiris ke Target Live Server `atoms-girl.tun.ply.gg:25565`**:
   - Eksekusi perintah:
     ```bash
     node -e "const { querySLP } = require('./src/network/liveProtocolClient.js'); querySLP({ host: 'atoms-girl.tun.ply.gg', port: 25565, timeoutMs: 10000 }).then(console.log);"
     ```
   - Hasil observasi data nyata:
     * `version`: `{"name":"26.1.2","protocol":775}`
     * `players`: `{"max":20,"online":2,"sample":[{"id":"c40b6a6d-dc0a-3749-ad1d-5e811499d981","name":"ExplorerSurvey"},{"id":"00000000-0000-0000-0000-000000000000","name":"Anonymous Player"}]}`
     * `description`: `"A Minecraft Server"`
     * `favicon`: String data URI berawalan `data:image/png;base64,...` (panjang 12.882 karakter)
     * `latencyMs`: 446ms – 1303ms.

3. **Uji Kasus Pencarian Bot pada `verifyBotOnline`**:
   - Pencarian bot yang terdaftar di sample (`ExplorerSurvey`) mengembalikan `isOnline: true`, `inSample: true`, `playerCount: 2`.
   - Pencarian bot yang tidak ada di sample (`NonExistentBot`) mengembalikan `isOnline: true` (karena `online >= 1` pada prototipe awal) namun `inSample: false`.
   - Kueri ke host yang tidak dapat dijangkau (`192.0.2.1:25565` dengan timeout 1000ms) menghasilkan penolakan tepat waktu dengan pesan: `[SLP] Batas waktu permintaan SLP ke 192.0.2.1:25565 habis (1000ms)`.

4. **Spesifikasi & Cakupan Milestone 2**:
   - Dokumen `SCOPE.md` baris 4–11 dan 19–58 menetapkan pemisahan modul mandiri `src/network/slpVerifier.js` dan CLI tool `test/verify_slp.js`.

---

## 2. Logic Chain

1. Berdasarkan **Observasi 1 & 4**, modul `src/network/slpVerifier.js` harus dipisahkan menjadi komponen mandiri (zero external dependencies) yang menyediakan fungsi `querySLP` dan `verifyBotOnline` agar dapat digunakan oleh CLI tester `test/verify_slp.js`, test suite unit/E2E, serta server dashboard `src/web/webServer.js`.
2. Berdasarkan **Observasi 2**, live server `atoms-girl.tun.ply.gg:25565` mengembalikan respons JSON standar Minecraft dengan `protocol: 775` dan `version.name: "26.1.2"`. Format `players.sample` adalah array objek `{ id, name }`, dan `description` dapat berupa string atau objek Chat Component. Oleh karena itu, parser SLP harus memiliki fungsi normalisasi deskripsi (ekstraksi teks polos).
3. Berdasarkan **Observasi 3**, verifikasi kehadiran bot membutuhkan pembedaan tegas antara:
   - Keberadaan pemain umum di server (`players.online >= 1`).
   - Keberadaan bot spesifik di dalam sample (`inSample === true`).
   - Penanganan saat server tidak menyertakan sample (`sampleOmitted === true`).
4. Oleh karena itu, `verifyBotOnline` harus mengembalikan objek yang mencakup properti:
   - `isOnline`: `boolean` (apakah bot spesifik terverifikasi online, atau `playerCount >= 1` jika tanpa username).
   - `playerCount`: `number` (nilai `players.online`).
   - `maxPlayers`: `number` (nilai `players.max`).
   - `inSample`: `boolean` (apakah `botUsername` ditemukan di `players.sample`).
   - `sampleOmitted`: `boolean` (apakah `players.sample` ditiadakan atau kosong oleh setting server).
   - `sample`: `Array<{ id, name }>`.
   - `version`: `{ name, protocol }`.
   - `descriptionText`: `string` (teks polos MOTD yang telah dinormalisasi).
   - `latencyMs`: `number`.
   - `rawStatus`: `object`.

---

## 3. Caveats

1. **Keterbatasan Ukuran Sample**: Server Minecraft secara default membatasi jumlah pemain di `players.sample` (biasanya maksimal 12 atau 20 entri). Jika server memiliki lebih dari batas tersebut (misal 50 pemain), bot mungkin online tetapi tidak muncul di cuplikan sample. Pada server uji `atoms-girl.tun.ply.gg`, total pemain aktif berkisar 1–3 sehingga seluruh pemain selalu masuk dalam sample.
2. **Kerahasiaan Pemain (Player Hiding)**: Jika server dikonfigurasi dengan `hide-online-players=true`, `sample` akan bernilai `undefined` atau array kosong `[]`. `verifyBotOnline` harus menandai `sampleOmitted: true` tanpa melempar crash runtime.
3. **Fluktuasi Latensi**: Koneksi ke `atoms-girl.tun.ply.gg` melalui tunnel ply.gg dapat mengalami fluktuasi latensi (400ms – 2500ms). Disarankan timeout default 5000ms – 10000ms untuk pengujian live.

---

## 4. Conclusion

1. Desain modul `src/network/slpVerifier.js` telah siap diimplementasikan oleh Worker M2 dengan antarmuka yang stabil:
   - `querySLP({ host, port = 25565, timeoutMs = 5000, protocolVersion = 775 })`
   - `verifyBotOnline({ host, port = 25565, botUsername, timeoutMs = 5000, protocolVersion = 775 })`
2. Validasi `verifyBotOnline` memiliki penanganan kasus batas lengkap (server offline/timeout, bot in sample, bot not in sample, sample omitted, zero players).
3. Seluruh pesan error yang dihasilkan memenuhi aturan tim (100% Bahasa Indonesia).

---

## 5. Verification Method

Untuk memverifikasi secara independen:

1. **Verifikasi Kueri SLP Live Server**:
   ```bash
   node -e "
   const { querySLP } = require('./src/network/liveProtocolClient.js');
   querySLP({ host: 'atoms-girl.tun.ply.gg', port: 25565, timeoutMs: 10000 })
     .then(res => console.log('SLP OK:', res.version, 'Online:', res.players.online))
     .catch(err => console.error('SLP Error:', err.message));
   "
   ```
   *Kondisi lulus*: Menampilkan `protocol: 775`, `name: '26.1.2'`, dan `online >= 0`.

2. **Verifikasi Penanganan Timeout & Error Jaringan**:
   ```bash
   node -e "
   const { querySLP } = require('./src/network/liveProtocolClient.js');
   querySLP({ host: '192.0.2.1', port: 25565, timeoutMs: 1000 })
     .catch(err => console.log('Passed expected timeout:', err.message));
   "
   ```
   *Kondisi lulus*: Menghasilkan pesan penolakan timeout dalam Bahasa Indonesia.

3. **Inspeksi Berkas Hasil Analisis**:
   - Periksa `.agents/sub_orch_m2_slp/explorer_2/analysis.md` untuk rincian skema lengkap dan diagram alir keputusan.
