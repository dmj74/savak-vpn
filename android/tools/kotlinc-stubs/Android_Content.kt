package android.content

import android.net.ConnectivityManager

open class Context {
    open val filesDir: java.io.File get() = java.io.File("/tmp/savak-files")
    open val cacheDir: java.io.File get() = java.io.File("/tmp/savak-cache")
    open val assets: android.content.res.AssetManager = android.content.res.AssetManager()
    open fun getDir(name: String, mode: Int): java.io.File = java.io.File("/tmp/savak-$name").apply { mkdirs() }
    open fun <T> getSystemService(type: Class<T>): T? = null
    open fun getSharedPreferences(name: String, mode: Int): SharedPreferences = SharedPreferences()
    open fun startService(intent: Intent): ComponentName? = ComponentName()

    /** Context.getString(int) and its varargs form — used for the notification labels. */
    open fun getString(resId: Int): String = "res:$resId"
    open fun getString(resId: Int, vararg formatArgs: Any?): String = "res:$resId"
    companion object { const val MODE_PRIVATE = 0 }
}

class SharedPreferences {
    fun getBoolean(key: String, def: Boolean): Boolean = def
    fun getString(key: String, def: String?): String? = def
    class Editor {
        fun putBoolean(key: String, value: Boolean): Editor = this
        fun apply() {}
    }
}

/** Android's two real constructors: an action string, or (context, target class). */
class Intent(var action: String? = null) {
    constructor(context: Context, target: Class<*>) : this(null)
    fun setAction(a: String): Intent = apply { action = a }
    fun putExtra(name: String, value: String?): Intent = this
    fun getStringExtra(name: String): String? = null
    companion object { const val ACTION_BOOT_COMPLETED = "android.intent.action.BOOT_COMPLETED" }
}

class ComponentName

abstract class BroadcastReceiver {
    abstract fun onReceive(context: Context, intent: Intent)
    fun goAsync(): PendingResult = PendingResult()
    class PendingResult { fun finish() {} }
}

