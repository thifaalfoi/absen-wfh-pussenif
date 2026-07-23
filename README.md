# Absen WFH — Pussenif (Web Responsif)

Aplikasi absen WFH (khusus hari Jumat) berbasis **web**, bukan aplikasi desktop lagi — jadi siapapun tinggal buka link dari browser HP atau laptop, tanpa install apa-apa.

Semuanya jadi satu server (Node.js + Express + SQLite):

- `/` → halaman absen (selfie + lokasi), responsif buat HP
- `/admin` → dashboard admin (rekap kehadiran + kelola daftar peserta)

## 1. Menjalankan server

```bash
cd backend
npm install
npm start
```

Server jalan di `http://localhost:3000`.

**Ganti kunci admin** dulu sebelum dipakai serius — buka `server.js`, ganti baris:

```js
const ADMIN_KEY = process.env.ADMIN_KEY || "ganti-kunci-ini";
```

atau jalankan dengan env var:

```bash
ADMIN_KEY=rahasiaku123 npm start
```

## 2. Cara pakai

- **Peserta**: buka `http://<alamat-server>:3000` di browser HP, pilih nama dari dropdown, nyalakan kamera, ambil selfie, kirim absen. Hanya bisa dikirim hari Jumat, dan 1x per hari per orang.
- **Admin**: buka `http://<alamat-server>:3000/admin`, masukkan kunci admin, lihat rekap + kelola daftar peserta terdaftar.

Server sudah diisi otomatis dengan 10 nama contoh (dari lembar Infolahta) saat `absen.db` pertama kali dibuat. Tambah/hapus peserta lain lewat dashboard admin.

## ⚠️ 3. PENTING: kamera & lokasi butuh HTTPS kalau diakses lewat jaringan

Ini yang paling sering bikin bingung: browser (terutama di HP) **memblokir akses kamera & lokasi** kalau halamannya dibuka lewat `http://` biasa — KECUALI dibuka di `localhost` (laptop yang sama dengan server).

Jadi kalau kamu coba dari HP ke laptop lewat WiFi kantor, misal buka `http://192.168.1.10:3000`, kemungkinan besar tombol "Nyalakan Kamera" bakal gagal / diblokir browser meskipun izinnya sudah dikasih.

**Solusi buat percobaan cepat (tanpa setup ribet):**
Pakai [ngrok](https://ngrok.com) atau [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) — keduanya bikin server lokal kamu bisa diakses lewat HTTPS publik dalam hitungan detik, gratis untuk skala kecil/percobaan.

```bash
# contoh pakai ngrok, setelah server npm start jalan di terminal lain:
ngrok http 3000
```

Nanti ngrok kasih URL seperti `https://xxxx.ngrok-free.app` — itu yang dibagikan ke anggota buat absen dari HP masing-masing.

**Solusi buat produksi/500+ orang (dipakai rutin, bukan cuma percobaan):**
Deploy server ini ke domain sendiri dengan HTTPS asli, misalnya:
- Pasang reverse proxy [Caddy](https://caddyserver.com) (otomatis HTTPS gratis lewat Let's Encrypt, tinggal beberapa baris config) di depan server Node ini.
- Atau deploy ke layanan seperti Railway/Render/VPS + Nginx+Certbot.

## 4. Catatan lain

- Satu orang hanya bisa absen **1x per hari**, dan nama harus ada di daftar peserta terdaftar (anti typo/nama palsu).
- Foto disimpan di `backend/uploads/`, data (nama, waktu, lat/lng) di `backend/absen.db` (SQLite, mode WAL, sudah pakai index — aman untuk skala 500+ orang).
- Untuk kebutuhan Pussenif yang dipakai rutin, sebaiknya:
  - Ganti sistem kunci admin sederhana dengan login user+password yang lebih aman.
  - Backup rutin `absen.db` dan folder `uploads/`.
  - Deploy pakai HTTPS asli (lihat poin 3).
