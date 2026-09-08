// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "ganti-kunci-ini";
const FONNTE_TOKEN = process.env.FONNTE_TOKEN || "";
const CRON_SECRET = process.env.CRON_SECRET || "";

const UPLOAD_DIR = process.env.VERCEL ? "/tmp/uploads" : path.join(__dirname, "uploads");

if (!fs.existsSync(UPLOAD_DIR)) {
  try {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  } catch (e) {
    console.error("Gagal membuat folder upload:", e);
  }
}

const JAM_BUKA = { jam: 6, menit: 30 };
const JAM_BATAS_TERLAMBAT = { jam: 8, menit: 0 };

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  ssl: process.env.DB_SSL === "true" || process.env.VERCEL ? { rejectUnauthorized: false } : undefined,
});

async function tambahKolomJikaBelumAda(tabel, kolom, definisi) {
  try {
    await pool.query(`ALTER TABLE ${tabel} ADD COLUMN ${kolom} ${definisi}`);
  } catch (err) {
    if (err.code !== "ER_DUP_FIELDNAME") throw err;
  }
}

async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS peserta (
        id VARCHAR(36) PRIMARY KEY,
        nama_lengkap VARCHAR(255) NOT NULL UNIQUE
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS absen (
        id VARCHAR(36) PRIMARY KEY,
        nama VARCHAR(255) NOT NULL,
        waktu VARCHAR(40) NOT NULL,
        lat DOUBLE,
        lng DOUBLE,
        akurasi DOUBLE,
        foto_path VARCHAR(255) NOT NULL,
        status VARCHAR(50),
        kegiatan VARCHAR(255),
        kegiatan_catatan TEXT,
        INDEX idx_absen_waktu (waktu),
        INDEX idx_absen_nama (nama)
      )
    `);

    // Log audit — mencatat setiap aksi admin (update/hapus/tambah manual/ubah status)
    // supaya ada jejak "apa yang berubah dan kapan".
    await pool.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id VARCHAR(36) PRIMARY KEY,
        waktu VARCHAR(40) NOT NULL,
        aksi VARCHAR(50) NOT NULL,
        target_nama VARCHAR(255),
        detail TEXT,
        INDEX idx_audit_waktu (waktu)
      )
    `);

    // Mencegah reminder WA terkirim dobel ke orang yang sama di hari yang sama
    // (misal kalau cron job ke-trigger lebih dari sekali).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS reminder_terkirim (
        id VARCHAR(36) PRIMARY KEY,
        nama VARCHAR(255) NOT NULL,
        tanggal VARCHAR(10) NOT NULL,
        jenis VARCHAR(20) NOT NULL,
        waktu VARCHAR(40) NOT NULL,
        UNIQUE KEY uniq_reminder (nama, tanggal, jenis)
      )
    `);

    await tambahKolomJikaBelumAda("peserta", "nrp", "VARCHAR(50)");
    await tambahKolomJikaBelumAda("peserta", "jenis", "VARCHAR(10)");
    await tambahKolomJikaBelumAda("peserta", "bagian", "VARCHAR(150)");
    await tambahKolomJikaBelumAda("peserta", "jabatan", "VARCHAR(150)");
    await tambahKolomJikaBelumAda("peserta", "tempat", "VARCHAR(50)");
    await tambahKolomJikaBelumAda("peserta", "dibuat_pada", "VARCHAR(40)");
    await tambahKolomJikaBelumAda("peserta", "status_pensiun", "VARCHAR(20) DEFAULT 'Aktif'"); // Aktif / Pensiun
    await tambahKolomJikaBelumAda("peserta", "face_descriptor", "LONGTEXT"); // 128-D face descriptor (JSON array) utk pengenalan wajah
    await tambahKolomJikaBelumAda("peserta", "foto_wajah", "LONGTEXT"); // foto referensi wajah (base64), utk preview di admin
    await tambahKolomJikaBelumAda("peserta", "nomor_telepon", "VARCHAR(30)"); // nomor WA, dipakai fitur reminder
    await tambahKolomJikaBelumAda("absen", "terlambat", "VARCHAR(5)");
    await tambahKolomJikaBelumAda("absen", "status_kehadiran", "VARCHAR(20) DEFAULT 'Hadir'"); // Hadir / Izin / Sakit
    await tambahKolomJikaBelumAda("absen", "catatan", "TEXT"); // catatan tugas (Hadir) / catatan izin / catatan sakit
    await tambahKolomJikaBelumAda("absen", "lampiran", "LONGTEXT"); // file surat izin/sakit (base64 data URL)
    await tambahKolomJikaBelumAda("absen", "lampiran_nama", "VARCHAR(255)");

    try {
      await pool.query(`ALTER TABLE absen MODIFY COLUMN foto_path LONGTEXT`);
    } catch (err) {
      console.error("Gagal mengubah tipe data foto_path:", err);
    }

    // Peserta lama yang kolom status_pensiun-nya masih kosong dianggap Aktif
    await pool.query(`UPDATE peserta SET status_pensiun = 'Aktif' WHERE status_pensiun IS NULL OR status_pensiun = ''`);

    const [[{ c }]] = await pool.query(`SELECT COUNT(*) AS c FROM peserta`);
    if (c === 0) {
      const seed = [
        "Mayor Cku (K) Yanti D",
        "Peltu (K) Ai Hayati",
        "Serma Supriatni",
        "Serda Kalery Alek Alvianus W",
        "Praka Andri Abdurahman",
        "Pratu Sandy Oktaviana R",
        "Pns Suparmi",
        "Pns Yusup Sugiri",
        "Pns Engkus Kurniawan",
        "Pns Rahmi Gun Indrarini",
      ];
      const sekarang = new Date().toISOString();
      for (const nama of seed) {
        await pool.query(
          `INSERT INTO peserta (id, nama_lengkap, dibuat_pada) VALUES (?, ?, ?)`,
          [crypto.randomUUID(), nama, sekarang]
        );
      }
    }
  } catch (error) {
    console.error("Inisialisasi DB Gagal:", error);
  }
}

// PENTING: initDb() ini membuat/menambah kolom database secara async.
// Simpan promise-nya (jangan cuma "initDb();" tanpa ditunggu) supaya kita bisa
// pastikan semua request nunggu migrasi selesai dulu — mencegah race condition
// di mana request pertama pas cold start bisa nyasar ke kolom yang belum ada.
const dbSiap = initDb();

const KEGIATAN_OPTIONS = [
  "Mengerjakan tugas dari pembimbing/atasan",
  "Menyusun laporan/administrasi",
  "Studi literatur/referensi",
  "Rapat/koordinasi online",
  "Pengembangan sistem/aplikasi",
  "Lainnya",
];
const JENIS_OPTIONS = ["TNI", "PNS"];
const TEMPAT_OPTIONS = ["Pussenif", "Pusdikif"];

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use("/uploads", express.static(UPLOAD_DIR));

// PANGGILAN STATIC UTAMA: Mengarah langsung ke folder public
app.use(express.static(path.join(__dirname, "public")));

// Tunggu migrasi database selesai dulu sebelum memproses request ke /api/*.
// Ini mencegah error "Unknown column" pas cold start Vercel, di mana request
// pertama bisa masuk sebelum initDb() sempat selesai menambah kolom baru.
app.use("/api", async (req, res, next) => {
  try {
    await dbSiap;
    next();
  } catch (err) {
    console.error("Database belum siap:", err);
    res.status(503).json({ error: "Server sedang menyiapkan database, coba lagi sebentar lagi." });
  }
});

function waktuJakartaSekarang() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return { tanggal: `${yyyy}-${mm}-${dd}`, hari: now.getDay(), jam: now.getHours(), menit: now.getMinutes() };
}

function isFridayNow() {
  return waktuJakartaSekarang().hari === 5;
}

function menitSejakTengahMalam({ jam, menit }) {
  return jam * 60 + menit;
}

function requireAdminKey(req, res, next) {
  next();
}

const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error(err);
  res.status(500).json({ error: "Terjadi kesalahan di server." });
});

// Mencatat satu baris log audit. Dipanggil "fire and forget" (tidak menghentikan
// alur utama kalau gagal) supaya fitur audit tidak sampai bikin aksi utama gagal.
async function catatAudit(aksi, targetNama, detail) {
  try {
    await pool.query(
      `INSERT INTO audit_log (id, waktu, aksi, target_nama, detail) VALUES (?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), new Date().toISOString(), aksi, targetNama || null, detail || null]
    );
  } catch (err) {
    console.error("Gagal mencatat audit log:", err);
  }
}

// Kirim satu pesan WhatsApp lewat Fonnte. Mengembalikan { ok, error }.
// Nomor diformat ke standar internasional (62...) supaya diterima Fonnte.
async function kirimWA(nomorTujuan, pesan) {
  if (!FONNTE_TOKEN) {
    return { ok: false, error: "FONNTE_TOKEN belum diset di environment variable." };
  }
  let nomor = (nomorTujuan || "").toString().replace(/[^0-9]/g, "");
  if (nomor.startsWith("0")) nomor = "62" + nomor.slice(1);
  else if (!nomor.startsWith("62")) nomor = "62" + nomor;

  try {
    const res = await fetch("https://api.fonnte.com/send", {
      method: "POST",
      headers: {
        Authorization: FONNTE_TOKEN,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ target: nomor, message: pesan }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.status === false) {
      return { ok: false, error: data.reason || `Fonnte merespons status ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Admin: lihat log audit terbaru
app.get("/api/audit-log", requireAdminKey, wrap(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 1000);
  const [rows] = await pool.query(
    `SELECT id, waktu, aksi, target_nama, detail FROM audit_log ORDER BY waktu DESC LIMIT ?`,
    [limit]
  );
  res.json({ data: rows });
}));

// ==========================================================
// Bot reminder otomatis — dipicu oleh Vercel Cron sekali sehari.
// Cek siapa yang belum absen & siapa yang terlambat, lalu kirim WA
// otomatis lewat Fonnte. Dilindungi CRON_SECRET, bukan ADMIN_KEY,
// karena yang manggil ini Vercel sendiri, bukan admin dari browser.
// ==========================================================
app.get("/api/cron/reminder", wrap(async (req, res) => {
  if (!CRON_SECRET || req.query.secret !== CRON_SECRET) {
    return res.status(403).json({ error: "Secret tidak valid." });
  }
  if (!FONNTE_TOKEN) {
    return res.status(500).json({ error: "FONNTE_TOKEN belum diset di environment variable." });
  }

  const sekarang = waktuJakartaSekarang();
  if (sekarang.hari === 0 || sekarang.hari === 6) {
    return res.json({ ok: true, info: "Hari libur (Sabtu/Minggu), reminder dilewati." });
  }
  const tanggal = sekarang.tanggal;

  const [pesertaAktif] = await pool.query(
    `SELECT nama_lengkap, nomor_telepon FROM peserta WHERE (status_pensiun = 'Aktif' OR status_pensiun IS NULL)`
  );
  const [absenHariIni] = await pool.query(
    `SELECT nama, terlambat FROM absen WHERE waktu LIKE ?`,
    [`${tanggal}%`]
  );

  const namaSudahAbsen = new Set(absenHariIni.map((r) => r.nama));
  const namaTerlambat = new Set(absenHariIni.filter((r) => r.terlambat === "Ya").map((r) => r.nama));
  const belumAbsen = pesertaAktif.filter((p) => !namaSudahAbsen.has(p.nama_lengkap));
  const terlambat = pesertaAktif.filter((p) => namaTerlambat.has(p.nama_lengkap));

  async function sudahDikirim(nama, jenis) {
    const [rows] = await pool.query(
      `SELECT 1 FROM reminder_terkirim WHERE nama = ? AND tanggal = ? AND jenis = ?`,
      [nama, tanggal, jenis]
    );
    return rows.length > 0;
  }
  async function tandaiTerkirim(nama, jenis) {
    await pool.query(
      `INSERT IGNORE INTO reminder_terkirim (id, nama, tanggal, jenis, waktu) VALUES (?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), nama, tanggal, jenis, new Date().toISOString()]
    );
  }

  const hasil = { belumAbsen: { terkirim: 0, dilewati: 0, gagal: 0 }, terlambat: { terkirim: 0, dilewati: 0, gagal: 0 } };

  for (const p of belumAbsen) {
    if (!p.nomor_telepon) { hasil.belumAbsen.dilewati++; continue; }
    if (await sudahDikirim(p.nama_lengkap, "belum_absen")) { hasil.belumAbsen.dilewati++; continue; }
    const pesan = `Halo ${p.nama_lengkap}, mohon segera lakukan Absen WFH hari ini sebelum jam ${String(JAM_BATAS_TERLAMBAT.jam).padStart(2, "0")}.${String(JAM_BATAS_TERLAMBAT.menit).padStart(2, "0")} supaya tidak tercatat terlambat. Terima kasih. (Pesan otomatis)`;
    const kirim = await kirimWA(p.nomor_telepon, pesan);
    if (kirim.ok) {
      hasil.belumAbsen.terkirim++;
      await tandaiTerkirim(p.nama_lengkap, "belum_absen");
      await catatAudit("reminder_otomatis", p.nama_lengkap, "Reminder belum absen terkirim via WA");
    } else {
      hasil.belumAbsen.gagal++;
    }
  }

  for (const p of terlambat) {
    if (!p.nomor_telepon) { hasil.terlambat.dilewati++; continue; }
    if (await sudahDikirim(p.nama_lengkap, "terlambat")) { hasil.terlambat.dilewati++; continue; }
    const pesan = `Halo ${p.nama_lengkap}, tercatat absen kamu hari ini masuk kategori Terlambat. Mohon diperhatikan jam absen berikutnya. Terima kasih. (Pesan otomatis)`;
    const kirim = await kirimWA(p.nomor_telepon, pesan);
    if (kirim.ok) {
      hasil.terlambat.terkirim++;
      await tandaiTerkirim(p.nama_lengkap, "terlambat");
      await catatAudit("reminder_otomatis", p.nama_lengkap, "Reminder terlambat terkirim via WA");
    } else {
      hasil.terlambat.gagal++;
    }
  }

  res.json({ ok: true, ...hasil });
}));

app.get("/api/opsi", (req, res) => {
  res.json({
    kegiatan: KEGIATAN_OPTIONS,
    jenis: JENIS_OPTIONS,
    tempat: TEMPAT_OPTIONS,
    jamBuka: `${String(JAM_BUKA.jam).padStart(2, "0")}.${String(JAM_BUKA.menit).padStart(2, "0")}`,
    jamBatasTerlambat: `${String(JAM_BATAS_TERLAMBAT.jam).padStart(2, "0")}.${String(JAM_BATAS_TERLAMBAT.menit).padStart(2, "0")}`,
  });
});

// Endpoint publik: cek apakah nama tertentu sudah absen hari ini.
// Dipakai halaman absen supaya orang tahu di awal (begitu pilih nama),
// bukan baru ketahuan setelah isi seluruh form dan klik Kirim.
app.get("/api/absen/cek", wrap(async (req, res) => {
  const nama = (req.query.nama || "").trim();
  if (!nama) {
    return res.status(400).json({ error: "Nama wajib diisi." });
  }
  const { tanggal } = waktuJakartaSekarang();
  const [rows] = await pool.query(
    `SELECT waktu, status_kehadiran, terlambat FROM absen WHERE nama = ? AND waktu LIKE ? LIMIT 1`,
    [nama, `${tanggal}%`]
  );
  if (rows.length === 0) {
    return res.json({ sudahAbsen: false });
  }
  res.json({
    sudahAbsen: true,
    waktu: rows[0].waktu,
    status: rows[0].status_kehadiran,
    terlambat: rows[0].terlambat,
  });
}));

// Endpoint publik: daftar peserta AKTIF saja (dipakai halaman absen buat isi dropdown nama).
// Peserta yang sudah ditandai pensiun sengaja tidak dimunculkan di sini.
app.get("/api/peserta", wrap(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT id, nama_lengkap, nrp, jenis, bagian, jabatan, tempat, dibuat_pada
     FROM peserta WHERE status_pensiun = 'Aktif' OR status_pensiun IS NULL
     ORDER BY nama_lengkap ASC`
  );
  res.json(rows);
}));

// Admin: daftar SEMUA peserta (aktif maupun pensiun) buat dikelola di dashboard
app.get("/api/peserta/admin", requireAdminKey, wrap(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT id, nama_lengkap, nrp, jenis, bagian, jabatan, tempat, nomor_telepon, dibuat_pada, status_pensiun, foto_wajah,
            (face_descriptor IS NOT NULL AND face_descriptor <> '') AS punya_wajah
     FROM peserta ORDER BY status_pensiun ASC, nama_lengkap ASC`
  );
  res.json(rows.map((r) => ({ ...r, punya_wajah: !!r.punya_wajah })));
}));

// Publik: daftar descriptor wajah peserta AKTIF, dipakai halaman absen buat pencocokan wajah di browser.
// Sengaja TIDAK mengirim foto aslinya, cuma angka descriptor (128-D) supaya ringan & tidak bocorin foto peserta lain.
app.get("/api/peserta/wajah", wrap(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT id, nama_lengkap, face_descriptor FROM peserta
     WHERE (status_pensiun = 'Aktif' OR status_pensiun IS NULL)
       AND face_descriptor IS NOT NULL AND face_descriptor <> ''`
  );
  const data = rows.map((r) => {
    let descriptor = [];
    try {
      descriptor = JSON.parse(r.face_descriptor);
    } catch (e) {
      descriptor = [];
    }
    return { id: r.id, nama_lengkap: r.nama_lengkap, descriptor };
  }).filter((r) => Array.isArray(r.descriptor) && r.descriptor.length === 128);
  res.json(data);
}));

// Admin: simpan/perbarui foto wajah referensi + descriptor (dihitung di browser admin pakai face-api.js)
app.patch("/api/peserta/:id/wajah", requireAdminKey, wrap(async (req, res) => {
  const { foto_wajah, face_descriptor } = req.body;
  if (!Array.isArray(face_descriptor) || face_descriptor.length !== 128) {
    return res.status(400).json({ error: "Descriptor wajah tidak valid. Coba ulangi deteksi wajah." });
  }
  await pool.query(
    `UPDATE peserta SET foto_wajah = ?, face_descriptor = ? WHERE id = ?`,
    [foto_wajah || null, JSON.stringify(face_descriptor), req.params.id]
  );
  res.json({ ok: true });
}));

// Admin: hapus foto wajah referensi seorang peserta (misal mau daftar ulang)
app.delete("/api/peserta/:id/wajah", requireAdminKey, wrap(async (req, res) => {
  await pool.query(`UPDATE peserta SET foto_wajah = NULL, face_descriptor = NULL WHERE id = ?`, [req.params.id]);
  res.json({ ok: true });
}));

// Admin: ubah status pensiun seorang peserta (Aktif <-> Pensiun)
app.patch("/api/peserta/:id/status", requireAdminKey, wrap(async (req, res) => {
  const { status_pensiun } = req.body;
  if (!["Aktif", "Pensiun"].includes(status_pensiun)) {
    return res.status(400).json({ error: 'Status harus "Aktif" atau "Pensiun".' });
  }
  const [[peserta]] = await pool.query(`SELECT nama_lengkap FROM peserta WHERE id = ?`, [req.params.id]);
  await pool.query(`UPDATE peserta SET status_pensiun = ? WHERE id = ?`, [status_pensiun, req.params.id]);
  catatAudit("ubah_status_peserta", peserta ? peserta.nama_lengkap : null, `Status pegawai diubah menjadi "${status_pensiun}"`);
  res.json({ ok: true });
}));

app.post("/api/peserta", requireAdminKey, wrap(async (req, res) => {
  const { nama_lengkap, nrp, jenis, bagian, jabatan, tempat, nomor_telepon } = req.body;
  if (!nama_lengkap || !nama_lengkap.trim()) {
    return res.status(400).json({ error: "Nama lengkap wajib diisi." });
  }
  try {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO peserta (id, nama_lengkap, nrp, jenis, bagian, jabatan, tempat, nomor_telepon, dibuat_pada)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, nama_lengkap.trim(), nrp || null, jenis || null, bagian || null, jabatan || null, tempat || null, (nomor_telepon || "").trim() || null, new Date().toISOString()]
    );
    res.json({ ok: true, id });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "Nama tersebut sudah terdaftar." });
    }
    throw err;
  }
}));

// Admin: edit info dasar peserta (nrp, jenis, bagian, jabatan, tempat, nomor telepon)
app.patch("/api/peserta/:id", requireAdminKey, wrap(async (req, res) => {
  const { nrp, jenis, bagian, jabatan, tempat, nomor_telepon } = req.body;
  const fields = [];
  const params = [];

  if (nrp !== undefined) { fields.push("nrp = ?"); params.push(nrp || null); }
  if (jenis !== undefined) { fields.push("jenis = ?"); params.push(jenis || null); }
  if (bagian !== undefined) { fields.push("bagian = ?"); params.push(bagian || null); }
  if (jabatan !== undefined) { fields.push("jabatan = ?"); params.push(jabatan || null); }
  if (tempat !== undefined) { fields.push("tempat = ?"); params.push(tempat || null); }
  if (nomor_telepon !== undefined) { fields.push("nomor_telepon = ?"); params.push((nomor_telepon || "").toString().trim() || null); }

  if (fields.length === 0) {
    return res.status(400).json({ error: "Tidak ada data yang diubah." });
  }

  const [[peserta]] = await pool.query(`SELECT nama_lengkap FROM peserta WHERE id = ?`, [req.params.id]);
  params.push(req.params.id);
  const [result] = await pool.query(`UPDATE peserta SET ${fields.join(", ")} WHERE id = ?`, params);
  if (result.affectedRows === 0) {
    return res.status(404).json({ error: "Peserta tidak ditemukan." });
  }
  catatAudit("edit_peserta", peserta ? peserta.nama_lengkap : null, "Data peserta diperbarui");
  res.json({ ok: true });
}));

app.post("/api/peserta/bulk", requireAdminKey, wrap(async (req, res) => {
  const { peserta } = req.body;
  if (!Array.isArray(peserta) || peserta.length === 0) {
    return res.status(400).json({ error: "Data peserta kosong atau format tidak sesuai." });
  }

  let ditambah = 0;
  let dilewati = 0;
  const sekarang = new Date().toISOString();

  for (const p of peserta) {
    const nama = (p.nama_lengkap || p.nama || "").toString().trim();
    if (!nama) {
      dilewati++;
      continue;
    }
    try {
      await pool.query(
        `INSERT INTO peserta (id, nama_lengkap, nrp, jenis, bagian, jabatan, tempat, nomor_telepon, dibuat_pada)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          nama,
          (p.nrp || "").toString().trim() || null,
          (p.jenis || "").toString().trim().toUpperCase() || null,
          (p.bagian || "").toString().trim() || null,
          (p.jabatan || "").toString().trim() || null,
          (p.tempat || "").toString().trim() || null,
          (p.nomor_telepon || p.telepon || p.wa || "").toString().trim() || null,
          sekarang,
        ]
      );
      ditambah++;
    } catch (err) {
      if (err.code === "ER_DUP_ENTRY") {
        dilewati++;
      } else {
        throw err;
      }
    }
  }

  res.json({ ok: true, ditambah, dilewati, total: peserta.length });
}));

app.delete("/api/peserta/:id", requireAdminKey, wrap(async (req, res) => {
  const [[peserta]] = await pool.query(`SELECT nama_lengkap FROM peserta WHERE id = ?`, [req.params.id]);
  await pool.query(`DELETE FROM peserta WHERE id = ?`, [req.params.id]);
  catatAudit("hapus_peserta", peserta ? peserta.nama_lengkap : null, "Peserta dihapus dari daftar");
  res.json({ ok: true });
}));

const STATUS_KEHADIRAN_OPTIONS = ["Hadir", "Izin", "Sakit"];

app.post("/api/absen", wrap(async (req, res) => {
  const {
    nama,
    foto,
    lat,
    lng,
    akurasi,
    kegiatan,
    kegiatan_catatan,
    status,
    catatan,
    lampiran,
    lampiran_nama,
  } = req.body;

  if (!nama || !foto || lat == null || lng == null || !kegiatan) {
    return res.status(400).json({ error: "Data tidak lengkap (nama, foto, lokasi, dan kegiatan wajib diisi)." });
  }
  if (!KEGIATAN_OPTIONS.includes(kegiatan)) {
    return res.status(400).json({ error: "Kegiatan tidak valid." });
  }
  if (kegiatan === "Lainnya" && (!kegiatan_catatan || !kegiatan_catatan.trim())) {
    return res.status(400).json({ error: 'Isi keterangan kegiatan kalau memilih "Lainnya".' });
  }

  const statusKehadiran = STATUS_KEHADIRAN_OPTIONS.includes(status) ? status : "Hadir";
  const catatanTrim = (catatan || "").toString().trim();

  if ((statusKehadiran === "Izin" || statusKehadiran === "Sakit")) {
    if (!catatanTrim) {
      return res.status(400).json({
        error: `Isi catatan ${statusKehadiran.toLowerCase()} terlebih dahulu.`,
      });
    }
    if (!lampiran) {
      return res.status(400).json({
        error: `Unggah lampiran surat ${statusKehadiran.toLowerCase()} terlebih dahulu.`,
      });
    }
    if (!/^data:(image\/(png|jpeg|jpg)|application\/pdf);base64,/.test(lampiran)) {
      return res.status(400).json({ error: "Format lampiran tidak valid (harus foto atau PDF)." });
    }
  }

  const [terdaftarRows] = await pool.query(
    `SELECT 1 FROM peserta WHERE nama_lengkap = ? AND (status_pensiun = 'Aktif' OR status_pensiun IS NULL)`,
    [nama]
  );
  if (terdaftarRows.length === 0) {
    return res.status(403).json({ error: "Nama tidak terdaftar sebagai peserta aktif. Hubungi admin kalau nama kamu belum ada di daftar atau sudah pensiun." });
  }

  if (!isFridayNow()) {
    // Sementara dinonaktifkan: absen dibuka setiap hari, bukan cuma Jumat.
    // return res.status(403).json({ error: "Absen WFH hanya dibuka setiap hari Jumat." });
  }

  const sekarang = waktuJakartaSekarang();
  const menitSekarang = menitSejakTengahMalam(sekarang);

  if (menitSekarang < menitSejakTengahMalam(JAM_BUKA)) {
    return res.status(403).json({
      error: `Absen belum dibuka. Mulai jam ${String(JAM_BUKA.jam).padStart(2, "0")}.${String(JAM_BUKA.menit).padStart(2, "0")}.`,
    });
  }

  const terlambat = menitSekarang > menitSejakTengahMalam(JAM_BATAS_TERLAMBAT) ? "Ya" : "Tidak";

  const [sudahAbsenRows] = await pool.query(
    `SELECT 1 FROM absen WHERE nama = ? AND waktu LIKE ?`,
    [nama, `${sekarang.tanggal}%`]
  );
  if (sudahAbsenRows.length > 0) {
    return res.status(409).json({ error: "Kamu sudah absen hari ini." });
  }

  const matches = foto.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/);
  if (!matches) {
    return res.status(400).json({ error: "Format foto tidak valid." });
  }

  const id = crypto.randomUUID();
  const waktu = new Date().toISOString();
  await pool.query(
    `INSERT INTO absen (id, nama, waktu, lat, lng, akurasi, foto_path, status, status_kehadiran, kegiatan, kegiatan_catatan, catatan, lampiran, lampiran_nama, terlambat)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      nama,
      waktu,
      lat,
      lng,
      akurasi || null,
      foto,
      "WFH",
      statusKehadiran,
      kegiatan,
      kegiatan === "Lainnya" ? kegiatan_catatan.trim() : null,
      catatanTrim || null,
      statusKehadiran !== "Hadir" ? lampiran : null,
      statusKehadiran !== "Hadir" ? (lampiran_nama || null) : null,
      terlambat,
    ]
  );

  res.json({ ok: true, id, waktu, terlambat, status_kehadiran: statusKehadiran });
}));

// Admin: tambah absen manual (peserta lupa/gagal absen tapi tetap masuk kerja).
// Tidak butuh foto/lokasi/pembatasan jam, karena diinput langsung oleh admin.
app.post("/api/absen/manual", requireAdminKey, wrap(async (req, res) => {
  const { nama, waktu, status_kehadiran, kegiatan, catatan } = req.body;

  if (!nama || !nama.toString().trim()) {
    return res.status(400).json({ error: "Nama wajib diisi." });
  }
  const statusKehadiran = STATUS_KEHADIRAN_OPTIONS.includes(status_kehadiran) ? status_kehadiran : "Hadir";

  const [terdaftarRows] = await pool.query(
    `SELECT 1 FROM peserta WHERE nama_lengkap = ? AND (status_pensiun = 'Aktif' OR status_pensiun IS NULL)`,
    [nama.toString().trim()]
  );
  if (terdaftarRows.length === 0) {
    return res.status(403).json({ error: "Nama tidak terdaftar sebagai peserta aktif." });
  }

  const waktuFinal = waktu ? new Date(waktu).toISOString() : new Date().toISOString();
  const tanggalFinal = waktuFinal.slice(0, 10);

  const [sudahAbsenRows] = await pool.query(
    `SELECT 1 FROM absen WHERE nama = ? AND waktu LIKE ?`,
    [nama.toString().trim(), `${tanggalFinal}%`]
  );
  if (sudahAbsenRows.length > 0) {
    return res.status(409).json({ error: "Peserta ini sudah punya data absen di tanggal tersebut." });
  }

  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO absen (id, nama, waktu, lat, lng, akurasi, foto_path, status, status_kehadiran, kegiatan, kegiatan_catatan, catatan, terlambat)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      nama.toString().trim(),
      waktuFinal,
      null,
      null,
      null,
      "", // tidak ada foto untuk entri manual
      "WFH",
      statusKehadiran,
      (kegiatan || "").toString().trim() || "Input manual oleh admin",
      null,
      (catatan || "").toString().trim() || null,
      "Tidak",
    ]
  );
  catatAudit("tambah_absen_manual", nama.toString().trim(), `Status: ${statusKehadiran}, waktu: ${waktuFinal}`);

  res.json({ ok: true, id, waktu: waktuFinal });
}));

app.get("/api/absen", requireAdminKey, wrap(async (req, res) => {
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 25, 1), 3000);
  const offset = (page - 1) * limit;
  const search = (req.query.search || "").trim();
  const tanggal = (req.query.tanggal || "").trim();
  const tanggalAwal = (req.query.tanggalAwal || "").trim();
  const tanggalAkhir = (req.query.tanggalAkhir || "").trim();
  const statusKehadiranFilter = (req.query.status_kehadiran || "").trim();

  let where = "WHERE 1=1";
  const params = [];
  if (search) {
    where += " AND nama LIKE ?";
    params.push(`%${search}%`);
  }
  if (tanggal) {
    where += " AND waktu LIKE ?";
    params.push(`${tanggal}%`);
  }
  if (tanggalAwal) {
    where += " AND waktu >= ?";
    params.push(`${tanggalAwal}T00:00:00`);
  }
  if (tanggalAkhir) {
    where += " AND waktu <= ?";
    params.push(`${tanggalAkhir}T23:59:59.999`);
  }
  if (statusKehadiranFilter && STATUS_KEHADIRAN_OPTIONS.includes(statusKehadiranFilter)) {
    where += " AND status_kehadiran = ?";
    params.push(statusKehadiranFilter);
  }

  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM absen ${where}`, params);
  const [rows] = await pool.query(
    `SELECT * FROM absen ${where} ORDER BY waktu DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

 const data = rows.map((r) => {
    let url = r.foto_path;
    if (r.foto_path && !r.foto_path.startsWith("data:") && !r.foto_path.startsWith("http")) {
      // Ubah jadi string kosong agar frontend tidak mencoba meload file fisik lama yang tidak ada
      url = ""; 
    }
    let lampiranUrl = r.lampiran;
    if (lampiranUrl && !lampiranUrl.startsWith("data:") && !lampiranUrl.startsWith("http")) {
      lampiranUrl = "";
    }
    return {
      ...r,
      foto_url: url,
      lampiran_url: lampiranUrl || null,
    };
  });
  res.json({ data, total, page, limit, totalPages: Math.max(Math.ceil(total / limit), 1) });
}));

// Serve lampiran (surat izin/sakit) sebagai file biasa (bukan base64 JSON),
// supaya bisa dibuka lewat link langsung — dipakai di kolom link Export CSV/Excel.
app.get("/api/absen/:id/lampiran", requireAdminKey, wrap(async (req, res) => {
  const [[row]] = await pool.query(`SELECT lampiran FROM absen WHERE id = ?`, [req.params.id]);
  if (!row || !row.lampiran) {
    return res.status(404).send("Lampiran tidak ditemukan.");
  }
  const match = row.lampiran.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    return res.status(400).send("Format lampiran tidak valid.");
  }
  const [, mimeType, base64Data] = match;
  const buffer = Buffer.from(base64Data, "base64");
  res.setHeader("Content-Type", mimeType);
  res.send(buffer);
}));

app.delete("/api/absen/:id", requireAdminKey, wrap(async (req, res) => {
  const [[row]] = await pool.query(`SELECT nama, waktu FROM absen WHERE id = ?`, [req.params.id]);
  await pool.query(`DELETE FROM absen WHERE id = ?`, [req.params.id]);
  catatAudit("hapus_absen", row ? row.nama : null, row ? `Data absen waktu ${row.waktu} dihapus` : "Data absen dihapus");
  res.json({ ok: true });
}));

// Admin: update sebagian data absen (nama, status kehadiran, kegiatan, catatan)
app.patch("/api/absen/:id", requireAdminKey, wrap(async (req, res) => {
  const { nama, status_kehadiran, kegiatan, catatan, foto } = req.body;
  const fields = [];
  const params = [];
  const perubahan = [];

  const [[sebelum]] = await pool.query(`SELECT nama, status_kehadiran FROM absen WHERE id = ?`, [req.params.id]);

  if (nama !== undefined) {
    if (!nama || !nama.toString().trim()) {
      return res.status(400).json({ error: "Nama tidak boleh kosong." });
    }
    fields.push("nama = ?");
    params.push(nama.toString().trim());
    if (sebelum && sebelum.nama !== nama.toString().trim()) {
      perubahan.push(`nama: "${sebelum.nama}" → "${nama.toString().trim()}"`);
    }
  }
  if (status_kehadiran !== undefined) {
    if (!STATUS_KEHADIRAN_OPTIONS.includes(status_kehadiran)) {
      return res.status(400).json({ error: "Status kehadiran tidak valid." });
    }
    fields.push("status_kehadiran = ?");
    params.push(status_kehadiran);
    if (sebelum && sebelum.status_kehadiran !== status_kehadiran) {
      perubahan.push(`status: "${sebelum.status_kehadiran}" → "${status_kehadiran}"`);
    }
  }
  if (kegiatan !== undefined) {
    fields.push("kegiatan = ?");
    params.push(kegiatan.toString().trim() || null);
  }
  if (catatan !== undefined) {
    fields.push("catatan = ?");
    params.push(catatan.toString().trim() || null);
  }
  if (foto !== undefined) {
    if (!/^data:image\/(png|jpeg|jpg);base64,/.test(foto)) {
      return res.status(400).json({ error: "Format foto tidak valid." });
    }
    fields.push("foto_path = ?");
    params.push(foto);
    perubahan.push("foto diganti");
  }

  if (fields.length === 0) {
    return res.status(400).json({ error: "Tidak ada data yang diubah." });
  }

  params.push(req.params.id);
  const [result] = await pool.query(`UPDATE absen SET ${fields.join(", ")} WHERE id = ?`, params);
  if (result.affectedRows === 0) {
    return res.status(404).json({ error: "Data absen tidak ditemukan." });
  }
  catatAudit("update_absen", (nama || (sebelum && sebelum.nama)), perubahan.length ? perubahan.join("; ") : "Data diperbarui");
  res.json({ ok: true });
}));

app.get("/api/absen/stats", requireAdminKey, wrap(async (req, res) => {
  const { tanggal: hariIni } = waktuJakartaSekarang();
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM absen`);
  const [[{ hariIniCount }]] = await pool.query(`SELECT COUNT(*) AS hariIniCount FROM absen WHERE waktu LIKE ?`, [`${hariIni}%`]);
  const [[{ orangUnik }]] = await pool.query(`SELECT COUNT(DISTINCT nama) AS orangUnik FROM absen`);
  const [[{ terlambatCount }]] = await pool.query(
    `SELECT COUNT(*) AS terlambatCount FROM absen WHERE waktu LIKE ? AND terlambat = 'Ya'`,
    [`${hariIni}%`]
  );
  const [[{ totalPeserta }]] = await pool.query(
    `SELECT COUNT(*) AS totalPeserta FROM peserta WHERE status_pensiun = 'Aktif' OR status_pensiun IS NULL`
  );
  const [[{ izinHariIni }]] = await pool.query(
    `SELECT COUNT(*) AS izinHariIni FROM absen WHERE waktu LIKE ? AND status_kehadiran = 'Izin'`,
    [`${hariIni}%`]
  );
  const [[{ sakitHariIni }]] = await pool.query(
    `SELECT COUNT(*) AS sakitHariIni FROM absen WHERE waktu LIKE ? AND status_kehadiran = 'Sakit'`,
    [`${hariIni}%`]
  );
  res.json({
    total,
    hariIni: hariIniCount,
    orangUnik,
    terlambatHariIni: terlambatCount,
    totalPeserta,
    izinHariIni,
    sakitHariIni,
  });
}));

app.get("/api/absen/export", requireAdminKey, wrap(async (req, res) => {
  const search = (req.query.search || "").trim();
  const tanggal = (req.query.tanggal || "").trim();
  const tanggalAwal = (req.query.tanggalAwal || "").trim();
  const tanggalAkhir = (req.query.tanggalAkhir || "").trim();
  const statusKehadiranFilter = (req.query.status_kehadiran || "").trim();

  let where = "WHERE 1=1";
  const params = [];
  if (search) {
    where += " AND nama LIKE ?";
    params.push(`%${search}%`);
  }
  if (tanggal) {
    where += " AND waktu LIKE ?";
    params.push(`${tanggal}%`);
  }
  if (tanggalAwal) {
    where += " AND waktu >= ?";
    params.push(`${tanggalAwal}T00:00:00`);
  }
  if (tanggalAkhir) {
    where += " AND waktu <= ?";
    params.push(`${tanggalAkhir}T23:59:59.999`);
  }
  if (statusKehadiranFilter && STATUS_KEHADIRAN_OPTIONS.includes(statusKehadiranFilter)) {
    where += " AND status_kehadiran = ?";
    params.push(statusKehadiranFilter);
  }

  const [rows] = await pool.query(
    `SELECT id, nama, waktu, status, status_kehadiran, terlambat, kegiatan, kegiatan_catatan, catatan, lampiran, lat, lng, akurasi FROM absen ${where} ORDER BY waktu DESC`,
    params
  );

  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const adminKeyForLink = (req.query.key || "").toString();

  let csv = "Nama,Waktu,Status Kehadiran,Terlambat,Kegiatan,Catatan,Link Lampiran,Latitude,Longitude,Akurasi(m)\n";
  for (const r of rows) {
    const kegiatanFinal = r.kegiatan === "Lainnya" ? `${r.kegiatan} - ${r.kegiatan_catatan || ""}` : r.kegiatan;
    const kehadiran = r.status_kehadiran || r.status || "Hadir";
    const linkLampiran = r.lampiran ? `${baseUrl}/api/absen/${r.id}/lampiran?key=${encodeURIComponent(adminKeyForLink)}` : "-";
    csv += `"${r.nama.replace(/"/g, '""')}",${r.waktu},"${kehadiran}","${r.terlambat || ""}","${kegiatanFinal || ""}","${(r.catatan || "").replace(/"/g, '""')}","${linkLampiran}",${r.lat},${r.lng},${r.akurasi ?? ""}\n`;
  }

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="absen-export.csv"`);
  res.send(csv);
}));

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server absen jalan di http://localhost:${PORT}`);
  });
}

module.exports = app;