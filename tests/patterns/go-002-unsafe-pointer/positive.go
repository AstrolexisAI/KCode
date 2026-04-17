// Positive fixture for go-002-unsafe-pointer.
// unsafe.Pointer conversion bypasses Go's memory safety — every
// use needs careful review.
package main

import "unsafe"

func BytesToInt(b []byte) int32 {
	// CONFIRMED: aliasing a []byte as *int32 skips bounds checks.
	return *(*int32)(unsafe.Pointer(&b[0]))
}
