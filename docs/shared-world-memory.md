# Memori dunia bersama

## Operasional

- Observer dipasang sekali per bot melalui `MineflayerRoleAdapter`: farmer, explorer,
  storage, guard, rancher, mob farm, builder, quarry, landscaper, dan survey.
- Membaca blok lokal dan event `blockUpdate`, bukan mencatat perintah sebagai sukses.
- Sampel sekitar bot: maksimal 567 posisi setiap 5 detik. Buffer dibatasi 4096 posisi.
- SQLite WAL menyerialkan transaksi antarproses pada host yang sama. File default:
  `data/shared-world.sqlite`. Jangan letakkan SQLite WAL di network filesystem.
- Memerlukan Node dengan `node:sqlite` (Node 22.13+); diverifikasi lokal pada Node 26.
  Pada runtime lama observer nonaktif. Worker tetap bekerja tanpa memori ini.
- `SHARED_WORLD_DB` mengatur file DB. Semua proses harus memakai path yang sama.
- `MC_WORLD_ID` wajib disamakan bila bot memakai alias alamat berbeda untuk dunia yang sama.
  Default identitas: host:port, dipisahkan lagi berdasarkan dimensi.
- `SHARED_WORLD_ENABLED=false` menonaktifkan observer.
- `GET /api/world-memory` menampilkan statistik dunia dan pengamat terakhir.
- Worker/dashboard yang sudah berjalan harus dimulai ulang untuk memuat kode baru.

## Semantik

Blok tidak diketahui menghasilkan null; udara hanya dicatat bila benar-benar terbaca.
Pengamatan lama tidak boleh mengganti pengamatan baru. Bukti berbeda pada timestamp
yang sama ditandai `needsResurvey`; data bukan jaminan kondisi dunia saat ini.
`getSharedBlock` menyediakan pembacaan untuk planner, tetapi aksi tetap harus
memverifikasi blok langsung. Data memori tidak dipakai sebagai pengganti dunia live.

Explorer memisahkan komponen terhubung XYZ, menyimpan voxel bukti, batas XYZ,
tingkat kepastian heuristik, dan revisi. Batas maksimum eksklusif. Bounding box
bukan representasi pasti ruangan. Observasi parsial memperluas bukti yang overlap,
tidak menghapus bagian yang belum terlihat. Air tidak otomatis disebut sungai.
Kelompok villager tidak otomatis disebut breeder atau iron farm.

Landmark lama tetap dibaca dari JSON. Pembaruan memakai exclusive lock dan atomic
rename. Lock sibuk menyebabkan tick gagal lalu diulang, bukan overwrite. Setelah
proses mati mendadak, lock yang tertinggal perlu diperiksa PID-nya dan dipulihkan
oleh operator saat semua writer berhenti; jangan menghapus lock aktif.

## LLM opsional

Default nonaktif. Klien khusus hanya meminta nama, tanpa tools, timeout 5 detik,
dan interval minimum 10 detik. Kegagalan kembali ke nama deterministik.
Konfigurasi backend melalui environment:

```dotenv
LANDMARK_LLM_ENABLED=false
LANDMARK_LLM_BASE_URL=https://ws-84zzha2fi52ai6a4.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1
LANDMARK_LLM_MODEL=
LANDMARK_LLM_API_KEY=
```

Isi ID model yang benar dari provider dan key pengganti melalui konfigurasi lokal,
bukan Git. Belum ada panggilan langsung ke provider dalam validasi ini.

## Batas implementasi

Ini fondasi pengamatan bersama, bukan pengenal semua bangunan. Pemisahan rumah yang
tersambung pagar, room/door graph, identitas villager bergerak, penghapusan otomatis
struktur rusak, klasifikasi breeder/trading hall, reservasi jalur kerja dan sinkronisasi
antarhost belum diimplementasikan. Metadata landmark dan DB blok belum satu transaksi.
Belum ada retention DB; pantau ukuran file selama survei jangka panjang.
