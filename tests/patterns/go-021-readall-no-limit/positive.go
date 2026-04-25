// Positive fixture for go-021-readall-no-limit.
// io.ReadAll on a network response body buffers the entire stream.
// A multi-GB malicious response OOMs the server.
package main

import (
	"io"
	"net/http"
)

func fetchAll(url string) ([]byte, error) {
	resp, err := http.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return io.ReadAll(resp.Body)
}
