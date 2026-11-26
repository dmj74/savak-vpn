# کنترل‌های تونل: کلید قطع، تونل شکافته، حالت روزمره، و فید سرور

این سند چهار چیزی را که درخواست شد توضیح می‌دهد — با مرز دقیق بین «کد نوشته و سنجیده شده»
و «روی دستگاه اجرا نشده». مرز را نوشتن همین است، نه فروختن اطمینان.

---

## ۱) Kill Switch — «جلوی قطع ناگهانی» یعنی چه، دقیقاً

معنای درستش «قطع نشدن اتصال» نیست؛ هیچ کلاینتی نمی‌تواند مسیر از دست‌رفته را زنده نگه دارد.
معنایش این است: **در مدت قطع، ترافیک به شبکهٔ اپراتور برگردد** — این اتفاقی است که باید
جلوگیری شود. پس رفتار انتخاب‌شده «خاموش کردن VPN» نیست، بلکه **قفل کردن روی همان اینترفیس** است:

```
تانل می‌میرد  →  SavakVpnService.enterGuard()
              →  backend.stop()               # هسته متوقف می‌شود
              →  fd/tun بسته **نمی‌شود**       # اینترفیس می‌ماند، مسیرها می‌مانند
              →  config_guard.json اجرا می‌شود # sing-box با همه‌چیز = block
              →  تلاش دوباره با backoff (۲s→۶s→۱۸s→۵۴s، حداکثر ۴ بار)
              →  موفق؟ برگشت به رانک ترجیحی    ناموفق؟ اعلان صریح، نه اسپینر بی‌پایان
```

پیکربندی گارد **از قبل رندر و اعتبارسنجی شده** داخل باندل است (`node.guard`) — ساختن JSON
در لحظهٔ مرگ تونل بدترین زمان ممکن است. شکل آن عمداً «منفیِ» کانفیگ زنده است:

```json
{ "outbounds": [{ "type": "block", "tag": "savak-block" }],
  "route": { "rules": [], "final": "savak-block", "auto_detect_interface": true },
  "inbounds": [ /* همان tun: آدرس/MTU/package rules تغییر نمی‌کند */ ] }
```

هیچ `savak-direct` در آن نیست، بنابراین هیچ قاعده‌ای نمی‌تواند چیزی را به شبکهٔ آزاد بفرستد —
حتی DNS. آدرس‌ها/MTU هم عوض نمی‌شوند، چون تغییرشان یعنی build مجدد اینترفیس و باز شدن همان
پنجرهٔ نشت. این‌ها در تست‌های موتور assert شده‌اند
(`engine/test/tunnel-controls.test.js`).

نیمهٔ اندرویدی‌اش در `SavakPlatformBridge.openTun()` است: وقتی `strict_route` روشن است،
Builder با **allow-list همهٔ برنامه‌های نصب‌شده** ساخته می‌شود (منهای آن‌هایی که کاربر بیرون
تونل گذاشته) و `setBlocking(true)` می‌خورد. اگر لیست برنامه‌ها خوانده نشود، `openTun`
**خطا می‌کند** — چون allow-list ناقص یعنی کلید قطع ناقص، و «تقریباً» در اینجا همان «بی‌خطر
به‌نظر رسیدن» است.

خاموش‌کردنش یک انتخاب صریح است (`TunnelPrefs`، پیش‌فرض = روشن). اگر پروفایل کلید را خواسته
باشد و کاربر خاموشش کند، UI همان لحظه هشدار می‌دهد؛ حالت را پنهان نمی‌کند.

### چه کسی `strict_route` را اجرا می‌کند (و چرا پاسخ «sing-box» غلط است)

در سورس 1.14.4، `strict_route` فقط دو جا ظاهر می‌شود:

```
$ grep -rn "StrictRoute" experimental/ option/
experimental/libbox/tun.go:25:      GetStrictRoute() bool
option/tun.go:32:   StrictRoute  bool `json:"strict_route,omitempty"`
```

هستهٔ Go چیزی با آن *کار نمی‌کند* — فقط از پیکربندی می‌خواند و روی پل به سمت پلتفرم می‌فرستد.
روی اندروید، «پلتفرم» خودِ همین اپ است: `SavakPlatformBridge.openTun()`. پس معنای
`strict_route` را ما تعریف می‌کنیم، و قاعده‌ای که انتخاب کرده‌ایم این است:

> allow-list همهٔ برنامه‌ها **فقط وقتی** ساخته می‌شود که پیکربندی خواسته باشد **و** کاربر کلید
> قطع را خاموش نکرده باشد.

دلیلش صادقانه است: allow-list یعنی یک تازه‌نصب‌شده تا reconnect بعدی می‌تواند هیچ مسیری نداشته
باشد. این هزینهٔ واقعی همان محافظت است، ولی اگر کاربر سوییچ را خاموش کرده، نباید پنهانی فعال
بماند. هر دو نیمهٔ این قاعده در یک فایل نوشته شده تا UI و سرویس دو جواب مختلف نداشته باشند.

## ۲) Split Tunneling

دو مکانیزم جدا، هر دو از پیکربندیِ رندرشده توسط موتور (نه حدس دستگاه):

| نوع | فیلد | به کجا می‌نشیند |
|---|---|---|
| بیرون‌تونلی کردن برنامه | `split.excludePackages` | `tun.exclude_package` → `addDisallowedApplication` |
| بیرون‌تونلی کردن دامنه | `split.bypassDomains` | قاعدهٔ `route` با `outbound: savak-direct` + `domain_suffix` |
| بیرون‌تونلی کردن رنج IP | `split.bypassPrefixes` / `excludePrefixes` | قاعدهٔ `ip_cidr` / `tun.route_exclude_address` |
| بر اساس نام پروسه | `split.bypassProcessNames` | قاعدهٔ `process_name` + `find_process: true` را روشن می‌کند |

دو قید که عمدی‌اند:
- `include_package` و `exclude_package` در sing-box با هم مجاز نیستند؛ اگر هر دو داده شوند
  حالت «فقط این برنامه‌ها» برنده می‌شود و لیست دیگر **رها نمی‌شود بی‌صدا** — موتور یکی را
  تولید می‌کند و تست همان را assert می‌کند.
- `find_process` هزینه دارد (UID→پکیج برای هر پکت)، پس فقط وقتی روشن می‌شود که واقعاً
  `bypassProcessNames` داده شده باشد.

CLI:

```bash
node engine/src/cli.js bundle --profile profile.json \
  --mode daily --kill-switch block \
  --split-apps com.android.chrome,ir.some.bank \
  --split-domains intranet.company.ir --split-prefixes 10.0.0.0/8,192.168.0.0/16
```

## ۳) تأخیر کم و «بهینه برای استفاده روزمره»: حالت `daily`

حالت جدید در کنار `game`، با وزن‌ها و رفتارهای متفاوت — نه یک لیبل:

```js
daily: { weights: { throughput: .26, latency: .30, stability: .26, evasion: .12, cost: .06 },
         bondInterfaces: false, lowLatencyDial: true,
         minSwitchGainPct: 22, dwellMs: 120_000,
         probeIntervalMs: { wifi: 420_000, cellular: 600_000 } }
```

چه چیزی واقعاً عوض می‌شود (و چرا حس می‌شود):
- `lowLatencyDial` → `connect_timeout` از `3s/2s` به `1.2s/900ms` — مسیر مرده سریع‌تر ول می‌شود؛
  همین عدد تفاوت «۲۰۰ میلی‌ثانیه مکث» با «سه ثانیه یخ» وسط تماس است.
- `tcp_keep_alive_interval` → `15s` (از ۳۰–۷۵ ثانیه): NAT سلفون وسط تماس نمی‌میرد.
- `route.default_fallback_delay` → `200ms` (وقتی باندینگ خاموش است).
- `tun.udp_timeout` → `1m` روی سلفون: نگه‌داشتن نگاشت‌های مردهٔ UDP هزینهٔ رادیو و باتری است.
- `minSwitchGainPct: 22` و `dwellMs: 120s`: تعویض پروتکل فقط با برد پایدارِ بزرگ‌تر — وسط تماس
  ویدیویی هیچ‌کس تعویض ۸٪ را نمی‌خواهد.
- کاوشِ آرام‌تر (probe بازهٔ ۷ تا ۱۰ دقیقه): باتریِ «روشن همه‌روزه».
- `bondInterfaces: false`: یک رابط، wake-up کمتر، رفتار RTT قابل پیش‌بینی‌تر.

`Tor` در این حالت نیست (`MODE_ALLOW.daily`) — سه RTT دستی با «روزمره» سازگار نیست.

### چه چیزی عملاً تولید می‌شود (خروجی واقعی همین مخزن)

```jsonc
// savak bundle --mode daily --kill-switch --split-apps com.android.chrome \
//              --split-prefixes 10.0.0.0/8   →  configs.vless_reality_tcp
"inbounds": [{ "type": "tun", "strict_route": true, "udp_timeout": "2m",
               "exclude_package": ["com.android.chrome"] }],
"route": { "default_fallback_delay": "200ms",
           "rules": [ …, { "outbound": "savak-direct", "ip_cidr": ["10.0.0.0/8"] } ] }

// و قفل همان گره: nodes[].guard  (روی دستگاه می‌شود config-guard.json)
{ "outbounds": [{ "type": "block", "tag": "savak-block" }],
  "route": { "rules": [], "final": "savak-block" },
  "inbounds": [{ "type": "tun", "strict_route": true, "exclude_package": ["com.android.chrome"] }] }
```

هر دو قطعه با schema رسمی 1.14.4 اعتبارسنجی می‌شوند (`validate: OK` در خروجی `savak bundle`)؛
یعنی `strict_route`، `udp_timeout`، `exclude_package`، `default_fallback_delay` و
`find_process` نام‌های مجاز sing-box هستند، نه اختراع ما.

## ۴) «سرور رایگان بیشتر» — چیزی که اضافه شد و چیزی که عمداً اضافه نشد

فید رایگان **مکانیزم** گرفت، فهرست نگرفت:

```bash
node engine/src/cli.js feed --file links.txt --out feed-profile.json [--require-reality] [--max 150]
# ورودی: لینک‌های vless/hy2/tuic/anytls/ss (یک‌به‌یک یا body بیس۶۴ اشتراک)
```

`engine/src/feed.js` چه می‌کند: پارس، طبقه‌بندی به رانک، حذف تکراری‌ها، سقف تعداد، **رد**
`security=none`/`insecure`، و ثبت فقط همان چیزی که خودِ لینک اثبات می‌کند (کلید Reality، SNI،
UDP). بعد پروفایلی می‌دهد که `signature=null` و `feedTrust: 'unverified'` است.

آن‌چه عمداً انجام نمی‌شود: هیچ آدرسی از غریبه‌ها در سورس/کانفیگ توزیع‌شده جای نمی‌گیرد، و
`buildBundle` پروفایل فید را **رد می‌کند** مگر با `--allow-unverified-feed` (تست دارد:
`ok=false` + پیام + `nodes: []`). دلیلش سلیقه نیست: خروجیِ یک «سرور رایگان» کسی است که
ترافیک شما از او رد می‌شود، و هیچ‌کدام از داده‌های این مخزن نمی‌تواند بگوید او همان کسی نیست
که فیلترینگ را می‌کند. اضافه‌کردن چنین فهرستی به ابزار ضدسانسور «قابلیت» نیست — واگذاری
سکوت‌گونهٔ تصمیم اعتماد به یک فایل متنی است. اگر فیدی را خودتان انتخاب کردید، موتور همان را
می‌گیرد و نردبان پیش از استفاده اندازه‌گیری می‌کند.

دو محدودیت عمدی که در تست قفل شده‌اند:

- هر گرهٔ وارداتی فقط همان پله‌ای را پیشنهاد می‌گیرد که لینکش نامیده
  (`servers[].protocols = [rung]`): پیوندی که یک vless/Reality توصیف می‌کند مجوز این نیست که
  شش کانفیگ Hy2/TUIC/WG برای آن رندر شود.
- هر گره یک `warning` می‌گیرد: `trust:unverified — …` که در صفحهٔ نردبان دیده می‌شود.

خروجی واقعی `savak feed` روی یک فایل ۵ خطی (۲ لینک سالم، یکی بدون TLS، یکی trojan):

```
feed      imported=2 rejected=2 trust=unverified
rungs     vless_reality_tcp×1 hy2_brutal×1
risk      1/2 without a pinned Reality key — they can be identified and are not pinned
  drop      link requests an insecure/none TLS mode; refusing to keep it ← vless://…
  drop      unsupported link type: trojan ← trojan://x@1.2.3.4:443#…
```

## ۵) «اتصال واقعی» — حالت دقیق

- **حلقهٔ گمشدهٔ قبلی بسته شد:** تا پیش از این `SavakVpnService` یک `openTun()` داشت که هیچ
  مسیری صدا نمی‌زد — یعنی هیچ TUNی ساخته نمی‌شد، ولی `running = true` بود. حالا اینترفیس در
  `SavakPlatformBridge` و **به درخواست خود sing-box** (`PlatformInterface.OpenTun`) ساخته می‌شود،
  `protect()` برای سوکت‌های خودِ هسته همان‌جا صدا زده می‌شود (بدون آن: حلقهٔ مسیریابی)، و
  `running` فقط وقتی true است که `tunEstablished` باشد. اگر AAR ثبت پلتفرم را نپذیرد، استارت
  **خطا می‌دهد** و UI «وصل است» را نشان نمی‌دهد. `connected` هم دیگر قبل از جواب سرویس
  ست نمی‌شود (`awaitTunnel()` با سقف ۲۱ ثانیه).
- **فایل APK و سرور، از این محیط ساخته/تهیه نمی‌شوند** (پنج میزبان لازم در TLS handshake بسته‌اند:
  `maven.google.com` · `repo1.maven.org` · `services.gradle.org` · `go.dev` · `dl.google.com`).
  `libbox` یعنی خودِ تونل، و بدون آن این کد «اتصال واقعی» نمی‌دهد؛ پس راه‌های واقعی همان دو
  مسیر همیشگی‌اند: `bash android/tools/install-toolchain.sh` روی دستگاه شما، یا فعال‌کردن
  `ci/apk-only.yml`. برای سرور: `server/bootstrap.sh` (sing-box 1.14.4، Reality، پورت‌های
  شناخته‌شده) و بعد `savak init` → `savak bundle` → فایل امضاشده داخل assets.
- **روی دستگاه اجرا نشده.** آنچه سبز است: `npm test` موتور (۱۰۴/۱۰۴)، چهار پایهٔ
  `typecheck.sh` (کامپایل kotlinc روی ۱۲ فایل ماژول با استاب‌های Android **و حالا خودِ
  `MainActivity.kt`** با استاب‌های `androidx/*`)، `aapt2 compile` منابع، `check:generated`،
  و `--self-test`. پای UI بی‌مصرف نبود: همان اول `Bundle.minSwitchGainPct` را که با `optInt`
  خوانده می‌شد و به `Selector(minSwitchGainPct: Double)` می‌رفت گرفت (`argument type mismatch:
  actual Int, expected Double`) — یعنی باگ «اولین بیلد Gradle» یکی کم شد. اینکه چک
  بی‌مصرف نیست با mutation هم سنجیده شد: `splitApps()` → `splitPackages()` → `exit=1` با
  `unresolved reference 'splitPackages' on receiver of type 'TunnelPrefs'`، بازگرداندن → `exit=0`.
  آنچه هنوز **سنجیده نشده**: امضای خودِ androidx/Compose (پلاگین Compose و runtime واقعی در
  کار نیستند — بدفهمیدن آپیک‌آن‌های آنها اینجا رد می‌شود و در Gradle می‌گیرد)، نام‌های
  `setPlatformInterface` / `startOrReloadService` وابسته به AAR است و هنوز هیچ‌جا لینک نشده؛
  و هیچ بسته‌ای روی موبایل نصب نشده. اولین بیلد واقعی، اولین لینک/اجرای واقعی این کد است —
  کامپایل شدنش دیگر به آن بیلد موکوت نیست، و این دقیقاً همان چیزی است که استاب‌ها برایش ساخته شدند.
