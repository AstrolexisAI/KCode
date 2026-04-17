// Positive fixture for rs-001-unsafe-block.
// `unsafe { ... }` blocks bypass Rust's safety guarantees and
// every use needs manual review.

fn read_raw(ptr: *const u8, len: usize) -> u8 {
    // CONFIRMED: dereferencing raw pointer requires unsafe.
    unsafe {
        *ptr.add(len - 1)
    }
}
