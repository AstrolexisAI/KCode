// Positive fixture for kt-001-force-unwrap.
// `x!!.method()` crashes with NullPointerException if x is null.

fun userNameLength(map: Map<String, String>): Int {
    // CONFIRMED: map["name"] could be null; !! throws NPE.
    return map["name"]!!.length
}
