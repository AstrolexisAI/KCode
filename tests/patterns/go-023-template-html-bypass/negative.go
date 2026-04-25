// Negative fixture for go-023-template-html-bypass.
// Plain string passed to the template — html/template auto-escapes
// it, so attacker payloads come out as harmless text.
package main

import (
	"html/template"
	"net/http"
)

func render(w http.ResponseWriter, r *http.Request) {
	t := template.Must(template.New("p").Parse(`{{.}}`))
	userInput := r.URL.Query().Get("msg")
	_ = t.Execute(w, userInput)
}
