// User-controlled tunnel policy: the kill switch and the split-tunnel list.
//
// One file because two readers must never disagree. The UI shows a state and the service
// acts on it; if each kept its own copy, the failure would be the specific kind that matters
// here — a screen saying "kill switch on" while the tunnel host believes it is off.
//
// Storage is SharedPreferences, and the *defaults* are the security-relevant part: the kill
// switch ships enabled, and split tunneling ships empty. A feature whose default is "leak"
// is not a feature.
package ir.savak.client.service

import android.content.Context
import android.content.SharedPreferences

class TunnelPrefs private constructor(private val sp: SharedPreferences) {

    /** Default true: losing the tunnel must never silently become losing privacy. */
    fun killSwitchEnabled(): Boolean = sp.getBoolean(KILL_SWITCH, true)

    fun setKillSwitch(enabled: Boolean) {
        sp.edit().putBoolean(KILL_SWITCH, enabled).apply()
    }

    /** Packages the user deliberately keeps outside the tunnel. Empty by default. */
    fun splitApps(): List<String> = csv(sp.getString(SPLIT_APPS, ""))

    fun setSplitApps(packages: List<String>) {
        sp.edit().putString(SPLIT_APPS, packages.filter { it.isNotBlank() }.joinToString(",") { it.trim() }).apply()
    }

    /** One-line summary for the status card, so the UI cannot invent its own wording. */
    fun describe(): String = buildString {
        append(if (killSwitchEnabled()) "کلید قطع: روشن" else "کلید قطع: خاموش")
        val n = splitApps().size
        if (n > 0) append(" · $n برنامه بیرون از تونل")
    }

    private fun csv(raw: String?): List<String> =
        (raw ?: "").split(',', '،', '\n', ' ').map { it.trim() }.filter { it.isNotEmpty() }

    companion object {
        private const val FILE = "savak-tunnel"
        private const val KILL_SWITCH = "kill_switch"
        private const val SPLIT_APPS = "split_apps"

        fun of(context: Context): TunnelPrefs =
            TunnelPrefs(context.getSharedPreferences(FILE, Context.MODE_PRIVATE))
    }
}
