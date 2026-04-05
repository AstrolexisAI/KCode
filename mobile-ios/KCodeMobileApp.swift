// KCodeMobile - iOS app entry point
// Companion app for KCode terminal assistant — chat from your phone

import SwiftUI

@main
struct KCodeMobileApp: App {
    @StateObject private var settings = AppSettings()
    @StateObject private var chatSession = ChatSession()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(settings)
                .environmentObject(chatSession)
        }
    }
}
