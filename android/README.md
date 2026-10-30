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
- **`spoof`/`fragment` سطح بسته:** روی اندروید روت نمی‌خواهیم؛ فقط `record_fragment`
  و `tls: {fragment}` در جایی که DPI واقعاً SNI خام را می‌بیند فعال می‌شود.
