package ir.savak.client.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.net.VpnService
import ir.savak.client.R
import ir.savak.client.engine.Rung
import java.io.File
import kotlin.concurrent.thread

/**
 * The tunnel host. Its job is exactly four things:
 *   1. own the VpnService lifecycle (permission, notification, the TUN fd),
 *   2. hand the *config the engine produced* to the backend,
 *   3. apply the selector switches the ladder decides, without reconnecting,
 *   4. never let "not connected" turn into "unprotected": the guard state.
 *
 * It contains no protocol logic and no config generation — that lives in the engine, so the
 * phone cannot invent a config the validator would have rejected.
 */
class SavakVpnService : VpnService() {

    companion object {
        const val ACTION_START = "ir.savak.client.START"
        const val ACTION_STOP = "ir.savak.client.STOP"
        const val ACTION_SWITCH = "ir.savak.client.SWITCH"
        const val EXTRA_TAG = "rung"
        private const val CHANNEL = "savak"
        private const val NOTIF = 0x5A7E

        /** Guard re-attempts before giving up. Bounded on purpose: an endless blackhole is a
         *  different harm than a leak, and the user must be able to tell the two apart. */
        private const val GUARD_ATTEMPTS = 4

        @Volatile
        var running: Boolean = false
            private set

        /** True while the interface is up but deliberately dropping everything. */
        @Volatile
        var guardActive: Boolean = false
            private set

        @Volatile
        var activeRungId: String? = null

        /** The service is created by the framework, so the ladder talks to it through this. */
        @Volatile
        var instance: SavakVpnService? = null
    }

    private var backend: TunnelBackend? = null
    private val prefs get() = TunnelPrefs.of(this)

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        instance = this
        SavakPlatformBridge.bind(this)
        when (intent?.action) {
            ACTION_STOP -> {
                stopEverything()
                return START_NOT_STICKY
            }
            ACTION_SWITCH -> {
                val tag = intent.getStringExtra(EXTRA_TAG)
                if (tag != null) applyRungTag(tag)
                return START_STICKY
            }
        }
        // The bundle is staged in BundleHolder before the service is started: a full
        // config would blow the binder transaction limit if it travelled by Intent.
        val rung = BundleHolder.pending ?: return START_NOT_STICKY
        startRung(rung)
        return START_STICKY
    }

    /** Called by the UI/ladder. `rung.config` is the pre-rendered sing-box document. */
    fun startRung(rung: Rung) {
        ensureChannel()
        val cfgFile = BundleHolder.writeConfig(this, rung)
        activeRungId = rung.id
        thread(name = "savak-start") {
            val b: TunnelBackend = backend ?: chosenBackend(this).also { backend = it }
            val res = b.start(cfgFile, BundleHolder.mtu)
            // `ok` alone is not "connected": the claim requires an interface. A backend that
            // started but never obtained a TUN is running in the dark, and saying "connected"
            // about it is the exact lie this app is built to avoid.
            val tunned = res.ok && (SavakPlatformBridge.tunEstablished || !BundleHolder.wantsTun)
            if (!tunned) {
                running = false
                BundleHolder.lastError = res.message ?: SavakPlatformBridge.lastError ?: "start failed"
                if (guardAvailable()) enterGuard(BundleHolder.lastError ?: "tunnel did not come up") else stopEverything()
            } else {
                running = true
                guardActive = false
                BundleHolder.lastError = null
                // The display name lives in the generated ladder table, not in the bundle:
                // the bundle carries configs, so a title there would be a second source of truth.
                val title = ir.savak.client.engine.LadderTable.BY_ID[rung.id]?.title ?: rung.id
                BundleHolder.statusLine = "$title · ${b.describe()} · ${tunnelState()} · ${prefs.describe()}${SavakPlatformBridge.warnings.firstOrNull()?.let { " ⚠" } ?: ""}"
            }
        }
    }

    /**
     * The fast path: every feasible rung is already present in the running config as a
     * selector member, so a transport change is one control call — no tunnel restart,
     * no IP re-assignment, no dropped VoIP call.
     */
    fun applyRungTag(outboundTag: String) {
        val b = backend ?: return
        thread(name = "savak-switch") {
            val res = b.setSelectorDefault("savak-ladder", outboundTag)
            if (!res.ok) {
                // Fall back to a full config swap for rungs whose kernel differs
                // (e.g. the WireGuard *endpoint* config has no selector at all).
                BundleHolder.rungByTag(outboundTag)?.let { startRung(it) }
            }
            activeRungId = outboundTag.removePrefix("savak-")
        }
    }

    private fun guardAvailable(): Boolean =
        prefs.killSwitchEnabled() && BundleHolder.guardConfig(this) != null

    /**
     * Leak-free lockdown: the interface stays exactly as it was (same addresses, same MTU,
     * same package rules) while everything behind it becomes a single `block` outbound, and
     * the ladder retries in the background.
     *
     * The alternative — stop the service — hands the sockets back to the carrier network,
     * which is the leak a kill switch exists to prevent, and is also how most clients end up
     * re-dialing while traffic flows in the clear.
     */
    private fun enterGuard(reason: String) {
        val guard = BundleHolder.guardConfig(this) ?: return
        guardActive = true
        running = false
        activeRungId = null
        BundleHolder.lastError = reason
        notifyState(getString(R.string.guard_title), "${getString(R.string.guard_text)} · دلیل: $reason")
        thread(name = "savak-guard") {
            val b = backend ?: chosenBackend(this).also { backend = it }
            var attempt = 0
            var delayMs = 2_000L
            while (attempt < GUARD_ATTEMPTS && guardActive) {
                runCatching { b.stop() }
                val res = b.start(guard, BundleHolder.mtu)
                if (res.ok && SavakPlatformBridge.tunEstablished) {
                    // Back on the ladder: the guard did its job, now hand over to a real rung.
                    val rung = BundleHolder.pending ?: BundleHolder.rungByTag("savak-${BundleHolder.preferredRung}")
                    if (rung != null) {
                        guardActive = false
                        startRung(rung)
                        return@thread
                    }
                }
                attempt++
                runCatching { Thread.sleep(delayMs) }
                delayMs = (delayMs * 3).coerceAtMost(90_000L)
            }
            // Give up *loudly*: the user sees why there is no connectivity instead of getting a
            // blackhole with a spinner, and the option to accept a clear-text fallback is theirs.
            notifyState(getString(R.string.guard_title), "تلاش خودکار تمام شد؛ محافظت ادامه دارد. برای برداشتنش کلید قطع را خاموش کنید")
        }
    }

    private fun stopEverything() {
        runCatching { backend?.stop() }
        backend = null
        SavakPlatformBridge.release()
        running = false
        guardActive = false
        activeRungId = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        stopEverything()
        instance = null
        super.onDestroy()
    }

    /**
     * Android revokes the tunnel (another VPN took over, the user toggled it off in Settings).
     * There is no way to keep the interface after this, so the honest behaviour is to stop and
     * say so — never to silently start over without protection.
     */
    override fun onRevoke() {
        BundleHolder.lastError = "دسترسی VPN پس گرفته شد"
        stopEverything()
        super.onRevoke()
    }

    /**
     * A radio switch invalidates the tunnel's sockets. sing-box exposes `ResetNetwork` on
     * its command channel precisely for this; without it the phone shows "connected" while
     * every packet goes to an interface that no longer exists.
     */
    fun resetNetwork() {
        runCatching { LibBoxReflect.resetNetwork() }
    }

    /**
     * The TUN is created from [SavakPlatformBridge] — by sing-box's own request
     * (`PlatformInterface.OpenTun`), with the kill-switch and split-tunnel rules applied
     * there. It is not built here, and nothing should start pretending otherwise: an earlier
     * revision of this file carried an `openTun()` that no code path called, which is exactly
     * how a VPN app ends up reporting a connection it never made.
     */
    private fun tunnelState(): String = when {
        guardActive -> "guard"
        SavakPlatformBridge.tunEstablished -> "tun:${SavakPlatformBridge.interfaceName ?: "?"}"
        else -> "none"
    }

    private fun notifyState(title: String, text: String) {
        ensureChannel()
        val nm = getSystemService(NotificationManager::class.java) ?: return
        nm.notify(NOTIF, baseNotification(title, text))
    }

    private fun ensureChannel() {
        val nm = getSystemService(NotificationManager::class.java) ?: return
        if (nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, getString(R.string.notif_channel), Notification.IMPORTANCE_LOW),
            )
        }
        startForeground(NOTIF, baseNotification(notifTitle(), BundleHolder.statusLine ?: activeRungId ?: ""))
    }

    /** Notification title: the profile name when the bundle carried one, else the app name.
     *  With several staged profiles on one phone, "savak فعال است" says nothing useful. */
    private fun notifTitle(): String =
        BundleHolder.profileLabel?.takeIf { it.isNotBlank() } ?: getString(R.string.notif_title)

    private fun baseNotification(title: String, text: String) =
        Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_name)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(true)
            .build()

    private fun chosenBackend(context: Context): TunnelBackend =
        if (BundleHolder.useSubprocess) {
            SubprocessBackend(context.getDir("savak-run", Context.MODE_PRIVATE), BundleHolder.binary)
        } else {
            LibBoxBackend(context)
        }
}

/**
 * The service and the UI process are the same process here, but passing a whole config
 * through an Intent hits the 1 MB binder limit — so the bundle lives in this holder and
 * on disk, and the Intent carries only the rung id.
 */
object BundleHolder {
    @Volatile var pending: Rung? = null
    @Volatile var statusLine: String? = null
    @Volatile var lastError: String? = null
    @Volatile var mtu: Int = 1400
    @Volatile var useSubprocess: Boolean = false
    @Volatile var binary: String = "sing-box"
    @Volatile var wantsTun: Boolean = true
    /** `profile.user`, staged with the rungs: a tunnel is named after its profile. */
    @Volatile var profileLabel: String? = null
    @Volatile var preferredRung: String = ""
    private var byTag: Map<String, Rung> = emptyMap()
    private var guardText: String? = null

    fun stage(rungs: List<Rung>, guard: String? = null, preferred: String? = null, profileLabel: String? = null) {
        this.profileLabel = profileLabel?.takeIf { it.isNotBlank() }
        byTag = rungs.associateBy { "savak-${it.id}" }
        pending = rungs.firstOrNull()
        guardText = guard
        preferredRung = preferred ?: pending?.id ?: ""
    }

    fun rungByTag(tag: String): Rung? = byTag[tag]

    fun writeConfig(context: Context, rung: Rung): File {
        val dir = dir(context)
        val f = File(dir, "config-${rung.id}.json")
        f.writeText(rung.config.toString(2))
        return f
    }

    /** The pre-rendered lockdown config, staged next to the rung configs. Null if the bundle
     *  carried none — which is the engine's way of saying "this profile has no kill switch". */
    fun guardConfig(context: Context): File? {
        val text = guardText ?: return null
        val f = File(dir(context), "config-guard.json")
        if (!f.exists() || f.readText() != text) f.writeText(text)
        return f
    }

    private fun dir(context: Context): File = context.getDir("savak-run", Context.MODE_PRIVATE).apply { mkdirs() }
}
