const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const preview = document.getElementById("preview");
const namaInput = document.getElementById("nama");
const statusInput = document.getElementById("status");
const kegiatanInput = document.getElementById("kegiatan");
const kegiatanCatatanWrap = document.getElementById("kegiatanLainnyaWrap");
const kegiatanCatatanInput = document.getElementById("kegiatanCatatan");
const btnCamera = document.getElementById("btnCamera");
const btnCapture = document.getElementById("btnCapture");
const btnRetake = document.getElementById("btnRetake");
const btnSubmit = document.getElementById("btnSubmit");
const statusEl = document.getElementById("statusMsg");
const dayBadge = document.getElementById("dayBadge");
const stampEl = document.getElementById("stamp");

let stream = null;
let capturedDataUrl = null;
let currentPosition = null; // { lat, lng, akurasi }

const HARI = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];

function updateDayBadge() {
  const today = new Date();
  const namaHari = HARI[today.getDay()];
  dayBadge.textContent = `Hari ini: ${namaHari}`;
  if (today.getDay() !== 5) {
    dayBadge.style.color = "#e2554d";
  }
}
updateDayBadge();

function setStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = "status" + (type ? " " + type : "");
}

async function loadPeserta() {
  namaInput.innerHTML = `<option value="">Memuat daftar peserta...</option>`;
  try {
    const res = await fetch("/api/peserta");
    const data = await res.json();

    namaInput.innerHTML = `<option value="">— pilih nama dari daftar peserta —</option>`;
    for (const p of data) {
      const opt = document.createElement("option");
      opt.value = p.nama_lengkap;
      opt.textContent = p.nama_lengkap;
      namaInput.appendChild(opt);
    }
    if (data.length === 0) {
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

    statusInput.innerHTML = `<option value="">— pilih status —</option>`;
    for (const s of data.status) {
      const opt = document.createElement("option");
      opt.value = s;
      opt.textContent = s;
      statusInput.appendChild(opt);
    }

    kegiatanInput.innerHTML = `<option value="">— pilih kegiatan —</option>`;
    for (const k of data.kegiatan) {
      const opt = document.createElement("option");
      opt.value = k;
      opt.textContent = k;
      kegiatanInput.appendChild(opt);
    }
  } catch (err) {
    setStatus("Gagal memuat opsi status/kegiatan: " + err.message, "err");
  }
}
loadOpsi();

kegiatanInput.addEventListener("change", () => {
  kegiatanCatatanWrap.style.display = kegiatanInput.value === "Lainnya" ? "block" : "none";
});

btnCamera.addEventListener("click", async () => {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 480 }, height: { ideal: 360 } },
      audio: false,
    });
    video.srcObject = stream;
    video.style.display = "block";
    btnCapture.disabled = false;
    setStatus("Kamera aktif. Posisikan wajah lalu ambil foto.", "");

    // Sekalian minta lokasi begitu kamera dinyalakan, biar user hanya izinkan sekali di awal
    requestLocation();
  } catch (err) {
    setStatus("Gagal mengakses kamera: " + err.message + " (pastikan izin kamera diaktifkan di browser)", "err");
  }
});

function requestLocation() {
  if (!navigator.geolocation) {
    setStatus("Perangkat tidak mendukung geolokasi.", "err");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      currentPosition = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        akurasi: pos.coords.accuracy,
      };
    },
    (err) => {
      setStatus("Gagal mengambil lokasi: " + err.message, "err");
    },
    { enableHighAccuracy: true, timeout: 15000 }
  );
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
  btnSubmit.disabled = false;

  // Matikan stream kamera setelah foto diambil
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
  }

  stampEl.style.display = "flex";
  setStatus("Foto berhasil diambil. Cek nama, lalu kirim absen.", "ok");
});

btnRetake.addEventListener("click", () => {
  capturedDataUrl = null;
  preview.style.display = "none";
  btnRetake.style.display = "none";
  btnSubmit.disabled = true;
  stampEl.style.display = "none";
  btnCamera.click();
});

btnSubmit.addEventListener("click", async () => {
  const nama = namaInput.value.trim();
  const status = statusInput.value;
  const kegiatan = kegiatanInput.value;
  const kegiatan_catatan = kegiatanCatatanInput.value.trim();

  if (!nama) {
    setStatus("Pilih nama kamu dulu ya.", "err");
    return;
  }
  if (!status) {
    setStatus("Pilih status kehadiran dulu.", "err");
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
  if (!currentPosition) {
    setStatus("Lokasi belum didapat, tunggu sebentar atau nyalakan ulang kamera.", "err");
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
        status,
        kegiatan,
        kegiatan_catatan,
      }),
    });
    const data = await res.json();

    if (!res.ok) {
      setStatus(data.error || "Gagal mengirim absen.", "err");
      btnSubmit.disabled = false;
      return;
    }

    setStatus("Absen berhasil dikirim! Terima kasih.", "ok");
  } catch (err) {
    setStatus("Tidak bisa terhubung ke server: " + err.message, "err");
    btnSubmit.disabled = false;
  }
});