// Positive fixture for go-023-template-html-bypass.
// template.HTML(userInput) bypasses html/template's auto-escaping —
// XSS if userInput is attacker-controllable.
package main

import (
	"html/template"
	"net/http"
)

func render(w http.ResponseWriter, r *http.Request) {
	t := template.Must(template.New("p").Parse(`{{.}}`))
	userInput := r.URL.Query().Get("msg")
	_ = t.Execute(w, template.HTML(userInput))
}
