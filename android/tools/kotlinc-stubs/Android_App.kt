// Android framework stand-ins for tools/typecheck.sh — never compiled by Gradle, never shipped.
//
// What this proves: the module's own code is syntactically valid and internally consistent
// (member names, arity, nullability) with no SDK installed. What it cannot prove: that the
// real android.jar agrees with these signatures — the stubs were written from the same docs
// as the app code, so a shared misreading passes here and fails in Gradle. The authoritative
// API check is the CI build (`ci/android-apk.yml`), which compiles against the real SDK.
package android.app

open class Notification {
    class Builder(context: android.content.Context, channelId: String) {
        fun setSmallIcon(id: Int): Builder = this
        fun setContentTitle(t: CharSequence): Builder = this
        fun setContentText(t: CharSequence): Builder = this
        fun setOngoing(v: Boolean): Builder = this
        fun build(): Notification = Notification()
    }

    companion object { const val IMPORTANCE_LOW = 2 }
}

class NotificationChannel(val id: String, name: CharSequence, val importance: Int)

class NotificationManager {
    fun getNotificationChannel(id: String): NotificationChannel? = null
    fun createNotificationChannel(channel: NotificationChannel) {}
}
