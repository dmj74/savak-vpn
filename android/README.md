# savak engine — کلاینت اندروید

این پوشه کد منبع اپلیکیشن اندروید است: یک پوستهٔ Kotlin/Compose که **تصمیم می‌گیرد** و
data plane را به `sing-box` می‌سپارد. چیزی که اینجا نمی‌بینید — و عمداً هم نیست — تولید
پیکربندی پروتکل است.

## معماری در یک پاراگراف

موتور (`../engine`) برای هر «پله»ٔ قابل‌استفاده یک پیکربندی کامل و اعتبارسنجی‌شدهٔ sing-box
تولید و امضا می‌کند (`savak bundle`). گوشی فقط سه کار می‌کند: مسیر را اندازه می‌گیرد،
بین پیکربندی‌های آماده انتخاب می‌کند، و انتخاب را به sing-box تحویل می‌دهد. هیچ گرامر
پیکربندی روی دستگاه نیست؛ پس یک آپدیت اپلیکیشن نمی‌تواند کلیدی را نصفه‌نیمه بسازد.

```
engine (Node)                       android (Kotlin)
  ladder.js  tune.js  score.js  ──▶  LadderTable.kt      (تولیدشده، دستی ویرایش نشود)
  bundle.js  profile.js        ──▶  bundle.json         (پیکربندی نهایی هر پله)
  keys.js                          ProfileVerifier.kt    (Ed25519، کلیدها در APK)
                                   LadderScore.kt        (هم‌ارز score.js)
                                   Selector.kt           (همان هیسترزیس)
                                   SavakVpnService.kt    (TUN + lifecycle)
                                   TunnelBackend.kt      ──▶ sing-box (libbox یا subprocess)
```

## ساختن

```bash
cd android
gradle :app:assembleDebug          # یا فقط پروژه را در Android Studio باز کنید
```

مخزن `gradle wrapper` ندارد (خود wrapper هم یک باینری است)؛ Android Studio هنگام import
آن را اضافه می‌کند و `gradle/wrapper/…` را برای شما می‌سازد. پیش‌نیازها: Android Studio
Ladybug یا جدیدتر، JDK 17، Android SDK 35.

### ۱. باندل پیکربندی

```bash
cd ../engine
npm ci
node src/cli.js bundle --profile /etc/savak/profile.json --node fra-1 \
     --mode auto --access cellular --out ../android/app/src/main/assets/bundle.json
cp /etc/savak/profile.json ../android/app/src/main/assets/profile.json
```

`bundle.json` و `profile.json` تولیدشده‌اند و در gitignore هستند. اگر نبودند، اپ با
پیام «باندل موجود نیست» بالا می‌آید — این رفتار درست است، نه crash.

### ۲. کتابخانهٔ libbox (AAR)

sing-box کتابخانهٔ Go است؛ برای اجرای درون‌فرآیندی باید با `gomobile` به AAR تبدیلش کنید:

```bash
git clone --depth 1 --branch v1.14.4 https://github.com/SagerNet/sing-box
cd sing-box && go install golang.org/x/mobile/cmd/gomobile@latest && gomobile init
gomobile bind -target=android -androidapi 26 -javapkg org.savak.core \
    -o ../android/third_party/maven/org/savak/core/libbox/1.14.4/libbox-1.14.4.aar \
    github.com/sagernet/sing-box/experimental/libbox
```

اگر AAR را نمی‌سازید، همان باینری `sing-box` را در `USE_SUBPROCESS_BACKEND = true`
با یک پروسهٔ فرزند اجرا کنید (`SubprocessBackend`) — این مسیر روی روت/rootless‌لینوکس
قابل تست است و دقیقاً همان فایل پیکربندی را مصرف می‌کند.

### ۳. کلیدهای مورد اعتماد برای امضای پروفایل

خروجی `node src/cli.js init` یک `keys.json` می‌دهد که دو شکل از یک کلید دارد:
`publicKey` (PEM، برای خودِ نود) و `publicKeyB64` (DER فشرده، برای اپ). `keyId` و
`publicKeyB64` را در `TrustedKeys.map` (پایین `MainActivity.kt`) بگذارید. اگر از روی اشتباه
PEM را بچسبانید، `ProfileVerifier` خودش armor را برمی‌دارد — چون «کلید نامشروع» بودنِ یک
کپی‌پیست بد، خطای بسیار گیج‌کننده‌ای است. فهرست خالی یعنی «همه رد شود» — این پیش‌فرض امن
است، نه باگ.

## ساخت APK روی دستگاه خودتان (اسکریپتش هست)

اگر شبکه‌تان به `services.gradle.org`، `dl.google.com`، `maven.google.com`، Central و `go.dev`
می‌رسد، یک اسکریپت همهٔ لازم را می‌گیرد و می‌سازد — و هر دانلود را **قبل از باز کردن** با
checksum خودِ منبع می‌سنجد (Gradle از `…bin.zip.sha256`، Go از `go.dev/dl/?mode=json`،
cmdline-tools از `repository2-3.xml`)؛ اگر checksum به دست نیاید، نصب نمی‌کند:

```bash
bash android/tools/install-toolchain.sh --check   # چه هست / چه نیست / شبکه باز است یا نه
bash android/tools/install-toolchain.sh           # نصب Gradle 8.10 + SDK 35 + NDK 27 + Go، بعد بیلد
```

نصب‌ها همگی از آدرس pinned و با بررسی sha256 انجام می‌شود و خروجی‌اش `savak-debug.apk` به‌همراه
sha256 است. اگر شبکه بسته باشد، اسکریپت **چیزی نصب نمی‌کند و چیزی را «ساخته شد» اعلام
نمی‌کند** — دقیقاً همان کاری که در یک sandbox بسته باید بکنید. مسیر کانتینر هم هست:
`bash android/tools/install-toolchain.sh docker`.

## فایل APK: چه چیزی تأیید می‌شود، و چه چیزی رد

`install-toolchain.sh` بعد از بیلد فایل را با `verify_apk` می‌سنجد؛ اگر رد شود
`savak-debug.apk` **پاک** می‌شود (exit 3) — نه با هشدار تحویل داده می‌شود. معیارش ساختاری است:
`classes*.dex`، `AndroidManifest.xml`/`resources.arsc`، `lib/<abi>/*.so` **برای هر سه** `abiFilters`
(یعنی libbox — همان تانل) و `assets/bundle.json`. `aapt2 dump badging` و `apksigner verify` اگر
حاضر باشند سنجیده می‌شوند و اگر نباشند پیام صریح «بررسی نشد» می‌دهند، نه ادعای مثبت.
روی هر فایل موجود: `bash android/tools/install-toolchain.sh --verify-apk <file.apk>`.
هر سه حالت در `--self-test` assert می‌شود (بی‌libbox → رد · تک‌ABI → رد · سه‌ABI → قبول) و با
mutation آزمایش شد که خودآزمون واقعاً قرمز می‌شود. شاخه‌های badging/apksigner روی APK واقعیِ
امضاشده هنوز اجرا نشده‌اند — از این محیط هیچ APK واقعی ساخته نمی‌شود (maven.google.com و
go.dev و dl.google.com در handshakeٔ TLS بسته‌اند)؛ این تنها بخشِ نسنجیدهٔ همین تابع است.

## آنچه تست‌شده و آنچه نشده

| | وضعیت |
|---|---|
| کامپایل شدن کد ماژول (۹ فایل: `engine/` `security/` `service/` `BootReceiver`) | ✅ اجرا شده با `kotlinc` روی JVM، بدون Android SDK |
| امتیازدهی و رتبه‌بندی پله‌ها روی ۱۰ سناریوی مسیر (۸۰ ردیف) | ✅ `LadderParityCheck` روی fixture تولیدشده از موتور، **اجرا شده** |
| اینکه خودِ چک «می‌تواند fail شود» | ✅ `checkDetectsMutation` — یک عددِ عوض‌شده باید گزارش شود |
| canonical JSON + Ed25519 روی پروفایل امضاشدهٔ `savak init` | ✅ تأیید شد؛ دست‌کاری آدرس، کلید ناشناخته و فهرست خالی → رد |
| هیسترزیس تعویض (dwell، حداقل سود، cooldown) | ✅ همان fixture، به‌علاوه `test/selector.test.js` در موتور |
| اعتبارسنجی پیکربندی‌ها مقابل schema رسمی sing-box 1.14.4 | ✅ در موتور، هنگام build باندل |
| `MainActivity.kt` (Compose) و مرز `libbox` (AAR) | ❌ عمداً stub نشد؛ اولین کامپایل واقعی‌شان در CI/Gradle است |
| رفتار روی دستگاه واقعی: TUN، DoH، battery optimization، rebind | ❌ هیچ‌وقت روی گوشی اجرا نشده — باید بسنجید |

### اجرای همین چک بدون Gradle

```bash
JAVA_HOME=/path/to/jdk-17 bash android/tools/typecheck.sh
```

چهار پایه است: (۱) `tools/res-check.py` — گراف ارجاع‌ها بین `R.*`، `res/`، `AndroidManifest.xml`
و `build.gradle.kts`؛ (۲) `aapt2 compile` روی همهٔ `res/` — با **خودِ ابزار واقعی اندروید**،
نسخهٔ `2.19-7832930`، که از PyPI می‌آید (`pip install aapt2`؛ فقط `chmod +x` لازم دارد)؛
(۳) هم‌ارزی امتیازدهی با fixture تولیدشده از موتور؛ (۴) تأیید امضای پروفایلی که خودِ
`savak init` امضا کرده.

`aapt2 link` عمداً انجام نمی‌شود: به `android.jar` فریمورک نیاز دارد و برداشتن یکی از مخزن
یک نفر ناشناس، به‌عنوان ورودیِ بیلد یک VPN، همان چیزی است که کل این مخزن بر ضدش نوشته شده
— همان‌طور که `libbox` به یک تگ pinned و sha256 قفل شده. هر چکی که اینجا سبز می‌شود، با
ابزاری است که منبعش مشخص است.

پایهٔ ۱ سه چیز را گرفت: دو وابستگی که هیچ source‌ای import‌شان نمی‌کرد
(`androidx.security:security-crypto` و `lifecycle-runtime-compose` — حجم APK + سطح CVE، پس
حذف شدند)، و یک کلاس که manifest اعلام می‌کرد و وجود نداشت (این‌جا نداشت، ولی چک می‌کند).

اگر `kotlinc` روی PATH نباشد، اسکریپت `KOTLIN_COMPILER_JAR` را می‌پذیرد
(`npm i -g kotlin-compiler` همین jar را می‌دهد). استاب‌های `tools/kotlinc-stubs/` فقط
داربست‌اند: Gradle آن‌ها را نمی‌بیند، پس هیچ‌وقت نمی‌توانند «سبز شدن» را به جای کد واقعی
ثابت کنند.

این حلقه چهار باگ واقعی را گرفت (نه یک‌بار که کد «تمیز به‌نظر می‌رسید»): `joinToString` در
Kotlin با جداساز `", "` canonical JSON را خراب می‌کرد — یعنی **هر** پروفایل امضاشده رد می‌شد؛
stub بیس۶۴ URL-safe بود؛ `toString` استابِ `JSONObject` به‌جای JSON خروجی map می‌داد؛ و
`verify` روی زیرمجموعهٔ `signedFields` امضا می‌کرد در حالی‌که موتور کل سند را امضا می‌کند.
هر چهارم فقط با اجرا دیده شدند.

یعنی: منطق و اعداد قابل اتکا هستند؛ یکپارچگی بیلد و رفتار روی گوشی را باید روی
دستگاه خودتان بسنجید. اولین چیزی که بعد از بیلد باید چک کنید:
`adb logcat | grep -i savak` و سپس اینکه `sing-box check` روی همان `bundle.json`
در گوشی سالم باشد.

## نکات رفتاری که عمدی هستند

- **تعویض بدون قطع اتصال:** همهٔ پله‌های قابل‌استفاده داخل یک `selector` به نام
  `savak-ladder` هستند، پس عوض‌کردن پروتکل یک فراخوانی API است و نه reconnect.
- **پیکربندی WireGuard جداست:** `wg_uot` یک `endpoint` است نه outbound، بنابراین
  برای آن پله یک config کامل عوض می‌شود (با `StartOrReloadService`).
- **بدون `insecure: true`:** روی گواهی self-signed از SPKI pinning استفاده می‌شود.
- **شروع روی بوت با `startForegroundService`:** `startService()` از `BootReceiver` روی
  Android ۸+ استثنا می‌دهد (اپ پس‌زمینه است)؛ تانل باید فوراً foreground شود. درِ اصلی همان
  «VPN همیشه‌روشن» سیستم است، نه این receiver.
- **`spoof`/`fragment` سطح بسته:** روی اندروید روت نمی‌خواهیم؛ فقط `record_fragment`
  و `tls: {fragment}` در جایی که DPI واقعاً SNI خام را می‌بیند فعال می‌شود.
