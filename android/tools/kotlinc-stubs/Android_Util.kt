package android.util

object Base64 {
    const val NO_WRAP = 2

    /**
     * NO_WRAP means "the standard alphabet, no line breaks" — which is what the engine emits
     * for signatures and SPKI pins. Decoding it with the URL-safe variant would turn a valid
     * signature into a verification failure, i.e. a stub bug that looks like an app bug.
     */
    @JvmStatic
    fun decode(input: String, flags: Int): ByteArray =
        java.util.Base64.getMimeDecoder().decode(input.replace('-', '+').replace('_', '/'))

    @JvmStatic
    fun encodeToString(input: ByteArray, flags: Int): String = java.util.Base64.getEncoder().encodeToString(input)
}
