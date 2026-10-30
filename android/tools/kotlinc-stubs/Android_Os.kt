package android.os

open class ParcelFileDescriptor(open val fd: Int = -1) {
    fun close() {}
}

class Bundle {
    fun getString(key: String): String? = null
}
