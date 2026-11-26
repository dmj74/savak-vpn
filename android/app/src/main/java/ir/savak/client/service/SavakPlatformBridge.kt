// The seam sing-box's libbox asks *the app* to fill: PlatformInterface, and the TUN.
//
// Why this file exists at all: `experimental/libbox` does not create VPN interfaces. In
// sing-box 1.14 the Go side declares `PlatformInterface` (`experimental/libbox/platform.go`)
// and calls back into Java to obtain the descriptor:
//
//     OpenTun(options TunOptions) (int32, error)
//     UsePlatformAutoDetectInterfaceControl() bool
//     AutoDetectInterfaceControl(fd int32) error
//     RegisterMyInterface(name string)
//
// `service.go` wraps that object as `adapter.PlatformInterface`, and its `OpenInterface` asks
// us for the fd. So the TUN — and therefore every kill-switch and split-tunnel decision in this
// app — is *our* code, not the AAR's. Which means:
//
//   • If we do not implement this, there is no tunnel. A VPN app that reports "connected"
//     without an interface is the worst failure mode available to this project, so nothing here
//     falls back quietly: each path either returns a real descriptor or throws, and the caller
//     turns that into a visible error plus the guard state.
//   • The binding is gomobile-generated, so class and method names are build artifacts. A
//     `java.lang.reflect.Proxy` over the interface the AAR actually exports means a rename
//     breaks loudly at startup instead of silently changing what the phone routes.
package ir.savak.client.service

import android.net.VpnService
import android.os.ParcelFileDescriptor
import ir.savak.client.R
import java.lang.reflect.InvocationHandler
import java.lang.reflect.Method
import java.lang.reflect.Proxy

/** Liveness and ownership state for the one TUN this process may own. */
object SavakPlatformBridge {

    /** One place to edit when `-javapkg` moves. */
    private const val PKG = "org.savak.core.libbox"

    @Volatile private var tun: ParcelFileDescriptor? = null
    @Volatile private var service: VpnService? = null

    /** Set only after `establish()` returned a descriptor. This is what "connected" means. */
    @Volatile var tunEstablished: Boolean = false
        private set

    /** Why the interface could not be created — surfaced verbatim in the UI and the notification. */
    @Volatile var lastError: String? = null
        private set

    /** The name sing-box thinks it is talking to, for the status line. */
    @Volatile var interfaceName: String? = null
        private set

    fun bind(vpn: VpnService) {
        service = vpn
        lastError = null
        warnings = emptyList()
    }

    /** Close the interface. The guard does *not* call this: the guard keeps the same fd and
     *  swaps what is behind it, because tearing the interface down is what leaks traffic. */
    fun release() {
        runCatching { tun?.close() }
        tun = null
        tunEstablished = false
        interfaceName = null
        service = null
        warnings = emptyList()
    }

    /**
     * The `PlatformInterface` implementation, or null when the linked AAR does not export the
     * type. `null` never means "run without a tunnel" — callers must treat it as fatal.
     */
    fun newPlatformInterface(): Any? {
        val iface = platformInterfaceClass() ?: return null
        val svc = service ?: return null
        return Proxy.newProxyInstance(iface.classLoader, arrayOf(iface), Handler(svc))
    }

    fun platformInterfaceClass(): Class<*>? = runCatching { Class.forName("$PKG.PlatformInterface") }.getOrNull()

    /**
     * Something the interface could not honour on this Android version. Not an error: each of
     * these is a *conservative* degradation (traffic stays inside the tunnel instead of escaping
     * it), so the tunnel stays safe while the user's intent is partly unmet — which is exactly
     * the class of fact a VPN app is trusted not to hide. Surfaces in the status line.
     */
    @Volatile var warnings: List<String> = emptyList()
        private set

    fun noteWarning(text: String) {
        if (warnings.none { it == text }) warnings = warnings + text
    }

    fun markEstablished(fd: ParcelFileDescriptor) {
        tun = fd
        tunEstablished = true
    }

    fun fail(reason: String) {
        tunEstablished = false
        lastError = reason
        runCatching { tun?.close() }
        tun = null
    }

    private class Handler(private val svc: VpnService) : InvocationHandler {
        override fun invoke(proxy: Any, method: Method, args: Array<out Any?>?): Any? = when (method.name) {
            "openTun" -> openTun(svc, args?.getOrNull(0))
            // The tunnel's own sockets must bypass the tunnel. Without this, sing-box dials
            // its server through the interface it is creating: a routing loop, not a VPN.
            "usePlatformAutoDetectInterfaceControl" -> true
            "autoDetectInterfaceControl" -> {
                val fd = (args?.getOrNull(0) as? Number)?.toInt() ?: -1
                if (!svc.protect(fd)) error("protect(fd=$fd) failed: the core's own socket would be captured by the tunnel")
                null
            }
            "registerMyInterface" -> { interfaceName = args?.getOrNull(0) as? String; null }
            "underNetworkExtension" -> true
            "usePlatformBridge", "usePlatformShell", "includeAllNetworks" -> false
            "clearDNSCache", "sendNotification", "cancelNotification",
            "startDefaultInterfaceMonitor", "closeDefaultInterfaceMonitor",
            "startNeighborMonitor", "closeNeighborMonitor" -> null
            "readWIFIState", "localDNSTransport", "findConnectionOwner", "lookupUser",
            "lookupSFTPServer", "readSystemSSHHostKey", "tailscaleHostname",
            "createBridge", "openShellSession" -> null
            "getInterfaces" -> emptyIterator()
            else -> defaultValue(method.returnType)
        }
    }

    // ── the TUN itself ───────────────────────────────────────────────────────────────────

    /**
     * Reads the `TunOptions` sing-box handed us and builds the interface. Note what is *not*
     * here: nothing is invented. Addresses, MTU, route ranges and the package lists all come
     * from the config the engine rendered and the schema validated — which is this app's whole
     * design (the phone selects configs, it never authors them).
     */
    private fun openTun(svc: VpnService, options: Any?): Int {
        lastError = null
        tun?.takeIf { tunEstablished }?.let {
            // One interface at a time. A second establish() would leave Android with two
            // competing sessions, and the packet path during that overlap is undefined.
            return it.fd
        }
        val builder = VpnService.Builder().setSession(svc.getString(R.string.app_name))
        val v4 = prefixes(options, "getInet4Address")
        val v6 = prefixes(options, "getInet6Address")
        if (v4.isEmpty() && v6.isEmpty()) {
            return failOpen(svc, "TunOptions carried no interface address — refusing to build a TUN that nothing can answer on")
        }
        (v4 + v6).forEach { builder.addAddress(it) }
        (call(options, "getMTU") as? Number)?.toInt()?.takeIf { it in 576..65535 }?.let { builder.setMtu(it) }

        if (bool(options, "getAutoRoute", true)) {
            builder.addRoute("0.0.0.0/0")
            builder.addRoute("::/0")
        } else {
            (prefixes(options, "getInet4RouteRange") + prefixes(options, "getInet6RouteRange"))
                .forEach { builder.addRoute(it) }
        }
        drain(call(options, "getDNSServerAddress")).firstOrNull()?.let { builder.addDnsServer(it) }

        // `route_exclude_address` — the engine's "these prefixes must not enter the tunnel"
        // (LAN, casting, the fake-IP hole for bypassed apps). VpnService only learned
        // addExcludeRoute recently, so it is *looked up* rather than assumed: on an older
        // device those prefixes simply stay inside the tunnel, and we say so out loud.
        val excludeRoutes = prefixes(options, "getInet4RouteExcludeAddress") + prefixes(options, "getInet6RouteExcludeAddress")
        if (excludeRoutes.isNotEmpty()) {
            val addExclude = runCatching { builder.javaClass.getMethod("addExcludeRoute", String::class.java) }.getOrNull()
            if (addExclude == null) {
                noteWarning("route_exclude_address بدون addExcludeRoute اعمال نشد (" + excludeRoutes.joinToString() + " داخل تونل می‌ماند)")
            } else {
                excludeRoutes.forEach { r ->
                    runCatching { addExclude.invoke(builder, r) }.onFailure { noteWarning("addExcludeRoute(" + r + ") رد شد") }
                }
            }
        }

        // ── kill switch and split tunneling ───────────────────────────────────────────────
        // Both are questions about *which sockets* reach this interface, which on Android is
        // answered by per-application routing rules. A Builder accepts an allow-list or a
        // deny-list, never both — so the order of these branches is the precedence, and it is
        // written down rather than discovered at runtime.
        val excludedApps = stringsOf(options, "getExcludePackage")
        val includedApps = stringsOf(options, "getIncludePackage")
        val strict = bool(options, "getStrictRoute", false)
        val prefs = TunnelPrefs.of(svc)
        // `strict_route` is read from the config, the toggle from the user, and *this* is the
        // only place the two are reconciled. That is not an accident: in sing-box 1.14 the Go
        // core only parses `option.TunInboundOptions.StrictRoute` and hands it over the bridge
        // (`experimental/libbox/tun.go: GetStrictRoute`) — nothing in the core acts on it. So
        // on this platform the *meaning* of strict_route is whatever this function does, and
        // the rule chosen here is "config asks AND user has not opted out": an allow-list is
        // the one control that can lock a freshly installed app out of the network until the
        // next reconnect, so a switch the user turned off must really turn it off.
        when {
            includedApps.isNotEmpty() -> includedApps.forEach { builder.addAllowedApplication(it) }
            strict && prefs.killSwitchEnabled() -> {
                // `strict_route` is where the kill switch becomes real: only the apps we name
                // can talk at all, and we name every installed app except the ones the user put
                // outside the tunnel. An unresolvable package is left *out* of the allow-list
                // (so it keeps working normally) and reported — a silently partial allow-list
                // would be a silently partial kill switch.
                val skip = (excludedApps + prefs.splitApps()).toSet()
                val installed: List<String> = runCatching {
                    svc.packageManager.getInstalledApplications(0).map { it.packageName }
                }.getOrDefault(emptyList())
                if (installed.isEmpty()) {
                    return failOpen(svc, "strict_route was requested but the installed-app list is unavailable; a partial allow-list would silently weaken the kill switch")
                }
                (installed - skip).forEach { builder.addAllowedApplication(it) }
            }
            // Not `excludedApps` alone: the user may have added an app locally after the
            // bundle was built (the UI writes TunnelPrefs, the engine could not know). The
            // strict branch above already unions the two; without this line the same switch
            // would work in one mode and silently do nothing in the other.
            excludedApps.isNotEmpty() || prefs.splitApps().isNotEmpty() ->
                (excludedApps + prefs.splitApps()).distinct().forEach { builder.addDisallowedApplication(it) }
        }
        // No proxy ARP, no captive-portal escape: while the interface exists, nothing else
        // may carry traffic. This is the Android-native half of the kill switch and it costs
        // nothing, so it is on whenever the guard is configured.
        if (prefs.killSwitchEnabled()) builder.setBlocking(true)

        val fd = try {
            builder.establish()
        } catch (e: Exception) {
            return failOpen(svc, "establish() threw: ${e.message}")
        }
        if (fd == null) return failOpen(svc, "establish() returned null — Android refused the interface (another VPN still owns it?)")
        markEstablished(fd)
        return fd.fd
    }

    private fun failOpen(svc: VpnService, reason: String): Int {
        fail(reason)
        error(reason) // → surfaces as the Go-side error, i.e. a visible start failure
    }

    // ── reflection helpers: one shape, no guessing in the call sites ──────────────────────

    private fun call(target: Any?, name: String): Any? =
        target?.let { runCatching { it.javaClass.getMethod(name).invoke(it) }.getOrNull() }

    private fun bool(target: Any?, name: String, default: Boolean): Boolean =
        (call(target, name) as? Boolean) ?: default

    private fun stringsOf(target: Any?, name: String): List<String> = drain(call(target, name))

    /** gomobile turns Go's `common.Iterator[string]` into hasNext/next; nothing else. */
    private fun drain(iter: Any?): List<String> {
        if (iter == null) return emptyList()
        val out = mutableListOf<String>()
        val hasNext = runCatching { iter.javaClass.getMethod("hasNext") }.getOrNull() ?: return emptyList()
        val next = runCatching { iter.javaClass.getMethod("next") }.getOrNull() ?: return emptyList()
        while (runCatching { hasNext.invoke(iter) as? Boolean == true }.getOrDefault(false)) {
            (runCatching { next.invoke(iter) }.getOrNull() as? String)?.let { out += it }
        }
        return out
    }

    private fun prefixes(target: Any?, name: String): List<String> {
        val iter = call(target, name) ?: return emptyList()
        val out = mutableListOf<String>()
        val hasNext = runCatching { iter.javaClass.getMethod("hasNext") }.getOrNull() ?: return emptyList()
        val next = runCatching { iter.javaClass.getMethod("next") }.getOrNull() ?: return emptyList()
        while (runCatching { hasNext.invoke(iter) as? Boolean == true }.getOrDefault(false)) {
            val item = runCatching { next.invoke(iter) }.getOrNull() ?: break
            val address = runCatching { item.javaClass.getMethod("address").invoke(item) }.getOrNull() as? String
            val prefix = runCatching { item.javaClass.getMethod("prefix").invoke(item) }.getOrNull() as? Int
            if (address != null && prefix != null) out += "$address/$prefix"
        }
        return out
    }

    private fun emptyIterator(): Any? {
        val type = runCatching { Class.forName("$PKG.NetworkInterfaceIterator") }.getOrNull() ?: return null
        return Proxy.newProxyInstance(type.classLoader, arrayOf(type)) { _, m, _ ->
            when (m.name) {
                "hasNext" -> false
                "next" -> null
                else -> defaultValue(m.returnType)
            }
        }
    }

    private fun defaultValue(t: Class<*>): Any? = when {
        t == java.lang.Boolean.TYPE || t == java.lang.Boolean::class.java -> false
        t == java.lang.Integer.TYPE || t == java.lang.Integer::class.java -> 0
        t == java.lang.Long.TYPE || t == java.lang.Long::class.java -> 0L
        t == java.lang.Float.TYPE -> 0f
        t == java.lang.Double.TYPE -> 0.0
        t == java.lang.Short.TYPE -> 0.toShort()
        t == java.lang.Byte.TYPE -> 0.toByte()
        else -> null
    }
}
