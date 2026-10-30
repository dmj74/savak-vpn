// Port of engine/src/score.js scoring, using the GENERATED LadderTable.
//
// The phone re-ranks between check-ins so it can switch transports without waiting for
// the server; that only helps if the ranking matches what the desktop engine would have
// said. Two things enforce that: the constants are generated from the engine, and
// LadderParityTest compares against a fixture produced by `npm run golden`
// (engine/tools/golden.mjs) on the same link scenarios.
package ir.savak.client.engine

import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

internal fun clamp(v: Double, lo: Double = 0.0, hi: Double = 1.0): Double = v.coerceIn(lo, hi)

/** Reno's √p throughput bound, softened by how much loss the transport absorbs itself. */
internal fun lossEfficiency(lossPct: Double?, tolerance: Double?): Double {
    val p = clamp((lossPct ?: 0.0) / 100.0, 0.0, 0.3)
    val rel = if (p <= 0.0015) 1.0 else clamp(sqrt(0.0015 / p), 0.05, 1.0)
    return clamp(1.0 - (1.0 - rel) * (1.0 - clamp(tolerance ?: 0.5)), 0.05, 1.0)
}

data class Sample(val attempts: Int = 0, val failures: Int = 0, val downMbps: Double? = null, val rttMs: Double? = null, val jitterMs: Double? = null)

data class Parts(
    val throughput: Double,
    val latency: Double,
    val stability: Double,
    val evasion: Double,
    val cost: Double,
    val modelledMbps: Double,
)

data class Tuning(val canHop: Boolean = false, val naiveQuic: Boolean? = null)

private fun effectiveAffinity(spec: RungSpec, link: LinkSnapshot, tuning: Tuning): Affinity {
    val a = spec.affinity
    if (spec.id == "naive_h3") {
        return if (tuning.naiveQuic == false) {
            a.copy(loss = 0.45, dpiQuic = 1.0, udpQos = 1.0, tcpOnly = 1.0, shaping = 0.7)
        } else {
            a.copy(tcpOnly = 0.0)
        }
    }
    return a
}

/** Mirrors `scoreParts()` exactly — keep the operation order identical if you touch it. */
internal fun scoreParts(spec: RungSpec, sample: Sample?, link: LinkSnapshot, tuning: Tuning, evasionApplied: Double = 0.0): Parts {
    val a = effectiveAffinity(spec, link, tuning)
    val loss = link.lossPct ?: 0.0
    val rtt = link.rttMs ?: 60.0
    val capacity = link.downMbps ?: 40.0

    var factor = (1.0 - spec.cost.overheadPct) * lossEfficiency(loss, a.loss)
    if (link.bandwidthShaped == true || link.sizeHeuristic == true) factor *= 0.4 + 0.6 * a.shaping
    if (link.udpThrottled == true && !tuning.canHop) {
        if (spec.family == Family.QUIC) factor *= 0.45
        else if (spec.family == Family.RAW_UDP) factor *= 0.35
    }
    if (spec.id == "wg_uot" && loss < 1.5) factor *= 1.06
    val modelled = capacity * factor
    val throughputRaw = sample?.downMbps ?: modelled
    val throughput = clamp(throughputRaw / max(capacity, 1.0))

    val rttTotal = (sample?.rttMs ?: rtt) + spec.cost.rttCostMs * rtt * 0.5 + (sample?.jitterMs ?: 0.0) * 0.5
    val latency = clamp(exp(-rttTotal / 90.0))

    val failRate = clamp((sample?.failures ?: 0).toDouble() / max(1, sample?.attempts ?: 1))
    val stability = clamp(
        (1.0 - clamp(loss / 12.0)) * (1.0 - clamp((sample?.jitterMs ?: 0.0) / 80.0)) * (1.0 - 0.8 * failRate) + a.udpQos * 0.08,
    )

    val observed = ArrayList<Double>()
    if (link.sniFiltered == true) observed.add(a.dpiSni)
    if (link.quicFingerprinted == true || link.quicBlocked == true) observed.add(a.dpiQuic)
    if (link.sizeHeuristic == true) observed.add(a.shaping)
    if (link.activeProbeSuspected == true) observed.add(a.activeProbe)
    if (link.portThrottled == true || link.portBlocked == true) observed.add(a.udpQos)
    if (link.tcpOnly == true) observed.add(a.tcpOnly)
    if (link.ipRangeBlocked == true) observed.add(a.ipBlocked)
    if (link.bandwidthShaped == true) observed.add(a.shaping)
    val evasionBase = if (observed.isEmpty()) clamp((a.dpiSni + a.dpiQuic + a.activeProbe) / 3.0) else observed.average()
    val evasion = clamp(evasionBase + evasionApplied * 0.12)

    val batteryCost = if (link.access == Access.CELLULAR) 0.5 else 0.25
    val cost = clamp(
        1.0 - (spec.cost.cpuLoad * 0.5 + spec.cost.overheadPct * 1.6 + batteryCost * if (spec.family == Family.QUIC) 0.25 else 0.05),
    )
    return Parts(throughput, latency, stability, evasion, cost, modelled)
}

data class Ranked(
    val spec: RungSpec,
    val inLadder: Boolean,
    val feasible: Boolean,
    val reason: String,
    val score: Double,
    val parts: Parts,
    val raw: Double = 0.0,
    val explore: Double = 0.0,
)

class Gate(val ok: Boolean, val reason: String, val evasionApplied: Double = 0.0)

/**
 * The hard gates, before any scoring. The reason strings and their order mirror
 * `feasibility()` in engine/src/score.js verbatim — including which check wins when two
 * apply, because a *different reason for the same verdict* is enough to make the parity
 * check lie about the port.
 *
 * `blocked` is the capability-side verdict the bundle shipped (no TLS listener, no CDN
 * fronting, legacy interop off): the device cannot re-derive those, so it must not guess.
 */
internal fun gate(
    spec: RungSpec,
    link: LinkSnapshot,
    mtu: Int,
    mode: String,
    advertised: Boolean,
    blocked: String?,
    evasionApplied: Double = -1.0,
): Gate {
    fun reject(why: String) = Gate(false, why)
    if (!advertised) return reject("node does not advertise ${'$'}{spec.id}")
    if (spec.requiresUdp && link.udpBlocked == true) return reject("UDP is blocked on this path")
    if (spec.requiresQuic && link.quicBlocked == true) return reject("QUIC/UDP-443 is being dropped")
    if (spec.id == "vless_ws_cdn" && link.http2Killed == true) return reject("HTTP/2 transports are being reset")
    if (blocked != null) return reject(blocked)
    val floor = spec.minMtu ?: 0
    if (floor > 0 && mtu > 0 && mtu < floor) return reject("needs MTU ≥ ${'$'}floor, path gives ${'$'}mtu")
    if (spec.id == "wg_uot" && link.wgSignatureBlocked == true) return reject("WireGuard packet pattern is being dropped")
    if (spec.id == "ss2022" && link.ssSaltBlocked == true) return reject("AEAD salt length is being matched")
    if (spec.family == Family.QUIC && link.quicRateLimited == true && mode == "game") {
        return reject("QUIC is being rate-limited; latency goals unreachable here")
    }
    val applied = if (evasionApplied >= 0.0) evasionApplied else 0.0
    return Gate(true, "", applied)
}

class LadderScore(
    private val snapshot: LinkSnapshot,
    private val nodeProtocols: Set<String>,
    private val mode: String = "auto",
    private val pathMtu: Int = 1420,
    private val tunings: Map<String, Tuning> = emptyMap(),
    private val hopRanges: Map<String, Int> = emptyMap(),
    private val evasionApplied: Map<String, Double> = emptyMap(),
    private val capabilityBlocked: Map<String, String> = emptyMap(),
) {
    private val weights = LadderTable.WEIGHTS[mode] ?: LadderTable.WEIGHTS.getValue("auto")
    private val allow = LadderTable.MODE_ALLOW[mode] ?: LadderTable.MODE_ALLOW.getValue("auto")

    fun rank(samples: Map<String, Sample>, history: Map<String, Double> = emptyMap()): List<Ranked> {
        val totalPulls = samples.values.sumOf { it.attempts }
        return LadderTable.ALL.map { spec ->
            val inLadder = spec.id in allow
            val g = gate(
                spec = spec,
                link = snapshot,
                mtu = pathMtu,
                mode = mode,
                advertised = spec.id in nodeProtocols,
                blocked = capabilityBlocked[spec.id],
                evasionApplied = evasionApplied[spec.id] ?: -1.0,
            )
            val sample = samples[spec.id]
            val tuning = tunings[spec.id] ?: Tuning(canHop = (hopRanges[spec.id] ?: 0) > 1)
            val parts = scoreParts(spec, sample, snapshot, tuning, g.evasionApplied)
            val w = weights
            val base = w.getOrElse(0) { 0.0 } * parts.throughput + w.getOrElse(1) { 0.0 } * parts.latency +
                w.getOrElse(2) { 0.0 } * parts.stability + w.getOrElse(3) { 0.0 } * parts.evasion +
                w.getOrElse(4) { 0.0 } * parts.cost
            val pulls = sample?.attempts ?: 0
            val explore = if (inLadder && g.ok && pulls < 6 && totalPulls > 0) 0.06 * sqrt(ln(totalPulls + 2.0) / (pulls + 1)) else 0.0
            val score = clamp(base + explore - (history[spec.id] ?: 0.0), 0.0, 1.2)
            Ranked(
                spec = spec,
                inLadder = inLadder,
                feasible = g.ok && inLadder,
                reason = if (!g.ok) g.reason else if (!inLadder) "excluded by policy mode" else "",
                score = score,
                parts = parts,
                raw = base,
                explore = explore,
            )
        }.sortedByDescending { it.score }
    }
}

/**
 * Hysteresis port of AdaptiveSelector: dwell, minimum gain, two confirming samples,
 * exponential cooldown. Without it the app re-handshakes on every jitter spike, which
 * users experience as "the VPN keeps dropping".
 */
class Selector(
    private val minSwitchGainPct: Double,
    private val dwellMs: Long,
    private val now: () -> Long = System::currentTimeMillis,
) {
    var current: String? = null
        private set

    private var since = 0L
    private var pendingId: String? = null
    private var pendingHits = 0

    private class State {
        var failures = 0
        var attempts = 0
        var cooldownUntil = 0L
        var penalty = 0.0
    }

    private val states = HashMap<String, State>()

    fun observe(rungId: String, ok: Boolean) {
        val st = states.getOrPut(rungId) { State() }
        st.attempts++
        if (ok) {
            st.failures /= 2
            st.cooldownUntil = 0
            st.penalty = max(0.0, st.penalty - 0.05)
        } else {
            st.failures++
            if (st.failures >= 2) {
                st.cooldownUntil = now() + min(15L * 60_000L, 5_000L * (1L shl min(st.failures - 2, 8)))
                st.penalty = min(0.12 * st.failures, 0.5)
            }
        }
    }

    fun samples(): Map<String, Sample> = states.mapValues { Sample(it.value.attempts, it.value.failures) }

    fun penalties(): Map<String, Double> = states.mapValues { it.value.penalty }

    data class Decision(val pick: String, val switched: Boolean, val gainPct: Double, val why: String)

    fun decide(rankedIn: List<Ranked>): Decision {
        val t = now()
        val pen = penalties()
        val ranked = rankedIn
            .map { it.copy(score = clamp(it.score - (pen[it.spec.id] ?: 0.0), 0.0, 1.2)) }
            .sortedByDescending { it.score }
        val best = ranked.firstOrNull { it.feasible } ?: error("ladder-empty: nothing feasible on this link")
        val incumbent = current?.let { id -> ranked.firstOrNull { it.spec.id == id } }
        val blocked = incumbent != null && (states[incumbent.spec.id]?.cooldownUntil ?: 0L) > t

        if (incumbent == null || blocked || !incumbent.feasible) {
            val switched = current != null && current != best.spec.id
            current = best.spec.id
            since = t
            pendingId = null
            pendingHits = 0
            val why = when {
                incumbent == null -> "cold start: best feasible rung"
                blocked -> "incumbent is in cooldown"
                else -> "incumbent became infeasible"
            }
            return Decision(best.spec.id, switched, if (incumbent == null) 100.0 else gain(best.score, incumbent.score), why)
        }
        val g = gain(best.score, incumbent.score)
        if (g < minSwitchGainPct) {
            pendingId = null
            pendingHits = 0
            return Decision(incumbent.spec.id, false, g, "within ${minSwitchGainPct}% of the incumbent — a switch would cost a handshake for nothing")
        }
        if (t - since < dwellMs) return Decision(incumbent.spec.id, false, g, "dwell timer (${dwellMs / 1000}s) not expired")
        if (pendingId != best.spec.id) {
            pendingId = best.spec.id
            pendingHits = 1
            return Decision(incumbent.spec.id, false, g, "${best.spec.id} leads by $g% but needs a second confirming sample")
        }
        pendingHits++
        if (pendingHits < 2) return Decision(incumbent.spec.id, false, g, "awaiting confirmation")
        pendingId = null
        pendingHits = 0
        current = best.spec.id
        since = t
        return Decision(best.spec.id, true, g, "sustained $g% win over ${incumbent.spec.id}")
    }

    private fun gain(a: Double, b: Double): Double = if (b <= 0.0) 100.0 else ((a - b) / b * 100.0 * 10.0).toLong() / 10.0
}
