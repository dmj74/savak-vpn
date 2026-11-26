package ir.savak.client

import android.content.Context
import android.content.Intent
import android.net.VpnService
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import ir.savak.client.engine.Bundle as SavakBundle
import ir.savak.client.engine.LadderScore
import ir.savak.client.engine.LinkMeasurer
import ir.savak.client.engine.LinkSnapshot
import ir.savak.client.engine.Rung
import ir.savak.client.engine.Selector
import ir.savak.client.engine.Tuning
import ir.savak.client.engine.parseBundle
import ir.savak.client.security.ProfileVerifier
import ir.savak.client.service.BundleHolder
import ir.savak.client.service.SavakVpnService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject

data class RankedRow(val id: String, val title: String, val feasible: Boolean, val reason: String, val score: Double, val notes: List<String>)

data class UiState(
    val measuring: Boolean = false,
    val connected: Boolean = false,
    val selectedRung: String? = null,
    val mode: String = "auto",
    val ranked: List<RankedRow> = emptyList(),
    val linkLine: String = "",
    val error: String? = null,
    val nodeLabel: String = "",
    val signature: String = "",
    val pinnedRung: String? = null,
    /** Asked for, not proven: the tunnel is only up when the service says the TUN exists. */
    val starting: Boolean = false,
    val guardActive: Boolean = false,
    val killSwitch: Boolean = true,
    val splitApps: Int = 0,
    /** What the signed profile asked for, shown next to the switch so a local "off" is a
     *  decision the user can see they made, not a drift nobody noticed. */
    val profileWantsKillSwitch: Boolean = false,
)

/**
 * One screen. Everything a user can touch changes the *policy*, never the protocol
 * parameters: the ladder and the scoring live in the engine, and a control here only
 * moves weights that engine already understands and has validated.
 */
class MainActivity : ComponentActivity() {

    private lateinit var vm: SavakViewModel

    private val consent = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == RESULT_OK) vm.startTunnel() else vm.reportError("دسترسی VPN داده نشد")
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        vm = SavakViewModel(applicationContext)
        vm.onRequestStart = {
            val prepare = VpnService.prepare(this, SavakVpnService::class.java)
            if (prepare == null) vm.startTunnel() else consent.launch(prepare)
        }
        setContent { MaterialTheme { SavakApp(vm) } }
        vm.start()
    }

    override fun onDestroy() {
        vm.shutdown()
        super.onDestroy()
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SavakApp(vm: SavakViewModel) {
    val state by vm.state.collectAsState()
    Scaffold(topBar = { TopAppBar(title = { Text("savak · پروکسی هوشمند") }) }) { pad ->
        Column(
            modifier = Modifier.fillMaxSize().padding(pad).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            horizontalAlignment = Alignment.Start,
        ) {
            StatusCard(state)
            ModePicker(state.mode) { vm.setMode(it) }
            TunnelControlsCard(state) { vm.toggleKillSwitch() }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { vm.measureNow() }, enabled = !state.measuring) { Text("اندازه‌گیری مسیر") }
                OutlinedButton(onClick = { vm.connect() }) {
                    Text(if (state.starting) "در حال برقراری…" else if (state.connected) "وصل‌شدن دوباره" else "وصل شو")
                }
                if (state.pinnedRung != null) OutlinedButton(onClick = { vm.unpin() }) { Text("حذف انتخاب دستی") }
            }
            Text("نردبان پروتکل", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(state.ranked) { row -> RungCard(row, state, enabled = row.feasible) { vm.pin(row.id) } }
            }
            if (state.measuring) LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
        }
    }
}

@Composable
private fun StatusCard(state: UiState) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(
                if (state.connected) "اتصال: فعال · ${state.selectedRung ?: "-"}" else "اتصال: قطع",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
            )
            if (state.guardActive) {
                Text(
                    "محافظت فعال: تونل از دست رفته و ترافیک عمداً مسدود است — تا وقتی اتصال دوباره برقرار نشود باز نمی‌شود",
                    color = MaterialTheme.colorScheme.error,
                )
            }
            if (state.starting && !state.connected) Text("در حال برقراری تونل…", style = MaterialTheme.typography.bodySmall)
            if (state.nodeLabel.isNotEmpty()) Text("گره: ${state.nodeLabel} · امضا: ${state.signature}")
            if (state.linkLine.isNotEmpty()) Text(state.linkLine, style = MaterialTheme.typography.bodySmall)
            state.error?.let { Text("خطا: $it", color = MaterialTheme.colorScheme.error) }
        }
    }
}

@Composable
private fun ModePicker(current: String, onPick: (String) -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        listOf(
            "auto" to "خودکار",
            "speed" to "سرعت",
            "stealth" to "پنهان‌کاری",
            "game" to "گیم",
            // «روزمره»: the mode a person leaves on all day. Offered because the engine
            // actually scores differently in it (bigger hysteresis, fewer probes, tighter
            // dial timeouts) — a chip that only changed a label would be a lie.
            "daily" to "روزمره",
            "resist" to "مقاوم",
        ).forEach { (id, label) ->
            if (id == current) Button(onClick = { onPick(id) }) { Text(label) }
            else OutlinedButton(onClick = { onPick(id) }) { Text(label) }
        }
    }
}

/**
 * Kill switch + split tunneling, on the same screen as the connection state: a control that
 * can be silently off is indistinguishable from one that never worked. The switch writes
 * [TunnelPrefs] and the service reads that same object, so there is exactly one answer to
 * "is the guard armed?" — see service/TunnelPrefs.kt for why that has to be one file.
 */
@Composable
private fun TunnelControlsCard(state: UiState, onToggleKillSwitch: () -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Switch(checked = state.killSwitch, onCheckedChange = { onToggleKillSwitch() })
                Text("کلید قطع اتصال", fontWeight = FontWeight.Bold)
            }
            Text(
                if (state.killSwitch) "با رفتن تونل، ترافیک مسدود می‌ماند (نشتی ندارد)"
                else "با رفتن تونل، ترافیک مستقیم از اپراتور می‌رود",
                style = MaterialTheme.typography.bodySmall,
            )
            if (state.splitApps > 0) {
                Text("${state.splitApps} برنامه بیرون از تونل نگه داشته می‌شوند", style = MaterialTheme.typography.bodySmall)
            }
            if (!state.killSwitch && state.profileWantsKillSwitch) {
                Text("پروفایل این محافظت را خواسته بود؛ خاموش‌کردنش انتخاب خودتان است", style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable
private fun RungCard(row: RankedRow, state: UiState, enabled: Boolean, onClick: () -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            val isActive = state.selectedRung == row.id
            Text(row.title + (if (isActive) "   ●" else ""), fontWeight = FontWeight.Bold)
            Text(
                "امتیاز ${(row.score * 100).toInt()}" + if (row.feasible) "" else " · غیرقابل استفاده: ${row.reason}",
                style = MaterialTheme.typography.bodySmall,
            )
            row.notes.take(3).forEach { Text("· $it", style = MaterialTheme.typography.bodySmall) }
            OutlinedButton(onClick = onClick, enabled = enabled) {
                Text(if (state.pinnedRung == row.id) "دستی: فعال" else if (isActive) "انتخاب خودکار" else "همین را استفاده کن")
            }
        }
    }
}

/**
 * Holds the bundle, runs the measurement loop, and decides when to switch. The switching
 * rule itself is [Selector] — a port of the engine's hysteresis — so the app cannot
 * thrash between transports on noise.
 */
class SavakViewModel(private val context: Context) {

    companion object {
        /** Same prefs file as BootReceiver — one name, or the persisted mode is unread. */
        private const val PREFS = "savak"

        /** Mode names the engine knows (must match engine/src/tune.js POLICIES keys). */
        val KNOWN_MODES = setOf("auto", "speed", "stealth", "game", "daily", "resist")
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val io = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val measurer = LinkMeasurer(context)

    val state = MutableStateFlow(UiState())
    var onRequestStart: (() -> Unit)? = null

    private var bundle: SavakBundle? = null
    private var selector: Selector? = null
    private var snapshot: LinkSnapshot? = null
    private var pinned: String? = null
    private var rungs: List<Rung> = emptyList()

    val mtu: Int get() = 1400

    init {
        loadBundle()
    }

    private fun loadBundle() {
        val assets = context.assets
        val text = assets.readOrNull("bundle.json")
        if (text == null) {
            state.value = state.value.copy(error = "باندل موجود نیست: با «savak bundle» بسازید و در assets/app/src/main/assets/bundle.json بگذارید")
            return
        }
        val parsed = runCatching { parseBundle(text) }.getOrElse {
            state.value = state.value.copy(error = "باندل نامعتبر: ${it.message}")
            return
        }
        // A bundle without a valid signature from a trusted key is refused outright:
        // this document decides where every packet goes.
        val profileJson = assets.readOrNull("profile.json")?.let { runCatching { JSONObject(it) }.getOrNull() }
        val verify = profileJson?.optJSONObject("signature")?.let {
            ProfileVerifier.verify(profileJson, TrustedKeys.map)
        }
        if (verify != null && !verify.ok) {
            state.value = state.value.copy(error = "امضای پروفایل رد شد: ${verify.reason}")
            return
        }
        bundle = parsed
        // The signed bundle decides which modes exist at all (policy.mode is what the engine
        // scored with); a locally persisted mode may only be applied when the bundle agrees.
        val saved = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("mode", null)
        rungs = parsed.nodes.first().rungs
        selector = Selector(parsed.minSwitchGainPct, parsed.dwellMs)
        syncControls()
        state.value = state.value.copy(
            nodeLabel = parsed.nodes.first().label,
            signature = when {
                verify?.ok == true -> "تأیید شد (${verify.keyId})"
                parsed.signaturePresent -> "کلید مورد اعتماد نیست"
                else -> "بدون امضا"
            },
            mode = saved?.takeIf { it in KNOWN_MODES } ?: parsed.mode,
            selectedRung = parsed.nodes.first().preferredRung,
        )
    }

    fun start() {
        scope.launch {
            while (isActive) {
                measureNow()
                delay(30_000)
            }
        }
    }

    fun shutdown() {
        scope.cancel()
        io.cancel()
    }

    fun setMode(mode: String) {
        state.value = state.value.copy(mode = mode)
        // Persisted in the file BootReceiver reads: without this the chosen mode is a
        // session-only decoration and the boot-time cold start picks a rung for a mode
        // the user stopped using days ago.
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("mode", mode).apply()
        refreshRanking()
    }

    fun pin(rungId: String) {
        pinned = rungId
        state.value = state.value.copy(pinnedRung = rungId)
        applyRung(rungId)
    }

    fun unpin() {
        pinned = null
        state.value = state.value.copy(pinnedRung = null)
        refreshRanking()
    }

    fun reportError(message: String) {
        state.value = state.value.copy(error = message)
    }

    fun connect() {
        onRequestStart?.invoke() ?: startTunnel()
    }

    fun startTunnel() {
        val rungId = pinned ?: bundle?.nodes?.firstOrNull()?.preferredRung ?: return
        BundleHolder.mtu = mtu
        applyRung(rungId)
        context.startService(Intent(context, SavakVpnService::class.java).setAction(SavakVpnService.ACTION_START))
        // `connected` is not set here, on purpose. The service is the only thing that knows
        // whether a TUN descriptor exists, and an app that paints itself green before that
        // answer arrives is exactly how a VPN ends up saying "connected" over a clear link.
        state.value = state.value.copy(starting = true, connected = false, selectedRung = rungId, error = null)
        awaitTunnel()
    }

    /** Poll the service until it reports a state, then stop looking. Bounded by design: a
     *  tunnel that never comes up must end in a visible error, not an endless spinner. */
    private fun awaitTunnel() {
        scope.launch {
            repeat(30) {
                val running = SavakVpnService.running
                val guard = SavakVpnService.guardActive
                if (running || guard || BundleHolder.lastError != null) {
                    state.value = state.value.copy(
                        starting = false,
                        connected = running,
                        guardActive = guard,
                        error = if (running) null else BundleHolder.lastError,
                    )
                    return@launch
                }
                delay(700)
            }
            state.value = state.value.copy(starting = false, connected = false, error = BundleHolder.lastError ?: "تونل برقرار نشد")
        }
    }

    fun toggleKillSwitch() {
        val prefs = ir.savak.client.service.TunnelPrefs.of(context)
        prefs.setKillSwitch(!prefs.killSwitchEnabled())
        syncControls()
        // Turning it off while the tunnel is up is the moment the guarantee disappears: say what
        // changes instead of quietly flipping a bit.
        if (!prefs.killSwitchEnabled() && bundle?.nodes?.firstOrNull()?.guard != null) {
            state.value = state.value.copy(error = "کلید قطع خاموش شد: از این پس با قطع تونل، ترافیک مستقیم می‌رود")
        }
    }

    fun syncControls() {
        val prefs = ir.savak.client.service.TunnelPrefs.of(context)
        state.value = state.value.copy(
            killSwitch = prefs.killSwitchEnabled(),
            splitApps = prefs.splitApps().size,
            profileWantsKillSwitch = bundle?.killSwitch == true,
        )
    }

    private fun applyRung(rungId: String) {
        val rung = rungs.firstOrNull { it.id == rungId } ?: return
        val node = bundle?.nodes?.firstOrNull()
        BundleHolder.stage(rungs, guard = node?.guard, preferred = node?.preferredRung, profileLabel = bundle?.profileName)
        BundleHolder.wantsTun = true
        if (SavakVpnService.running) {
            context.startService(
                Intent(context, SavakVpnService::class.java)
                    .setAction(SavakVpnService.ACTION_SWITCH)
                    .putExtra(SavakVpnService.EXTRA_TAG, "savak-$rungId"),
            )
        }
        state.value = state.value.copy(selectedRung = rungId, error = BundleHolder.lastError)
    }

    fun measureNow() {
        val node = bundle?.nodes?.firstOrNull() ?: return
        state.value = state.value.copy(measuring = true)
        io.launch {
            val snap = runCatching {
                measurer.snapshot(node.address, intArrayOf(443, 8443, 2053, 2087), probeUdpPort = 20125, probeTcpPort = 20126)
            }.getOrElse {
                // Never fail closed on a measurement error: fall back to "unknown link"
                // so the engine's priors choose, rather than the app choosing nothing.
                LinkSnapshot(access = measurer.access(), source = "degraded")
            }
            snapshot = snap
            val mtuSeen = snap.mtuCap?.let { it - 80 } ?: mtu
            BundleHolder.mtu = mtuSeen
            state.value = state.value.copy(
                measuring = false,
                linkLine = "مسیر: ${accessLabel(snap.access)} · RTT ${snap.rttMs.fmt("ms")} · " +
                    "پایین‌رونده ${snap.downMbps.fmt("Mb/s")} · افت ${snap.lossPct.fmt("%")?.let { "$it٪" }} · " +
                    "UDP ${if (snap.udpBlocked == true) "مسدود" else "سالم"} · MTU ${mtuSeen}",
                error = BundleHolder.lastError,
            )
            refreshRanking()
        }
    }

    private fun accessLabel(a: ir.savak.client.engine.Access) = when (a) {
        ir.savak.client.engine.Access.WIFI -> "وای‌فای"
        ir.savak.client.engine.Access.CELLULAR -> "همراه"
        ir.savak.client.engine.Access.ETHERNET -> "شبکه سیمی"
        else -> "نامشخص"
    }

    private fun Double?.fmt(unit: String): String = this?.let { "${"%.0f".format(it)}$unit" } ?: "-"

    private fun refreshRanking() {
        val b = bundle ?: return
        val node = b.nodes.first()
        val snap = snapshot ?: LinkSnapshot(measurer.access(), source = "assumed")
        val scoring = LadderScore(
            snapshot = snap,
            nodeProtocols = node.rungs.map { it.id }.toSet(),
            mode = state.value.mode,
            pathMtu = BundleHolder.mtu + 80,
        )
        val ranked = scoring.rank(selector?.samples() ?: emptyMap())
        state.value = state.value.copy(
            ranked = ranked.map { r ->
                RankedRow(
                    id = r.spec.id,
                    title = r.spec.title,
                    feasible = r.feasible,
                    reason = r.reason,
                    score = r.score,
                    notes = node.rungs.firstOrNull { it.id == r.spec.id }?.tuning?.notes?.map { it.second } ?: emptyList(),
                )
            },
        )
        val sel = selector ?: return
        if (pinned != null) return
        val decision = runCatching { sel.decide(ranked) }.getOrNull() ?: return
        if (decision.switched) applyRung(decision.pick)
    }
}

private fun android.content.res.AssetManager.readOrNull(name: String): String? =
    runCatching { open(name).bufferedReader().use { it.readText() } }.getOrNull()

/**
 * Trust anchors, compiled in. Generated by `node src/cli.js init` (see android/README.md);
 * an empty map means every profile is refused, which is the safe default.
 */
private object TrustedKeys {
    val map: Map<String, String> = emptyMap()
}
