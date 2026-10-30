# savak — کلاینت پروکسی هوشمند اندروید

موتور «نردبان پروتکل»: هر بار که مسیر عوض می‌شود، پروتکل هم عوض می‌شود — بر اساس
اندازه‌گیری، نه حدس.

**دانلود مستقیم اپ (همان لینک قبلی):** 👇👇👇
https://doo.st/1406

---

## نسخهٔ `0.2.0-engine` — چه چیزی قابل دانلود است

| چیز | لینک | وضعیت |
|---|---|---|
| سورس کامل (موتور + اپ + گره + مستند) | https://github.com/dmj74/savak-vpn/archive/refs/tags/v0.2.0-engine.tar.gz | ✅ آماده |
| Release صفحهٔ گیت‌هاب (دارای APK) | https://github.com/dmj74/savak-vpn/releases/tag/v0.2.0-engine | ✅ ساخته شد — APK به آن می‌چسبد |
| **APK دیباگ** | همان صفحهٔ release، بعد از اولین اجرای موفق Actions | ⚙️ `[Actions → build → apk]` |
| `bundle.json` گوشی | روی **گره خودتان**: `node src/cli.js bundle …` | ✅ عمداً آپلود نمی‌شود (کلیدهای شما داخلش است) |

چرا APK را همین‌جا نساختیم: بیلد اندروید به Android SDK + JDK 17 + Go (برای AARِ `libbox`)
نیاز دارد و در محیط توسعه‌ای که این کد در آن نوشته شد هیچ‌کدام نبود — `dl.google.com` و
Maven Central هم از آن شبکه قابل دسترس نبودند (چک شد: هر دو `000`). برای همین
`.github/workflows/android-apk.yml` اضافه شده: همان سه ابزار را روی Runner نصب می‌کند،
AAR را از تگِ pinned شدهٔ `v1.14.4` می‌سازد، تست‌های هم‌ارزی Kotlin را اجرا می‌کند و APK را
به release می‌چسباند. تا آن Workflow سبز شود، «دانلود اپ» یعنی بیلد محلی:

```bash
bash android/tools/build-libbox.sh        # AAR از سورس sing-box (Go + NDK لازم است)
cd android && gradle :app:assembleDebug   # یا همان پروژه را در Android Studio باز کنید
```

لینک `doo.st/1406` همان بیلد قدیمی را نشان می‌دهد. آپلود نسخهٔ جدید روی آن کانال،
کاری است که فقط خودتان می‌توانید بکنید: لینک کوتاه متعلق به حساب شماست و من نه آن
حساب را دارم و نه می‌سازم.

---

## چرا «نردبان» و نه «یک پروتکل قوی»؟

چون پروتکلِ قوی وجود خارجی ندارد؛ **مسیر** قوی یا بی‌رحم است. Hysteria2 روی یک مودم
خانگی عالی است و روی همان خط در ساعت ۲۱ یعنی افت ۱۲٪. VLESS+Reality روی DPIِ فعال‌محور
ناپیدا است و روی لینک تمیز، مالیات crypto بی‌مورد دارد. پس:

```
۱۱ پروتکل known ──▶ دروازهٔ سخت (چه چیزی روی این مسیر کار می‌کند؟)
                  ──▶ امتیاز وزنی (سرعت / تأخیر / پایداری / ستیزگی / هزینه)
                  ──▶ انتخاب با هیسترزیس (dwell + حداقل سود + cooldown)
                  ──▶ یک config آماده و اعتبارسنجی‌شدهٔ sing-box 1.14.4
```

هر پله idea برتر یک ابزار معروف را می‌آورد (Hysteria2، TUIC، Xray Reality، NaïveProxy،
AnyTLS، Shadowsocks-2022، WireGuard، CDN-fronted VLESS، Tor) و همه در یک `selector`
رقابت می‌کنند. جزئیات: [docs/smart-evasion.md](docs/smart-evasion.md) ·
عدد و سرعت: [docs/speed.md](docs/speed.md)

> «ترکیب فیلترشکن‌های معروف» = استفاده از بهترین ایدهٔ هر stack متن‌باز، نه wrap کردن
> سرویس‌های تجاری. بستن Nord/Express/… از نظر ToS ممکن نیست و عملاً ترافیک شما را به یک
> شخص ثالث سوم می‌دهد.

## مخزن چه دارد

| مسیر | چیست |
|---|---|
| `engine/` | موتور Node (بدون وابستگی جز `ajv`): مدل پروتکل، tuning، امتیازدهی، تولید config، پروب‌های واقعی، CLI، داشبورد |
| `engine/test/` | ۷۸ تست: اعتبارسنجی config مقابل **schema رسمی sing-box 1.14.4**، رتبه‌بندی، tuning، پروب‌ها با سوکت واقعی، امضای پروفایل، پیوندهای اشتراک، CLI، داشبورد |
| `server/` | `bootstrap.sh` (نصب گره + sysctl + systemd)، `sysctl-savak.conf`، پاسخ‌دهندهٔ اندازه‌گیری |
| `android/` | منبع Kotlin/Compose کلاینت (منطق انتخاب + امنیت پروفایل + TUN)، با جدول پله‌ای که **از موتور تولید می‌شود** |
| `docs/` | توضیح دو بخش اصلی: ستیزگی با فیلترینگ، و واقعیتِ سرعت |

## شروع سریع

```bash
cd engine && npm ci

# ببیند موتور برای مسیر شما چه انتخاب می‌کند و چرا
node src/cli.js plan --mode auto --access cellular --censor sni-only --pretty

# یک گرهٔ کامل: کلیدها + پروفایل امضاشده + server.json اعتبارسنجی‌شده
node src/cli.js init --hostname fra1.example.com --node fra-1 --outDir ./out

# باندل گوشی: یک config آماده برای هر پلهٔ قابل‌استفاده
node src/cli.js bundle --profile ./out/profile.json --node fra-1 --out ./out/bundle.json

# داشبورد (فارسی، RTL) — هر اسلایدر کل موتور را دوباره اجرا می‌کند
node src/cli.js serve --port 8080
```

روی گره:

```bash
sudo bash server/bootstrap.sh --hostname fra1.example.com --node fra-1 --apply
```

## چیزهایی که عمداً این‌طور ساخته شده‌اند

- **اعتبارسنجی با schema رسمی، نه «به‌نظر ما»:** هر config تولیدشده مقابل
  `schema/sing-box-1.14.4.schema.json` (از خود پروژهٔ sing-box) چک می‌شود؛ `additionalProperties: false`
  در همه‌جاست، پس یک کلید غلط real یعنی تست شکسته، نه config خاموش.
- **پروب واقعی، نه خودتأییدی:** `probes.js` با سوکت UDP/TCP باز می‌کند، بسته‌ها را با
  sequence تطبیق می‌دهد و می‌گوید UDP زنده است، افت چند است، و throttle پروتکل‌محور است یا
  پورت‌محور. `link.source` در هر نتیجه نوشته می‌شود: `measured` یا `synthesized`.
- **امضای Ed25519 روی پروفایل گره‌ها:** سندی که تعیین می‌کند بسته‌های شما کجا بروند، بدون
  امضای معتبر از کلیدِ compiled-in در APK، رد می‌شود. (`docs` + `ProfileVerifier.kt`)
- **بدون `insecure: true`:** برای self-signed، SPKI pinning.
- **روند روی گوشی = یک API call:** همهٔ پله‌های قابل‌استفاده داخل همان config هستن، پس
  تعویض پروتکل یعنی `PUT /proxies/savak-ladder` — نه قطع و وصل شدن تونل.
- **بدون تولید bandwidth:** tuning سقف‌های خودزنی (پنجرهٔ کوچک، PMTUD، مالیات TLS بی‌مورد)
  را برمی‌دارد و پروتکلی را انتخاب می‌کند که سانسورگر نمی‌تواند ارزان بکُشد. عدد را خودتان
  با `savak race` بگیرید.

## مستند نیست، واقعی است: محدودیت‌ها

- موتور config می‌سازد و انتخاب می‌کند؛ **data plane خودِ sing-box است**. پس نسخهٔ sing-box
  باید 1.14.x باشد (1.11+ برای `endpoints`، 1.12+ برای حذف GeoIP، 1.13+ برای `sniff` به‌عنوان
  rule action، 1.14.4 برای Chrome parrot/gecko).
- `android/` **منبع است، APK نه**: در این محیط Android SDK و toolchain گو در دسترس نبود.
  بیلد و رفتار روی دستگاه را خودتان بسنجید (`android/README.md`).
- ECH و `spoof` (نیازمند روت) عمداً پیاده نشده‌اند؛ `docs/smart-evasion.md` توضیح می‌دهد چرا.
- Tor فقط به‌عنوان طبقهٔ آخر در جدول است؛ config آن نیاز به bridge زنده دارد که این موتور
  برای شما نمی‌سازد.

---

### English summary

A measurement-driven **protocol ladder** for [sing-box 1.14.4](https://github.com/SagerNet/sing-box):
11 transports (Hysteria2, TUIC v5, VLESS+Reality, WireGuard, AnyTLS, Shadowsocks-2022,
NaïveProxy H3, CDN-fronted VLESS, legacy VMess, Tor-last), each emitted as a complete
validated config, ranked by hard feasibility gates plus weighted scoring
(throughput · latency · stability · evasion · cost), with hysteresis so the tunnel does not
re-handshake on noise. Configs are validated against sing-box's own JSON schema; profiles are
Ed25519-signed; links are measured with real sockets, not assumed. The Android client ships
only the selector and the trust logic — no config grammar on the device.

Speed claims are deliberately narrow: this removes self-inflicted ceilings (window sizing,
PMTUD, needless TLS/pacing taxes) and picks the transport the censor cannot cheaply kill.
`node src/cli.js race` is how you verify it on your own link.
