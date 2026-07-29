-- phpMyAdmin SQL Dump
-- version 5.2.1
-- https://www.phpmyadmin.net/
--
-- Host: 127.0.0.1
-- Generation Time: Jul 28, 2026 at 02:06 AM
-- Server version: 10.4.32-MariaDB
-- PHP Version: 8.2.12

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Database: `absen_wfh`
--

-- --------------------------------------------------------

--
-- Table structure for table `absen`
--

CREATE TABLE `absen` (
  `id` varchar(36) NOT NULL,
  `nama` varchar(255) NOT NULL,
  `waktu` varchar(40) NOT NULL,
  `lat` double DEFAULT NULL,
  `lng` double DEFAULT NULL,
  `akurasi` double DEFAULT NULL,
  `foto_path` varchar(255) NOT NULL,
  `status` varchar(50) DEFAULT NULL,
  `kegiatan` varchar(255) DEFAULT NULL,
  `kegiatan_catatan` text DEFAULT NULL,
  `terlambat` varchar(5) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `peserta`
--

CREATE TABLE `peserta` (
  `id` varchar(36) NOT NULL,
  `nama_lengkap` varchar(255) NOT NULL,
  `nrp` varchar(50) DEFAULT NULL,
  `jenis` varchar(10) DEFAULT NULL,
  `bagian` varchar(150) DEFAULT NULL,
  `jabatan` varchar(150) DEFAULT NULL,
  `tempat` varchar(50) DEFAULT NULL,
  `dibuat_pada` varchar(40) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `peserta`
--

INSERT INTO `peserta` (`id`, `nama_lengkap`, `nrp`, `jenis`, `bagian`, `jabatan`, `tempat`, `dibuat_pada`) VALUES
('0a0fd944-8592-11f1-a907-e24cd7510f57', 'Mayor Cku (K) Yanti D', NULL, NULL, NULL, NULL, NULL, NULL),
('0a0fe5bd-8592-11f1-a907-e24cd7510f57', 'Peltu (K) Ai Hayati', NULL, NULL, NULL, NULL, NULL, NULL),
('0a0fe672-8592-11f1-a907-e24cd7510f57', 'Serma Supriatni', NULL, NULL, NULL, NULL, NULL, NULL),
('0a0fe6b8-8592-11f1-a907-e24cd7510f57', 'Serda Kalery Alek Alvianus W', NULL, NULL, NULL, NULL, NULL, NULL),
('0a0fe6ff-8592-11f1-a907-e24cd7510f57', 'Praka Andri Abdurahman', NULL, NULL, NULL, NULL, NULL, NULL),
('0a0fe867-8592-11f1-a907-e24cd7510f57', 'Pratu Sandy Oktaviana R', NULL, NULL, NULL, NULL, NULL, NULL),
('0a0fe8a6-8592-11f1-a907-e24cd7510f57', 'Pns Suparmi', NULL, NULL, NULL, NULL, NULL, NULL),
('0a0fe8e1-8592-11f1-a907-e24cd7510f57', 'Pns Yusup Sugiri', NULL, NULL, NULL, NULL, NULL, NULL),
('0a0fe927-8592-11f1-a907-e24cd7510f57', 'Pns Engkus Kurniawan', NULL, NULL, NULL, NULL, NULL, NULL),
('0a0fe98a-8592-11f1-a907-e24cd7510f57', 'Pns Rahmi Gun Indrarini', NULL, NULL, NULL, NULL, NULL, NULL),
('5690185d-451b-43a8-95d0-c83edc91e1c7', 'Thifaal Fauzan', NULL, NULL, NULL, NULL, NULL, NULL);

--
-- Indexes for dumped tables
--

--
-- Indexes for table `absen`
--
ALTER TABLE `absen`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_absen_waktu` (`waktu`),
  ADD KEY `idx_absen_nama` (`nama`);

--
-- Indexes for table `peserta`
--
ALTER TABLE `peserta`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `nama_lengkap` (`nama_lengkap`);
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
