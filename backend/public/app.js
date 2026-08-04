// ===== Elemen utama =====
const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const preview = document.getElementById("preview");
const namaInput = document.getElementById("nama");
const kegiatanInput = document.getElementById("kegiatan");
const kegiatanCatatanWrap = document.getElementById("kegiatanLainnyaWrap");
const kegiatanCatatanInput = document.getElementById("kegiatanCatatan");
const statusKehadiranInput = document.getElementById("statusKehadiran");
const lampiranWrap = document.getElementById("lampiranWrap");
const lampiranFile = document.getElementById("lampiranFile");
const catatanInput = document.getElementById("catatan");
const catatanCount = document.getElementById("catatanCount");
const catatanLabel = document.getElementById("catatanLabel");
const btnCamera = document.getElementById("btnCamera");
const btnCapture = document.getElementById("btnCapture");
const btnRetake = document.getElementById("btnRetake");
const btnSubmit = document.getElementById("btnSubmit");
const statusEl = document.getElementById("statusMsg");
const dayBadge = document.getElementById("dayBadge");
const stampEl = document.getElementById("stamp");
const locBadge = document.getElementById("locBadge");
const locText = document.getElementById("locText");
const btnRetryLoc = document.getElementById("btnRetryLoc");
const intro = document.getElementById("intro");
const mainApp = document.getElementById("mainApp");
const btnMulai = document.getElementById("btnMulai");
const qualityBadge = document.getElementById("qualityBadge");
const qualityText = document.getElementById("qualityText");

// Riwayat lokal (fitur 7)
const btnRiwayat = document.getElementById("btnRiwayat");
const btnRiwayatIntro = document.getElementById("btnRiwayatIntro");
const riwayatOverlay = document.getElementById("riwayatOverlay");
const riwayatList = document.getElementById("riwayatList");
const btnCloseRiwayat = document.getElementById("btnCloseRiwayat");

let stream = null;
let capturedDataUrl = null;
let currentPosition = null; // { lat, lng, akurasi }
let lampiranDataUrl = null;
let lampiranNamaFile = null;
let photoQualityOk = false;

const HARI = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
const HISTORY_KEY = "absen_riwayat_lokal_v1";

btnMulai.addEventListener("click", () => {
  intro.style.display = "none";
  mainApp.style.display = "block";
});

function updateDayBadge() {
  const today = new Date();
  const dow = today.getDay(); // 0=Minggu ... 6=Sabtu
  const namaHari = HARI[dow];

  if (dow === 5) {
    dayBadge.textContent = `Hari ini: ${namaHari} (Jadwal WFH)`;
  } else if (dow === 0 || dow === 6) {
    dayBadge.textContent = `Hari ini: ${namaHari} (Libur)`;
    dayBadge.style.color = "#8891A8";
  } else {
    dayBadge.textContent = `Hari ini: ${namaHari} (Bukan jadwal WFH)`;
    dayBadge.style.color = "#e2554d";
  }
}
updateDayBadge();

// ==========================================================
// FITUR 6: Toast Notification Beranimasi (pengganti alert())
// ==========================================================
const toastContainer = document.getElementById("toastContainer");

function showToast(msg, type = "info", duration = 3500) {
  const el = document.createElement("div");
  el.className = "toast " + type;
  el.innerHTML = `<span class="dot"></span><span class="toast-msg"></span>`;
  el.querySelector(".toast-msg").textContent = msg;
  toastContainer.appendChild(el);
  setTimeout(() => {
    el.classList.add("hide");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  }, duration);
}
// Override window.alert supaya semua alert() lama otomatis jadi toast rapi
window.alert = (msg) => showToast(String(msg), "info", 4000);

function setStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = "status" + (type ? " " + type : "");
  if (msg) {
    showToast(msg, type === "err" ? "err" : type === "ok" ? "ok" : "info");
  }
}

// ==========================================================
// Daftar peserta & kegiatan (dari API, dengan fallback aman)
// ==========================================================
async function loadPeserta() {
  namaInput.innerHTML = `<option value="">Memuat daftar peserta...</option>`;
  try {
    const res = await fetch("/api/peserta");
    const data = await res.json();
    const list = Array.isArray(data) ? data : data.data || data.peserta || [];

    namaInput.innerHTML = `<option value="">— pilih nama dari daftar peserta —</option>`;
    for (const p of list) {
      const namaVal = p.nama_lengkap || p.nama || p.fullname || p;
      if (!namaVal) continue;
      const opt = document.createElement("option");
      opt.value = namaVal;
      opt.textContent = namaVal;
      namaInput.appendChild(opt);
    }
    if (list.length === 0) {
      namaInput.innerHTML = `<option value="">— daftar peserta masih kosong —</option>`;
      setStatus("Daftar peserta masih kosong. Hubungi admin untuk mendaftarkan nama.", "err");
    }
  } catch (err) {
    namaInput.innerHTML = `<option value="">— gagal memuat daftar —</option>`;
    setStatus("Gagal memuat daftar peserta: " + err.message, "err");
  }
}
loadPeserta();

async function loadOpsi() {
  try {
    const res = await fetch("/api/opsi");
    const data = await res.json();

    kegiatanInput.innerHTML = `<option value="">— pilih kegiatan —</option>`;
    for (const k of data.kegiatan) {
      const opt = document.createElement("option");
      opt.value = k;
      opt.textContent = k;
      kegiatanInput.appendChild(opt);
    }
  } catch (err) {
    setStatus("Gagal memuat daftar kegiatan: " + err.message, "err");
  }
}
loadOpsi();

kegiatanInput.addEventListener("change", () => {
  kegiatanCatatanWrap.style.display = kegiatanInput.value === "Lainnya" ? "block" : "none";
});

// ==========================================================
// FITUR 1: Catatan / Keterangan Tugas — hitung karakter
// ==========================================================
catatanInput.addEventListener("input", () => {
  catatanCount.textContent = catatanInput.value.length;
});

// ==========================================================
// FITUR 4: Status Kehadiran fleksibel + lampiran izin/sakit
// + Catatan Sakit / Catatan Izin (kolom catatan berubah otomatis)
// ==========================================================
const CATATAN_CONFIG = {
  Hadir: {
    label: "Catatan / Keterangan Tugas",
    placeholder: "Tuliskan ringkasan tugas atau catatan hari ini (opsional)...",
  },
  Izin: {
    label: "Catatan Izin",
    placeholder: "Jelaskan alasan izin Anda (mis. keperluan keluarga, dinas luar, dll)...",
  },
  Sakit: {
    label: "Catatan Sakit",
    placeholder: "Jelaskan keluhan / keterangan sakit Anda...",
  },
};

function updateCatatanField() {
  const status = statusKehadiranInput.value;
  const cfg = CATATAN_CONFIG[status] || CATATAN_CONFIG.Hadir;
  catatanLabel.textContent = cfg.label;
  catatanInput.placeholder = cfg.placeholder;
}

statusKehadiranInput.addEventListener("change", () => {
  const perluLampiran = statusKehadiranInput.value === "Izin" || statusKehadiranInput.value === "Sakit";
  lampiranWrap.style.display = perluLampiran ? "block" : "none";
  if (!perluLampiran) {
    lampiranFile.value = "";
    lampiranDataUrl = null;
    lampiranNamaFile = null;
  }
  updateCatatanField();
  checkFormReady();
});

// Set label/placeholder awal sesuai status default saat halaman dimuat
updateCatatanField();

lampiranFile.addEventListener("change", () => {
  const file = lampiranFile.files[0];
  if (!file) {
    lampiranDataUrl = null;
    lampiranNamaFile = null;
    checkFormReady();
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    showToast("Ukuran lampiran maksimal 5MB.", "err");
    lampiranFile.value = "";
    lampiranDataUrl = null;
    lampiranNamaFile = null;
    checkFormReady();
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    lampiranDataUrl = reader.result;
    lampiranNamaFile = file.name;
    showToast("Lampiran berhasil dipilih: " + file.name, "ok");
    checkFormReady();
  };
  reader.readAsDataURL(file);
});

// ==========================================================
// Kamera
// ==========================================================
btnCamera.addEventListener("click", async () => {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 480 }, height: { ideal: 360 } },
      audio: false,
    });
    video.srcObject = stream;
    video.style.display = "block";
    preview.style.display = "none";
    btnCapture.disabled = false;
    setStatus("Kamera aktif. Posisikan wajah lalu ambil foto.", "");

    requestLocation();
  } catch (err) {
    setStatus("Gagal mengakses kamera: " + err.message + " (pastikan izin kamera diaktifkan di browser)", "err");
  }
});

function setLocBadge(state, text) {
  locBadge.className = "loc-badge" + (state ? " " + state : "");
  locText.textContent = text;
  btnRetryLoc.style.display = state === "err" ? "inline-block" : "none";
}

function requestLocation() {
  if (!navigator.geolocation) {
    setLocBadge("err", "Perangkat tidak mendukung geolokasi.");
    return;
  }
  setLocBadge("loading", "Mendeteksi lokasi...");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      currentPosition = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        akurasi: pos.coords.accuracy,
      };
      const akurasiText = pos.coords.accuracy ? ` (±${Math.round(pos.coords.accuracy)}m)` : "";
      setLocBadge(
        "ok",
        `Lokasi terdeteksi: ${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}${akurasiText}`
      );
      checkFormReady();
    },
    (err) => {
      setLocBadge("err", "Gagal mengambil lokasi: " + err.message);
      checkFormReady();
    },
    { enableHighAccuracy: true, timeout: 15000 }
  );
}

btnRetryLoc.addEventListener("click", requestLocation);

// ==========================================================
// FITUR 8: Validasi kualitas foto sederhana (deteksi kosong / gelap)
// ==========================================================
function setQualityBadge(state, text) {
  qualityBadge.className = "quality-badge " + state;
  qualityText.textContent = text;
}

function analyzePhotoQuality(ctx, width, height) {
  const sampleW = Math.min(width, 160);
  const sampleH = Math.min(height, 120);
  let imageData;
  try {
    imageData = ctx.getImageData(0, 0, width, height);
  } catch (e) {
    return { ok: true, brightness: 128, variance: 50, reason: "unchecked" };
  }
  const data = imageData.data;
  const step = Math.max(1, Math.floor(data.length / 4 / (sampleW * sampleH)));
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 4 * step) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    sum += lum;
    sumSq += lum * lum;
    n++;
  }
  const mean = sum / n;
  const variance = sumSq / n - mean * mean;

  if (mean < 25) {
    return { ok: false, brightness: mean, variance, reason: "gelap" };
  }
  if (mean > 240 && variance < 60) {
    return { ok: false, brightness: mean, variance, reason: "terang" };
  }
  if (variance < 15) {
    return { ok: false, brightness: mean, variance, reason: "kosong" };
  }
  return { ok: true, brightness: mean, variance, reason: "ok" };
}

btnCapture.addEventListener("click", () => {
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  capturedDataUrl = canvas.toDataURL("image/jpeg", 0.9);

  preview.src = capturedDataUrl;
  preview.style.display = "block";
  video.style.display = "none";
  btnRetake.style.display = "block";
  btnCapture.disabled = true;
  btnCamera.style.display = "none";

  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
  }

  stampEl.style.display = "flex";

  const quality = analyzePhotoQuality(ctx, canvas.width, canvas.height);
  photoQualityOk = quality.ok;
  if (quality.ok) {
    setQualityBadge("ok", "Kualitas foto baik");
    setStatus("Foto berhasil diambil. Cek nama, lalu kirim absen.", "ok");
  } else {
    let pesan = "Foto tampak kurang jelas";
    if (quality.reason === "gelap") pesan = "Foto terlalu gelap";
    else if (quality.reason === "terang") pesan = "Foto terlalu terang / silau";
    else if (quality.reason === "kosong") pesan = "Foto tampak kosong / kamera tertutup";
    setQualityBadge("bad", pesan + " — ambil ulang");
    showToast(pesan + ". Silakan ambil ulang foto Anda.", "err");
  }

  checkFormReady();
});

btnRetake.addEventListener("click", () => {
  capturedDataUrl = null;
  preview.style.display = "none";
  btnRetake.style.display = "none";
  btnCamera.style.display = "block";
  btnSubmit.disabled = true;
  stampEl.style.display = "none";
  qualityBadge.className = "quality-badge";
  photoQualityOk = false;
  btnCamera.click();
});

// ==========================================================
// Validasi kesiapan form
// ==========================================================
function checkFormReady() {
  const status = statusKehadiranInput.value;
  const perluIzinSakit = status === "Izin" || status === "Sakit";
  const catatanIzinSakitOk = !perluIzinSakit || !!catatanInput.value.trim();
  const lampiranOk = !perluIzinSakit || !!lampiranDataUrl;

  const ready =
    !!capturedDataUrl &&
    photoQualityOk &&
    !!currentPosition &&
    !!namaInput.value &&
    catatanIzinSakitOk &&
    lampiranOk;
  btnSubmit.disabled = !ready;
}
namaInput.addEventListener("change", checkFormReady);
kegiatanInput.addEventListener("change", checkFormReady);
catatanInput.addEventListener("input", checkFormReady);

// ==========================================================
// FITUR 7: Riwayat Lokal (localStorage) — per perangkat
// ==========================================================
function getLocalHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
  } catch (e) {
    return [];
  }
}

function saveLocalHistory(entry) {
  const list = getLocalHistory();
  list.unshift(entry);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 50)));
}

function renderHistory() {
  const list = getLocalHistory();
  if (list.length === 0) {
    riwayatList.innerHTML = `<div class="hist-empty">Belum ada riwayat absen di perangkat ini.</div>`;
    return;
  }
  riwayatList.innerHTML = list
    .map((item) => {
      const waktu = new Date(item.waktu).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" });
      const statusColor =
        item.status === "Hadir" ? "var(--green)" : item.status === "Izin" || item.status === "Sakit" ? "var(--amber)" : "var(--text)";
      return `
        <div class="hist-item">
          <div class="hist-top">
            <span class="hist-status" style="color:${statusColor}">${item.status || "-"}${item.terlambat === "Ya" ? " · Terlambat" : ""}</span>
            <span class="hist-time">${waktu}</span>
          </div>
          <div class="hist-note">${item.kegiatan || "-"}</div>
          ${item.catatan ? `<div class="hist-note">📝 ${item.catatan}</div>` : ""}
        </div>`;
    })
    .join("");
}

function openRiwayat() {
  renderHistory();
  riwayatOverlay.classList.add("show");
}
function closeRiwayat() {
  riwayatOverlay.classList.remove("show");
}
btnRiwayat.addEventListener("click", openRiwayat);
btnRiwayatIntro.addEventListener("click", () => {
  intro.style.display = "none";
  mainApp.style.display = "block";
  openRiwayat();
});
btnCloseRiwayat.addEventListener("click", closeRiwayat);
riwayatOverlay.addEventListener("click", (e) => {
  if (e.target === riwayatOverlay) closeRiwayat();
});

// ==========================================================
// Kirim absen
// ==========================================================
btnSubmit.addEventListener("click", async () => {
  const nama = namaInput.value.trim();
  const kegiatan = kegiatanInput.value;
  const kegiatan_catatan = kegiatanCatatanInput.value.trim();
  const status = statusKehadiranInput.value;
  const catatan = catatanInput.value.trim();

  if (!nama) {
    setStatus("Pilih nama kamu dulu ya.", "err");
    return;
  }
  if (!kegiatan) {
    setStatus("Pilih kegiatan dulu.", "err");
    return;
  }
  if (kegiatan === "Lainnya" && !kegiatan_catatan) {
    setStatus("Isi keterangan kegiatan kamu.", "err");
    return;
  }
  if (!capturedDataUrl) {
    setStatus("Ambil foto selfie dulu.", "err");
    return;
  }
  if (!photoQualityOk) {
    setStatus("Kualitas foto kurang baik. Silakan ambil ulang.", "err");
    return;
  }
  if (!currentPosition) {
    setStatus("Lokasi belum didapat, tunggu sebentar atau nyalakan ulang kamera.", "err");
    return;
  }
  if ((status === "Izin" || status === "Sakit") && !catatan) {
    setStatus("Isi catatan " + status.toLowerCase() + " terlebih dahulu.", "err");
    return;
  }
  if ((status === "Izin" || status === "Sakit") && !lampiranDataUrl) {
    setStatus("Unggah lampiran surat " + status.toLowerCase() + " terlebih dahulu.", "err");
    return;
  }

  btnSubmit.disabled = true;
  setStatus("Mengirim absen...", "");

  try {
    const res = await fetch("/api/absen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nama,
        foto: capturedDataUrl,
        lat: currentPosition.lat,
        lng: currentPosition.lng,
        akurasi: currentPosition.akurasi,
        kegiatan,
        kegiatan_catatan,
        status,
        catatan,
        lampiran: lampiranDataUrl,
        lampiran_nama: lampiranNamaFile,
      }),
    });
    const data = await res.json();

    if (!res.ok) {
      setStatus(data.error || "Gagal mengirim absen.", "err");
      btnSubmit.disabled = false;
      return;
    }

    const terlambat = data.terlambat === "Ya" ? "Ya" : "Tidak";

    saveLocalHistory({
      waktu: new Date().toISOString(),
      nama,
      status,
      kegiatan: kegiatan === "Lainnya" && kegiatan_catatan ? `${kegiatan} — ${kegiatan_catatan}` : kegiatan,
      catatan,
      terlambat,
    });

    if (terlambat === "Ya") {
      setStatus("Absen berhasil dikirim — tercatat TERLAMBAT (lewat jam 08.00).", "err");
    } else {
      setStatus("Absen berhasil dikirim, tepat waktu. Terima kasih.", "ok");
    }
  } catch (err) {
    setStatus("Tidak bisa terhubung ke server: " + err.message, "err");
    btnSubmit.disabled = false;
  }
});