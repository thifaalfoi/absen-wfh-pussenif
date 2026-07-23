// server.js
// Backend untuk aplikasi Absen WFH (selfie + lokasi) — versi database MySQL.
// Bisa diarahkan ke MySQL di mana saja (bukan cuma localhost) lewat file .env.
// Jalankan: npm install && npm start

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
// Kunci sederhana buat lindungi dashboard admin & API GET.
const ADMIN_KEY = process.env.ADMIN_KEY || "ganti-kunci-ini";

const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

// Jam buka & batas tepat waktu absen (jam lokal Asia/Jakarta)
const JAM_BUKA = { jam: 6, menit: 30 };   // 06.30 — sebelum ini absen belum dibuka
const JAM_BATAS_TERLAMBAT = { jam: 8, menit: 0 }; // 08.00 — lewat ini dianggap terlambat

// ------------------------------------------------------------------
// Koneksi database — isi kredensial di file .env (lihat .env.example).
// Bisa mengarah ke MySQL di mana saja: VPS sendiri, atau layanan hosting
// MySQL gratis/berbayar seperti Railway, Aiven, Clever Cloud, dsb.
// ------------------------------------------------------------------
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : undefined,
});

async function tambahKolomJikaBelumAda(tabel, kolom, definisi) {
  try {
    await pool.query(`ALTER TABLE ${tabel} ADD COLUMN ${kolom} ${definisi}`);
  } catch (err) {
    if (err.code !== "ER_DUP_FIELDNAME") throw err;
  }
}

async function initDb() {
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

  // Kolom tambahan untuk data peserta (kompatibel mundur kalau tabel sudah ada sebelumnya)
  await tambahKolomJikaBelumAda("peserta", "nrp", "VARCHAR(50)");
  await tambahKolomJikaBelumAda("peserta", "jenis", "VARCHAR(10)");       // TNI / PNS
  await tambahKolomJikaBelumAda("peserta", "bagian", "VARCHAR(150)");     // mis. Infolahta, Penerangan
  await tambahKolomJikaBelumAda("peserta", "jabatan", "VARCHAR(150)");
  await tambahKolomJikaBelumAda("peserta", "tempat", "VARCHAR(50)");      // Pussenif / Pusdikif
  await tambahKolomJikaBelumAda("peserta", "dibuat_pada", "VARCHAR(40)");

  // Kolom tambahan untuk absen: tanda terlambat
  await tambahKolomJikaBelumAda("absen", "terlambat", "VARCHAR(5)"); // 'Ya' / 'Tidak'

  // Seed daftar peserta percobaan (cuma jalan kalau tabel peserta masih kosong)
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
}

// Kegiatan WFH yang bisa dipilih (status kehadiran sekarang otomatis "WFH")
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
app.use(express.json({ limit: "15mb" })); // foto base64 + import excel butuh limit lebih besar
app.use("/uploads", express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, "public")));

// Jam & tanggal sekarang berdasarkan zona waktu Asia/Jakarta
function waktuJakartaSekarang() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return { tanggal: `${yyyy}-${mm}-${dd}`, hari: now.getDay(), jam: now.getHours(), menit: now.getMinutes() };
}
function isFridayNow() {
  return waktuJakartaSekarang().hari === 5; // 0=Minggu ... 5=Jumat
}
function menitSejakTengahMalam({ jam, menit }) {
  return jam * 60 + menit;
}

function requireAdminKey(req, res, next) {
  const key = req.query.key || req.headers["x-admin-key"];
  if (key !== ADMIN_KEY) {
    return res.status(401).json({ error: "Kunci admin salah atau tidak ada." });
  }
  next();
}

// Bungkus handler async biar error di-catch otomatis dan gak bikin server crash
const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error(err);
  res.status(500).json({ error: "Terjadi kesalahan di server." });
});

// Endpoint publik: daftar opsi (kegiatan, jenis, tempat)
app.get("/api/opsi", (req, res) => {
  res.json({ kegiatan: KEGIATAN_OPTIONS, jenis: JENIS_OPTIONS, tempat: TEMPAT_OPTIONS });
});

// Endpoint publik: daftar peserta terdaftar (dipakai halaman absen buat isi dropdown nama)
app.get("/api/peserta", wrap(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT id, nama_lengkap, nrp, jenis, bagian, jabatan, tempat, dibuat_pada FROM peserta ORDER BY nama_lengkap ASC`
  );
  res.json(rows);
}));

// Admin: tambah peserta baru (satu-satu, lewat form)
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

// Admin: import peserta massal dari Excel (dikirim sebagai array JSON hasil parsing di browser)
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

// Admin: hapus peserta
app.delete("/api/peserta/:id", requireAdminKey, wrap(async (req, res) => {
  await pool.query(`DELETE FROM peserta WHERE id = ?`, [req.params.id]);
  res.json({ ok: true });
}));

// Endpoint absen dari halaman web
app.post("/api/absen", wrap(async (req, res) => {
  const { nama, foto, lat, lng, akurasi, kegiatan, kegiatan_catatan } = req.body;

  if (!nama || !foto || lat == null || lng == null || !kegiatan) {
    return res.status(400).json({ error: "Data tidak lengkap (nama, foto, lokasi, dan kegiatan wajib diisi)." });
  }
  if (!KEGIATAN_OPTIONS.includes(kegiatan)) {
    return res.status(400).json({ error: "Kegiatan tidak valid." });
  }
  if (kegiatan === "Lainnya" && (!kegiatan_catatan || !kegiatan_catatan.trim())) {
    return res.status(400).json({ error: 'Isi keterangan kegiatan kalau memilih "Lainnya".' });
  }

  // Nama harus salah satu dari daftar peserta terdaftar (anti typo / nama palsu)
  const [terdaftarRows] = await pool.query(`SELECT 1 FROM peserta WHERE nama_lengkap = ?`, [nama]);
  if (terdaftarRows.length === 0) {
    return res.status(403).json({ error: "Nama tidak terdaftar sebagai peserta. Hubungi admin kalau nama kamu belum ada di daftar." });
  }

  if (!isFridayNow()) {
    return res.status(403).json({ error: "Absen WFH hanya dibuka setiap hari Jumat." });
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

  // foto dikirim sebagai data URL base64: "data:image/jpeg;base64,...."
  const matches = foto.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/);
  if (!matches) {
    return res.status(400).json({ error: "Format foto tidak valid." });
  }
  const ext = matches[1] === "png" ? "png" : "jpg";
  const buffer = Buffer.from(matches[2], "base64");

  const id = crypto.randomUUID();
  const fileName = `${id}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, fileName), buffer);

  const waktu = new Date().toISOString();
  await pool.query(
    `INSERT INTO absen (id, nama, waktu, lat, lng, akurasi, foto_path, status, kegiatan, kegiatan_catatan, terlambat)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, nama, waktu, lat, lng, akurasi || null, fileName, "WFH", kegiatan, kegiatan === "Lainnya" ? kegiatan_catatan.trim() : null, terlambat]
  );

  res.json({ ok: true, id, waktu, terlambat });
}));

// Endpoint untuk admin: lihat data absen (dengan pencarian nama, filter tanggal, & pagination)
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

  const data = rows.map((r) => ({ ...r, foto_url: `/uploads/${r.foto_path}` }));
  res.json({ data, total, page, limit, totalPages: Math.max(Math.ceil(total / limit), 1) });
}));

// Statistik ringkas untuk dashboard
app.get("/api/absen/stats", requireAdminKey, wrap(async (req, res) => {
  const { tanggal: hariIni } = waktuJakartaSekarang();
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM absen`);
  const [[{ hariIniCount }]] = await pool.query(`SELECT COUNT(*) AS hariIniCount FROM absen WHERE waktu LIKE ?`, [`${hariIni}%`]);
  const [[{ orangUnik }]] = await pool.query(`SELECT COUNT(DISTINCT nama) AS orangUnik FROM absen`);
  const [[{ terlambatCount }]] = await pool.query(
    `SELECT COUNT(*) AS terlambatCount FROM absen WHERE waktu LIKE ? AND terlambat = 'Ya'`,
    [`${hariIni}%`]
  );
  res.json({ total, hariIni: hariIniCount, orangUnik, terlambatHariIni: terlambatCount });
}));

// Export data (sesuai filter) ke CSV
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
    `SELECT nama, waktu, status, terlambat, kegiatan, kegiatan_catatan, lat, lng, akurasi FROM absen ${where} ORDER BY waktu DESC`,
    params
  );

  let csv = "Nama,Waktu,Status,Terlambat,Kegiatan,Catatan Kegiatan,Latitude,Longitude,Akurasi(m)\n";
  for (const r of rows) {
    const kegiatanFinal = r.kegiatan === "Lainnya" ? `${r.kegiatan} - ${r.kegiatan_catatan || ""}` : r.kegiatan;
    csv += `"${r.nama.replace(/"/g, '""')}",${r.waktu},"${r.status || ""}","${r.terlambat || ""}","${kegiatanFinal || ""}","${(r.kegiatan_catatan || "").replace(/"/g, '""')}",${r.lat},${r.lng},${r.akurasi ?? ""}\n`;
  }

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="absen-export.csv"`);
  res.send(csv);
}));

// Halaman dashboard admin
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server absen jalan di http://localhost:${PORT}`);
      console.log(`Dashboard admin: http://localhost:${PORT}/admin`);
    });
  })
  .catch((err) => {
    console.error("Gagal konek/menyiapkan database:", err.message);
    console.error("Cek kembali isian DB_HOST/DB_USER/DB_PASSWORD/DB_NAME di file .env");
    process.exit(1);
  });