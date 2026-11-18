import CryptoKit
import Foundation
import WidgetKit

// What the widget shows, kept in the App Group: written by the app while it has its link (mobile/src/widget.ts), and
// by the widget itself when it answers or refreshes with the app closed. Same JSON both ways.

private let appGroup = "group.app.lepons.mobile"

struct Snap: Codable {
  struct Row: Codable, Identifiable {
    let id: String
    let folder: String
    let agent: String?
    var mood: String
    var label: String
    /// What it is doing now, or its result once done.
    let now: String?
    /// When that was (epoch ms).
    let at: Double?
  }
  struct Choice: Codable, Identifiable {
    let n: Int
    let label: String
    let key: String?
    var id: Int { n }
  }
  struct Ask: Codable {
    let id: String
    let folder: String
    let agent: String?
    let text: String?
    let question: String?
    let choices: [Choice]?
    /// SHA-256 of the waiting screen the choices were read from.
    let sig: String?
    /// "failed" or "changed" after a tap that could not answer.
    var status: String?
  }
  struct Words: Codable {
    let waiting: String
    let working: String
    let done: String
    let open: String
    let more: String
    let asks: String
    let empty: String
    let failed: String?
    let changed: String?
    let moods: [String: String]?
  }
  let pc: String
  var at: Double
  var waiting: Int
  var working: Int
  var done: Int
  var rows: [Row]
  var asks: [Ask]
  let words: Words
}

func screenSig(_ preview: String) -> String {
  hexString(Data(SHA256.hash(data: Data(preview.trimmingCharacters(in: .whitespacesAndNewlines).utf8))))
}

/// What a fresh session's question is matched by, as the app writes `sig` (widget-snapshot.ts): the PC's ask id, or the
/// preview's fingerprint from a PC that sends no ask.
func askSig(_ session: [String: Any]) -> String? {
  if let id = (session["ask"] as? [String: Any])?["id"] as? String { return id }
  return (session["preview"] as? String).map(screenSig)
}

/// The buttons a session's `ask` gives, as widget-snapshot.ts picks them: one-pick options only, without the typing row.
/// None for a multi-select (ticks, then Tab) or an unnumbered picker (arrows, then Enter), which stay in the app.
func askChoices(_ session: [String: Any]) -> (question: String?, choices: [Snap.Choice], sig: String)? {
  guard let ask = session["ask"] as? [String: Any], let sig = ask["id"] as? String,
        let options = ask["options"] as? [[String: Any]] else { return nil }
  if options.contains(where: { $0["checked"] != nil || $0["keys"] != nil }) { return nil }
  let choices: [Snap.Choice] = options.compactMap { option in
    guard option["freeText"] as? Bool != true, let n = option["n"] as? Int, let label = option["label"] as? String else { return nil }
    return Snap.Choice(n: n, label: String(label.prefix(60)), key: option["key"] as? String)
  }
  guard !choices.isEmpty, choices.count <= 9 else { return nil }
  return (ask["question"] as? String, choices, sig)
}

enum WidgetStore {
  static func load() -> Snap? {
    guard let text = UserDefaults(suiteName: appGroup)?.string(forKey: "snapshot"), let data = text.data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(Snap.self, from: data)
  }

  static func save(_ snap: Snap) {
    guard let data = try? JSONEncoder().encode(snap), let text = String(data: data, encoding: .utf8) else { return }
    UserDefaults(suiteName: appGroup)?.set(text, forKey: "snapshot")
  }

  /// The widget's view rebuilt from the PC's `/api/state`, as the app builds it (mobile/src/phone/widget-snapshot.ts):
  /// AI sessions, waiting first, then by when each last moved. A question keeps the buttons the app read for it only
  /// while its screen is still the one they were read from; a new one opens the app.
  static func rebuilt(from state: Any?, old: Snap) -> Snap? {
    guard let sessions = (state as? [String: Any])?["sessions"] as? [[String: Any]] else { return nil }
    let agents = sessions.filter { $0["agent"] as? Bool == true }
    func lamp(_ s: [String: Any]) -> String { s["agentGone"] as? Bool == true ? "shellOnly" : (s["mood"] as? String ?? "idle") }
    func at(_ s: [String: Any]) -> Double { ((s["summary"] as? [String: Any])?["now"] as? [String: Any])?["at"] as? Double ?? 0 }
    func name(_ s: [String: Any]) -> String {
      let folder = s["folder"] as? String ?? ""
      if let of = s["worktreeOf"] as? String { return "\(of) · \(s["worktree"] as? String ?? folder)" }
      return folder
    }
    let order = agents.sorted { a, b in
      let (wa, wb) = (lamp(a) == "waiting", lamp(b) == "waiting")
      return wa != wb ? wa : at(a) > at(b)
    }
    let rows: [Snap.Row] = order.prefix(8).map { s in
      let mood = lamp(s)
      let summary = s["summary"] as? [String: Any]
      let step = (summary?["now"] as? [String: Any])?["text"] as? String
      let doing = mood == "done" ? (summary?["result"] as? String ?? step) : step
      let line = doing.map { String($0.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ").prefix(120)) }
      let when = at(s)
      return Snap.Row(id: s["id"] as? String ?? "", folder: name(s), agent: s["agentName"] as? String, mood: mood,
                      label: old.words.moods?[mood] ?? mood, now: (line?.isEmpty ?? true) ? nil : line, at: when > 0 ? when : nil)
    }
    let asks: [Snap.Ask] = order.filter { lamp($0) == "waiting" }.map { s in
      let id = s["id"] as? String ?? ""
      let preview = (s["preview"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
      let text = preview.map { $0.count > 600 ? "…" + String($0.suffix(600)) : $0 }
      // A PC that sends its reading of the menu (ask) gives the buttons here, with the app closed; an older PC's
      // choices come only from the app's last snapshot of that same screen.
      if let own = askChoices(s) {
        return Snap.Ask(id: id, folder: name(s), agent: s["agentName"] as? String, text: (text?.isEmpty ?? true) ? nil : text,
                        question: own.question, choices: own.choices, sig: own.sig, status: nil)
      }
      let before = old.asks.first { $0.id == id }
      let same = before?.sig != nil && askSig(s) == before?.sig
      return Snap.Ask(id: id, folder: name(s), agent: s["agentName"] as? String, text: (text?.isEmpty ?? true) ? nil : text,
                      question: same ? before?.question : nil, choices: same ? before?.choices : nil, sig: same ? before?.sig : nil, status: nil)
    }
    var snap = old
    snap.at = Date().timeIntervalSince1970 * 1000
    snap.rows = rows
    snap.asks = asks
    snap.waiting = agents.filter { lamp($0) == "waiting" }.count
    snap.working = agents.filter { lamp($0) == "working" }.count
    snap.done = agents.filter { lamp($0) == "done" }.count
    return snap
  }

  /// Gives up on a link that does not answer: the widget has a few seconds, not a minute.
  static func within<T>(_ seconds: Double, _ work: @escaping () async throws -> T) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
      group.addTask { try await work() }
      group.addTask {
        try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        throw RelayError.closed
      }
      let first = try await group.next()!
      group.cancelAll()
      return first
    }
  }

  /// Fresh state from the PC with the app closed: a short link of the widget's own. False when it could not.
  @discardableResult
  static func refresh() async -> Bool {
    guard let link = WidgetLink.load(), let old = load() else { return false }
    let relay = RelaySession(link: link)
    defer { relay.close() }
    do {
      let state = try await within(10) { () -> Any? in
        try await relay.open()
        let reply = try await relay.request("GET", "/api/state")
        return reply.status == 200 ? reply.body : nil
      }
      guard let next = rebuilt(from: state, old: old) else { return false }
      save(next)
      return true
    } catch {
      return false
    }
  }

  /// The choice tapped on the widget, sent as the app sends it, only if the PC still shows the screen it was read from.
  static func answer(session: String, key: String, sig: String) async {
    guard var snap = load() else { return }
    func mark(_ status: String) {
      if let at = snap.asks.firstIndex(where: { $0.id == session }) { snap.asks[at].status = status }
      save(snap)
    }
    guard let link = WidgetLink.load() else { return mark("failed") }
    let relay = RelaySession(link: link)
    defer { relay.close() }
    do {
      let outcome = try await within(12) { () -> (String, Any?) in
        try await relay.open()
        let state = try await relay.request("GET", "/api/state")
        let sessions = (state.body as? [String: Any])?["sessions"] as? [[String: Any]] ?? []
        guard let now = sessions.first(where: { $0["id"] as? String == session }), now["mood"] as? String == "waiting",
              askSig(now) == sig else { return ("changed", state.body) }
        let sent = try await relay.request("POST", "/api/input", body: ["s": session, "key": key])
        return (sent.status == 200 ? "sent" : "failed", state.body)
      }
      switch outcome.0 {
      case "sent":
        // Answered: off the stack of questions, and working again until the PC says otherwise.
        if var next = rebuilt(from: outcome.1, old: snap) {
          next.asks.removeAll { $0.id == session }
          if let at = next.rows.firstIndex(where: { $0.id == session }) {
            next.rows[at].mood = "working"
            next.rows[at].label = next.words.moods?["working"] ?? next.words.working
          }
          next.waiting = max(0, next.waiting - 1)
          next.working += 1
          snap = next
        } else {
          snap.asks.removeAll { $0.id == session }
        }
        save(snap)
      case "changed":
        if let next = rebuilt(from: outcome.1, old: snap) { snap = next }
        mark("changed")
      default:
        mark("failed")
      }
    } catch {
      mark("failed")
    }
  }
}
