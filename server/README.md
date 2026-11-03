# savak server — گرهٔ شبکه

دو چیز این پوشه را «سرور» می‌کند: فایل پیکربندی sing-box که موتور تولید می‌کند، و
یک پاسخ‌دهندهٔ اندازه‌گیری که به پروب‌های گوشی جواب می‌دهد.

## bootstrap.sh

```bash
# روی VPS، از repo clone شده
sudo bash server/bootstrap.sh --hostname fra1.example.com --node fra-1 --apply
```

بدون `--apply` فقط چاپ می‌کند چه خواهد کرد (dry-run) — پیدا کردن اشتباه همان‌جا
کم‌هزینه‌ترین جا است.

| کلید | کار |
|---|---|
| `--apply` | نوشتن واقعی: نصب sing-box، ساخت config، sysctl، سرویس systemd |
| `--hostname <fqdn>` | آدرس گره؛ اگر ACME می‌خواهید باید DNS آن حل شده باشد |
| `--node <id>` | شناسهٔ گره در پروفایل |
| `--brutal` | اگر ماژول kernel `tcp_brutal` نصب است (bootstrap خودش وجودش را چک می‌کند) |
| `--email <a@b>` | ایمیل ACME برای گواهی Let's Encrypt |
| `--state-dir <dir>` | پیش‌فرض `/etc/savak` |

کارهایی که انجام می‌دهد، به همین ترتیب:

1. **پیش‌انجام:** `tcp_available_congestion_control` را می‌خواند. اگر `bbr` نباشد
   می‌گوید BBR درگیر نمی‌شود؛ اگر `brutal` نباشد، `multiplex.brutal` از config حذف
   می‌شود. ادعا و config باید یکی باشند — این دلیل چک کردن است.
2. **نصب sing-box 1.14.4** (باینری رسمی؛ در ایران معمولاً با `GITHUB_BASE=<mirror>`).
3. **تولید همهٔ کلیدها با موتور:** `node src/cli.js init` — X25519 برای Reality و
   WireGuard، کلید SS-2022 با طول درست برای cipher، رمزهای hy2/tuic/anytls، و
   امضای Ed25519 پروفایل. هیچ `echo | base64` در shell نیست.
4. **`server.json`** با اعتبارسنجی ajv مقابل schema رسمی، شامل همهٔ پله‌ها + endpoint
   WireGuard + sniffer + `block-censys` rule.
5. **sysctl** (`sysctl-savak.conf` → `/etc/sysctl.d/90-savak.conf`): BBR+fq،
   `rmem_max/wmem_max` بزرگ (پنجرهٔ client بی‌معنی می‌ماند اگر kernel اجازه ندهد)،
   conntrack، `tcp_fastopen=3`، ECN خاموش (روی لین‌های shaped ضرر می‌زند).
6. **systemd**: `savak.service` (با Hardening و `LimitNOFILE`) و
   `savak-probe.service` (پاسخ‌دهندهٔ اندازه‌گیری).
7. **باندل موبایل**: `/etc/savak/bundle.json` — همان فایلی که در assets اپ می‌رود.

## پاسخ‌دهندهٔ پروب (`engine/src/probe-service.js`)

گوشی بدون یک نقطهٔ انتهایی واقعی نمی‌فهمد UDP زنده است یا نه. این سرویس:

* `20125/udp` — درخواست `SAVAKQ|seq|t0|pad` را با پاسخ کوتاه `SAVAKR|seq|t0`
  (۱۴ بایت) جواب می‌دهد. عمداً نامتقارن است: پاسخ هم‌اندازهٔ درخواست، سرویس را به
  ابزار amplification تبدیل می‌کرد.
* `20126/tcp` — برای ۲ ثانیه جریان بایت می‌فرستد تا گوشی throughput واقعی را اندازه
  بگیرد.

هر دو stateless‌اند؛ لاگ نمی‌گیرند و هیچ داده‌ای از کاربر نمی‌بینند.

```bash
node engine/src/probe-service.js            # پیش‌فرض‌ها
SAVAK_PROBE_UDP=20125 SAVAK_PROBE_TCP=20126 node engine/src/probe-service.js
```

## پس از bootstrap

```bash
systemctl status savak savak-probe
node engine/src/cli.js race --profile /etc/savak/profile.json --node fra-1   # از client
journalctl -u savak -f
```

`/etc/savak/keys.json` را پشتیبان بگیرید: کلید امضای پروفایل آنجاست و بدون آن،
پروفایل‌های بعدی روی گوشی‌های موجود verify نمی‌شوند.
