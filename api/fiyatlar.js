// Vercel Serverless Function  ->  /api/fiyatlar
// Tarayıcı ozandoviz.com'a doğrudan gidemez (CORS). Bu fonksiyon veriyi sunucu tarafında çeker,
// düzenleyip aynı alan adından (CORS sorunu olmadan) ekrana verir.

const TABAN = process.env.KAYNAK_TABAN || "https://www.ozandoviz.com/";

const KAYNAKLAR = {
  tl: "onlinesarrafiyetlpagedataredis.php",      // Sarrafiye TL alış / satış (Yeni + Eski)
  has: "sarrafiyehaspagedataredis.php",          // Sarrafiye Has
  iscilik: "onlinesarrafiyepagedataredis.php",   // Sarrafiye İşçilik
  milyem: "gram2pagedataredis.php",              // 1.00/995 satırı: Milyem
  gram: "centergramgoldpagedata.php",            // 1 gram fiyatı  (<-- bkz. aşağıdaki not)
};
// NOT: Ozandöviz sayfasındaki "1.00/995" FİYAT satırının (ör. 6,335.4 / 6,409.0) tam adresi
// belliyse sadece yukarıdaki "gram" adresini ve alttaki GRAM_ANAHTAR değerini değiştirin.
const GRAM_ANAHTAR = "gram13";

const SURE_ASIMI_MS = 6000;

// "6,333" -> 6333   "1,000.0" -> 1000   "10317.25" -> 10317.25
function sayi(v) {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}
function cift(x) {
  return x ? { alis: sayi(x.alis), satis: sayi(x.satis) } : null;
}

// ---- Ürün eşleştirme (işçilik adresi liste döndürür) ----
function urunSirasi(kod) {
  const t = String(kod).toLocaleLowerCase("tr-TR");
  if (t.includes("çeyrek")) return 0;
  if (t.includes("yarım")) return 1;
  if (t.includes("teklik")) return 2;
  if (t.includes("gremse")) return 3;
  if (t.includes("beşli")) return 5;
  if (t.includes("lira")) return 4;
  return -1;
}
function yeniMi(kod) {
  const t = String(kod).toLocaleLowerCase("tr-TR").trim();
  if (/^(yeni|y\.|y\s)/.test(t)) return true;
  if (/^(eski|e\.|e\s)/.test(t)) return false;
  return null;
}
function diziyiAnahtarla(dizi) {
  const sonuc = {};
  let tamam = true;
  dizi.forEach(function (satir) {
    const sira = urunSirasi(satir.code), yeni = yeniMi(satir.code);
    if (sira < 0 || yeni === null) { tamam = false; return; }
    sonuc["stl" + (2 * sira + (yeni ? 1 : 2))] = satir;
  });
  if (tamam && Object.keys(sonuc).length === dizi.length) return sonuc;
  const yedek = {};                       // adlar tanınmazsa: önce 6 Yeni, sonra 6 Eski
  dizi.forEach(function (satir, i) {
    yedek["stl" + (2 * (i % 6) + (i < 6 ? 1 : 2))] = satir;
  });
  return yedek;
}

function haritala(nesne) {
  const cikti = {};
  Object.keys(nesne).forEach(function (k) { cikti[k] = cift(nesne[k]); });
  return cikti;
}
function ilkSatir(nesne, tercih) {
  const satir = (tercih && nesne[tercih]) || nesne[Object.keys(nesne)[0]];
  if (!satir) throw new Error("Satır bulunamadı");
  return { kod: satir.code, alis: sayi(satir.alis), satis: sayi(satir.satis) };
}

const ISLE = {
  tl: function (d) { return haritala(d); },
  has: function (d) { return haritala(d); },
  iscilik: function (d) { return haritala(Array.isArray(d) ? diziyiAnahtarla(d) : d); },
  milyem: function (d) { return ilkSatir(d); },                    // gram2... içindeki İLK satır
  gram: function (d) { return ilkSatir(d, GRAM_ANAHTAR); },
};

async function cek(dosya) {
  const kontrol = new AbortController();
  const zamanlayici = setTimeout(function () { kontrol.abort(); }, SURE_ASIMI_MS);
  try {
    const cevap = await fetch(TABAN + dosya, {
      headers: { "User-Agent": "Mozilla/5.0", "Cache-Control": "no-cache" },
      signal: kontrol.signal,
    });
    if (!cevap.ok) throw new Error("HTTP " + cevap.status);
    const json = JSON.parse(await cevap.text());
    if (!json || json.data === null || typeof json.data !== "object") throw new Error("Beklenmeyen veri");
    return json.data;
  } finally {
    clearTimeout(zamanlayici);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }

  const adlar = Object.keys(KAYNAKLAR);
  const sonuclar = await Promise.all(adlar.map(function (ad) {
    return cek(KAYNAKLAR[ad])
      .then(function (d) { return { ok: true, veri: ISLE[ad](d) }; })
      .catch(function (e) { return { ok: false, hata: String((e && e.message) || e) }; });
  }));

  const kaynaklar = {};
  adlar.forEach(function (ad, i) { kaynaklar[ad] = sonuclar[i]; });
  const hicbiriYok = sonuclar.every(function (s) { return !s.ok; });

  // Vercel kenarında 5 sn önbellek: kaç ekran açık olursa olsun ozandoviz'e ~5 sn'de bir tek istek gider.
  // (Tarayıcı tarafında önbellek yok: max-age=0. "stale-while-revalidate" bilerek KULLANILMADI,
  //  çünkü eski veriyi "canlı" gibi gösterebilir.)
  res.setHeader("Cache-Control", hicbiriYok
    ? "no-store"
    : "public, max-age=0, s-maxage=5");
  res.statusCode = hicbiriYok ? 502 : 200;
  res.end(JSON.stringify({ zaman: new Date().toISOString(), kaynaklar: kaynaklar }));
};
