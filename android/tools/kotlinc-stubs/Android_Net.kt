package android.net

open class Network

open class NetworkCapabilities {
    fun hasTransport(t: Int): Boolean = false
    fun hasCapability(c: Int): Boolean = false

    companion object {
        const val TRANSPORT_WIFI = 1
        const val TRANSPORT_CELLULAR = 0
        const val TRANSPORT_ETHERNET = 3
        const val NET_CAPABILITY_VALIDATED = 16
    }
}

open class ConnectivityManager {
    open val activeNetwork: Network? = null
    open val allNetworks: Array<Network>? = null
    open fun getNetworkCapabilities(n: Network): NetworkCapabilities? = null
}

/**
 * The VPN entry point. `prepare()` returning null means "already consented", which is the
 * branch the app treats as ready-to-start — the same meaning it has on a device.
 */
/** Real hierarchy is VpnService → Service → ContextWrapper → Context, so the stub extends
 * Context too; otherwise `getString`/`getSystemService` look missing when they are not. */
open class VpnService : android.content.Context() {

    open fun onStartCommand(intent: android.content.Intent?, flags: Int, startId: Int): Int = 1
    open fun onDestroy() {}
    open fun onRevoke() {}
    open fun stopSelf() {}
    open fun stopForeground(flags: Int) {}
    open fun startForeground(id: Int, notification: android.app.Notification) {}

    class Builder {
        fun setSession(name: String): Builder = this
        fun setMtu(mtu: Int): Builder = this
        fun addAddress(cidr: String): Builder = this
        fun addRoute(cidr: String): Builder = this
        fun addDnsServer(addr: String): Builder = this
        fun setBlocking(blocking: Boolean): Builder = this
        fun establish(): android.os.ParcelFileDescriptor? = android.os.ParcelFileDescriptor()
    }

    companion object {
        const val START_STICKY = 1
        const val START_NOT_STICKY = 2
        const val STOP_FOREGROUND_REMOVE = 1

        @JvmStatic
        fun prepare(context: android.content.Context, service: Class<*>?): android.content.Intent? = null
    }
}
