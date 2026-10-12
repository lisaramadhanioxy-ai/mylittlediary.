My Little Diary

Aplikasi diary digital pribadi dengan akun pengguna, fitur penguncian PIN, penyimpanan kenangan, dan isolasi data antar pengguna.

Persyaratan

- Node.js versi 18 atau lebih baru.
- Browser modern.
- Seluruh file proyek, termasuk "server.js" dan folder "test/" jika ingin menjalankan tes keamanan.

Menjalankan Aplikasi

Buka Terminal atau Command Prompt di folder utama proyek, kemudian jalankan:

node server.js

Secara default, server berjalan di alamat:

http://localhost:3000

Untuk menjalankan tes keamanan isolasi data, gunakan terminal kedua:

node --test test/isolation.test.js

Tes keamanan bersifat opsional dan memerlukan file "test/isolation.test.js".

Fitur Keamanan dan Privasi

1. Isolasi Data Pengguna

Setiap entri diary, kenangan, dan pengaturan dikaitkan dengan "user_id" pemiliknya. Server memeriksa kepemilikan data berdasarkan sesi pengguna yang sedang login.

2. Autentikasi dan Sesi

Identitas pengguna ditentukan melalui sesi yang dikelola server. Token sesi disimpan dalam cookie dengan perlindungan "HttpOnly" dan "SameSite=Strict".

3. Perlindungan Akses Data

Pengguna tidak boleh membaca, mengubah, atau menghapus data milik akun lain. Permintaan terhadap data yang bukan milik pengguna akan ditolak oleh server.

4. Validasi Input

Server memvalidasi input dan membatasi field yang boleh diterima. Identitas pemilik data tidak boleh ditentukan secara bebas oleh browser.

5. Penguncian PIN

Fitur penguncian PIN harus diverifikasi oleh server, bukan hanya dengan menyembunyikan tampilan di browser.

6. Perlindungan Tambahan

Aplikasi menerapkan pembatasan percobaan login, validasi permintaan, dan header keamanan sesuai implementasi pada "server.js".

Penyimpanan Data

Data disimpan pada lokasi penyimpanan yang dikonfigurasi oleh server. Jika menggunakan penyimpanan file JSON, pastikan direktori data tidak dapat diakses secara langsung melalui web.

Jangan membagikan file database atau data pribadi pengguna.

Konfigurasi Server

Konfigurasi berikut dapat digunakan jika didukung oleh implementasi "server.js".

Variabel| Fungsi
"PORT"| Port server
"HOST"| Alamat server
"DATA_DIR"| Lokasi penyimpanan data
"SECURE_COOKIES=1"| Mengaktifkan cookie Secure untuk HTTPS
"TRUST_PROXY=1"| Mempercayai proxy yang telah dikonfigurasi dengan benar
"ALLOWED_HOSTS"| Membatasi host yang diizinkan

Deployment

Untuk penggunaan melalui internet, deploy aplikasi ke hosting yang mendukung Node.js dan menyediakan HTTPS.

Pastikan:

- Server backend benar-benar berjalan.
- Penyimpanan data bersifat persisten.
- Cookie dan konfigurasi keamanan disesuaikan dengan lingkungan produksi.
- Data pengguna tidak dapat diakses melalui URL publik.
- Rahasia dan kredensial tidak disimpan di kode frontend atau repositori publik.

Catatan: GitHub Pages hanya menyajikan file statis dan tidak menjalankan "server.js". Untuk mengaktifkan autentikasi dan isolasi data, backend harus dijalankan pada layanan server yang sesuai.

Catatan

README ini menjelaskan cara penggunaan dan keamanan aplikasi. Fitur yang disebutkan hanya berfungsi apabila benar-benar tersedia dan diterapkan dalam kode proyek.
