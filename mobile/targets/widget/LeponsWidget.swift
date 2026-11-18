import AppIntents
import SwiftUI
import WidgetKit

// The home-screen widget: the PC in use's sessions, waiting first then the latest to move, each with what it is doing;
// or, when a question waits, the newest one with its choices as buttons that answer from here (Intents.swift).

struct Entry: TimelineEntry {
  let date: Date
  let snap: Snap?
}

struct Provider: TimelineProvider {
  func placeholder(in context: Context) -> Entry { Entry(date: .now, snap: nil) }
  func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) { completion(Entry(date: .now, snap: WidgetStore.load())) }
  // The app rewrites the widget while it has its link; with the app closed, a view older than ten minutes is fetched
  // again on the widget's own link. WidgetKit spaces these out on its own budget.
  func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
    Task {
      if let snap = WidgetStore.load(), Date().timeIntervalSince1970 * 1000 - snap.at > 10 * 60_000 {
        await WidgetStore.refresh()
      }
      completion(Timeline(entries: [Entry(date: .now, snap: WidgetStore.load())], policy: .after(Date().addingTimeInterval(15 * 60))))
    }
  }
}

private let text = Color("wText")
private let muted = Color("wMuted")
private let live = Color("wLive")

private func lamp(_ mood: String) -> Color {
  switch mood {
  case "waiting": return live
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

/// The PC's name, when this view was made, and a button that fetches it again.
private struct Header: View {
  let snap: Snap
  var body: some View {
    HStack(spacing: 6) {
      Text(snap.pc).font(.system(size: 13, weight: .semibold)).foregroundStyle(text).lineLimit(1)
      Spacer(minLength: 4)
      Text(Date(timeIntervalSince1970: snap.at / 1000), style: .time).font(.system(size: 11)).foregroundStyle(muted)
      Button(intent: RefreshWidget()) {
        Image(systemName: "arrow.clockwise").font(.system(size: 11, weight: .semibold)).foregroundStyle(muted)
      }
      .buttonStyle(.plain)
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
      Header(snap: snap)
      HStack(spacing: 10) {
        Count(label: snap.words.waiting, n: snap.waiting, color: live)
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

/// A full-width button in the widget's own colours.
private struct Pill: View {
  let label: String
  let filled: Bool
  var body: some View {
    Text(label).font(.system(size: 12, weight: .semibold)).lineLimit(1)
      .foregroundStyle(filled ? Color("wBg") : text)
      .frame(maxWidth: .infinity, alignment: filled ? .center : .leading)
      .padding(.vertical, 5).padding(.horizontal, 8)
      .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(filled ? live : Color("wRaise")))
  }
}

/// The newest question waiting: whose it is, what it asks, and its choices -- answered from here -- or the way to it.
private struct AskView: View {
  let snap: Snap
  let ask: Snap.Ask
  let family: WidgetFamily
  var body: some View {
    let room = family == .systemLarge ? 6 : 3
    VStack(alignment: .leading, spacing: 5) {
      HStack(spacing: 6) {
        Circle().fill(live).frame(width: 7, height: 7)
        Text(snap.words.asks).font(.system(size: 12, weight: .semibold)).foregroundStyle(live).lineLimit(1)
        Spacer(minLength: 4)
        if snap.asks.count > 1 {
          Text(snap.words.more.replacingOccurrences(of: "{n}", with: String(snap.asks.count - 1)))
            .font(.system(size: 11)).foregroundStyle(muted).lineLimit(1)
        }
      }
      Text([ask.folder, ask.agent].compactMap { $0 }.joined(separator: " · "))
        .font(.system(size: 14, weight: .semibold)).foregroundStyle(text).lineLimit(1)
      if family == .systemSmall {
        Spacer(minLength: 0)
      } else if let status = ask.status {
        Text(status == "changed" ? (snap.words.changed ?? snap.words.open) : (snap.words.failed ?? snap.words.open))
          .font(.system(size: 11)).foregroundStyle(Color("wStop")).lineLimit(2)
        Spacer(minLength: 0)
        Link(destination: sessionURL(ask.id)) { Pill(label: snap.words.open, filled: true) }
      } else if let choices = ask.choices, let sig = ask.sig, !choices.isEmpty {
        if let question = ask.question {
          Text(question).font(.system(size: 11)).foregroundStyle(muted).lineLimit(family == .systemLarge ? 3 : 1)
        }
        ForEach(choices.prefix(room)) { choice in
          Button(intent: AnswerChoice(session: ask.id, key: choice.key ?? String(choice.n), sig: sig)) {
            Pill(label: "\(choice.n). \(choice.label)", filled: false)
          }
          .buttonStyle(.plain)
        }
        if choices.count > room {
          Link(destination: sessionURL(ask.id)) {
            Text(snap.words.open).font(.system(size: 11, weight: .semibold)).foregroundStyle(live)
          }
        }
        Spacer(minLength: 0)
      } else {
        if let question = ask.text {
          Text(question).font(.system(size: 11, design: .monospaced)).foregroundStyle(muted)
            .lineLimit(family == .systemLarge ? 14 : 3)
        }
        Spacer(minLength: 0)
        Link(destination: sessionURL(ask.id)) { Pill(label: snap.words.open, filled: true) }
      }
    }
    .widgetURL(sessionURL(ask.id))
  }
}

/// The Lock Screen's three: how many wait (circle), a line of counts above the clock (inline), and the newest
/// question with its choices as number buttons -- or the sessions -- in the rectangle. The system draws them in its
/// own tint, so they carry no colours of their own.
private struct LockView: View {
  let snap: Snap?
  let family: WidgetFamily
  var body: some View {
    if let snap {
      switch family {
      case .accessoryCircular:
        VStack(spacing: 0) {
          Text("\(snap.waiting)").font(.system(size: 22, weight: .bold)).widgetAccentable()
          Text(snap.words.waiting).font(.system(size: 9)).lineLimit(1).minimumScaleFactor(0.6)
        }
        .widgetURL(snap.asks.first.map { sessionURL($0.id) })
      case .accessoryInline:
        Text("\(snap.words.waiting) \(snap.waiting) · \(snap.words.working) \(snap.working)")
      default:
        if let ask = snap.asks.first {
          LockAsk(snap: snap, ask: ask)
        } else {
          VStack(alignment: .leading, spacing: 1) {
            Text("\(snap.words.waiting) \(snap.waiting) · \(snap.words.working) \(snap.working)")
              .font(.system(size: 13, weight: .semibold)).widgetAccentable().lineLimit(1)
            ForEach(snap.rows.prefix(2)) { row in
              Text("\(row.folder) · \(row.label)").font(.system(size: 12)).lineLimit(1)
            }
            if snap.rows.isEmpty { Text(snap.words.empty).font(.system(size: 12)).lineLimit(1) }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .widgetURL(snap.rows.first.map { sessionURL($0.id) })
        }
      }
    } else {
      Text("Lepons")
    }
  }
}

/// The newest question in the Lock Screen rectangle: whose, what it asks, and up to four choices by number.
private struct LockAsk: View {
  let snap: Snap
  let ask: Snap.Ask
  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(ask.folder).font(.system(size: 13, weight: .semibold)).widgetAccentable().lineLimit(1)
      if let choices = ask.choices, let sig = ask.sig, !choices.isEmpty, ask.status == nil {
        Text(ask.question ?? snap.words.asks).font(.system(size: 11)).lineLimit(1)
        HStack(spacing: 4) {
          ForEach(choices.prefix(4)) { choice in
            Button(intent: AnswerChoice(session: ask.id, key: choice.key ?? String(choice.n), sig: sig)) {
              Text("\(choice.n)").font(.system(size: 13, weight: .bold))
                .frame(maxWidth: .infinity, minHeight: 22)
                .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(.white.opacity(0.22)))
            }
            .buttonStyle(.plain)
          }
        }
      } else {
        Text(ask.status == "changed" ? (snap.words.changed ?? snap.words.open) : ask.status != nil ? (snap.words.failed ?? snap.words.open) : snap.words.asks)
          .font(.system(size: 11)).lineLimit(2)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .widgetURL(sessionURL(ask.id))
  }
}

struct LeponsWidgetView: View {
  @Environment(\.widgetFamily) var family
  let entry: Entry
  var body: some View {
    if [WidgetFamily.accessoryCircular, .accessoryRectangular, .accessoryInline].contains(family) {
      LockView(snap: entry.snap, family: family)
        .containerBackground(for: .widget) {
          if family == .accessoryCircular { AccessoryWidgetBackground() }
        }
    } else {
      home
    }
  }

  private var home: some View {
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
    .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryCircular, .accessoryRectangular, .accessoryInline])
  }
}

@main
struct LeponsWidgets: WidgetBundle {
  var body: some Widget { LeponsWidget() }
}
