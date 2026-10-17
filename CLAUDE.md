# Proje: Bağımsız Doğrulamalı Kripto Koruma Agent'ı

OKX TR x Team1 Hackathon, Ankara, 17 Ekim 2026. Canlı demo saat 20:00'de.
Kod 19:00'da dondurulur. Bu tarihe kadar her şey çalışır durumda kalmalı.

## Tek cümlede

Kripto tutan ama piyasayı 7/24 izleyemeyen biri için çalışan, olağandışı bir
hareket gördüğünde kendi bulgusunu bağımsız bir ikinci agent'a doğrulatan, emin
olduğunda sınırları kodla çizilmiş bir bütçeyle koruma işlemi yapan, emin
olamadığında hiçbir şey yapmayan otonom sistem.

## Değişmez kurallar (asla ihlal etme)

1. **Yalnızca OKX demo hesabı veya bu iş için fonlanmış izole hesap.** Hesap
   türü `OKX_ACCOUNT` (`demo` | `real`) ile açıkça seçilir; demo'da her emir
   çağrısında `--demo` zorunludur. `real` yalnızca etkinlik için fonlanmış,
   küçük bakiyeli hesapla kullanılır (17 Ekim: organizatörlerin gönderdiği 30 USDT;
   bütçe 30, işlem başı 5, günlük zarar 5 USDT). Ana hesap anahtarı asla kullanılmaz;
   API izni Read + Trade, Withdraw yok. `live` kelimesini içeren hiçbir argüman,
   profil veya yapılandırma kodda bulunmaz. `execute.ts` bunu çalışma anında da
   kontrol eder ve argüman dizisinde `live` görürse emri reddeder.
2. **Varsayılan DRY_RUN=1.** Emir hazırlanır, risk onayı gösterilir, loglanır
   ama gönderilmez. Emrin gerçekten gönderilmesi için açıkça `DRY_RUN=0` gerekir.
3. **Risk motorunda LLM yok.** `src/risk.ts` saf, deterministik TypeScript.
   Aksiyonu agent'lar değil bu kod onaylar.
4. **LLM metni asla komut satırına girmez.** Emir argümanları yalnızca
   `risk.ts`'in ürettiği, doğrulanmış değerlerden (izinli çift, sayısal miktar,
   sabit emir tipi) oluşur.
5. **ARGUS, ATLAS'ın çıktısını asla görmez.** ARGUS'a sadece ham veri gider.
   İkisinin de çıktısı mühürlenmeden karşılaştırma yapılmaz.
6. **Sırlar `.env` içinde.** `.env` her zaman `.gitignore`'da. Anahtarları
   koda, log'a veya rapora yazma.
7. **Belirsizlik = aksiyon yok.** Şüphede kalan her durumda sonuç "işlem
   yapma"dır. Hata, zaman aşımı veya geçersiz JSON da belirsiz sayılır.
8. **CLI komutlarını ve bayraklarını uydurma.** `okx` sözdizimini `okx --help`
   ve `okx <komut> --help` çıktısından doğrula. Bilmediğin bir şeyi sor.
9. **Enjekte edilmiş veri her yerde etiketlenir.** Raporda ve logda "ENJEKTE",
   kayıtlı agent yanıtları "KAYITLI YANIT" olarak görünür.

## Teknoloji

- Node.js 18+, TypeScript, `npx tsx` ile çalıştırma (derleme adımı yok)
- Geliştirme ortamı: Windows, PowerShell. Yollar için `path` modülü.
- OKX Agent Trade Kit: `okx` CLI, child process ile çağrılır (aşağıya bak)
- LLM sağlayıcısı agent başına `.env`'den seçilir (`ATLAS_PROVIDER`, `ARGUS_PROVIDER`):
  `anthropic` (Anthropic SDK) veya OpenAI uyumlu `openai` | `gemini` | `groq`
  (`openai` SDK + baseURL, `src/agents/llm.ts`). ATLAS ve ARGUS **farklı
  sağlayıcıda** olmalı — farklı sağlayıcı bilinçli bir seçim.
- Hackathon kurulumu (ücretsiz katmanlar): ATLAS = Gemini (`gemini-3.5-flash`),
  ARGUS = Groq (`openai/gpt-oss-120b`). Demo yanıtları `gemini-3.8-flash` ile
  kaydedildi; o modelin günlük ücretsiz kotası dolduğu için canlı çağrılar 3.5'e geçti.
- Bir sağlayıcının anahtarı yalnızca o sağlayıcının uç noktasına gider.
- Hız için küçük/hızlı modeller tercih edilir
- Zincir: Avalanche Fuji testnet (chainId 43113), `viem`
- Yapılandırma: `dotenv`

### ATK'yı Windows'ta çağırma

Windows'ta `okx` bir `.cmd` kısayoludur. Güncel Node sürümleri `.cmd`
dosyalarını `shell: false` ile çalıştırmaz (EINVAL). Tercih edilen yol:
paketin JS giriş dosyasını bul (`npm root -g` altında `@okx_ai/okx-trade-cli`
paketinin `package.json` → `bin` alanı) ve `spawn(process.execPath, [giris.js, ...args])`
ile **shell olmadan** çağır. Bu işe yaramazsa `shell: true` kullanılabilir,
ama o durumda kural 4 daha da kritik olur. Tek bir `runOkx(args: string[])`
yardımcı fonksiyonu yaz, tüm çağrılar ondan geçsin.

## Akış

```
collector → stats (robust z) ── tetik? ──┬→ ATLAS ─┐
                                         └→ ARGUS ─┴→ seal commit → reveal → compare
                                                                               │
                                     report ← execute (ATK) ← risk ←──────────┘
```

1. **Veri toplama** (`src/data/`): 1 dakikalık mumlar + fiyat. Hacim
   **yalnızca kapanmış (`confirm == "1"`) 1m mumlardan** alınır. Ticker'daki
   hacim son 24 saatin kayan toplamıdır, kullanılmaz. Her kaydın benzersiz
   `record_id`'si var. Kayıtlar `recordings/*.jsonl`'a yazılır. `--replay <dosya>`
   kayıtlı veriyi aynı formatta oynatır. `--inject <senaryo>` replay'e yapay
   anomali ekler ve eklenen kayıtları `injected: true` olarak işaretler.
2. **İstatistik kontrolü** (`src/stats/`): LLM'siz. Kayan pencerede
   (varsayılan 60 mum) **robust z** = (x − medyan) / (1.4826 × MAD).
   Fiyat için getiri, hacim için log(hacim). MAD sıfırsa küçük bir epsilon
   kullan, bölme hatası verme.
3. **Tetik:** her mumda LLM çağrılmaz. Fiyat |robust z| ≥ 2 veya hacim
   robust z ≥ 3 olduğunda LLM turu başlar.
4. **ATLAS ve ARGUS** (`src/agents/`): aynı ham pencereyi (son 60 mum,
   `record_id`'leriyle) **paralel** ve birbirinden habersiz analiz eder.
   Hazır istatistik değerleri agent'lara verilmez; bağımsız kontrol olarak kalır.
5. **Mühür** (`src/chain/`): iki bulgunun hash'i commit edilir, iki commit de
   tamamlanınca reveal edilir.
6. **Karşılaştırma** (`src/compare.ts`): karar kuralları aşağıda.
7. **Risk motoru** (`src/risk.ts`): limitler, aksiyon tablosu, pozisyon boyutu.
8. **Aksiyon** (`src/execute.ts`): onaylanırsa demo hesapta emir (DRY_RUN'a uyar).
9. **Rapor** (`src/report/`): kanıtlar, uyum seviyesi, belirsizlikler,
   alınan/alınmayan aksiyon, etiketler (ENJEKTE / KAYITLI YANIT), Snowtrace linkleri.

## Bulgu şeması (ATLAS ve ARGUS aynı formatı döndürür)

LLM'den serbest metin değil, bu JSON istenir. Şemaya uymayan çıktı = belirsiz.

```json
{
  "agent": "ATLAS | ARGUS",
  "round_id": "string",
  "symbol": "BTC-USDT",
  "anomaly": true,
  "type": "price_drop | price_spike | volume_spike | none",
  "direction": "up | down | none",
  "severity": 0.0,
  "confidence": 0.0,
  "evidence": [{ "record_id": "string", "note": "string" }],
  "explanation": "string"
}
```

- `orderbook_imbalance` ilk sürümde yok: geçmiş emir defteri verisi olmadığı
  için ne değerlendirilebilir ne de replay edilebilir.
- `evidence` içindeki her `record_id` gerçek veride bulunmalı. Bulunmayan
  kanıta atıf yapan bulgu geçersizdir (halüsinasyon kontrolü, kodla yapılır).
- `confidence` LLM'in kendi beyanıdır, kalibre değildir. Raporda ve sunumda
  "uyum seviyesi" denir, asla "doğruluk olasılığı" denmez.

## Karar kuralları (`compare.ts`)

- **Örtüşme tanımı:** `anomaly`, `type` ve `direction` aynı.
- **İstatistik onayı:** fiyat |robust z| ≥ 3 **ve** hacim robust z ≥ 2
  (fiyat ve hacim birlikte tepki veriyor). Sadece hacim yüksekse bu
  `volume_spike`'tır ve tek başına aksiyon gerektirmez.
- Örtüşüyor:
  - **Yüksek:** örtüşme + iki güven ≥ 0.7 + istatistik onayı var
  - **Orta:** örtüşme var ama bu koşullardan biri eksik
- Ayrışıyor → **tek tur** uyuşmazlık turu:
  - ATLAS'a yalnızca hangi alanda ayrışıldığı söylenir (ör. "type farklı"),
    ARGUS'un gerekçesi gösterilmez (taklidi azaltmak için).
  - ATLAS fikrini **yalnızca daha önce kullanmadığı `record_id`'lerle yeni
    kanıt sunarsa** değiştirebilir. Yeni kanıt yoksa veya geçersizse sonuç
    **belirsiz**.
  - Tur sonunda örtüşme sağlansa bile uyum **en fazla "orta"**.
- Hâlâ ayrışıyor → **belirsiz**, aksiyon yok.

## Aksiyon tablosu ve risk motoru (`risk.ts`)

| Bulgu tipi | Uyum | Aksiyon |
|---|---|---|
| price_drop | yüksek | Demo hesaptaki varlığın limit dahilinde bir kısmını sat (azaltma) |
| price_drop | orta | Aynı, yarım boyutla |
| price_drop | belirsiz/düşük | Yok |
| price_spike | herhangi | Yalnızca uyarı |
| volume_spike | herhangi | Yalnızca uyarı |
| none | — | Yok |

Kurallar (tüm değerler `.env`/`config.ts`'ten okunur, kodda sabit yazılmaz):
- Toplam bütçe tavanı, işlem başı limit, günlük maksimum zarar
- Yalnızca izinli çiftler (varsayılan: BTC-USDT, ETH-USDT)
- Azaltma emri eldeki bakiyeyi aşamaz; bakiye önce okunur
- Zorunlu stop-loss kuralı yalnızca **yeni risk açan** emirlere uygulanır.
  Azaltma emri risk açmadığı için stop-loss gerektirmez. (İlk sürümde yeni
  risk açan emir yoktur.)
- Kill switch: `KILL_SWITCH=1` veya proje kökünde `KILL` dosyası varsa hiçbir emir gitmez
- Her karar (onay veya ret) gerekçesiyle loglanır

## Mühür (`src/chain/`)

- Ortak arayüz: `SealProvider { commit(rec): Promise<Receipt>; reveal(rec): Promise<Receipt> }`
  - `SelfTxSeal` (**birincil**): cüzdanın kendine 0 değerli tx'i, mühür `data` alanında
  - `LocalLogSeal` (yedek): aynı kayıt yerel dosyaya, zincire yazılmaz
  - `ContractSeal` (isteğe bağlı, zaman kalırsa)
- `hash = keccak256(canonicalJSON(bulgu) + salt)`, salt bulgu başına rastgele 32 bayt.
- Commit verisi: `agent`, `round_id`, `hash`. Reveal: bulgu + salt, hash
  yeniden hesaplanıp doğrulanır.
- İşlemler **sırayla** gönderilir (nonce çakışmasın).
- `AVAX_PRIVATE_KEY` yalnızca bu iş için açılmış, içinde testnet AVAX dışında
  hiçbir şey olmayan bir cüzdana ait.
- **Kanıtın sınırı (sunumda doğru söyle):** mühür, iki agent'ın da diğerinin
  cevabı açıklandıktan sonra fikrini değiştirmediğini kanıtlar. ARGUS'un
  ATLAS'ın çıktısını görmediği ise kod yapısıyla (ayrı çağrı, sadece ham veri)
  sağlanır, zincirle değil.

## Değerlendirme (`src/evaluate.ts`)

Asıl soru: "Uyum yüksek bulgular gerçekten daha isabetli mi?"
- Gerçek tarihsel 1m mumlardan **zaman kesitli** pencereler: agent'lar yalnızca
  pencere sonuna kadarki veriyi görür, sonrasını asla.
- Hem olay pencereleri (istatistik tetiği çalışanlar) hem rastgele sakin
  pencereler (yanlış alarm oranı için).
- Sonuç ölçütü: sonraki 15–60 dakikada gerçekleşen volatilite/fiyat değişimi,
  pencere öncesi taban çizgisine göre anlamlı biçimde arttı mı.
- Enjekte edilmiş veri değerlendirmeye **dahil edilmez**.
- Çıktı: uyum seviyesine göre isabet ve yanlış alarm tablosu, örneklem
  sayısıyla birlikte. Örneklem küçükse raporda açıkça yazılır.
- Hedef boyut: önce 20 pencere (10 olay + 10 sakin). Zaman kalırsa artır.

## Demo modları

- `--replay <dosya>`: kayıtlı piyasa verisi
- `--inject <senaryo>`: replay'e etiketli yapay anomali ekler
- `--record-agents`: agent yanıtlarını `recordings/agents/`'a kaydeder
- `--cached`: kayıtlı agent yanıtlarını oynatır, raporda "KAYITLI YANIT" etiketiyle
- `--resume` (evaluate): kayıtlı yanıt varsa kullanır, yoksa çağırıp kaydeder
- Zaman aşımları cömert: LLM çağrısı başına 45 sn, zincir işlemi başına 60 sn.
  Ekranda her aşamanın ilerlemesi loglanır.
- Gösterilecek üç senaryo, her biri tek komutla:
  1. price_drop, iki agent örtüşüyor → azaltma emri (veya DRY_RUN logu)
  2. Agent'lar ayrışıyor, uyuşmazlık turu sonrası belirsiz → işlem yapılmaz
  3. Kill switch açık → hiçbir şey olmaz
- Örnek: `npx tsx src/main.ts --replay recordings/X.jsonl --inject drop --cached`

## Klasör yapısı

```
src/
  config.ts
  okx.ts        runOkx yardımcı fonksiyonu
  data/         collector.ts, replay.ts, inject.ts
  stats/        robustZ.ts
  agents/       atlas.ts, argus.ts, schema.ts, cache.ts
  chain/        seal.ts (SealProvider + uygulamalar)
  compare.ts
  risk.ts
  execute.ts
  evaluate.ts
  report/
  main.ts       uçtan uca akış
recordings/     kayıtlı piyasa verisi ve agent yanıtları
```

## Ortam değişkenleri (`.env.example`'da tut)

```
DRY_RUN=1
ATLAS_PROVIDER=gemini
ARGUS_PROVIDER=groq
ATLAS_MODEL=
ARGUS_MODEL=
GEMINI_API_KEY=
GROQ_API_KEY=
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
LLM_TIMEOUT_MS=45000
AVAX_RPC_URL=https://api.avax-test.network/ext/bc/C/rpc
AVAX_PRIVATE_KEY=
SEAL_PROVIDER=selftx
CHAIN_TIMEOUT_MS=60000
TOTAL_BUDGET_USDT=1000
MAX_PER_TRADE_USDT=100
MAX_DAILY_LOSS_USDT=50
ALLOWED_PAIRS=BTC-USDT,ETH-USDT
KILL_SWITCH=0
```

## İlk doğrulamalar (kod yazmadan önce, sırayla)

1. `okx --help`, `okx spot --help`, `okx swap --help`: demo nasıl seçiliyor,
   hangi emir türleri var
2. Hesap bakiyesini oku: satılabilecek bir varlık var mı ✅ (17 Ekim, gerçek hesap)
3. Node'dan `runOkx(["market", ...])` ile bir piyasa çağrısı (Windows .cmd sorunu)
4. Onaysız emir gidebiliyor mu (önce çok küçük bir test) ✅ (ordId 4017908707754840064, 0.00001472 BTC)
5. İki LLM anahtarını tek satırlık istekle test et, model adlarını doldur
6. Fuji'de test cüzdanından kendine 0 değerli bir tx

## Çalışma şekli

- Her istekte tek modül yaz, başka dosyalara dokunma. İstenmedikçe refactor yapma.
- Her modül tek başına çalıştırılabilir olsun (kendi küçük demo girişi).
- Harici bir çağrı başarısız olursa çökme, logla ve "belirsiz" olarak devam et.
- Loglar okunaklı ve Türkçe olsun; jüri ekranda görecek.

## Öncelik (zaman yetmezse bu sırayla kesilir)

Çekirdek, asla kesilmez: veri → robust z → iki bağımsız analiz → karşılaştırma
→ risk motoru → emir (DRY_RUN dahil) → rapor, ve `--replay/--inject/--cached`.

Kesme sırası:
1. Süslü arayüz (terminal + basit HTML rapor yeter)
2. ContractSeal
3. `evaluate.ts`'in boyutu (20 pencerenin altına inme; inemiyorsan sunumda
   "değerlendirme planı" olarak anlat, sonuç uydurma)
4. Uyuşmazlık turu (yoksa ayrışma doğrudan belirsiz)
5. SelfTxSeal (yerine LocalLogSeal)
