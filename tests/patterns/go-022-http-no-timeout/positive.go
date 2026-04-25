// Positive fixture for go-022-http-no-timeout.
// http.Client zero-value Timeout is unlimited. A slow / malicious
// server can hold the connection open forever.
package main

import "net/http"

var client = http.Client{}

func ping(url string) (*http.Response, error) {
	return client.Get(url)
}
