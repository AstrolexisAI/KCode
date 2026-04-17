// Negative fixture for rs-001-unsafe-block.
// Safe Rust with no `unsafe` keyword. The regex requires
// `unsafe {` specifically — function signatures don't trigger.

fn read_slice(buf: &[u8], idx: usize) -> Option<u8> {
    buf.get(idx).copied()
}
