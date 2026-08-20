# Laporan Analisis Teknis Remediasi Codec — Explorer M1 Iterasi 2

**Peneliti**: Explorer M1 Iterasi 2 (`explorer_m1_iter2`)  
**Target Modul**: `src/network/liveProtocolClient.js` & `test/network/live_protocol_codecs.test.js`  
**Parent Agent**: Sub-Orchestrator M1 (`sub_orch_m1_protocol` / `63c0ad2d-488d-4c7b-967e-2664fb9ce50d`)  
**Status**: Analisis Selesai — Rekomendasi Presisi Siap Diterapkan oleh Worker 2.

---

## 1. Ringkasan Eksekutif

Berdasarkan temuan adversarial review dari Challenger 1 (`challenger_m1_1`), terdapat dua kelemahan implementasi pada fungsi codec jaringan di `src/network/liveProtocolClient.js`:
1. **CRITICAL**: `writeVarLong` mengalami infinite loop / `RangeError: Invalid array length` saat menerima nilai `BigInt` negatif (misal `-1n`, `-2147483648n`). Hal ini disebabkan oleh *arithmetic sign-extension* pada operator `>>` bawaan JavaScript `BigInt`.
2. **HIGH**: `readVarInt`, `readVarLong`, dan `readString` mengembalikan objek bernilai 0 dengan `size: 0` alih-alih `null` ketika buffer kosong (`Buffer.alloc(0)`) atau `offset >= buf.length`. Hal ini dapat memicu infinite loop pada parser stream yang memajukan kursor berdasarkan `result.size` (`offset += size`).

Laporan ini menyajikan akar masalah, bukti reproduksi empiris, rekomendasi perubahan kode *before-after* yang presisi untuk Worker 2, serta spesifikasi penambahan unit test pada `test/network/live_protocol_codecs.test.js`.

---

## 2. Analisis Mendalam Akar Masalah & Bukti Empiris

### Bug 1: `writeVarLong` Crash pada BigInt Negatif (CRITICAL)

#### Lokasi Kode Eksisting:
`src/network/liveProtocolClient.js:118-131`
```javascript
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
```

#### Mekanisme Kerusakan:
- Pada tipe data `BigInt` JavaScript, operasi shift kanan `val >>= 7n` mempertahankan tanda (*sign bit*).
- Untuk nilai negatif seperti `-1n`:
  - `-1n & ~0x7Fn` menghasilkan `-128n` (tidak pernah sama dengan `0n`).
  - `-1n >>= 7n` tetap bernilai `-1n`.
  - Loop `while (true)` berjalan tanpa henti dan terus melakukan `bytes.push()`, hingga V8 melemparkan eksepsi `RangeError: Invalid array length` saat panjang array melebihi $2^{32}-1$.
- Pada protokol Minecraft (LEB128 64-bit), angka negatif direpresentasikan dalam format two's complement 64-bit tak bertanda (*unsigned 64-bit*). Misalnya `-1n` direpresentasikan sebagai `0xFFFFFFFFFFFFFFFFn` (10 byte LEB128: `[0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x01]`).

#### Bukti Reproduksi Empiris:
Eksekusi `node .agents/challenger_m1_1/reproduce_bugs.js`:
```
Testing Bug 1: writeVarLong with negative BigInts
Attempting writeVarLong(-1n)...
Bug 1 Confirmed! Caught error: RangeError - Invalid array length
```

---

### Bug 2: `readVarInt`, `readVarLong`, & `readString` False Positive pada Buffer Kosong / OOB (HIGH)

#### Lokasi Kode Eksisting:
`src/network/liveProtocolClient.js:91-111` & `139-158`
```javascript
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
```

#### Mekanisme Kerusakan:
- Jika `buf` kosong (`buf.length === 0`) atau `offset >= buf.length`:
  - Kondisi loop `offset + size < buf.length` bernilai `false` pada iterasi ke-0. Loop tidak pernah dieksekusi.
  - Variabel `size` tetap `0`, `b` tetap `0`.
  - Pengecekan `(b & 0x80) !== 0` bernilai `false` karena `0 & 0x80 === 0`.
  - Fungsi mengeksekusi `return { value, size };` dan mengembalikan `{ value: 0, size: 0 }`.
- Dampak pada `readVarLong`: Mengembalikan `{ value: 0n, size: 0 }`.
- Dampak pada `readString`: Membaca `lenResult` sebagai `{ value: 0, size: 0 }`, sehingga mengembalikan `{ value: '', size: 0 }`.
- Dampak Fatal: Pada parser paket stream yang memajukan offset `offset += res.size`, pertambahan `+ 0` membuat offset tidak bergeser, berujung pada **infinite loop** pemrosesan paket. Selain itu, VarInt/VarLong valid minimal membutuhkan setidaknya 1 byte (`size >= 1`).

#### Bukti Reproduksi Empiris:
```
readVarInt(Buffer.alloc(0), 0) returned: { value: 0, size: 0 }
readVarLong(Buffer.alloc(0), 0) returned: { value: 0n, size: 0 }
readString(Buffer.alloc(0), 0) returned: { value: '', size: 0 }
```

---

## 3. Rekomendasi Kode Presisi untuk Worker 2

Worker 2 direkomendasikan untuk menerapkan perbaikan langsung pada `src/network/liveProtocolClient.js` sebagai berikut:

### 1. Perbaikan `writeVarLong` (`src/network/liveProtocolClient.js`)

**Before**:
```javascript
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
```

**After**:
```javascript
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
```

---

### 2. Perbaikan `readVarInt` (`src/network/liveProtocolClient.js`)

**Before**:
```javascript
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
```

**After**:
```javascript
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
```

---

### 3. Perbaikan `readVarLong` (`src/network/liveProtocolClient.js`)

**Before**:
```javascript
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
```

**After**:
```javascript
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
```

---

### 4. Perbaikan `readString` (`src/network/liveProtocolClient.js`)

**Before**:
```javascript
function readString(buf, offset = 0) {
  const lenResult = readVarInt(buf, offset);
  if (!lenResult) return null;

  const start = offset + lenResult.size;
  const end = start + lenResult.value;
  if (buf.length < end) return null;

  const value = buf.toString('utf8', start, end);
  return { value, size: lenResult.size + lenResult.value };
}
```

**After**:
```javascript
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
```

---

## 4. Spesifikasi Unit Test untuk `test/network/live_protocol_codecs.test.js`

Worker 2 wajib memperbarui suite uji `test/network/live_protocol_codecs.test.js` dengan menambahkan 3 assertion block baru pada `describe('1. Uji Encoding & Decoding VarInt / VarLong', ...)`:

```javascript
    it('harus mengkodekan dan mendekodekan VarLong negatif dan batas 64-bit secara presisi', () => {
      const negativeLongs = [
        -1n,
        -2n,
        -127n,
        -128n,
        -2147483648n,
        -9223372036854775808n, // Nilai minimum signed 64-bit
        9223372036854775807n,  // Nilai maksimum signed 64-bit
        0n,
        1n
      ];

      for (const val of negativeLongs) {
        const encoded = writeVarLong(val);
        assert.ok(encoded.length >= 1 && encoded.length <= 10, `Panjang VarLong (${encoded.length}) di luar 1..10 byte untuk ${val}`);
        
        const decoded = readVarLong(encoded, 0);
        assert.ok(decoded !== null, `VarLong gagal didekode untuk nilai ${val}`);
        assert.equal(decoded.value, val, `Nilai VarLong tidak cocok untuk ${val}`);
        assert.equal(decoded.size, encoded.length, `Ukuran size VarLong (${decoded.size}) != encoded.length (${encoded.length})`);
      }

      // Verifikasi eksplisit panjang byte two's complement untuk -1n (harus tepat 10 byte)
      const minusOneBuf = writeVarLong(-1n);
      assert.equal(minusOneBuf.length, 10, 'VarLong untuk -1n harus tepat 10 byte');
    });

    it('harus mengembalikan null pada buffer kosong atau offset out-of-bounds untuk readVarInt, readVarLong, dan readString', () => {
      const emptyBuf = Buffer.alloc(0);
      const dummyBuf = Buffer.from([0x01, 0x02]);

      // Buffer kosong
      assert.equal(readVarInt(emptyBuf, 0), null, 'readVarInt harus return null pada buffer 0-byte');
      assert.equal(readVarLong(emptyBuf, 0), null, 'readVarLong harus return null pada buffer 0-byte');
      assert.equal(readString(emptyBuf, 0), null, 'readString harus return null pada buffer 0-byte');

      // Offset out-of-bounds
      assert.equal(readVarInt(dummyBuf, 5), null, 'readVarInt harus return null pada offset out-of-bounds');
      assert.equal(readVarLong(dummyBuf, 5), null, 'readVarLong harus return null pada offset out-of-bounds');
      assert.equal(readString(dummyBuf, 5), null, 'readString harus return null pada offset out-of-bounds');
    });

    it('harus mengembalikan null untuk stream VarInt dan VarLong malformed yang melebihi batas byte maksimum', () => {
      // 5 byte VarInt dengan MSB aktif (tidak pernah terminasi)
      const malformedVarInt = Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80]);
      assert.equal(readVarInt(malformedVarInt, 0), null, 'VarInt 5-byte malformed harus return null');

      // 10 byte VarLong dengan MSB aktif (tidak pernah terminasi)
      const malformedVarLong = Buffer.alloc(10, 0x80);
      assert.equal(readVarLong(malformedVarLong, 0), null, 'VarLong 10-byte malformed harus return null');
    });
```

---

## 5. Rencana Verifikasi Kualitas

Setelah Worker 2 menerapkan perubahan di atas:
1. `node .agents/challenger_m1_1/reproduce_bugs.js` harus berjalan tanpa error, dengan `writeVarLong(-1n)` menghasilkan buffer panjang 10 byte, serta `readVarInt`, `readVarLong`, dan `readString` mengembalikan `null` pada buffer kosong.
2. `node .agents/challenger_m1_1/fuzz_codecs_stress.js` harus menghasilkan **28 PASS, 0 FAIL** (100% lulus).
3. `node --test test/network/*.test.js` harus lulus 100% mencakup pengujian codec dan pengujian integrasi live server.
