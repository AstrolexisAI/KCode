// Negative fixture for go-002-unsafe-pointer.
// Plain pointer-to-struct conversions without `unsafe` stay safe
// under Go's type system.
package main

type Point struct {
	X, Y int
}

func move(p *Point, dx, dy int) {
	p.X += dx
	p.Y += dy
}
