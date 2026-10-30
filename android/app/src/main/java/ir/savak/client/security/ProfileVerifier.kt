// Trust: a savak bundle is a remote instruction that says "send every packet here".
// Whoever can push a config can read the traffic, so the document is signed and the
// verification keys are compiled into the APK — not fetched, not user-editable, and not
// part of the signed payload (that would let a signer revoke its own verifier).
package ir.savak.client.security

import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.X509EncodedKeySpec

object ProfileVerifier {

    /**
     * Canonical JSON, byte-identical to engine/src/profile.js `canonicalJson()`:
     * sorted object keys, insertion order for arrays, and floats rendered the way
     * JavaScript's Number does it for the values a profile actually contains (integers
     * and short decimals). A divergence here reads as a signature failure on every
     * device, which is the worst possible bug to discover in the field.
     */
    fun canonical(node: Any?): String = when (node) {
        null -> "null"
        is JSONObject -> {
            val keys = node.keys().asSequence().toSortedSet()
            keys.joinToString(prefix = "{", postfix = "}") { k -> "\"${escape(k)}\":${canonical(node.get(k))}" }
        }
        is JSONArray -> (0 until node.length()).joinToString(prefix = "[", postfix = "]") { canonical(node.get(it)) }
        is String -> "\"${escape(node)}\""
        is Boolean -> node.toString()
        is Int, is Long -> node.toString()
        is Double, is Float -> jsNumber(node.toDouble())
        is Number -> jsNumber(node.toDouble())
        else -> "\"${escape(node.toString())}\""
    }

    private fun jsNumber(d: Double): String {
        if (d == d.toLong().toDouble()) return d.toLong().toString()
        return d.toString()
    }

    private fun escape(s: String): String = buildString {
        for (ch in s) {
            when (ch) {
                '"' -> append("\\\"")
                '\\' -> append("\\\\")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                else -> if (ch < ' ') append("\\u%04x".format(ch.code)) else append(ch)
            }
        }
    }

    data class VerifyResult(val ok: Boolean, val keyId: String?, val reason: String)

    fun verify(profile: JSONObject, trusted: Map<String, String>): VerifyResult {
        val sig = profile.optJSONObject("signature")
            ?: return VerifyResult(false, null, "unsigned profile — refuse")
        val keyId = sig.optString("keyId")
        val pubB64 = trusted[keyId] ?: return VerifyResult(false, keyId, "unknown signing key $keyId")
        val signedFields = sig.optJSONArray("signedFields")?.let { a -> (0 until a.length()).map { a.getString(it) } }
            ?: listOf("profileVersion", "issuer", "user", "servers", "credentials", "policy")
        val subset = JSONObject()
        for (f in signedFields) if (profile.has(f)) subset.put(f, profile.get(f))
        val payload = canonical(subset).toByteArray(Charsets.UTF_8)
        return try {
            val kf = KeyFactory.getInstance("Ed25519")
            val der = Base64.decode(pubB64, Base64.NO_WRAP)
            val pub = kf.generatePublic(X509EncodedKeySpec(spkiFromRawEd25519(der)))
            val s = Signature.getInstance("Ed25519")
            s.initVerify(pub)
            s.update(payload)
            val sigBytes = Base64.decode(sig.getString("value"), Base64.NO_WRAP)
            if (s.verify(sigBytes)) VerifyResult(true, keyId, "ok")
            else VerifyResult(false, keyId, "signature does not match the canonical payload")
        } catch (e: java.security.NoSuchAlgorithmException) {
            // Android gained Ed25519 in API 33. Refusing is the safe answer: an unsigned
            // config must never be the fallback when crypto is missing.
            VerifyResult(false, keyId, "Ed25519 unavailable on this device (needs Android 13+): ${e.message}")
        } catch (e: Exception) {
            VerifyResult(false, keyId, "verification error: ${e.message}")
        }
    }

    /** raw 32-byte key → SubjectPublicKeyInfo for Ed25519 (the format Java's KeyFactory wants). */
    private fun spkiFromRawEd25519(raw: ByteArray): ByteArray {
        val prefix = byteArrayOf(
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
        )
        val key = if (raw.size == prefix.size + 32) raw else prefix + raw
        return key
    }
}
