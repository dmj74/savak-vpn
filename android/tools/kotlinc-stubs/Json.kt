// A minimal org.json stand-in, used ONLY by tools/typecheck.sh.
//
// Why this exists: the Android module's decision logic (bundle parsing, scoring, parity
// check) depends on org.json, which ships inside android.jar — so without a stub none of it
// can be compiled without the SDK. These classes implement the handful of methods the app
// actually calls, with the semantics those methods have on a device (`opt*` returns a
// default for a missing key, `get*` throws, `isNull` distinguishes JSON null from absent).
//
// This is scaffolding, not app code: nothing under app/src/main references it, and Gradle
// never puts it on the compile path.
package org.json

class JSONException(message: String) : RuntimeException(message)

class JSONObject internal constructor(internal val map: LinkedHashMap<String, Any?> = LinkedHashMap()) {

    constructor(source: String) : this(topMap(source))

    val keys: Set<String> get() = map.keys

    fun keys(): Iterator<String> = map.keys.iterator()

    fun length(): Int = map.size

    fun has(key: String): Boolean = map.containsKey(key)

    fun isNull(key: String): Boolean = !map.containsKey(key) || map[key] == null

    fun get(key: String): Any = map[key] ?: throw JSONException("JSONObject[$key] not found")

    fun opt(key: String): Any? = map[key]

    fun getString(key: String): String = asString(map[key] ?: throw JSONException("no $key"))

    fun optString(key: String): String = if (map.containsKey(key)) asString(map[key]) else ""

    fun optString(key: String, fallback: String): String = if (map.containsKey(key) && map[key] != null) asString(map[key]) else fallback

    fun getInt(key: String): Int = (map[key] as? Number)?.toInt() ?: throw JSONException("$key is not an int")

    fun optInt(key: String): Int = (map[key] as? Number)?.toInt() ?: 0

    fun optInt(key: String, fallback: Int): Int = (map[key] as? Number)?.toInt() ?: fallback

    fun getLong(key: String): Long = (map[key] as? Number)?.toLong() ?: throw JSONException("$key is not a long")

    fun optLong(key: String): Long = (map[key] as? Number)?.toLong() ?: 0L

    fun optLong(key: String, fallback: Long): Long = (map[key] as? Number)?.toLong() ?: fallback

    fun getBoolean(key: String): Boolean = map[key] as? Boolean ?: throw JSONException("$key is not a boolean")

    fun optBoolean(key: String): Boolean = map[key] as? Boolean ?: false

    fun optBoolean(key: String, fallback: Boolean): Boolean = map[key] as? Boolean ?: fallback

    fun getDouble(key: String): Double = (map[key] as? Number)?.toDouble() ?: throw JSONException("$key is not a number")

    fun optDouble(key: String): Double = (map[key] as? Number)?.toDouble() ?: Double.NaN

    fun optDouble(key: String, fallback: Double): Double = (map[key] as? Number)?.toDouble() ?: fallback

    fun getJSONObject(key: String): JSONObject = map[key] as? JSONObject ?: throw JSONException("$key is not an object")

    fun optJSONObject(key: String): JSONObject? = map[key] as? JSONObject

    fun getJSONArray(key: String): JSONArray = map[key] as? JSONArray ?: throw JSONException("$key is not an array")

    fun optJSONArray(key: String): JSONArray? = map[key] as? JSONArray

    fun put(key: String, value: Any?): JSONObject = apply { map[key] = value }

    override fun toString(): String = write(this, 0)

    fun toString(indentSpaces: Int): String = write(map, indentSpaces)

    private fun asString(v: Any?): String = when (v) {
        null -> ""
        is String -> v
        else -> v.toString()
    }

    private fun write(v: Any?, indent: Int): String = when (v) {
        null -> "null"
        is JSONObject -> v.map.entries.joinToString(prefix = "{", postfix = "}") { (k, x) ->
            "\"${esc(k)}\":${if (indent > 0) "\n" + " ".repeat(indent) else ""}${write(x, if (indent > 0) indent + 2 else 0)}"
        }
        is JSONArray -> v.items.joinToString(prefix = "[", postfix = "]") { write(it, indent) }
        is String -> "\"${esc(v)}\""
        is Number, is Boolean -> v.toString()
        else -> "\"${esc(v.toString())}\""
    }

    private fun esc(s: String): String = buildString {
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

    companion object {
        /** The parser builds nested JSONObject/JSONArray; only the top level must unwrap. */
        internal fun topMap(src: String): LinkedHashMap<String, Any?> = when (val v = Parser(src).parseValue()) {
            is JSONObject -> v.map
            else -> throw JSONException("top level value is not a JSON object")
        }
    }
}

class JSONArray internal constructor(val items: MutableList<Any?> = ArrayList()) {

    constructor(source: String) : this(Parser(source).parseValue().let { v ->
        (v as? JSONArray)?.items ?: throw JSONException("top level value is not a JSON array")
    })

    fun length(): Int = items.size

    fun get(i: Int): Any = items[i] ?: throw JSONException("JSONArray[$i] is null")

    fun opt(i: Int): Any? = items.getOrNull(i)

    fun getString(i: Int): String = (items[i] as? String) ?: items[i]?.toString() ?: throw JSONException("not a string")

    fun getJSONObject(i: Int): JSONObject = items[i] as? JSONObject ?: throw JSONException("not an object")

    fun getJSONArray(i: Int): JSONArray = items[i] as? JSONArray ?: throw JSONException("not an array")

    fun optJSONObject(i: Int): JSONObject? = items.getOrNull(i) as? JSONObject

    fun put(value: Any?): JSONArray = apply { items.add(value) }

    override fun toString(): String = items.joinToString(prefix = "[", postfix = "]")
}

/** Recursive-descent JSON reader — just enough of RFC 8259 for our own fixtures. */
internal class Parser(private val s: String) {
    private var i = 0

    fun parseValue(): Any? {
        skip()
        return when (peek()) {
            '{' -> parseObj()
            '[' -> parseArr()
            '"' -> parseStr()
            't' -> literal("true", true)
            'f' -> literal("false", false)
            'n' -> literal("null", null)
            else -> parseNum()
        }
    }

    private fun parseObj(): JSONObject {
        val m = LinkedHashMap<String, Any?>()
        expect('{')
        skip()
        if (peek() == '}') { i++; return JSONObject(m) }
        while (true) {
            skip()
            val key = parseStr()
            skip(); expect(':')
            m[key] = parseValue()
            skip()
            when (peek()) {
                ',' -> i++
                '}' -> { i++; return JSONObject(m) }
                else -> throw JSONException("expected , or } at $i")
            }
        }
    }

    private fun parseArr(): JSONArray {
        val list = ArrayList<Any?>()
        expect('[')
        skip()
        if (peek() == ']') { i++; return JSONArray(list) }
        while (true) {
            list.add(parseValue())
            skip()
            when (peek()) {
                ',' -> i++
                ']' -> { i++; return JSONArray(list) }
                else -> throw JSONException("expected , or ] at $i")
            }
        }
    }

    private fun parseStr(): String {
        expect('"')
        val sb = StringBuilder()
        while (i < s.length) {
            val c = s[i++]
            if (c == '"') return sb.toString()
            if (c == '\\') {
                when (val e = s[i++]) {
                    '"' -> sb.append('"'); '\\' -> sb.append('\\'); '/' -> sb.append('/')
                    'b' -> sb.append('\b'); 'f' -> sb.append('\u000C'); 'n' -> sb.append('\n')
                    'r' -> sb.append('\r'); 't' -> sb.append('\t')
                    'u' -> { sb.append(s.substring(i, i + 4).toInt(16).toChar()); i += 4 }
                    else -> throw JSONException("bad escape \\$e")
                }
            } else sb.append(c)
        }
        throw JSONException("unterminated string")
    }

    private fun parseNum(): Any {
        val start = i
        while (i < s.length && s[i].let { it.isDigit() || it == '-' || it == '+' || it == '.' || it == 'e' || it == 'E' }) i++
        val raw = s.substring(start, i)
        return raw.toLongOrNull() ?: raw.toDoubleOrNull() ?: throw JSONException("bad number '$raw'")
    }

    private fun <T> literal(word: String, value: T): T {
        if (!s.startsWith(word, i)) throw JSONException("expected $word at $i")
        i += word.length
        return value
    }

    private fun peek(): Char = s.getOrElse(i) { '\u0000' }

    private fun expect(c: Char) { if (s[i] != c) throw JSONException("expected '$c' at $i"); i++ }

    private fun skip() { while (i < s.length && s[i].isWhitespace()) i++ }

}
