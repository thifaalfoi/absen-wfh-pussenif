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

    await tambahKolomJikaBelumAda("peserta", "nrp", "VARCHAR(50)");
    await tambahKolomJikaBelumAda("peserta", "jenis", "VARCHAR(10)");
    await tambahKolomJikaBelumAda("peserta", "bagian", "VARCHAR(150)");
    await tambahKolomJikaBelumAda("peserta", "jabatan", "VARCHAR(150)");
    await tambahKolomJikaBelumAda("peserta", "tempat", "VARCHAR(50)");
    await tambahKolomJikaBelumAda("peserta", "dibuat_pada", "VARCHAR(40)");
    await tambahKolomJikaBelumAda("peserta", "status_pensiun", "VARCHAR(20) DEFAULT 'Aktif'"); // Aktif / Pensiun
    await tambahKolomJikaBelumAda("peserta", "face_descriptor", "LONGTEXT"); // 128-D face descriptor (JSON array) utk pengenalan wajah
    await tambahKolomJikaBelumAda("peserta", "foto_wajah", "LONGTEXT"); // foto referensi wajah (base64), utk preview di admin
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

initDb();

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

app.get("/api/opsi", (req, res) => {
  res.json({ kegiatan: KEGIATAN_OPTIONS, jenis: JENIS_OPTIONS, tempat: TEMPAT_OPTIONS });
});

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
    `SELECT id, nama_lengkap, nrp, jenis, bagian, jabatan, tempat, dibuat_pada, status_pensiun, foto_wajah,
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
  await pool.query(`UPDATE peserta SET status_pensiun = ? WHERE id = ?`, [status_pensiun, req.params.id]);
  res.json({ ok: true });
}));

app.post("/api/peserta", requireAdminKey, wrap(async (req, res) => {
  const { nama_lengkap, nrp, jenis, bagian, jabatan, tempat } = req.body;
  if (!nama_lengkap || !nama_lengkap.trim()) {
    return res.status(400).json({ error: "Nama lengkap wajib diisi." });
  }
  try {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO peserta (id, nama_lengkap, nrp, jenis, bagian, jabatan, tempat, dibuat_pada)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, nama_lengkap.trim(), nrp || null, jenis || null, bagian || null, jabatan || null, tempat || null, new Date().toISOString()]
    );
    res.json({ ok: true, id });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "Nama tersebut sudah terdaftar." });
    }
    throw err;
  }
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
        `INSERT INTO peserta (id, nama_lengkap, nrp, jenis, bagian, jabatan, tempat, dibuat_pada)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          nama,
          (p.nrp || "").toString().trim() || null,
          (p.jenis || "").toString().trim().toUpperCase() || null,
          (p.bagian || "").toString().trim() || null,
          (p.jabatan || "").toString().trim() || null,
          (p.tempat || "").toString().trim() || null,
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
  await pool.query(`DELETE FROM peserta WHERE id = ?`, [req.params.id]);
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

app.get("/api/absen", requireAdminKey, wrap(async (req, res) => {
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 25, 1), 100);
  const offset = (page - 1) * limit;
  const search = (req.query.search || "").trim();
  const tanggal = (req.query.tanggal || "").trim();

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

  const [rows] = await pool.query(
    `SELECT nama, waktu, status, status_kehadiran, terlambat, kegiatan, kegiatan_catatan, catatan, lampiran, lat, lng, akurasi FROM absen ${where} ORDER BY waktu DESC`,
    params
  );

  let csv = "Nama,Waktu,Status Kehadiran,Terlambat,Kegiatan,Catatan,Lampiran,Latitude,Longitude,Akurasi(m)\n";
  for (const r of rows) {
    const kegiatanFinal = r.kegiatan === "Lainnya" ? `${r.kegiatan} - ${r.kegiatan_catatan || ""}` : r.kegiatan;
    const kehadiran = r.status_kehadiran || r.status || "Hadir";
    const adaLampiran = r.lampiran ? "Ada" : "-";
    csv += `"${r.nama.replace(/"/g, '""')}",${r.waktu},"${kehadiran}","${r.terlambat || ""}","${kegiatanFinal || ""}","${(r.catatan || "").replace(/"/g, '""')}","${adaLampiran}",${r.lat},${r.lng},${r.akurasi ?? ""}\n`;
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