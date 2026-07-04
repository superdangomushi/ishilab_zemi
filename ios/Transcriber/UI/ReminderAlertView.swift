import SwiftUI
import AudioToolbox

/// 締切リマインドの全画面アラート（Android の ReminderAlertActivity 相当）。
/// 表示中は約10秒バイブし、「了解」を押すまで閉じない（スワイプでも閉じない）。
struct ReminderAlertView: View {
    @ObservedObject var center = ReminderAlertCenter.shared
    @State private var vibrateCount = 0
    private let vibrateTimer = Timer.publish(every: 1.1, on: .main, in: .common).autoconnect()
    private static let vibrateTimes = 9 // 約10秒

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                Spacer(minLength: 80)
                Text("⏰ 締切リマインド").font(.title2.bold())
                ForEach(center.messages, id: \.self) { m in
                    Text(m)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)
                }
                Button {
                    center.acknowledge()
                } label: {
                    Text("了解")
                        .font(.headline)
                        .frame(maxWidth: .infinity, minHeight: 56)
                }
                .buttonStyle(.borderedProminent)
            }
            .padding(24)
        }
        .interactiveDismissDisabled(true) // 「了解」を押すまで閉じさせない
        .onAppear { vibrateCount = 0 }
        .onReceive(vibrateTimer) { _ in
            // 表示中に新しいリマインドが来たら onChange で改めて振動する。
            if vibrateCount < Self.vibrateTimes {
                AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
                vibrateCount += 1
            }
        }
        .onChange(of: center.messages) { _ in
            vibrateCount = 0
        }
    }
}
