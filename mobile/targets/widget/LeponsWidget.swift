import SwiftUI
import WidgetKit

// What the app last wrote into the App Group (mobile/src/widget.ts): the PC in use, its sessions with the
// ones waiting first, and the questions waiting on it, newest first. Words come from the app, in its language.
private let appGroup = "group.app.lepons.mobile"

struct Snap: Codable {
  struct Row: Codable, Identifiable {
    let id: String
    let folder: String
    let agent: String?
    let mood: String
    let label: String
    /// What it is doing now, or its result once done.
    let now: String?
    /// When that was (epoch ms).
    let at: Double?
  }
  struct Ask: Codable {
    let id: String
    let folder: String
    let agent: String?
    let text: String?
  }
  struct Words: Codable {
    let waiting: String
    let working: String
    let done: String
    let open: String
    let more: String
    let asks: String
    let empty: String
  }
  let pc: String
  let at: Double
  let waiting: Int
  let working: Int
  let done: Int
  let rows: [Row]
  let asks: [Ask]
  let words: Words
}

struct Entry: TimelineEntry {
  let date: Date
  let snap: Snap?
}

struct Provider: TimelineProvider {
  func load() -> Snap? {
    guard let text = UserDefaults(suiteName: appGroup)?.string(forKey: "snapshot"), let data = text.data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(Snap.self, from: data)
  }
  func placeholder(in context: Context) -> Entry { Entry(date: .now, snap: nil) }
  func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) { completion(Entry(date: .now, snap: load())) }
  // The app reloads the widget whenever what it shows changes; nothing to schedule here.
  func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
    completion(Timeline(entries: [Entry(date: .now, snap: load())], policy: .never))
  }
}

private let text = Color("wText")
private let muted = Color("wMuted")

private func lamp(_ mood: String) -> Color {
  switch mood {
  case "waiting": return Color("wLive")
  case "working": return Color("wGo")
  case "failed": return Color("wStop")
  case "done": return Color("wGo").opacity(0.55)
  default: return Color("wIdle")
  }
}

private func sessionURL(_ id: String) -> URL { URL(string: "lepons://session/\(id)")! }

private struct Count: View {
  let label: String
  let n: Int
  let color: Color
  var body: some View {
    HStack(spacing: 4) {
      Text("\(n)").font(.system(size: 15, weight: .bold)).foregroundStyle(n > 0 ? color : muted)
      Text(label).font(.system(size: 11)).foregroundStyle(muted).lineLimit(1)
    }
  }
}

/// One session: lamp, folder, AI and state; under it, what it is doing now and when it last moved.
private struct RowView: View {
  let row: Snap.Row
  let detail: Bool
  var body: some View {
    VStack(alignment: .leading, spacing: 1) {
      HStack(spacing: 6) {
        Circle().fill(lamp(row.mood)).frame(width: 7, height: 7)
        Text(row.folder).font(.system(size: 13, weight: .semibold)).foregroundStyle(text).lineLimit(1)
        if let agent = row.agent {
          Text(agent).font(.system(size: 11)).foregroundStyle(muted).lineLimit(1)
        }
        Spacer(minLength: 4)
        Text(row.label).font(.system(size: 11, weight: .semibold)).foregroundStyle(lamp(row.mood)).lineLimit(1)
      }
      if detail, row.now != nil || row.at != nil {
        HStack(spacing: 6) {
          Text(row.now ?? "").font(.system(size: 11)).foregroundStyle(muted).lineLimit(1)
          Spacer(minLength: 4)
          if let at = row.at {
            Text(Date(timeIntervalSince1970: at / 1000), style: .time).font(.system(size: 10)).foregroundStyle(muted)
          }
        }
        .padding(.leading, 13)
      }
    }
  }
}

/// The PC's sessions: counts, then rows with the ones waiting first.
private struct SummaryView: View {
  let snap: Snap
  let family: WidgetFamily
  var body: some View {
    let shown = family == .systemSmall ? 2 : family == .systemLarge ? 7 : 3
    let detail = family != .systemSmall
    VStack(alignment: .leading, spacing: detail ? 5 : 6) {
      HStack {
        Text(snap.pc).font(.system(size: 13, weight: .semibold)).foregroundStyle(text).lineLimit(1)
        Spacer(minLength: 4)
        Text(Date(timeIntervalSince1970: snap.at / 1000), style: .time).font(.system(size: 11)).foregroundStyle(muted)
      }
      HStack(spacing: 10) {
        Count(label: snap.words.waiting, n: snap.waiting, color: Color("wLive"))
        if family != .systemSmall {
          Count(label: snap.words.working, n: snap.working, color: Color("wGo"))
          Count(label: snap.words.done, n: snap.done, color: muted)
        }
      }
      if snap.rows.isEmpty {
        Text(snap.words.empty).font(.system(size: 12)).foregroundStyle(muted)
      }
      ForEach(snap.rows.prefix(shown)) { row in
        if family == .systemSmall {
          RowView(row: row, detail: false)
        } else {
          Link(destination: sessionURL(row.id)) { RowView(row: row, detail: detail) }
        }
      }
      Spacer(minLength: 0)
    }
    .widgetURL(snap.rows.first.map { sessionURL($0.id) })
  }
}

/// The newest question waiting: whose it is, what the screen says, and the way to it.
private struct AskView: View {
  let snap: Snap
  let ask: Snap.Ask
  let family: WidgetFamily
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 6) {
        Circle().fill(Color("wLive")).frame(width: 7, height: 7)
        Text(snap.words.asks).font(.system(size: 12, weight: .semibold)).foregroundStyle(Color("wLive")).lineLimit(1)
        Spacer(minLength: 4)
        if snap.asks.count > 1 {
          Text(snap.words.more.replacingOccurrences(of: "{n}", with: String(snap.asks.count - 1)))
            .font(.system(size: 11)).foregroundStyle(muted).lineLimit(1)
        }
      }
      Text([ask.folder, ask.agent].compactMap { $0 }.joined(separator: " · "))
        .font(.system(size: 14, weight: .semibold)).foregroundStyle(text).lineLimit(1)
      if let question = ask.text, family != .systemSmall {
        Text(question).font(.system(size: 11, design: .monospaced)).foregroundStyle(muted)
          .lineLimit(family == .systemLarge ? 14 : 3)
      }
      Spacer(minLength: 0)
      if family != .systemSmall {
        Link(destination: sessionURL(ask.id)) {
          Text(snap.words.open).font(.system(size: 13, weight: .semibold)).foregroundStyle(Color("wBg"))
            .frame(maxWidth: .infinity).padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color("wLive")))
        }
      }
    }
    .widgetURL(sessionURL(ask.id))
  }
}

struct LeponsWidgetView: View {
  @Environment(\.widgetFamily) var family
  let entry: Entry
  var body: some View {
    Group {
      if let snap = entry.snap {
        if let ask = snap.asks.first {
          AskView(snap: snap, ask: ask, family: family)
        } else {
          SummaryView(snap: snap, family: family)
        }
      } else {
        VStack(alignment: .leading, spacing: 4) {
          Text("Lepons").font(.system(size: 15, weight: .bold)).foregroundStyle(text)
          Spacer(minLength: 0)
        }
      }
    }
    .containerBackground(Color("wBg"), for: .widget)
  }
}

struct LeponsWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "LeponsWidget", provider: Provider()) { entry in
      LeponsWidgetView(entry: entry)
    }
    .configurationDisplayName("Lepons")
    .description("AI 세션과 기다리는 질문")
    .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
  }
}

@main
struct LeponsWidgets: WidgetBundle {
  var body: some Widget { LeponsWidget() }
}
