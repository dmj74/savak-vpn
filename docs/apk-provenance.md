# منشأ فایل APK — آنچه توزیع می‌کنید با آنچه توزیع *می‌شمارید*

این سند یک ادعا نیست؛ خروجی چهار دستور اجراشده روی **همان فایلی است که همین مخزن توزیع
می‌کند**. دلیل نوشتنش: «APK بساز» پنج دور تکرار شد و پاسخ فنی یکی بود، اما یک سؤال باز ماند —
*آخرین APKی که الان پخش می‌شود چیست؟* وقتی فایل را از همان جایی که لینک شده بیرون کشیدم، جواب
تغییر کرد: آن فایل VPN نیست.

## ۱) فایلی که README/سایت به‌عنوان «دانلود مستقیم» می‌دهد

مخزن `dmj74/dmj74.github.io` (Pages، همان‌که `doo.st/1406` به آن می‌رسد) یک APK در `media/` دارد:

```
$ gh api "repos/dmj74/dmj74.github.io/contents/media/mvlwr3bq6hef.apk?ref=main" \
    --jq '.content' | base64 -d > site-latest.apk
$ sha256sum site-latest.apk ; stat -c %s site-latest.apk
8966666fb7c1245bf825b01f4efd5d87dc0228f5c33a4d2af644506079d1bc01
1160148                                  ← ۱٫۱ مگابایت
```

و این همان چیزی است که `verify_apk` این مخزن رد می‌کند (exit 3):

```
✓ AndroidManifest.xml   ✓ resources.arsc   ✓ dex: 1 فایل
✗ هیچ lib/<abi>/*.so نیست — این APK هستهٔ تانل (libbox) را ندارد
⚠ assets/bundle.json نیست
```

## ۲) آن فایل دقیقاً چیست

```
$ aapt2 dump badging site-latest.apk
package: name='ir.titanali.app' versionCode='10019' versionName='1.0.19'
sdkVersion:'23'   targetSdkVersion:'36'
uses-permission: name='android.permission.INTERNET'
application-label:'تیتانلی'
launchable-activity: name='ir.titanali.app.MainActivity'
```

- پکیج `ir.titanali.app` است، **نه** `ir.savak.client` — خروجیِ یک «سایت‌را-APK-کن» عمومی
  (Titanali) است؛ `assets/downloads.js` همان کاربرد را تأیید می‌کند: `window.TitanaliAndroid
  .beginDownload/appendDownload/completeDownload` — یک helper برای دانلود فایل داخل WebView.
- مجوزهای manifest فقط `INTERNET`. هیچ `<service>` اعلام‌نشده و
  `android.permission.BIND_VPN_SERVICE` نیست — یعنی حتی *اگر* کد بخواهد، سیستم‌عامل
  `VpnService` را به آن نمی‌سپارد.
- `classes.dex` کل ۱۷٫۲ کیلوبایت است. جست‌وجوی رشته‌ها در dex و هر سه asset:
  `vpn|tun|sing-box|proxy|vless` → **صفر تطابق**.
- امضا: `META-INF/DMJ74.RSA`، گواهی `subject=CN=dmj74 · issuer=CN=dmj74` — خودامضا، و
  فقط JAR v1 (`APK Signature Scheme v2/v3` در ساختار فایل نشانه‌ای ندارد).

جمع‌بندی: این فایل ترافیک را از هیچ تونلی رد نمی‌کند. «VPN نبودن» این فایل یک نظر نیست — تعداد
کتابخانه‌های native و مجوزهای اعلام‌شده در manifest صفر است. پس چیزی که خطرناک است نه
بی‌فایده‌بودنش: کاربر چیزی که لینک شده را «کلاینت پروکسی» می‌پندارد و فایل یک پوستۀ وب‌سایت است —
هیچ تونلی در آن نیست. دقیقاً همان حالتی که `build()` را مجبور کردیم فایلِ بی‌libbox را *پاک* کند.

## ۳) فایل‌های واقعی‌تر کجايند

- Release `Vpn` (پیش‌انتشار، ۲۰۲۶‑۰۹‑۲۰) فقط یک لینک MediaFire است:
  `SAVAK-1.10.1.apk` — صفحه‌اش می‌گوید «uploaded from Sweden on September 20, 2026 at 5:24 PM»
  و **هیچ checksum منتشرشده‌ای ندارد**. لینک کوتاه + میزبان خارجی + بدون هشدار = نه
  یکپارچگی، نه تداوم: هرکس آن URL را جابه‌جا کند، APK را جابه‌جا می‌کند.
- در Google Drive مجموعه‌ای منظم از بیلدها هست (نام/اندازه/تاریخ خوانده شد، محتوایتان نه):
  `AZADAN-v1.14.0-vc21-{arm64-v8a,armeabi-v7a,x86_64}-release.apk`
  ≈ ۵۶٫۷ / ۵۴٫۲ / ۶۰٫۲ مگابایت، versionCode در نام (`vc21`)، و نسخه‌های sing-box ۱٫۱۴.x —
  یعنی همین‌ها بیلدهای واقعی با native هستند. برای همین است که اندازۀ ۱٫۱ مگابایتِ فایل
  سایت در برابر ۵۶ مگابایتِ آن‌ها تفاوت را نشان می‌دهد.
- `actions/artifacts` و `releases` همین مخزن: `total_count: 0` — هیچ APKی به GitHub ضمیمه نشده.

## ۴) کاری که باید کرد (و این مخزن آماده‌اش است)

1. **فایل را از میزبان شخص ثالث بیرون بیاورید**: `ci/apk-only.yml` را فعال کنید؛ APK به‌عنوان
   release asset روی همین repo می‌نشیند (نه MediaFire، نه Drive، نه لینک کوتاه).
2. **چک‌سامه را چاپ کنید**: workflow `sha256sum` را کنار فایل می‌گذارد. روی هر فایلی که الان
   توزیع می‌کنید بزنید:
   `bash android/tools/install-toolchain.sh --verify-apk <file.apk>` — و منتظر `exit=0` باشید.
3. **هویت بیلد را قفل کنید**: `applicationId` باید `ir.savak.client` باشد، `lib/<abi>/` باید
   libbox را داشته باشد، و مجوز `BIND_VPN_SERVICE` باید در manifest باشد. سه مورد بالا هرکدام
   با یک `aapt2 dump badging` قابل سنجش است — قبل از این‌که کسی نصب کند.
4. **v2/v3 را روشن نگه دارید** (AGP به‌صورت پیش‌فرض v2 را می‌زند؛ برای `targetSdk 36` روی
   Android ۱۴+، v1 تنها کافی نیست) و کلید امضا را در `server/release-signing.properties` بگذارید.

> چیزی که این سند *ادعا نمی‌کند*: این‌که فایل‌های Drive بدافزارند، یا این‌کهTitanali نشتی داده
> است. فقط این‌که فایل ۱٫۱ مگابایتی که لینک «دانلود مستقیمِ کلاینت» به آن می‌رسد `doo.st/1406` هیچ مؤلفهٔ VPNی ندارد — که با
> `aapt2` و `unzip` در سی ثانیه اندازه گرفته می‌شود.
