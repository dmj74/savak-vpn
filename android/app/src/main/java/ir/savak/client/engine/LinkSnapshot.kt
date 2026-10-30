// The measurement model, in its own file with no Android imports on purpose: the scoring
// code and the parity check must be compilable (and runnable) without the Android SDK —
// see android/tools/typecheck.sh, which does exactly that.
package ir.savak.client.engine

enum class Access { WIFI, CELLULAR, ETHERNET, OTHER, NONE }

data class LinkSnapshot(
    val access: Access,
    val rttMs: Double? = null,
    val jitterMs: Double? = null,
    val lossPct: Double? = null,
    val downMbps: Double? = null,
    val upMbps: Double? = null,
    val mtuCap: Int? = null,
    val udpBlocked: Boolean? = null,
    val quicBlocked: Boolean? = null,
    val sniFiltered: Boolean? = null,
    val portThrottled: Boolean? = null,
    val udpThrottled: Boolean? = null,
    val portBlocked: Boolean? = null,
    val http2Killed: Boolean? = null,
    val wgSignatureBlocked: Boolean? = null,
    val ssSaltBlocked: Boolean? = null,
    val quicRateLimited: Boolean? = null,
    val mtu: Int? = null,
    val tcpOnly: Boolean? = null,
    val quicFingerprinted: Boolean? = null,
    val bandwidthShaped: Boolean? = null,
    val sizeHeuristic: Boolean? = null,
    val activeProbeSuspected: Boolean? = null,
    val ipRangeBlocked: Boolean? = null,
    val bothRadios: Boolean = false,
    val source: String = "measured",
) {
    /** JSON the engine's ranking function understands; `null`s are omitted on purpose. */
    fun toJson(): org.json.JSONObject {
        val o = org.json.JSONObject()
        o.put("source", source)
        o.put("access", if (access == Access.CELLULAR) "cellular" else "wifi")
        rttMs?.let { o.put("rttMs", it) }
        jitterMs?.let { o.put("jitterMs", it) }
        lossPct?.let { o.put("lossPct", it) }
        downMbps?.let { o.put("downMbps", it) }
        upMbps?.let { o.put("upMbps", it) }
        mtuCap?.let { o.put("mtuCap", it) }
        udpBlocked?.let { o.put("udpBlocked", it) }
        quicBlocked?.let { o.put("quicBlocked", it) }
        sniFiltered?.let { o.put("sniFiltered", it) }
        portThrottled?.let { o.put("portThrottled", it) }
        udpThrottled?.let { o.put("udpThrottled", it) }
        portBlocked?.let { o.put("portBlocked", it) }
        http2Killed?.let { o.put("http2Killed", it) }
        wgSignatureBlocked?.let { o.put("wgSignatureBlocked", it) }
        ssSaltBlocked?.let { o.put("ssSaltBlocked", it) }
        quicRateLimited?.let { o.put("quicRateLimited", it) }
        quicFingerprinted?.let { o.put("quicFingerprinted", it) }
        bandwidthShaped?.let { o.put("bandwidthShaped", it) }
        sizeHeuristic?.let { o.put("sizeHeuristic", it) }
        activeProbeSuspected?.let { o.put("activeProbeSuspected", it) }
        ipRangeBlocked?.let { o.put("ipRangeBlocked", it) }
        return o
    }
}
