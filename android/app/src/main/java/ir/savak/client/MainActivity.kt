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
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { vm.measureNow() }, enabled = !state.measuring) { Text("اندازه‌گیری مسیر") }
                OutlinedButton(onClick = { vm.connect() }) { Text(if (state.connected) "وصل‌شدن دوباره" else "وصل شو") }
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
            "resist" to "مقاوم",
        ).forEach { (id, label) ->
            if (id == current) Button(onClick = { onPick(id) }) { Text(label) }
            else OutlinedButton(onClick = { onPick(id) }) { Text(label) }
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
        rungs = parsed.nodes.first().rungs
        selector = Selector(parsed.minSwitchGainPct, parsed.dwellMs)
        state.value = state.value.copy(
            nodeLabel = parsed.nodes.first().label,
            signature = when {
                verify?.ok == true -> "تأیید شد (${verify.keyId})"
                parsed.signaturePresent -> "کلید مورد اعتماد نیست"
                else -> "بدون امضا"
            },
            mode = parsed.mode,
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
        state.value = state.value.copy(connected = true, selectedRung = rungId)
    }

    private fun applyRung(rungId: String) {
        val rung = rungs.firstOrNull { it.id == rungId } ?: return
        BundleHolder.stage(rungs)
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
