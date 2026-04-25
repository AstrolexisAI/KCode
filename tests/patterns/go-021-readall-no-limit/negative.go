// Negative fixture for go-021-readall-no-limit.
// io.LimitReader caps the response at 10 MiB before reading.
package main

import (
	"io"
	"net/http"
)

const maxBytes = 10 << 20

func fetchAll(url string) ([]byte, error) {
	resp, err := http.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return io.ReadAll(io.LimitReader(resp.Body, maxBytes))
}
