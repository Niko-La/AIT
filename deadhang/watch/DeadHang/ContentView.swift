import SwiftUI

struct ContentView: View {
    var body: some View {
        TabView {
            TimerView()
            HistoryView()
            SettingsView()
        }
        .tabViewStyle(.verticalPage)
    }
}

struct TimerView: View {
    @EnvironmentObject private var session: HangSession

    var body: some View {
        VStack(spacing: 4) {
            Text(status)
                .font(.caption2.weight(.semibold))
                .textCase(.uppercase)
                .foregroundStyle(session.hangStartDate == nil ? Color.orange : Color.green)

            TimelineView(.periodic(from: .now, by: 0.1)) { context in
                Text(formatHang(seconds(at: context.date), tenths: context.cadence == .live))
                    .font(.system(size: 48, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .minimumScaleFactor(0.5)
                    .lineLimit(1)
                    .foregroundStyle(session.hangStartDate == nil ? Color.primary : Color.green)
            }

            if session.isRunning {
                Label(session.armRaised ? "Arm up" : "Arm down", systemImage: session.armRaised ? "arrow.up" : "arrow.down")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else if let notice = session.notice {
                Text(notice).font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
            } else if session.best > 0 {
                Text("Best \(formatHang(session.best))").font(.footnote).foregroundStyle(.secondary)
            }

            Button(session.isRunning ? "Stop" : "Start") {
                session.isRunning ? session.stop() : session.start()
            }
            .buttonStyle(.borderedProminent)
            .tint(session.isRunning ? .red : .orange)
            .padding(.top, 4)
        }
        .padding(.horizontal)
    }

    private var status: String {
        if session.hangStartDate != nil { return "Hanging" }
        if session.lastHang != nil { return session.lastWasBest ? "New best!" : "Saved" }
        return session.isRunning ? "Grab the bar" : "Dead hang"
    }

    private func seconds(at date: Date) -> TimeInterval {
        if let start = session.hangStartDate { return date.timeIntervalSince(start) }
        return session.lastHang?.duration ?? 0
    }
}

struct HistoryView: View {
    @EnvironmentObject private var session: HangSession

    var body: some View {
        List {
            if session.hangs.isEmpty {
                Text("No hangs yet").foregroundStyle(.secondary)
            }
            ForEach(session.hangs.reversed()) { hang in
                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Text(formatHang(hang.duration)).font(.headline).monospacedDigit()
                        if hang.duration == session.best {
                            Image(systemName: "star.fill").foregroundStyle(.orange).imageScale(.small)
                        }
                    }
                    Text(hang.date.formatted(date: .abbreviated, time: .shortened))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            .onDelete(perform: session.delete)
        }
        .navigationTitle("History")
    }
}

struct SettingsView: View {
    @AppStorage(SettingKey.minimumDuration) private var minimumDuration = 3.0
    @AppStorage(SettingKey.tenSecondTaps) private var tenSecondTaps = true
    @AppStorage(SettingKey.flipArm) private var flipArm = false

    var body: some View {
        List {
            Picker("Ignore under", selection: $minimumDuration) {
                ForEach([2.0, 3.0, 5.0, 10.0], id: \.self) { Text("\(Int($0)) s").tag($0) }
            }
            Toggle("Tap every 10 s", isOn: $tenSecondTaps)
            Section {
                Toggle("Flip arm direction", isOn: $flipArm)
            } footer: {
                Text("If the timer says “Arm down” while your arm is straight overhead, turn this on. Changes apply on the next Start.")
            }
        }
        .navigationTitle("Settings")
    }
}
