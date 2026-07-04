import SwiftUI

/// 録音・文字起こし関連（状態 / 操作 / モデル）をまとめたタブ。
struct RecordingTabView: View {
    @EnvironmentObject var viewModel: MainViewModel
    @EnvironmentObject var service: AudioCaptureService

    var body: some View {
        ScrollView {
            VStack(spacing: 12) {
                StatusCard(state: service.state)

                TranscribeModeCard()

                if !viewModel.ui.serverTranscribe {
                    ModelCard()
                }

                if viewModel.ui.anyModelReady || viewModel.ui.serverTranscribe {
                    ControlRow()
                }

                if let err = service.state.error {
                    Text("エラー: \(err)")
                        .foregroundColor(.red)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                if let msg = viewModel.ui.sendMessage {
                    Text(msg)
                        .font(.caption)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(16)
        }
    }
}

/// 状態カード。録音時間・処理中区間・直近テキストなどを表示する。
struct StatusCard: View {
    let state: ServiceState
    @State private var now = AudioCaptureService.nowElapsedMs()
    private let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        CardView {
            let status: String = {
                if state.draining { return "送信待ち（未送信を送信中）" }
                if state.transcribing { return "音声を文字起こし中" }
                if !state.active { return "停止中" }
                if state.paused { return "一時停止中（マイク解放中）" }
                return "録音中"
            }()
            Text("状態: \(status)").font(.headline)

            if state.active && !state.transcribing {
                Text("録音時間: \(formatDuration(elapsedMs))")
                Text("※ 文字起こしは1時間ごと、または終了時にまとめて実行します。")
                    .font(.caption)
            }
            // 現在どの区間を処理しているかと進捗。
            if state.transcribing {
                Text("処理中の音声: \(state.transcribeLabel ?? "-")")
                ProgressView(value: Double(state.transcribeProgress))
                Text("\(Int(state.transcribeProgress * 100))%").font(.caption)
            }
            if let model = state.modelName {
                Text("モデル: \(model)")
            }
            Text("処理済: \(state.chunksDone) 区間  待機: \(state.queueSize) 区間")
            if let file = state.currentFile {
                Text("最新の出力: \(file)")
            }
            if !state.lastText.isEmpty {
                Text("直近: \(state.lastText)")
                    .font(.caption)
                    .lineLimit(2)
            }
        }
        .onReceive(timer) { _ in
            if state.active { now = AudioCaptureService.nowElapsedMs() }
        }
    }

    /// 録音の合計継続時間(ms)。一時停止中は積算値で止まる。
    private var elapsedMs: Int64 {
        let running = state.recordingStartedElapsed > 0
            ? max(0, now - state.recordingStartedElapsed)
            : 0
        return state.accumulatedRecordMs + running
    }

    private func formatDuration(_ ms: Int64) -> String {
        let totalSec = ms / 1000
        let h = totalSec / 3600
        let m = (totalSec % 3600) / 60
        let s = totalSec % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%02d:%02d", m, s)
    }
}

/// 文字起こし方法の選択カード。
/// 端末処理(Whisper)は遅い端末だと時間がかかるため、音声をサーバーへアップロードして
/// サーバー側で文字起こしするモードを選べる（AIHelper ログインが必要）。
struct TranscribeModeCard: View {
    @EnvironmentObject var viewModel: MainViewModel

    var body: some View {
        CardView {
            Text("文字起こしの方法").font(.headline)
            RadioRow(selected: !viewModel.ui.serverTranscribe, enabled: true) {
                viewModel.setServerTranscribe(false)
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text("端末で処理（オフライン）")
                    Text("Whisper モデルで端末内処理。通信不要だが時間がかかる。")
                        .font(.caption).foregroundColor(.secondary)
                }
            }
            RadioRow(selected: viewModel.ui.serverTranscribe, enabled: viewModel.ui.account.loggedIn) {
                viewModel.setServerTranscribe(true)
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text("サーバーで処理（音声をアップロード）")
                    Text(viewModel.ui.account.loggedIn
                         ? "録音区間の音声をサーバーへ送り、サーバー側で文字起こし。処理状況はダッシュボードで確認できます。"
                         : "利用するには先に「秘書」タブで AIHelper にログインしてください。")
                        .font(.caption).foregroundColor(.secondary)
                }
            }
            Text("※ 切り替えは次回の録音開始から反映されます。")
                .font(.caption)
        }
    }
}

/// Android の RadioButton＋ラベル行の代替。
struct RadioRow<Label: View>: View {
    let selected: Bool
    let enabled: Bool
    let action: () -> Void
    @ViewBuilder let label: Label

    var body: some View {
        Button(action: action) {
            HStack(alignment: .center, spacing: 10) {
                Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                    .foregroundColor(selected ? AppTheme.primary : .secondary)
                label
                    .foregroundColor(.primary)
                Spacer(minLength: 0)
            }
        }
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.5)
        .buttonStyle(.plain)
    }
}

/// 文字起こしモデルのカード。ダウンロード済みモデルはラジオで選び直せ、
/// 未ダウンロードのモデルはこの場でダウンロードできる。
struct ModelCard: View {
    @EnvironmentObject var viewModel: MainViewModel

    var body: some View {
        CardView {
            Text("文字起こしモデル").font(.headline)
            if !viewModel.ui.anyModelReady {
                Text("初回はモデルのダウンロードが必要です。DL後はオフラインで動作。日本語は base 以上を推奨。")
                    .font(.caption)
            }
            ForEach(WhisperModel.allCases) { model in
                let downloaded = viewModel.ui.downloadedModels.contains(model)
                let selected = viewModel.ui.selectedModel == model
                let isDownloading = viewModel.ui.downloading == model
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(model.displayName)
                        Text("約\(model.approxMb)MB").font(.caption).foregroundColor(.secondary)
                    }
                    Spacer()
                    if isDownloading {
                        ProgressView().scaleEffect(0.8)
                    } else if downloaded {
                        HStack(spacing: 4) {
                            Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                                .foregroundColor(selected ? AppTheme.primary : .secondary)
                            Text(selected ? "使用中" : "使用").font(.caption)
                        }
                        .onTapGesture { viewModel.selectModel(model) }
                    } else {
                        Button("ダウンロード") { viewModel.download(model) }
                            .buttonStyle(.borderedProminent)
                            .disabled(viewModel.ui.downloading != nil)
                    }
                }
                if isDownloading {
                    if viewModel.ui.downloadProgress >= 0 {
                        ProgressView(value: Double(viewModel.ui.downloadProgress))
                    } else {
                        ProgressView()
                    }
                }
            }
            if let err = viewModel.ui.downloadError {
                Text("ダウンロード失敗: \(err)").foregroundColor(.red)
            }
            Text("※ 録音中に変更した場合は次回の録音開始から反映されます。")
                .font(.caption)
        }
    }
}

/// 録音開始/終了＋一時停止/再開。
/// Android は一時停止/再開を通知バーのボタンで行うが、iOS は常駐通知が無いためここに置く。
struct ControlRow: View {
    @EnvironmentObject var service: AudioCaptureService

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 12) {
                Button("録音開始") { AudioCaptureService.shared.start() }
                    .buttonStyle(.borderedProminent)
                    .disabled(service.state.active)
                if service.state.active {
                    if service.state.paused {
                        Button("再開") { AudioCaptureService.shared.resumeMic() }
                            .buttonStyle(.bordered)
                    } else {
                        Button("一時停止") { AudioCaptureService.shared.pauseMic() }
                            .buttonStyle(.bordered)
                    }
                }
                Button("終了") { AudioCaptureService.shared.stop() }
                    .buttonStyle(.bordered)
                    .disabled(!service.state.active)
            }
            Text("※ 一時停止はマイクを完全に解放し、再開で再取得します。")
                .font(.caption)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
