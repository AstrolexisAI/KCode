// Negative fixture for go-022-http-no-timeout.
// Timeout set on the client → unlimited-hang attack mitigated.
package main

import (
	"net/http"
	"time"
)

var client = http.Client{Timeout: 30 * time.Second}

func ping(url string) (*http.Response, error) {
	return client.Get(url)
}
