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
    /**
     * Byte-exact `JSON.stringify` of a key-sorted tree. Kotlin's `joinToString` defaults its
     * separator to ", " — one space and every signature fails to verify, so the separators are
     * written out explicitly. Checked by `android/tools/typecheck.sh`, which verifies a profile
     * signed by the real engine.
     */
    fun canonical(node: Any?): String = when (node) {
        null -> "null"
        is JSONObject -> {
            val keys = node.keys().asSequence().toSortedSet()
            keys.joinToString(separator = ",", prefix = "{", postfix = "}") { k -> "\"${escape(k)}\":${canonical(node.get(k))}" }
        }
        is JSONArray -> (0 until node.length()).joinToString(separator = ",", prefix = "[", postfix = "]") { canonical(node.get(it)) }
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

    /** Byte-for-byte what JSON.stringify produces — the engine canonicalises with it. */
    private fun escape(s: String): String = buildString {
        for (ch in s) {
            when (ch) {
                '"' -> append("\\\"")
                '\\' -> append("\\\\")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                '\b' -> append("\\b")
                '\u000C' -> append("\\f")
                else -> if (ch < ' ') append("\\u%04X".format(ch.code)) else append(ch)
            }
        }
    }

    data class VerifyResult(val ok: Boolean, val keyId: String?, val reason: String)

    fun verify(profile: JSONObject, trusted: Map<String, String>): VerifyResult {
        val sig = profile.optJSONObject("signature")
            ?: return VerifyResult(false, null, "unsigned profile — refuse")
        val keyId = sig.optString("keyId")
        val pubB64 = trusted[keyId] ?: return VerifyResult(false, keyId, "unknown signing key $keyId")
        // The signature covers EVERY field except `signature` itself — including `profileId`,
        // `createdAt` and `minClientVersion`. Signing only a declared subset would let
        // `minClientVersion` be rewritten to allow a downgrade, and it is what this verifier
        // first got wrong (it then refused every real profile, which is the loud direction).
        val payload = canonical(profile.minus("signature")).toByteArray(Charsets.UTF_8)

        // `signedFields` is a promise about content, not the exclusion list: refuse a
        // document that dropped a field the signature says it covers.
        val declared = sig.optJSONArray("signedFields")
        if (declared != null) {
            for (i in 0 until declared.length()) {
                val field = declared.getString(i)
                if (!profile.has(field)) return VerifyResult(false, keyId, "signed field '$field' is missing from the profile")
            }
        }
        return try {
            val kf = KeyFactory.getInstance("Ed25519")
            val der = b64(pubB64)
            val pub = kf.generatePublic(X509EncodedKeySpec(spkiFromRawEd25519(der)))
            val s = Signature.getInstance("Ed25519")
            s.initVerify(pub)
            s.update(payload)
            val sigBytes = b64(sig.getString("value"))
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

    /**
     * A trust anchor or signature arriving as base64url (the engine uses `base64url` for
     * some key material) must still verify. Android's decoder is strict about the alphabet,
     * so normalise the alphabet and the padding here rather than refusing the profile —
     * a false rejection in the field is indistinguishable from a revocation.
     */
    private fun b64(value: String): ByteArray {
        // de-armour first: an operator pastes the PEM from keys.json into TrustedKeys more
        // often than they paste the DER, and "unknown signing key" is a cruel error for that.
        val body = value.trim()
            .lines()
            .filterNot { it.startsWith("-----") }
            .joinToString("")
            .trim()
        val normalized = body.replace('-', '+').replace('_', '/')
        val padded = normalized + "=".repeat((4 - normalized.length % 4) % 4)
        return Base64.decode(padded, Base64.NO_WRAP)
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


/** Shallow copy without a key — org.json has no such helper and we must not mutate the input. */
private fun JSONObject.minus(key: String): JSONObject {
    val out = JSONObject()
    for (k in this.keys()) if (k != key) out.put(k, this.get(k))
    return out
}
