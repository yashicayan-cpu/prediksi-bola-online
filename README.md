# Prediksi Bola Online

Website jadwal dan prediksi sepak bola berbasis Cloudflare Workers + D1.

Fitur utama:
- Halaman publik jadwal dan prediksi
- Admin login
- Paste jadwal massal
- Deteksi liga dan handicap
- Prediksi otomatis berdasarkan arah handicap
- Skor acak yang mengikuti tim favorit
- Preview sebelum publish
- Penyimpanan Cloudflare D1

Format input contoh:

```text
ITALY SERIE A

08/09 0:00  Cagliari  VS  Lecce 0 : 1/2
08/09 2:45  Udinese  VS  Lazio 0 : 1/4

SPAIN LA LIGA

08/09 1:00  Getafe CF  VS  Celta Vigo 0 : 1/4
08/09 3:30  Elche  VS  Real Sociedad 1/4 : 0
```

Prediksi sistem adalah perkiraan berbasis handicap yang diinput dan randomisasi skor, bukan jaminan hasil pertandingan.
