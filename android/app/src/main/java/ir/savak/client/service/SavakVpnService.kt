package ir.savak.client.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.net.VpnService
import android.os.ParcelFileDescriptor
import ir.savak.client.R
import ir.savak.client.engine.Rung
import kotlin.concurrent.thread

/**
 * The tunnel host. Its job is exactly three things:
 *   1. own the VpnService lifecycle (permission, notification, the TUN fd),
 *   2. hand the *config the engine produced* to the backend,
 *   3. apply the selector switches the ladder decides, without reconnecting.
 *
 * It contains no protocol logic and no config generation — that lives in the engine, so
 * the phone cannot invent a config the validator would have rejected.
 */
class SavakVpnService : VpnService() {

    companion object {
        const val ACTION_START = "ir.savak.client.START"
        const val ACTION_STOP = "ir.savak.client.STOP"
        const val ACTION_SWITCH = "ir.savak.client.SWITCH"
        const val EXTRA_TAG = "rung"
        private const val CHANNEL = "savak"
        private const val NOTIF = 0x5A7E

        @Volatile
        var running: Boolean = false
            private set

        @Volatile
        var activeRungId: String? = null

        /** The service is created by the framework, so the ladder talks to it through this. */
        @Volatile
        var instance: SavakVpnService? = null
    }

    private var backend: TunnelBackend? = null
    private var tun: ParcelFileDescriptor? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        instance = this
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
            val res = kotlinx.coroutines.runBlocking { b.start(cfgFile, BundleHolder.mtu) }
            if (!res.ok) {
                running = false
                BundleHolder.lastError = res.message ?: "start failed"
                stopSelf()
            } else {
                running = true
                BundleHolder.lastError = null
                BundleHolder.statusLine = "${rung.title} · ${b.describe()}"
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
            val res = kotlinx.coroutines.runBlocking { b.setSelectorDefault("savak-ladder", outboundTag) }
            if (!res.ok) {
                // Fall back to a full config swap for rungs whose kernel differs
                // (e.g. the WireGuard *endpoint* config has no selector at all).
                BundleHolder.rungByTag(outboundTag)?.let { startRung(it) }
            }
            activeRungId = outboundTag.removePrefix("savak-")
        }
    }

    private fun stopEverything() {
        runCatching { kotlinx.coroutines.runBlocking { backend?.stop() } }
        runCatching { tun?.close() }
        tun = null
        running = false
        activeRungId = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        stopEverything()
        instance = null
        super.onDestroy()
    }

    override fun onRevoke() {
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
     * Builds the TUN and hands the descriptor over. `ProtectFromVpnService` is what stops
     * the tunnel from eating its own probes; `setBlocking(false)` is required by sing-box's
     * async TUN reader.
     */
    @Suppress("unused")
    private fun openTun(mtu: Int, addressCidrs: List<String>, routes: List<String>): ParcelFileDescriptor? {
        val builder = Builder()
            .setSession(getString(R.string.app_name))
            .setMtu(mtu)
        addressCidrs.forEach { builder.addAddress(it) }
        routes.forEach { builder.addRoute(it) }
        builder.addDnsServer("8.8.8.8")
        builder.setBlocking(false)
        val fd = try {
            builder.establish()
        } catch (e: Exception) {
            BundleHolder.lastError = e.message
            null
        }
        tun = fd
        return fd
    }

    private fun ensureChannel() {
        val nm = getSystemService(NotificationManager::class.java) ?: return
        if (nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, getString(R.string.notif_channel), Notification.IMPORTANCE_LOW),
            )
        }
        startForeground(
            NOTIF,
            Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_name)
                .setContentTitle(getString(R.string.notif_title))
                .setContentText(activeRungId ?: "")
                .setOngoing(true)
                .build(),
        )
    }

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
    private var byTag: Map<String, Rung> = emptyMap()

    fun stage(rungs: List<Rung>) {
        byTag = rungs.associateBy { "savak-${it.id}" }
        pending = rungs.firstOrNull()
    }

    fun rungByTag(tag: String): Rung? = byTag[tag]

    fun writeConfig(context: Context, rung: Rung): File {
        val dir = context.getDir("savak-run", Context.MODE_PRIVATE)
        dir.mkdirs()
        val f = File(dir, "config-${rung.id}.json")
        f.writeText(rung.config.toString(2))
        return f
    }
}
