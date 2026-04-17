// Positive fixture for swift-001-force-unwrap.
// `identifier!.method()` force-unwraps Optional then calls a
// method. If the identifier holds nil, this crashes at runtime.

func countFromUser(user: String?) -> Int {
    // CONFIRMED: user is Optional; ! crashes if nil.
    return user!.count
}
