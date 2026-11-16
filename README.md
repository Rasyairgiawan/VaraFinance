# KendaliUang — Sistem Manajemen Keuangan Pribadi & Disiplin Finansial

Aplikasi kontrol keuangan pribadi berbasis web responsif, **Progressive Web App (PWA)**, dan proyek **Android (Capacitor)** berbahasa Indonesia dengan mata uang Rupiah (IDR).

---

## 1. Fitur Utama yang Diimplementasikan

- **Dashboard & Dana Aman Dibelanjakan (Safe-to-Spend)**:
  - Total aset seluruh akun, rincian saldo per tipe akun (tunai, bank, e-wallet, tabungan/investasi/bisnis), Safe-to-Spend tanpa penghitungan ganda, sisa anggaran harian/mingguan/bulanan, serta kalender ringkas aktivitas keuangan.
- **Mode Finansial Otomatis**:
  - Mengevaluasi otomatis **Mode Pemulihan**, **Mode Stabilisasi**, **Mode Menabung**, dan **Mode Pertumbuhan** berdasarkan kondisi aktual (bukan sekadar saldo) disertai penjelasan alasan.
- **Mesin Disiplin Finansial & Evaluasi Konsumtif**:
  - Peringatan bertingkat (*Normal*, *Peringatan*, *Kritis*, *Peringatan Pemulihan*), gerbang konfirmasi alasan tertulis saat melampaui batas aman, evaluasi transaksi **Rokok, Nongkrong, dan Jajan**, serta **Hari Tanpa Jajan (No-Spend Day)** dengan konfirmasi manual eksplisit.
- **Kalender Keuangan & Pengingat**:
  - Kalender bulanan yang menampilkan pemasukan aktual, pengeluaran, jatuh tempo utang, jadwal kewajiban rutin, jadwal pembayaran freelance, setoran tabungan, serta pengingat yang dapat diatur dan dinonaktifkan pengguna.
- **Manajemen Proyek Freelance Website**:
  - Memisahkan omzet kontrak, pembayaran berstatus *Diharapkan* vs *Diterima*, biaya operasional proyek (domain/hosting/API) yang dipotong sebelum perhitungan profit bersih, serta pembagian jatah bisnis vs pribadi.
- **Utang, Kewajiban Jangka Panjang & Target Tabungan**:
  - Mendukung kewajiban sementara, rutin tanpa batas waktu, rutin dengan batas waktu, dan sekali bayar lengkap dengan status (*Aktif*, *Ditangguhkan*, *Selesai*, *Dibatalkan*), riwayat pembayaran, penghentian alokasi otomatis saat berakhir, dan pengalihan alokasi ke tujuan tabungan lain.
- **Multi-Akun, Transfer & Backup/Restore**:
  - Pembuatan, pengeditan, dan penghapusan tervalidasi untuk akun Tunai, Bank, E-Wallet, Tabungan, Kas Bisnis, dan Investasi. Ekspor & Pulihkan (Restore) JSON dengan validasi skema.
- **PWA & Offline-First**:
  - Service worker (`vite-plugin-pwa`), Web App Manifest, ikon PNG (`192x192`, `512x512`, `maskable`, `apple-touch-icon`), tombol install di dalam aplikasi, serta indikator offline.

---

## 2. Konfigurasi Supabase (Cloud Database & Auth)

Aplikasi ini menyertakan skema PostgreSQL lengkap beserta **Row Level Security (RLS)** di:
- `supabase/migrations/0001_initial_schema.sql`
- `supabase/migrations/0002_long_term_obligations_and_calendar.sql`

### Langkah Setup Supabase (Gratis / Free Tier):
1. Buat proyek baru di [Supabase](https://supabase.com/).
2. Buka **SQL Editor** di dashboard Supabase, lalu jalankan isi file `supabase/migrations/0001_initial_schema.sql` dan dilanjutkan dengan `supabase/migrations/0002_long_term_obligations_and_calendar.sql`.
3. Buka **Project Settings → API** dan salin:
   - `Project URL` → masukkan ke `VITE_SUPABASE_URL`
   - `anon public key` → masukkan ke `VITE_SUPABASE_ANON_KEY`
4. Buat file `.env` di root proyek (mengacu pada `.env.example`):
   ```env
   VITE_SUPABASE_URL="https://YOUR_PROJECT.supabase.co"
   VITE_SUPABASE_ANON_KEY="YOUR_SUPABASE_ANON_KEY"
   ```
   > **Keamanan:** Jangan pernah memasukkan `service_role` key ke kode frontend atau file `.env` dengan prefix `VITE_`.
5. Jika kredensial belum diisi, aplikasi otomatis berjalan jujur dalam **Mode Lokal / Demo (Offline-First)** menggunakan penyimpanan perangkat (`localStorage`) tanpa mengklaim sinkronisasi cloud aktif.

---

## 3. Menjalankan Web App & PWA

```bash
# Install dependensi
npm install

# Jalankan mode pengembangan (port 3000)
npm run dev

# Jalankan pengujian skenario otomatis (Vitest)
npx vitest run

# Build produksi Web + PWA
npm run build
```

### Deploy Web Gratis (Cloudflare Pages):
1. Hubungkan repositori GitHub ke **Cloudflare Pages**.
2. Set build command: `npm run build` dan output directory: `dist`.
3. Tambahkan environment variables `VITE_SUPABASE_URL` dan `VITE_SUPABASE_ANON_KEY` di pengaturan Cloudflare Pages.

---

## 4. Proyek Android (Capacitor) & Build APK

Proyek Android Capacitor telah disiapkan di direktori `android/` (konfigurasi di `capacitor.config.ts`).

### Sinkronisasi Web ke Android:
```bash
npm run build
npx cap sync android
```

### Build Android Debug APK (membutuhkan JDK 17+ dan Android SDK):
```bash
cd android
./gradlew assembleDebug
```
Hasil APK akan berada di:
`android/app/build/outputs/apk/debug/app-debug.apk`

Atau buka folder `android/` di **Android Studio** dan pilih **Build → Build Bundle(s) / APK(s) → Build APK(s)**.
