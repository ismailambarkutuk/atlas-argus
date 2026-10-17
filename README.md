# ATLAS–ARGUS

**Bağımsız doğrulamalı kripto koruma agent'ı** · Avalanche Team1 × OKX TR Agentic Hackathon, Ankara, 17 Ekim 2026

Kripto tutan ama piyasayı 7/24 izleyemeyen biri için çalışan otonom bir sistem. Olağandışı bir hareket gördüğünde bulgusunu **ikinci, bağımsız bir agent'a** doğrulatır. Emin olduğunda, sınırları kodla çizilmiş bir bütçeyle koruma işlemi (kısmi satış) hazırlar. **Emin olamadığında hiçbir şey yapmaz.**

---

## OKX Agent Trade Kit ile yapılan çağrılar

Piyasa verisi ve emir tarafı tamamen **OKX Agent Trade Kit (ATK)** üzerinden çalışır. ATK, projeye sabit sürümle bağımlılık olarak eklidir ([`@okx_ai/okx-trade-cli@1.4.8`](https://www.npmjs.com/package/@okx_ai/okx-trade-cli), `package.json`). Tüm çağrılar tek bir kapıdan geçer: [`src/okx.ts`](src/okx.ts) içindeki `runOkx`. Bu fonksiyon ATK'yı shell olmadan çalıştırır ve argümanları beyaz listeden geçirir.

| ATK komutu | Nerede | Ne için | Durum |
|---|---|---|---|
| `okx market candles <çift> --bar 1m --limit 300 [--after <ms>]` | [collector.ts](src/data/collector.ts) | 1 dakikalık kapanmış mumlar (canlı izleme, kayıt, tarihsel değerlendirme) | ✅ Gerçek çağrı |
| `okx market ticker <çift>` | [collector.ts](src/data/collector.ts) | Anlık fiyat (canlı modda emir boyutu için) | ✅ Gerçek çağrı |
| `okx market instruments --instType SPOT --instId <çift>` | [execute.ts](src/execute.ts) | Lot adımı ve minimum emir miktarı (risk motoru miktarı bunlara göre yuvarlar) | ✅ Gerçek çağrı |
| `okx account balance <ccy>` | [execute.ts](src/execute.ts) | Satılabilecek bakiye (risk motoru emri bunu aşmayacak şekilde boyutlar) | ✅ Gerçek çağrı (OKX TR) |
| `okx [--demo] spot place --instId <çift> --side sell --ordType market --sz <miktar> --tdMode cash` | [execute.ts](src/execute.ts) | Koruma amaçlı kısmi satış | ✅ Gerçek hesapta gönderildi ve gerçekleşti (aşağıya bakın). Varsayılan **DRY_RUN**: emir hazırlanır, gönderilmez |

Örnek çıktı (`npx tsx src/okx.ts`):

```
[OKX] Giriş dosyası: …/node_modules/@okx_ai/okx-trade-cli/dist/index.js (shell yok)
[OKX] BTC-USDT son fiyat: 81529.5 (1086 ms)
```

---

## Problem

Ani bir düşüşte elinde kripto olan bireysel kullanıcı ya uyuyordur ya da paniğe kapılır. Tek bir yapay zekâ agent'ına bu kararı bırakmak da güvenli değildir: LLM'ler halüsinasyon görür, olmayan veriye atıf yapar ve kendinden emin konuşur.

## Çözüm: iki agent, bir mühür, bir risk motoru

```
OKX ATK ──► istatistik ── tetik? ──┬──► ATLAS (Gemini) ──┐
(1m mumlar)  (robust z)            └──► ARGUS (Groq)  ───┴──► Avalanche mühür ──► karşılaştırma ──► risk motoru ──► emir ──► rapor
                                        aynı ham veri,         commit → reveal       kod, LLM yok     kod, LLM yok   DRY_RUN
                                        birbirinden habersiz
```

1. **Veri.** OKX Agent Trade Kit (`okx` CLI) ile 1 dakikalık kapanmış mumlar alınır.
2. **İstatistik tetiği (LLM yok).** Son mum, önceki 60 muma göre robust z ile ölçülür. Tetik koşulu: fiyat |z| ≥ 2 veya hacim z ≥ 3. Tetik yoksa LLM çağrılmaz.
3. **İki bağımsız analiz.** ATLAS ve ARGUS farklı sağlayıcılarda çalışır ve aynı ham pencereyi paralel analiz eder. Birbirlerinin çıktısını görmezler. Bulgular serbest metin değil, şemaya uyan JSON olarak döner. Şemaya uymayan çıktı ya da veride olmayan kayda atıf (halüsinasyon) **belirsiz** sayılır.
4. **Avalanche mührü.** İki bulgunun önce yalnızca hash'i Fuji C-Chain'e yazılır (commit). İkisi de yazıldıktan sonra bulgular açılır (reveal) ve hash doğrulanır.
5. **Karşılaştırma (LLM yok).** İki agent aynı sonuca vardı mı? Güven beyanları ve istatistik onayıyla birlikte uyum seviyesi belirlenir: yüksek / orta / belirsiz. Ayrışmada tek turluk bir uyuşmazlık turu yapılır. ATLAS'a yalnızca hangi alanda ayrışıldığı söylenir; fikrini ancak **yeni kanıtla** değiştirebilir.
6. **Risk motoru (LLM yok).** Saf, deterministik TypeScript. İzinli çiftler, bütçe tavanı, işlem başı limit, günlük zarar sınırı, lot yuvarlama ve minimum miktar burada uygulanır. Kill switch açıksa hiçbir emir gitmez.
7. **Emir ve rapor.** Onaylanan azaltma emri OKX ATK komutu olarak hazırlanır. Her karar gerekçesiyle HTML/JSON rapora yazılır.

| Bulgu | Uyum | Aksiyon |
|---|---|---|
| price_drop | yüksek | Eldeki varlığın limit dahilinde bir kısmını sat |
| price_drop | orta | Aynı, yarım boyutla |
| price_drop | belirsiz | **Yok** |
| price_spike / volume_spike | herhangi | Yalnızca uyarı |

## Neler gerçek, neler değil

| | Durum |
|---|---|
| OKX piyasa verisi (mum, ticker, enstrüman bilgisi) | ✅ ATK ile gerçek çağrılar |
| ATLAS ve ARGUS analizleri | ✅ Gerçek LLM çağrıları (Gemini, Groq). Demo yanıtları kayıtlı ve **KAYITLI YANIT** etiketiyle oynatılır. |
| Avalanche Fuji mührü | ✅ Gerçek işlemler. Örnek commit: [Snowtrace](https://testnet.snowtrace.io/tx/0x1094f51be21e5a10bf643ff711440a4bda958015d6f47ec43ec2e7a12627a321) · [mühür cüzdanının tüm işlemleri](https://testnet.snowtrace.io/address/0x54480A9725D919AeF4a9ef45b43552A8237200Ce) |
| Sürekli canlı izleme (`--watch`) | ✅ Gerçek piyasada her dakika |
| OKX bakiyesi | ✅ Gerçek hesaptan ATK ile okunuyor (`OKX_ACCOUNT=real`). Demo modunda demo anahtarı olmadığı için **SAHTE BAKİYE**; sahte bakiyeyle emir kodda engellidir. |
| OKX emri | ✅ Risk motorunun onayladığı emir ATK ile OKX TR'ye gönderildi ve gerçekleşti: ordId `4017908707754840064`, 0.00001472 BTC satış, ort. fiyat 81,519.5 USDT (≈1.2 USDT). Bu, emir ayağının testiydi: karar yapay olarak "price_drop / yüksek" verildi; fiyat, bakiye ve lot gerçekti. Varsayılan **DRY_RUN**'dır: demolarda emir hazırlanır ama gönderilmez. |

Mührün kanıtladığı şey: hiçbir agent, diğerinin cevabı açıklandıktan sonra fikrini değiştirmedi. ARGUS'un ATLAS'ın çıktısını görmediğini ise kod yapısı sağlar (ayrı çağrı, yalnızca ham veri), zincir değil.

## Kurulum

Gereksinim: Node.js 18+. OKX Agent Trade Kit `npm install` ile proje içine kurulur.

```bash
npm install
cp .env.example .env                    # Windows: copy .env.example .env
```

`.env` içinde doldurulacaklar:

| Değişken | Ne için |
|---|---|
| `GEMINI_API_KEY` | ATLAS (Google AI Studio, ücretsiz katman) |
| `GROQ_API_KEY` | ARGUS (console.groq.com, ücretsiz katman) |
| `AVAX_PRIVATE_KEY` | İsteğe bağlı. Yalnızca test AVAX içeren bir Fuji cüzdanı. Boşsa mühür yerel dosyaya yazılır. |

Sağlayıcılar `ATLAS_PROVIDER` / `ARGUS_PROVIDER` ile değiştirilebilir (`anthropic | openai | gemini | groq`). İki agent farklı sağlayıcıda olmalıdır. Diğer tüm limitler (bütçe, işlem başı limit, eşikler) `.env.example`'da açıklamalarıyla birlikte yer alır.

**Demo senaryoları için hiçbir anahtar gerekmez.** Agent yanıtları kayıtlıdır.

## Çalıştırma

| Komut | Ne yapar |
|---|---|
| `npm run demo:drop` | Kayıtlı veriye etiketli bir düşüş eklenir (**ENJEKTE**). İki agent örtüşür → uyum yüksek → azaltma emri hazırlanır (DRY_RUN) |
| `npm run demo:diverge` | Yoruma açık bir fitil eklenir. Agent'lar ayrışır → uyuşmazlık turu → **belirsiz, işlem yok** |
| `npm run demo:kill` | Uyum yüksek, ama kill switch emri durdurur |
| `npm run watch` | BTC-USDT'yi canlı izler, her dakika kontrol eder. Ctrl+C ile durur. |
| `npx tsx src/main.ts --symbol ETH-USDT` | Tek seferlik canlı kontrol |
| `npm run evaluate` | 20 tarihsel pencerelik değerlendirme (kayıtlı yanıtlarla, internetsiz) |

Raporlar `reports/` altına HTML ve JSON olarak yazılır. Demo senaryoları internet varsa mührü Fuji'ye yazar; yoksa otomatik olarak yerel mühüre geçer.

Kill switch: `KILL_SWITCH=1` ya da proje kökünde `KILL` adlı bir dosya. Watch modunda izlemeyi tamamen durdurur.

## Değerlendirme

Soru: *Uyumu yüksek bulgular gerçekten daha isabetli mi?* Gerçek BTC-USDT 1 dakikalık verisinden 10 olay penceresi (istatistik tetiği çalışan) ve 10 sakin pencere seçildi. Agent'lar yalnızca pencere sonuna kadarki veriyi gördü. Enjekte veri değerlendirmeye dahil değildir.

| Uyum | n | Anomali iddiası | 15 dk'da hareket sürdü | 60 dk'da hareket sürdü | Yanlış alarm (sakin piyasada) |
|---|---|---|---|---|---|
| yüksek | 4 | 4 | 2/4 | 0/4 | 0 |
| orta | 8 | 2 | 0/2 | 0/2 | 0 |
| belirsiz | 8 | 0 | – | – | 0 |

- Sakin piyasada hiç yanlış alarm yok.
- Yüksek uyumlu bulgular kısa vadede daha isabetli görünüyor, ama **örneklem çok küçük**. Bu bir sonuç değil, ilk sinyal ve tekrarlanabilir bir değerlendirme altyapısı.
- "Uyum beyanı" agent'ın kendi beyanıdır; kalibre değildir ve doğruluk olasılığı olarak okunmamalıdır.
- ATLAS yanıtlarının bir kısmı `gemini-3.8-flash`, bir kısmı `gemini-3.5-flash` ile alındı (ücretsiz kota nedeniyle). Model bilgisi sonuç dosyasında pencere bazında kayıtlıdır.

## Güvenlik ilkeleri

- **Varsayılan `DRY_RUN=1`.** Gerçek emir yalnızca açıkça `DRY_RUN=0` ile gider.
- **Yalnızca demo hesap veya izole etkinlik hesabı.** `OKX_ACCOUNT=demo`'da her emirde `--demo` zorunludur; `real` yalnızca bu iş için fonlanmış 30 USDT'lik hesapla, düşük limitlerle (bütçe 30, işlem başı 5, günlük zarar 5 USDT) kullanılır. API izni Read + Trade, çekim yok. Argümanlarda "live" geçen emir çalışma anında reddedilir.
- **Kayıtlı veya enjekte veriden gerçek emir çıkmaz.** Replay modunda ya da pencerede ENJEKTE kayıt varsa emir, `DRY_RUN=0` olsa bile yalnızca hazırlanır. Gerçek emir yalnızca anlık piyasa verisinden (canlı mod, `--watch`) çıkabilir.
- **LLM metni asla komut satırına girmez.** Emir argümanları yalnızca risk motorunun doğruladığı değerlerden oluşur: izinli çift, lot katına aşağı yuvarlanmış miktar, sabit emir tipi.
- **Belirsizlik = aksiyon yok.** Hata, zaman aşımı, geçersiz JSON ve halüsinasyon belirsiz sayılır.
- **Agent'lar opak kimlik görür** (`r-0001…`). Gerçek kayıt kimlikleri ve enjeksiyon bilgisi agent'lara gitmez.
- **Sırlar `.env`'de kalır.** Log'larda maskelenir, `okx` alt sürecine aktarılmaz, her anahtar yalnızca kendi sağlayıcısına gönderilir.

## Proje yapısı

```
src/
  config.ts        .env okuma, sağlayıcı seçimi, kill switch
  okx.ts           runOkx: ATK CLI'yi shell olmadan çağırır, argüman beyaz listesi
  data/            collector (OKX), replay, inject (etiketli yapay anomali)
  stats/           robust z
  agents/          atlas, argus, ortak şema/istem, kayıt (cache), OpenAI uyumlu istemci
  chain/seal.ts    SelfTxSeal (Fuji) + LocalLogSeal (yedek), commit → reveal
  compare.ts       uyum kuralları ve uyuşmazlık turu
  risk.ts          saf risk motoru (lot yuvarlama BigInt ile)
  execute.ts       emir (DRY_RUN), bakiye, enstrüman bilgisi
  report/          HTML/JSON rapor
  evaluate.ts      tarihsel değerlendirme
  main.ts          uçtan uca akış ve --watch
recordings/        kayıtlı piyasa verisi ve agent yanıtları
```

Her modül tek başına çalıştırılabilir; örneğin `npx tsx src/risk.ts` ya da `npx tsx src/chain/seal.ts`.

## Sınırlar ve sonraki adımlar

- Günlük zarar sınırı kodda var, ama gerçekleşen kâr/zarar henüz emir geçmişinden hesaplanmıyor (harcanan bütçe takip ediliyor). Sonraki adım: dolum fiyatlarından gerçekleşen zararın hesaplanması.
- Mühür şu an cüzdanın kendine gönderdiği 0 değerli işlemlerin veri alanında duruyor; hash doğrulaması zincir dışında yapılıyor. Bir mühür kontratı bu doğrulamayı zincir üzerinde yapabilir.
- İstatistik tetiği bilinçli olarak hassas (gerçek BTC verisinde yaklaşık 8 dakikada bir). Eleme işini iki agent'ın uyumu yapıyor. Ücretsiz LLM kotası için watch modunda tur sonrası bekleme ve oturum başına tur tavanı var.
- Değerlendirme örneklemi küçük. Altyapı daha fazla pencereyle tekrar çalıştırılmaya hazır (`--resume`).
