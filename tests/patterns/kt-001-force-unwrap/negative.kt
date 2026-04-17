// Negative fixture for kt-001-force-unwrap.
// Safe call `?.` with `?: default` returns a fallback instead of
// crashing.

fun userNameLength(map: Map<String, String>): Int {
    return map["name"]?.length ?: 0
}
