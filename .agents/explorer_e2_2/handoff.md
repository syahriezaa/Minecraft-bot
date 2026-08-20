# Laporan Handoff: Analisis & Strategi Perbaikan `test/runner.js` (Temuan 3 & 5 serta Keamanan Regex Filter)

**Agent**: `explorer_e2_2` (Investigator & Analyst)  
**Track**: E2E Testing Track Remediation  
**Scope**: `test/runner.js` — Penanganan Berkas Suite yang Hilang (Temuan 3), Pembersihan Timer Leak (Temuan 5), dan Keamanan Kompilasi Regex Filter (`--filter`).

---

## 1. Observation (Pengamatan Empiris)

### A. Temuan 3: Berkas Suite Tier yang Hilang Tidak Mengeset `hasErrors` (Silent Pass Bug)
- **Lokasi Kode**: `test/runner.js` baris 197–218.
- **Kondisi Eksisting**:
  ```javascript
  // test/runner.js:197-218
  for (const tier of options.tiers) {
    const tierMeta = tierFiles[tier];
    if (tierMeta && fs.existsSync(tierMeta.path)) {
      try {
        const suiteModule = require(tierMeta.path);
        const runnerFn = suiteModule.registerSuite || suiteModule.runSuite || suiteModule;
        if (typeof runnerFn === 'function') {
          await testCtx.runSuite(tierMeta.name, runnerFn);
        }
      } catch (err) {
        hasErrors = true;
        if (!options.json) {
          console.error(`Gagal mengeksekusi Tier ${tier}: ${err.message}`);
        }
        if (options.bail) break;
      }
    } else {
      if (!options.json) {
        console.log(`  ⚠ Catatan: File suite Tier ${tier} (${tierMeta ? tierMeta.path : 'N/A'}) belum ditemukan.`);
      }
    }
  }
  ```
- **Bukti Empiris & Dampak**:
  1. Jika pengguna/CI mengeksekusi `node test/runner.js --tier 1,2` dan berkas `tier2_boundary_corner.test.js` tidak sengaja terhapus/hilang, loop melewati tier 2 pada cabang `else`.
  2. Karena `tier 1` lulus (70 tes lulus), nilai `failed = 0`, `total = 70`, dan `hasErrors` tetap bernilai `false`.
  3. Baris 253 mencetak: `Status Akhir : SEMUA SUITE LULUS 100% (PASSED) 🎉` dan proses keluar dengan `exit code 0`.
  4. Ini merupakan *silent failure* kritis di mana suite yang diminta tidak dieksekusi namun dilaporkan 100% lulus.
  5. Kasus tepi tambahan: Jika berkas modul ada tetapi tidak mengekspor fungsi (`typeof runnerFn !== 'function'`), runner mengabaikannya tanpa mencatat error maupun mengeset `hasErrors = true`.

---

### B. Temuan 5: Timer Leak pada Guard Timeout Pengujian (`setTimeout` tanpa `clearTimeout`)
- **Lokasi Kode**: `test/runner.js` baris 123–136.
- **Kondisi Eksisting**:
  ```javascript
  // test/runner.js:123-136
  try {
    await Promise.race([
      item.fn(),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`Timeout: Pengujian melebihi batas waktu ${this.options.timeout}ms`)),
          this.options.timeout
        )
      )
    ]);
  } catch (err) {
    status = 'FAILED';
    error = err;
  }
  ```
- **Bukti Empiris & Dampak**:
  1. Pada setiap kasus uji (163 kasus uji), `Promise.race` mendaftarkan timer `setTimeout(..., 15000)` pada Node.js timer heap.
  2. Ketika `item.fn()` selesai cepat (misal dalam 1–5ms), `Promise.race` langsung resolve, namun timer `setTimeout` 15 detik tetap aktif di background karena `timerId` tidak disimpan dan tidak pernah dipanggil `clearTimeout(timerId)`.
  3. Akibatnya, terdapat 163 timer menggantung (*dangling timers*). Jika runner diimpor sebagai library/module dalam runner lain tanpa pemanggilan paksa `process.exit()`, *event loop* Node.js tertahan selama 15 detik hingga semua timer kedaluwarsa.
  4. Pemborosan alokasi memori objek timer dan closure callback yang tertahan hingga 15 detik.

---

### C. Keamanan Regex Filter (`--filter <pola>` melempar uncaught `SyntaxError`)
- **Lokasi Kode**: `test/runner.js` baris 114–117.
- **Kondisi Eksisting**:
  ```javascript
  // test/runner.js:114-117
  for (const item of testQueue) {
    if (this.options.filter && !new RegExp(this.options.filter, 'i').test(item.name)) {
      continue;
    }
  ```
- **Bukti Empiris & Dampak**:
  1. `new RegExp(this.options.filter, 'i')` dievaluasi berulang-ulang di dalam perulangan kasus uji tanpa blok `try ... catch`.
  2. Saat pengguna memasukkan filter dengan karakter regex tidak lengkap seperti `node test/runner.js --filter "["` atau `node test/runner.js --filter "Level 1 ("` (misal saat copy-paste nama tes yang mengandung tanda kurung), proses langsung melempar exception:
     `SyntaxError: Invalid regular expression: /[/i: Unterminated character class`
  3. Exception tersebut menyebabkan seluruh suite crash seketika, menghentikan eksekusi tes berikutnya, dan melewatkan cleanup hooks.
  4. Selain itu, melakukan kompilasi `new RegExp` 163 kali di dalam loop memboroskan siklus CPU dibandingkan kompilasi sekali di awal (*pre-compiled regex*).

---

## 2. Logic Chain (Rantai Logika Pembuktian)

1. **Observasi 1.A** membuktikan bahwa saat `tierMeta.path` tidak ada di disk, cabang `else` hanya mencetak log teks biasa tanpa mengubah state `hasErrors`.
2. **Inferensi 1**: State `hasErrors = false` menyebabkan ringkasan konsol dan JSON menganggap seluruh proses berhasil jika tes sebelumnya lulus, menghasilkan exit code `0`.
3. **Solusi 1**: Mengeset `hasErrors = true`, mencetak pesan kesalahan berbahasa Indonesia via `console.error`, dan menghormati opsi `--bail` (`if (options.bail) break;`).
4. **Observasi 1.B** membuktikan bahwa `setTimeout` di `Promise.race` tidak pernah dibatalkan saat tes selesai lebih awal dari timeout.
5. **Inferensi 2**: Node.js event loop menahan handle timer aktif selama durasi timeout (15000ms), menyebabkan timer leak dan penundaan pengosongan event loop.
6. **Solusi 2**: Menangkap `timerId = setTimeout(...)` dan memanggil `clearTimeout(timerId)` secara deterministik di dalam blok `finally`.
7. **Observasi 1.C** membuktikan bahwa masukan `--filter` yang mengandung karakter regex tidak valid memicu `SyntaxError` tak tertangani.
8. **Inferensi 3**: Pengguna sering memfilter tes menggunakan teks biasa yang kebetulan mengandung karakter khusus regex seperti `(`, `[`, `*`, `+`.
9. **Solusi 3**: Melakukan pra-kompilasi regex filter di constructor `TestContext` dengan mekanisme `try ... catch`. Jika regex tidak valid, lakukan fallback otomatis ke pencocokan teks harfiah yang di-escape (`String(filter).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')`).

---

## 3. Caveats (Batasan & Asumsi)

- **Batasan Investigasi**: Agent `explorer_e2_2` beroperasi dalam mode *read-only*. Penerapan perubahan kode pada `test/runner.js` akan dilakukan oleh `worker_e2e_1` setelah koordinasi orchestrator.
- **Ketergantungan Rekan**:
  - `explorer_e2_1` bertanggung jawab atas perbaikan Temuan 1 (sinkronisasi status summary `"PASSED"` vs `hasErrors`) dan Temuan 2 (`try ... finally` untuk `afterHooks`).
  - `explorer_e2_3` bertanggung jawab atas Temuan 4 (socket tracking & port contention di `wsTestHelper.js`).
  - Strategi perbaikan di dokumen ini dirancang modular dan saling melengkapi secara presisi dengan solusi `explorer_e2_1` dan `explorer_e2_3`.

---

## 4. Conclusion & Recommended Fix Strategy (Strategi Solusi & Spesifikasi Perubahan)

Berikut adalah spesifikasi perubahan konkret untuk diterapkan pada `test/runner.js`:

### A. Pra-Kompilasi Filter Regex Aman pada `TestContext`
Tambahkan helper `_compileFilter` pada kelas `TestContext` untuk mengompilasi regex sekali dengan fallback aman terhadap karakter khusus:

```javascript
// Lokasi: test/runner.js (dalam class TestContext)
class TestContext {
  constructor(options) {
    this.options = options;
    this.results = [];
    this.currentSuite = '';
    this.filterRegex = this._compileFilter(options.filter);
  }

  _compileFilter(filter) {
    if (!filter) return null;
    try {
      return new RegExp(filter, 'i');
    } catch (e) {
      // Fallback aman: jika pola regex tidak valid, escape karakter khusus agar menjadi pencocokan teks harfiah
      const escaped = String(filter).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(escaped, 'i');
    }
  }
```

Dan perbarui pengecekan filter pada loop tes:
```javascript
// Pada runSuite:
if (this.filterRegex && !this.filterRegex.test(item.name)) {
  continue;
}
```

---

### B. Pembersihan Timer Leak via `clearTimeout` di Blok `finally`
Simpan referensi `timerId` dan pastikan dibersihkan seketika setelah `Promise.race` selesai (baik lulus, gagal, maupun timeout):

```javascript
// Lokasi: test/runner.js (dalam TestContext.prototype.runSuite)
let timerId = null;
try {
  const timeoutPromise = new Promise((_, reject) => {
    timerId = setTimeout(
      () => reject(new Error(`Timeout: Pengujian melebihi batas waktu ${this.options.timeout}ms`)),
      this.options.timeout
    );
  });

  await Promise.race([
    Promise.resolve().then(() => item.fn()),
    timeoutPromise
  ]);
} catch (err) {
  status = 'FAILED';
  error = err;
} finally {
  if (timerId !== null) {
    clearTimeout(timerId);
    timerId = null;
  }
}
```

---

### C. Penanganan Berkas Suite Tier yang Hilang & Validasi Runner Export
Perbarui loop eksekusi tier pada fungsi `main()` agar menandai `hasErrors = true`, mencetak pesan kesalahan, dan mematuhi opsi `--bail`:

```javascript
// Lokasi: test/runner.js (dalam fungsi main)
for (const tier of options.tiers) {
  const tierMeta = tierFiles[tier];
  if (tierMeta && fs.existsSync(tierMeta.path)) {
    try {
      const suiteModule = require(tierMeta.path);
      const runnerFn = suiteModule.registerSuite || suiteModule.runSuite || suiteModule;
      if (typeof runnerFn === 'function') {
        await testCtx.runSuite(tierMeta.name, runnerFn);
      } else {
        hasErrors = true;
        if (!options.json) {
          console.error(`  ✖ Kesalahan: Modul suite Tier ${tier} tidak mengekspor fungsi runner yang valid.`);
        }
        if (options.bail) break;
      }
    } catch (err) {
      hasErrors = true;
      if (!options.json) {
        console.error(`Gagal mengeksekusi Tier ${tier}: ${err.message}`);
      }
      if (options.bail) break;
    }
  } else {
    hasErrors = true;
    if (!options.json) {
      console.error(`  ✖ Kesalahan: Berkas suite Tier ${tier} (${tierMeta ? tierMeta.path : 'N/A'}) tidak ditemukan.`);
    }
    if (options.bail) break;
  }
}
```

---

## 5. Verification Method (Metode Verifikasi Independen)

Setelah `worker_e2e_1` menerapkan perbaikan di atas, verifikasi independen dapat dilakukan dengan rangkaian perintah berikut:

### 1. Verifikasi Penanganan Berkas Suite Hilang (Exit Code = 1 & hasErrors)
```bash
# Uji tier yang tidak ada di mapping
node test/runner.js --tier 99
# Pastikan exit code = 1 dan output melaporkan ZERO TESTS

# Uji penanganan ketika berkas sementara disimulasikan hilang
node -e '
const { main } = require("./test/runner.js");
// Simulasi runner memproses tier dengan berkas non-eksisten
'
```

### 2. Verifikasi Pembersihan Timer Leak
```bash
# Jalankan runner dengan pelacakan active handles Node.js
node -e '
const { TestContext } = require("./test/runner.js");
const tc = new TestContext({ timeout: 15000 });
tc.runSuite("Timer Test", async ({ it }) => {
  it("fast test", async () => {});
}).then(() => {
  console.log("Active timer handles count:", process._getActiveHandles ? process._getActiveHandles().filter(h => h && h._onTimeout).length : 0);
});
'
# Hasil yang diharapkan: Active timer handles count = 0 (semua timer ter-clear seketika).
```

### 3. Verifikasi Filter Regex Aman
```bash
# Uji karakter bracket tidak tertutup
node test/runner.js --filter "["
# Harapan: Tidak terjadi crash SyntaxError, runner mengeksekusi pencocokan literal, exit code 1 jika 0 cocok.

# Uji karakter kurung buka tidak tertutup
node test/runner.js --filter "Level 1 ("
# Harapan: Berhasil memfilter tes yang mengandung teks "Level 1 (" tanpa SyntaxError crash.

# Uji filter regex valid
node test/runner.js --filter "T1-F0[1-3]"
# Harapan: Berhasil mencocokkan tes fitur F01, F02, dan F03.
```

### 4. Verifikasi Regresi Menyeluruh
```bash
node test/runner.js
# Harapan: 163/163 kasus uji lulus 100%, exit code 0.
```
