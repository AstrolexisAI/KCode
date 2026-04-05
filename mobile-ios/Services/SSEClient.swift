// KCodeMobile - Server-Sent Events client
// Custom URLSession-based SSE parser for /api/prompt?stream=true

import Foundation

enum SSEEvent {
    case session(sessionId: String)
    case text(String)
    case toolResult(name: String, result: String, isError: Bool)
    case toolProgress(name: String, index: Int, total: Int, status: String)
    case turnStart
    case compaction(tokensAfter: Int)
    case done(sessionId: String, usage: [String: Int])
    case error(String)
}

protocol SSEClientDelegate: AnyObject {
    func sseClient(_ client: SSEClient, didReceive event: SSEEvent)
    func sseClient(_ client: SSEClient, didCompleteWithError error: Error?)
}

class SSEClient: NSObject, URLSessionDataDelegate {
    weak var delegate: SSEClientDelegate?
    private var dataTask: URLSessionDataTask?
    private var buffer = Data()
    private var session: URLSession!

    override init() {
        super.init()
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 300
        config.timeoutIntervalForResource = 600
        self.session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }

    func connect(url: URL, body: [String: Any], sessionId: String?) {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        if let sid = sessionId {
            request.setValue(sid, forHTTPHeaderField: "X-Session-Id")
        }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        buffer = Data()
        dataTask = session.dataTask(with: request)
        dataTask?.resume()
    }

    func disconnect() {
        dataTask?.cancel()
        dataTask = nil
    }

    // MARK: - URLSessionDataDelegate

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        buffer.append(data)
        processBuffer()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        DispatchQueue.main.async {
            self.delegate?.sseClient(self, didCompleteWithError: error)
        }
    }

    // MARK: - SSE Parsing

    private func processBuffer() {
        while let range = buffer.range(of: "\n\n".data(using: .utf8)!) {
            let eventData = buffer.subdata(in: 0..<range.lowerBound)
            buffer.removeSubrange(0..<range.upperBound)
            if let eventText = String(data: eventData, encoding: .utf8) {
                parseEvent(eventText)
            }
        }
    }

    private func parseEvent(_ raw: String) {
        var eventType: String?
        var dataLine: String?

        for line in raw.split(separator: "\n") {
            let lineStr = String(line)
            if lineStr.hasPrefix("event: ") {
                eventType = String(lineStr.dropFirst(7))
            } else if lineStr.hasPrefix("data: ") {
                dataLine = String(lineStr.dropFirst(6))
            }
        }

        guard let type = eventType, let data = dataLine?.data(using: .utf8) else { return }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }

        let event: SSEEvent?
        switch type {
        case "session":
            event = (json["sessionId"] as? String).map { .session(sessionId: $0) }
        case "text":
            event = (json["text"] as? String).map { .text($0) }
        case "tool_result":
            if let name = json["name"] as? String, let result = json["result"] as? String {
                event = .toolResult(name: name, result: result, isError: json["isError"] as? Bool ?? false)
            } else {
                event = nil
            }
        case "tool_progress":
            if let name = json["name"] as? String, let idx = json["index"] as? Int,
               let total = json["total"] as? Int, let status = json["status"] as? String {
                event = .toolProgress(name: name, index: idx, total: total, status: status)
            } else {
                event = nil
            }
        case "turn_start":
            event = .turnStart
        case "compaction":
            event = (json["tokensAfter"] as? Int).map { .compaction(tokensAfter: $0) }
        case "done":
            let sid = json["sessionId"] as? String ?? ""
            let usage = json["usage"] as? [String: Int] ?? [:]
            event = .done(sessionId: sid, usage: usage)
        case "error":
            event = (json["message"] as? String).map { .error($0) }
        default:
            event = nil
        }

        if let e = event {
            DispatchQueue.main.async {
                self.delegate?.sseClient(self, didReceive: e)
            }
        }
    }
}
