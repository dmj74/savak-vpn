// Bundle model: the phone consumes what `savak bundle` produced.
//
// Deliberately thin. The device does NOT generate sing-box configs: it selects among
// pre-rendered, pre-validated, signed ones. Keeping the config grammar on one side of
// the boundary means an app update can never introduce a half-supported key.
package ir.savak.client.engine

import org.json.JSONArray
import org.json.JSONObject

data class RungTuning(
    val id: String,
    val notes: List<Pair<String, String>>,
    val flags: List<Pair<String, String>>,
    val downMbps: Int?,
    val upMbps: Int?,
    val hopRanges: List<String>,
)

data class Rung(
    val id: String,
    val config: JSONObject,
    val tuning: RungTuning?,
)

data class Node(
    val id: String,
    val label: String,
    val address: String,
    val region: String,
    val preferredRung: String,
    val rungs: List<Rung>,
    val ranking: List<RankRow>,
    val warnings: List<String>,
    /** Per-rung scorer inputs echoed by the engine (see engine/src/bundle.js). */
    val scoringInputs: Map<String, ScoringInputs> = emptyMap(),
)

data class ScoringInputs(val evasionApplied: Double, val canHop: Boolean, val naiveQuic: Boolean?)

data class RankRow(val rungId: String, val feasible: Boolean, val score: Double, val reason: String)

data class Bundle(
    val profileId: String,
    val issuer: String,
    val user: String,
    val mode: String,
    val minSwitchGainPct: Int,
    val dwellMs: Long,
    val nodes: List<Node>,
    val signaturePresent: Boolean,
) {
    fun node(id: String?): Node = nodes.firstOrNull { it.id == id } ?: nodes.first()
}

fun parseBundle(text: String): Bundle {
    val o = JSONObject(text)
    val nodes = mutableListOf<Node>()
    val arr: JSONArray = o.optJSONArray("nodes") ?: JSONArray()
    for (i in 0 until arr.length()) {
        val n = arr.getJSONObject(i)
        val configs = n.getJSONObject("configs")
        val allowed = n.optJSONArray("allowedRungs") ?: JSONArray()
        val tuningObj = n.optJSONObject("tuning") ?: JSONObject()
        val rungs = mutableListOf<Rung>()
        for (j in 0 until allowed.length()) {
            val id = allowed.getString(j)
            val cfg = configs.optJSONObject(id) ?: continue
            rungs += Rung(id, cfg, tuningObj.optJSONObject(id)?.let { parseTuning(id, it) })
        }
        val ranking = mutableListOf<RankRow>()
        n.optJSONArray("ranking")?.let { ra ->
            for (k in 0 until ra.length()) {
                val r = ra.getJSONObject(k)
                ranking += RankRow(r.getString("rungId"), r.optBoolean("feasible"), r.optDouble("score"), r.optString("reason"))
            }
        }
        val inputsObj = n.optJSONObject("scoringInputs") ?: JSONObject()
        val inputs = HashMap<String, ScoringInputs>()
        for (k in inputsObj.keys()) {
            val v = inputsObj.getJSONObject(k)
            inputs[k] = ScoringInputs(v.optDouble("evasionApplied", 0.0), v.optBoolean("canHop"), if (v.has("naiveQuic")) v.getBoolean("naiveQuic") else null)
        }
        nodes += Node(
            id = n.getString("id"),
            label = n.optString("label", n.getString("id")),
            address = n.getString("address"),
            region = n.optString("region", ""),
            preferredRung = n.optString("preferredRung", rungs.firstOrNull()?.id ?: ""),
            rungs = rungs,
            ranking = ranking,
            warnings = n.optJSONArray("warnings").let { w ->
                if (w == null) emptyList() else (0 until w.length()).map { w.getString(it) }
            },
            scoringInputs = inputs,
        )
    }
    val policy = o.optJSONObject("policy") ?: JSONObject()
    return Bundle(
        profileId = o.optString("profileId"),
        issuer = o.optString("issuer", ""),
        user = o.optString("user", ""),
        mode = policy.optString("mode", "auto"),
        minSwitchGainPct = policy.optInt("minSwitchGainPct", 15),
        dwellMs = policy.optLong("dwellMs", 45_000L),
        nodes = nodes,
        signaturePresent = o.optJSONObject("signature") != null,
    )
}

private fun parseTuning(id: String, o: JSONObject): RungTuning {
    fun pairs(a: JSONArray?): List<Pair<String, String>> =
        if (a == null) emptyList() else (0 until a.length()).map {
            val x = a.getJSONObject(it)
            x.optString("key", x.optString("flag")) to x.optString("why", x.optString("note"))
        }
    val bw = o.optJSONObject("bandwidth")
    val hop = o.optJSONObject("hop")?.optJSONArray("server_ports")
    return RungTuning(
        id = id,
        notes = pairs(o.optJSONArray("notes")),
        flags = pairs(o.optJSONArray("flags")),
        downMbps = bw?.optInt("downMbps")?.takeIf { it > 0 },
        upMbps = bw?.optInt("upMbps")?.takeIf { it > 0 },
        hopRanges = hop?.let { (0 until it.length()).map { i -> it.getString(i) } } ?: emptyList(),
    )
}
