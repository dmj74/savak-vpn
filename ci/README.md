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

## سه کاری که workflow انجام می‌دهد

| job | چرا ارزش دارد |
|---|---|
| `engine` | ۷۸ تست + `check:generated` (اگر `LadderTable.kt` یا fixture هم‌ارزی کهنه باشد، build می‌ایستد) + یک `init`/`bundle` واقعی از CLI |
| `libbox` | ساخت AAR از **تگ pinned** `v1.14.4` با `gomobile` و ثبت sha256 — چون اعتبار configها مقابل schema همان نسخه سنجیده شده |
| `apk` | `assembleDebug` + `testDebugUnitTest` (پورت Kotlin در برابر اعداد موتور) و آپلود `savak-debug.apk` روی release |

بیلد امضاشدهٔ release عمداً opt-in است: تا وقتی repo variable‏ `HAVE_SIGNING_KEY=true` نشود،
آن step اجرا نمی‌شود — یک fork بدون keystore نباید فقط به‌خاطر آن قرمز شود، و مخزن عمومی
نباید هیچ کلید امضایی ببیند.
