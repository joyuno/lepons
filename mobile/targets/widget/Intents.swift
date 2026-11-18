import AppIntents
import WidgetKit

/// A choice tapped on the widget: answered from the widget itself (WidgetStore.answer), the app stays closed.
struct AnswerChoice: AppIntent {
  static var title: LocalizedStringResource = "Answer"
  static var isDiscoverable: Bool = false
  // Tapped on a locked phone (the Lock Screen widget, StandBy), it asks for Face ID first: whoever holds the phone
  // does not get to answer the PC's agent.
  static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

  @Parameter(title: "Session") var session: String
  @Parameter(title: "Key") var key: String
  @Parameter(title: "Screen") var sig: String

  init() {}

  init(session: String, key: String, sig: String) {
    self.session = session
    self.key = key
    self.sig = sig
  }

  func perform() async throws -> some IntentResult {
    await WidgetStore.answer(session: session, key: key, sig: sig)
    WidgetCenter.shared.reloadAllTimelines()
    return .result()
  }
}

/// The widget's own refresh: fresh state from the PC with the app closed.
struct RefreshWidget: AppIntent {
  static var title: LocalizedStringResource = "Refresh"
  static var isDiscoverable: Bool = false

  init() {}

  func perform() async throws -> some IntentResult {
    await WidgetStore.refresh()
    WidgetCenter.shared.reloadAllTimelines()
    return .result()
  }
}
