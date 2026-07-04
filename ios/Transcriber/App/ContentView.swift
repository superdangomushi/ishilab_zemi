import SwiftUI

/// メイン画面。上部タブ（録音/記録/予定/秘書）＋右下 AI ボタン＋処理中バッジ。
/// （Android 版 MainScreen の移植）
struct ContentView: View {
    @EnvironmentObject var viewModel: MainViewModel
    @EnvironmentObject var service: AudioCaptureService

    @State private var tab = 0
    @State private var chatOpen = false

    var body: some View {
        ZStack {
            VStack(spacing: 0) {
                Text("常時録音・ローカル文字起こし")
                    .font(.headline)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                TabRow(selected: $tab, titles: ["録音", "記録", "予定", "秘書"])
                switch tab {
                case 0: RecordingTabView()
                case 1: RecordsTabView()
                case 2: CalendarTabView()
                default: SecretaryTabView()
                }
            }
            .background(AppTheme.background)

            // 音声→テキスト変換中は右上に小さく表示（操作は妨げない）。どの区間かと進捗も出す。
            if service.state.transcribing {
                TranscribingBadge(state: service.state)
            }

            // 右下の AI ボタン（どのタブからでも秘書チャットを呼び出せる）。
            VStack {
                Spacer()
                HStack {
                    Spacer()
                    Button {
                        chatOpen = true
                    } label: {
                        Text("AI")
                            .font(.title3.bold())
                            .foregroundColor(.white)
                            .frame(width: 56, height: 56)
                            .background(AppTheme.primary)
                            .clipShape(Circle())
                            .shadow(radius: 4)
                    }
                    .padding(.trailing, 16)
                    .padding(.bottom, 16)
                }
            }
        }
        .sheet(isPresented: $chatOpen) {
            AssistantChatView()
                .environmentObject(viewModel)
        }
    }
}

/// Android の TabRow 相当の上部タブ。
struct TabRow: View {
    @Binding var selected: Int
    let titles: [String]

    var body: some View {
        HStack(spacing: 0) {
            ForEach(titles.indices, id: \.self) { i in
                Button {
                    selected = i
                } label: {
                    VStack(spacing: 6) {
                        Text(titles[i])
                            .font(.subheadline.weight(selected == i ? .semibold : .regular))
                            .foregroundColor(selected == i ? AppTheme.primary : .secondary)
                        Rectangle()
                            .fill(selected == i ? AppTheme.primary : .clear)
                            .frame(height: 2)
                    }
                }
                .frame(maxWidth: .infinity)
            }
        }
        .background(Color(.systemBackground))
    }
}

/// 文字起こし処理中を右上にちょこんと示す小さなインジケータ（画面操作はブロックしない）。
struct TranscribingBadge: View {
    let state: ServiceState

    var body: some View {
        VStack {
            HStack {
                Spacer()
                HStack(spacing: 6) {
                    ProgressView()
                        .scaleEffect(0.7)
                    let pct = Int(state.transcribeProgress * 100)
                    Text(state.transcribeLabel.map { "\($0) 処理中 \(pct)%" } ?? "処理中 \(pct)%")
                        .font(.caption)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(Color(.systemBackground))
                .clipShape(Capsule())
                .shadow(radius: 3)
                .padding(.top, 10)
                .padding(.trailing, 10)
            }
            Spacer()
        }
        .allowsHitTesting(false)
    }
}

/// カード共通の見た目（Android の Material3 Card 相当）。
struct CardView<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color(.systemBackground))
        .cornerRadius(12)
        .shadow(color: .black.opacity(0.06), radius: 3, y: 1)
    }
}
