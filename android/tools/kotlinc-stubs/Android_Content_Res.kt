package android.content.res

open class AssetManager {
    open fun open(name: String): java.io.InputStream = java.io.FileInputStream(name)
}
