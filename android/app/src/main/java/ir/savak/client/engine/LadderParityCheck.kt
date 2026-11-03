// The parity check itself, with no test framework in it.
//
// Why a plain function instead of JUnit assertions only: the same comparison has to run in
// three places — `gradle test`, a bare `kotlinc` invocation without the Android SDK
// (android/tools/typecheck.sh), and any future CI step. Duplicating the logic would mean
// the standalone check could pass while the unit test checks something else.
package ir.savak.client.engine

import org.json.JSONObject

object LadderParityCheck {

    data class Report(val scenarios: Int, val rows: Int, val failures: List<String>) {
        val ok: Boolean get() = failures.isEmpty()
    }

    /**
     * A check that cannot fail is decoration. Perturb one expected score by enough to be a
     * real disagreement and confirm the report says so — run by `tools/typecheck.sh` and by
     * the Gradle unit test, so a future refactor that swallows mismatches (a `runCatching`
     * added around the loop, a tolerance that quietly widens) is caught here and not on a
     * phone in the field.
     */
    fun checkDetectsMutation(text: String): Boolean {
        // Mutate the parsed fixture, not its text: a regex over the raw JSON made this
        // self-test blind to a pretty-printed file (it looked for `"score":0.` in a file that
        // says `"score": 0.`) — precisely the silence a guard like this must not have.
        val doc = JSONObject(text)
        val scenarios = doc.optJSONArray("scenarios") ?: return false
        for (i in 0 until scenarios.length()) {
            val expected = scenarios.optJSONObject(i)?.optJSONArray("expected") ?: continue
            for (k in 0 until expected.length()) {
                val row = expected.optJSONObject(k) ?: continue
                if (!row.has("score")) continue
                val before = row.getDouble("score")
                row.put("score", if (before > 0.5) before - 0.25 else before + 0.25)
                // Re-serialise the whole document so `tolerance` survives the trip.
                return check(doc.toString()).failures.isNotEmpty()
            }
        }
        return false // nothing to perturb: the fixture shape changed, look at it
    }

    fun check(text: String): Report {
        val doc = JSONObject(text)
        val tolerance = doc.optDouble("tolerance", 1e-5)
        val scenarios = doc.getJSONArray("scenarios")
        val failures = ArrayList<String>()
        var rows = 0
        for (i in 0 until scenarios.length()) {
            val sc = scenarios.getJSONObject(i)
            val name = sc.getString("name")
            val expected = sc.getJSONArray("expected")
            rows += expected.length()
            val link = snapshotOf(sc.getJSONObject("link"))
            val samples = sc.optJSONObject("samples")?.let { so ->
                so.keys().asSequence().associateWith { k ->
                    val v = so.getJSONObject(k)
                    Sample(
                        attempts = v.optInt("attempts"),
                        failures = v.optInt("failures"),
                        downMbps = v.optDoubleOrNull("downMbps"),
                        rttMs = v.optDoubleOrNull("rttMs"),
                        jitterMs = v.optDoubleOrNull("jitterMs"),
                    )
                }
            } ?: emptyMap()
            val inputs = HashMap<String, ScoringInputs>()
            val hop = HashMap<String, Int>()
            for (j in 0 until expected.length()) {
                val row = expected.getJSONObject(j)
                val inp = row.getJSONObject("inputs")
                inputs[row.getString("rungId")] = ScoringInputs(
                    evasionApplied = inp.optDouble("evasionApplied", 0.0),
                    canHop = inp.optBoolean("canHop"),
                    naiveQuic = if (inp.has("naiveQuic")) inp.getBoolean("naiveQuic") else null,
                )
                hop[row.getString("rungId")] = if (inp.optBoolean("canHop")) 4 else 0
            }
            val nodeGate = sc.optJSONObject("nodeGate")
            val blocked = HashMap<String, String>()
            if (nodeGate != null) for (k in nodeGate.keys()) blocked[k] = nodeGate.getString(k)
            val got = LadderScore(
                snapshot = link,
                nodeProtocols = LadderTable.ALL.map { it.id }.toSet(),
                mode = sc.getString("mode"),
                pathMtu = sc.getJSONObject("requested").optInt("mtu", 1420),
                tunings = inputs.mapValues { (_, v) -> Tuning(canHop = v.canHop, naiveQuic = v.naiveQuic) },
                hopRanges = hop,
                evasionApplied = inputs.mapValues { it.value.evasionApplied },
                capabilityBlocked = blocked,
            ).rank(samples).filter { it.inLadder }
            // Only in-ladder rows: the engine's fixture is the ladder it would ship, and
            // comparing excluded rungs would compare two different notions of "considered".

            val wantOrder = (0 until expected.length()).map { expected.getJSONObject(it).getString("rungId") }
            if (got.map { it.spec.id } != wantOrder) {
                failures += "$name: order differs — got ${got.map { it.spec.id }} want $wantOrder"
            }
            // Row-by-row comparison happens even when the order differs: the order is a
            // symptom, and printing only that would leave whoever fixes it guessing which
            // part of the score moved.

            for (j in 0 until expected.length()) {
                val want = expected.getJSONObject(j)
                val row = got.first { it.spec.id == want.getString("rungId") }
                val ctx = "$name/${row.spec.id}"
                if (row.feasible != want.getBoolean("feasible")) {
                    failures += "$ctx: feasible=${row.feasible} want ${want.getBoolean("feasible")} (reason: ${row.reason})"
                }
                val wantReason = want.getString("reason")
                if (wantReason.isNotEmpty() && !row.reason.contains(wantReason.take(24))) {
                    failures += "$ctx: reason '${row.reason}' should contain '$wantReason'"
                }
                failures += near(ctx, "score", row.score, want.getDouble("score"), tolerance)
                val parts = want.getJSONObject("parts")
                failures += near(ctx, "throughput", row.parts.throughput, parts.getDouble("throughput"), tolerance)
                failures += near(ctx, "latency", row.parts.latency, parts.getDouble("latency"), tolerance)
                failures += near(ctx, "stability", row.parts.stability, parts.getDouble("stability"), tolerance)
                failures += near(ctx, "evasion", row.parts.evasion, parts.getDouble("evasion"), tolerance)
                failures += near(ctx, "cost", row.parts.cost, parts.getDouble("cost"), tolerance)
            }
        }
        return Report(scenarios.length(), rows, failures.filter { it.isNotEmpty() })
    }

    private fun near(ctx: String, what: String, got: Double, want: Double, tol: Double): String =
        if (kotlin.math.abs(got - want) > tol) "$ctx: $what got $got want $want (Δ ${kotlin.math.abs(got - want)})" else ""

    private fun snapshotOf(o: JSONObject) = LinkSnapshot(
        access = if (o.optString("access") == "cellular") Access.CELLULAR else Access.WIFI,
        rttMs = o.optDoubleOrNull("rttMs"),
        jitterMs = o.optDoubleOrNull("jitterMs"),
        lossPct = o.optDoubleOrNull("lossPct"),
        downMbps = o.optDoubleOrNull("downMbps"),
        upMbps = o.optDoubleOrNull("upMbps"),
        mtuCap = if (o.has("mtuCap")) o.getInt("mtuCap") else null,
        mtu = if (o.has("mtu")) o.getInt("mtu") else null,
        http2Killed = o.optBoolOrNull("http2Killed"),
        wgSignatureBlocked = o.optBoolOrNull("wgSignatureBlocked"),
        ssSaltBlocked = o.optBoolOrNull("ssSaltBlocked"),
        quicRateLimited = o.optBoolOrNull("quicRateLimited"),
        tcpOnly = o.optBoolOrNull("tcpOnly"),
        udpBlocked = o.optBoolOrNull("udpBlocked"),
        quicBlocked = o.optBoolOrNull("quicBlocked"),
        sniFiltered = o.optBoolOrNull("sniFiltered"),
        portThrottled = o.optBoolOrNull("portThrottled"),
        udpThrottled = o.optBoolOrNull("udpThrottled"),
        portBlocked = o.optBoolOrNull("portBlocked"),
        quicFingerprinted = o.optBoolOrNull("quicFingerprinted"),
        bandwidthShaped = o.optBoolOrNull("bandwidthShaped"),
        sizeHeuristic = o.optBoolOrNull("sizeHeuristic"),
        activeProbeSuspected = o.optBoolOrNull("activeProbeSuspected"),
        ipRangeBlocked = o.optBoolOrNull("ipRangeBlocked"),
        bothRadios = o.optBoolean("bothRadios", false),
        source = o.optString("source", "fixture"),
    )

    private fun JSONObject.optDoubleOrNull(key: String): Double? = if (has(key) && !isNull(key)) getDouble(key) else null

    private fun JSONObject.optBoolOrNull(key: String): Boolean? = if (has(key) && !isNull(key)) getBoolean(key) else null
}
