# CI — فایل workflow این پوشه است، نه `.github/workflows/`

GitHub اجرای workflow را فقط از `.github/workflows/` می‌پذیرد، پس این فایل را یک‌بار منتقل کنید:

```bash
mkdir -p .github/workflows
cp ci/android-apk.yml .github/workflows/android-apk.yml
git add .github/workflows/android-apk.yml && git commit -m "ci: enable the build workflow" && git push
```

یا در همان مخزن، از وب: **Add file → Commit file** با مسیر `.github/workflows/android-apk.yml`
و محتوای همین فایل. یک‌بار که رفت، هر پوش به `main` و هر تگ `v*` بیلد را اجرا می‌کند.

## چرا این‌جا است

توکنی که این نشست با آن به GitHub وصل است permission `workflows` را ندارد و GitHub هر
pushی که فایل workflow را بسازد یا عوض کند را بدون آن permission رد می‌کند
(`refusing to allow a GitHub App to create or update workflow … without workflows permission`).
گذاشتن فایل در `ci/` یعنی: کل محتوای pipeline در مخزن است و review می‌شود، و فعال‌سازی‌اش
یک تصمیم صریح شماست — نه چیزی که یک agent پنهانی روشن کند.

اگر می‌خواهید من خودم منتقلش کنم: به GitHub App مربوط به این نشست **Workflows: Read & write**
بدهید (Settings → Third-party Access / GitHub Apps → Arena → Repository permissions) و بگویید؛
یک push بیشتر نیست.

## فقط باینری می‌خواهید: `ci/apk-only.yml`

`apk-only.yml` حداقلِ همان کار است (libbox از تگ pinned → `assembleDebug` → sha256 → artifact و
ضمیمه به release) و برای «فقط فایل APK را بده» ساخته شده؛ `android-apk.yml` همان به‌علاوهٔ تست
موتور، چک kotlinc/parity و بیلد امضاشدهٔ release است. فعال‌سازی هر دو یکی است:

```bash
# با gh، یک دستور — توجه: این با توکن *شما* کار می‌کند؛ با اپ Arena رد می‌شود (403 workflows)
gh api -X PUT repos/dmj74/savak-vpn/contents/.github/workflows/apk-only.yml \
  -f message="ci: enable the debug-APK build" -f branch=main \
  -f content="$(base64 -w0 ci/apk-only.yml)"
```

## چهار کاری که workflow انجام می‌دهد

| job | چرا ارزش دارد |
|---|---|
| `engine` | ۷۹ تست + `check:generated` (اگر `LadderTable.kt` یا fixture هم‌ارزی کهنه باشد، build می‌ایستد) + یک `init`/`bundle` واقعی از CLI |
| `kotlin-port` | کامپایل منطق اپ با `kotlinc` و اجرای چک هم‌ارزی (۸۰ ردیف) + تأیید امضای پروفایل — **بدون Android SDK**، پس اگر مدل امتیازدهی از موتور جدا شود، اینجا در چند ثانیه قرمز می‌شود، نه بعد از ۴۵ دقیقه بیلد AAR |
| `libbox` | ساخت AAR از **تگ pinned** `v1.14.4` با `gomobile` و ثبت sha256 — چون اعتبار configها مقابل schema همان نسخه سنجیده شده |
| `apk` | `assembleDebug` + `testDebugUnitTest` (پورت Kotlin در برابر اعداد موتور) و آپلود `savak-debug.apk` روی release |

هیچ‌کدام از این‌ها راز نیست: همان دو چک بدون CI هم روی لپ‌تاپ اجرا می‌شوند —
`cd engine && npm test` و `bash android/tools/typecheck.sh` (با `JAVA_HOME` و
`KOTLIN_COMPILER_JAR`). چیزی که CI اضافه می‌کند Android SDK، Go و بیلد APK است.

بیلد امضاشدهٔ release عمداً opt-in است: تا وقتی repo variable‏ `HAVE_SIGNING_KEY=true` نشود،
آن step اجرا نمی‌شود — یک fork بدون keystore نباید فقط به‌خاطر آن قرمز شود، و مخزن عمومی
نباید هیچ کلید امضایی ببیند.

## پیش‌پیمایشِ خودِ workflow (امشب، بدون Runner)

هر چهار job روی فایل‌های واقعی همین مخزن اجرا شد و این‌ها گرفته شد — همه‌شان نوعِ خطایی است
که «اولین اجرای CI» را قرمز می‌کند و به‌راحتی از دید در می‌رود:

- یک `env:` تکراری در step بیلد امضاشده — کلید دوبل در یک mapping یعنی **کل فایل workflow
  پارس نمی‌شود** و حتی `apk` هم اجرا نمی‌شد. ادغام شد.
- `android-actions/setup-android` در job `apk` بدون `packages:` — AGP پلتفرم را خودش دانلود
  نمی‌کند، فقط `Failed to find target with hash string` می‌دهد. `platforms;android-35` و
  `build-tools;35.0.0` اضافه شد.
- `gradle` روی PATH تصویر Runner با نسخه‌ای است که تصویر دوست داشته؛ AGP 8.5.2 به Gradle ≥ 8.7
  نیاز دارد، پس `gradle-version: '8.10'` صریح شد.
- `upload-artifact` با `path` مطلق بیرون از workspace: شکل درخت artifact تعیین‌نداشته‌شدنی
  می‌داد (محل AAR یک دایرکتوری عمیق‌تر می‌شد). `root:` صریح اضافه شد تا `settings.gradle.kts`
  همان‌جا را ببیند که انتظار دارد.
- `python3 android/tools/res-check.py` (منطق اندروید، leg ۱ِ `typecheck.sh`) قبل از هر بیلدی
  گراف `R.*` ↔ `res/` ↔ manifest ↔ وابستگی‌ها را چک می‌کند.

 YAML با یک پارسر «کلید تکراری ممنوع» بررسی شد؛ اما هنوز **هیچ Runner آن را اجرا نکرده** —
اولین اجرا ممکن است چیزی نشان دهد که اینجا دیده نمی‌شود (Compose، دانلود Maven).
