// Data-plane seam.
//
// savak's Kotlin layer decides *which* transport to run and *with what config*; the
// bytes themselves are moved by sing-box. Two backends, one interface:
//
//   • LibBoxBackend      — in-process via the gomobile `libbox` binding (the normal
//                          Android path; no subprocess on Android).
//   • SubprocessBackend  — writes the config and runs the `sing-box` binary, used on
//                          rooted devices / Linux / Android-with-per-package-binary,
//                          and it is the one we can integration-test without a phone.
//
// Both take an *already validated* config document: validation happens once, in the
// engine, at bundle build time (engine/test/schema.test.js), not on the hot path here.
package ir.savak.client.service

import android.content.Context
import java.io.File
import java.util.concurrent.TimeUnit

interface TunnelBackend {
    fun start(config: File, tunMtu: Int): Result
    fun reload(config: File): Result
    fun stop()
    fun setSelectorDefault(selectorTag: String, outboundTag: String): Result
    fun describe(): String

    data class Result(val ok: Boolean, val message: String? = null, val pid: Int? = null)
}

/**
 * libbox path. The entry points below are the ones `experimental/libbox` exports in
 * sing-box 1.14 (`Setup`, `CheckConfig`, `HasTunInbound`, `GetTunnelFileDescriptor`) plus
 * the command channel the service uses (`CommandServer.StartOrReloadService`).
 *
 * NOTE for whoever wires the AAR: the generated class/package names depend on the
 * gomobile build (`-javapkg org.savak.core`), so the calls are funnelled through
 * [LibBoxReflect] rather than hard imports — a rename in the AAR must not silently
 * change which config the phone runs, and reflection fails loudly at startup instead
 * of failing quietly at the first handshake.
 */
class LibBoxBackend(private val context: Context) : TunnelBackend {

    override fun start(config: File, tunMtu: Int): TunnelBackend.Result {
        val text = config.readText()
        // Cheap pre-flight: libbox will refuse this config otherwise, mid-connect.
        val checked = runCatching { LibBoxReflect.checkConfig(text) }
        if (checked.isFailure) return TunnelBackend.Result(false, "config rejected by libbox: ${checked.exceptionOrNull()?.message}")
        val hasTun = runCatching { LibBoxReflect.hasTunInbound(text) }.getOrDefault(true)
        if (hasTun && SavakPlatformBridge.platformInterfaceClass() == null) {
            // The config asks for a TUN and the linked AAR cannot be handed the object that
            // creates one. Starting anyway would mean "running, unprotected, looks connected".
            return TunnelBackend.Result(
                false,
                "libbox exposes no PlatformInterface: the app cannot supply a TUN, so it will not report a tunnel",
            )
        }
        return runCatching {
            LibBoxReflect.startService(context, text, hasTun)
            if (hasTun && !SavakPlatformBridge.tunEstablished) {
                // openTun was never called, or it failed. Either way there is no interface.
                val why = SavakPlatformBridge.lastError ?: "sing-box did not request a TUN from the app"
                return@runCatching TunnelBackend.Result(false, "no tunnel interface: $why")
            }
            TunnelBackend.Result(true, if (hasTun) "tun" else "proxy-only")
        }.getOrElse { TunnelBackend.Result(false, it.message) }
    }

    override fun reload(config: File) = start(config, 0)

    /**
     * Stops the core, and deliberately does *not* close the TUN.
     *
     * Whoever owns the interface owns the routes. Closing the descriptor here would tear the
     * interface down mid-transition — and the instant that happens, every socket on the device
     * is handed back to the carrier network. That is the exact window the guard state exists to
     * avoid, so the fd is released only by `SavakVpnService.stopEverything()`, i.e. when the
     * user (or Android) truly ends the tunnel.
     */
    override fun stop() {
        runCatching { LibBoxReflect.stopService() }
    }

    override fun setSelectorDefault(selectorTag: String, outboundTag: String) =
        runCatching { LibBoxReflect.putProxy(selectorTag, outboundTag) }
            .fold({ TunnelBackend.Result(true) }, { TunnelBackend.Result(false, it.message) })

    override fun describe() = "libbox (in-process)"
}

/**
 * Object-façade over the gomobile binding. Everything that depends on the exact AAR
 * layout lives here and nowhere else.
 */
object LibBoxReflect {
    private const val PKG = "org.savak.core.libbox"

    private fun cls(name: String): Class<*> = Class.forName("$PKG.$name")

    fun checkConfig(json: String) {
        val c = runCatching { cls("Box") }.getOrElse { error("libbox AAR not linked: add the sing-box gomobile library ($PKG.Box)") }
        c.getMethod("checkConfig", String::class.java).invoke(null, json)
    }

    fun hasTunInbound(json: String): Boolean {
        val c = cls("Box")
        return c.getMethod("hasTunInbound", String::class.java).invoke(null, json) as Boolean
    }

    fun setup(context: Context) {
        // Mirrors libbox.SetupOptions: paths the service is allowed to touch + the
        // command channel the UI process uses to talk to the VPN process.
        val o = cls("SetupOptions")
        val opts = o.getDeclaredConstructor().newInstance()
        o.getMethod("setBasePath", String::class.java).invoke(opts, context.filesDir.absolutePath)
        o.getMethod("setWorkingPath", String::class.java).invoke(opts, context.cacheDir.absolutePath)
        o.getMethod("setTempPath", String::class.java).invoke(opts, context.cacheDir.absolutePath)
        o.getMethod("setFixAndroidStack", Boolean::class.javaPrimitiveType).invoke(opts, true)
        cls("Box").getMethod("setup", o).invoke(null, opts)
    }

    fun startService(context: Context, json: String, hasTun: Boolean) {
        setup(context)
        val instance = svcInstance(context)
        val svc = instance.javaClass
        if (hasTun) {
            val platform = SavakPlatformBridge.newPlatformInterface()
                ?: error("no PlatformInterface proxy (no VpnService bound?) — refusing to start without a TUN path")
            val setter = svc.methods.firstOrNull { it.name == "setPlatformInterface" && it.parameterCount == 1 }
                ?: error("the linked libbox Service has no setPlatformInterface(...): the AAR cannot be given a TUN factory")
            setter.invoke(instance, platform)
        }
        svc.getMethod("startOrReloadService", String::class.java).invoke(instance, json)
    }

    fun stopService() {
        runCatching { cls("Service").getMethod("closeService").invoke(null) }
    }

    fun putProxy(name: String, group: String) {
        // Runtime switch: the ladder config carries every feasible rung inside a
        // `selector`, so changing transport is one API call and never a reconnect.
        runCatching { cls("Service").getMethod("putProxy", String::class.java, String::class.java).invoke(null, name, group) }
            .onFailure { error("selector switch unavailable: ${it.message}") }
    }

    fun resetNetwork() {
        runCatching { cls("Service").getMethod("resetNetwork").invoke(null) }
    }

    private fun svcInstance(context: Context): Any =
        cls("Service").getMethod("getInstance", Context::class.java).invoke(null, context)
}

/**
 * Runs the real binary. Testable on a laptop or a rooted device:
 *   sing-box check -C dir && sing-box run -C dir
 * and switches rungs through the Clash-compatible control API, which the engine
 * enables by putting `experimental.clash_api` into the config when asked.
 *
 * Nothing here is `suspend`: every caller already runs on a dedicated thread, and a fake
 * coroutine boundary would only make the module require a dependency it does not use.
 */
class SubprocessBackend(private val workDir: File, private val binary: String = "sing-box") : TunnelBackend {
    private var process: Process? = null

    override fun start(config: File, tunMtu: Int): TunnelBackend.Result {
        val check = exec(listOf(binary, "check", "-D", workDir.absolutePath, "-c", config.absolutePath), 20)
        if (check.code != 0) return TunnelBackend.Result(false, "sing-box check failed: ${check.out.take(800)}")
        val p = ProcessBuilder(binary, "run", "-D", workDir.absolutePath, "-c", config.absolutePath)
            .redirectErrorStream(true)
            .directory(workDir)
            .start()
        process = p
        // A fast death means a capability/permission problem, not a config one — and it is
        // the *only* failure mode a subprocess backend has, so spend 1.5s looking for it.
        val died = p.waitFor(1500, TimeUnit.MILLISECONDS) && p.exitValue() != 0
        return if (died) TunnelBackend.Result(false, "sing-box exited immediately: ${lastOutput(p)}", p.pid().toInt())
        else TunnelBackend.Result(true, "running", p.pid().toInt())
    }

    override fun reload(config: File): TunnelBackend.Result {
        val check = exec(listOf(binary, "check", "-D", workDir.absolutePath, "-c", config.absolutePath), 20)
        if (check.code != 0) return TunnelBackend.Result(false, "refusing to reload an invalid config: ${check.out.take(600)}")
        // SIGHUP makes sing-box re-read the file without dropping the tunnel. (Writing to
        // the process' stdin would do nothing at all — it has no console.)
        val pid = process?.pid() ?: return TunnelBackend.Result(false, "not running")
        exec(listOf("kill", "-HUP", pid.toString()), 5)
        return TunnelBackend.Result(true, "reloaded")
    }

    override fun stop() {
        // Same rule as the libbox path: destroy the core, leave the interface alone. The
        // subprocess is not what owns the TUN on Android — the VpnService is.
        process?.destroy()
        process = null
    }

    override fun setSelectorDefault(selectorTag: String, outboundTag: String): TunnelBackend.Result {
        val port = readPort() ?: return TunnelBackend.Result(false, "clash_api not enabled in this config")
        return runCatching {
            val conn = (java.net.URL("http://127.0.0.1:$port/proxies/$selectorTag").openConnection() as java.net.HttpURLConnection)
            conn.requestMethod = "PUT"
            conn.doOutput = true
            conn.setRequestProperty("content-type", "application/json")
            conn.outputStream.use { it.write("""{"name":"$outboundTag"}""".toByteArray()) }
            val code = conn.responseCode
            TunnelBackend.Result(code in 200..299, if (code in 200..299) null else "HTTP $code")
        }.getOrElse { TunnelBackend.Result(false, it.message) }
    }

    override fun describe() = "sing-box subprocess ($binary)"

    private fun readPort(): Int? = File(workDir, ".savak-api-port").takeIf { it.exists() }?.readText()?.trim()?.toIntOrNull()

    /** Why a process died at once is almost always in its stderr — surface it, don't guess. */
    private fun lastOutput(p: Process): String = runCatching {
        String(p.errorStream.readBytes(), Charsets.UTF_8).take(400)
    }.getOrDefault("")

    private data class Exec(val code: Int, val out: String)

    private fun exec(cmd: List<String>, timeoutSec: Long): Exec {
        val p = ProcessBuilder(cmd).redirectErrorStream(true).start()
        val out = p.inputStream.bufferedReader().readText()
        p.waitFor(timeoutSec, TimeUnit.SECONDS)
        return Exec(if (p.isAlive) { p.destroy(); -1 } else p.exitValue(), out)
    }
}
