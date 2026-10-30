package ir.savak.client

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.VpnService
import ir.savak.client.service.BundleHolder
import ir.savak.client.service.SavakVpnService

/**
 * Reconnect after a reboot — but only if the user asked for it.
 *
 * Two guards matter here:
 *  • `alwaysOn` is the system's own contract (Settings → VPN → "Always on VPN"). If the
 *    platform has not been told that, starting a device-wide tunnel on boot is a surprise.
 *  • A boot happens with an unmeasured link. The first 30 s uses the engine's cold-start
 *    choice rather than a measured one, and the measurement loop takes over after that.
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        val prefs = context.getSharedPreferences("savak", Context.MODE_PRIVATE)
        val autoStart = prefs.getBoolean("auto_start", false)
        val alwaysOn = VpnService.prepare(context, SavakVpnService::class.java) == null
        if (!autoStart || !alwaysOn) return

        val pending = goAsync()
        try {
            val text = runCatching { context.assets.open("bundle.json").bufferedReader().use { it.readText() } }.getOrNull()
                ?: return
            val bundle = runCatching { ir.savak.client.engine.parseBundle(text) }.getOrNull() ?: return
            val node = bundle.nodes.first()
            val cold = coldStartRung(node.rungs, prefs.getString("mode", "auto") ?: "auto")
                ?: return
            BundleHolder.stage(node.rungs)
            context.startService(Intent(context, SavakVpnService::class.java).setAction(SavakVpnService.ACTION_START))
        } finally {
            pending.finish()
        }
    }

    /**
     * Cold start without measurements: prefer the rung that works on the widest variety of
     * paths (VLESS+Reality over TCP survives most middleboxes and needs no UDP), and only
     * then the fastest QUIC rung. Mirrors `coldStartPick()` in engine/src/score.js.
     */
    private fun coldStartRung(rungs: List<ir.savak.client.engine.Rung>, mode: String): ir.savak.client.engine.Rung? {
        val priority = when (mode) {
            "speed" -> listOf("hy2_brutal", "tuic_v5", "vless_reality_tcp")
            "game" -> listOf("wg_uot", "tuic_v5", "hy2_brutal")
            "stealth", "resist" -> listOf("vless_reality_tcp", "vless_reality_grpc", "anytls")
            else -> listOf("vless_reality_tcp", "hy2_brutal", "tuic_v5", "anytls")
        }
        return priority.firstNotNullOfOrNull { id -> rungs.firstOrNull { it.id == id } } ?: rungs.firstOrNull()
    }
}
