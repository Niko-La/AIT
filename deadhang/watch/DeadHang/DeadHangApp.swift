import SwiftUI

@main
struct DeadHangApp: App {
    @StateObject private var session = HangSession()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(session)
        }
    }
}
