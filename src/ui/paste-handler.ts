// KCode - Global paste handler registry
// Simple module-level callback for passing paste events from the stdin
// interceptor (paste-stream.ts) to InputPrompt without circular imports.

type PasteCallback = (text: string) => void;

let _handler: PasteCallback | null = null;

export function setPasteHandler(handler: PasteCallback | null): void {
  _handler = handler;
}

export function invokePasteHandler(text: string): void {
  if (_handler) _handler(text);
}
