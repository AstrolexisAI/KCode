// Negative fixture for swift-001-force-unwrap.
// Optional chaining `?.` returns nil instead of crashing.

func userNameLength(from map: [String: String]) -> Int {
    return map["name"]?.count ?? 0
}
