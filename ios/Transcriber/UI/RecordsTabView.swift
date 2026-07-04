import SwiftUI

/// 文字起こし記録を「日付 → 時刻 → 本文」の階層で辿るタブ（端末/サーバー切替つき）。
struct RecordsTabView: View {
    @State private var source = 0

    var body: some View {
        VStack(spacing: 0) {
            TabRow(selected: $source, titles: ["端末", "サーバー"])
            if source == 0 {
                LocalRecordsList()
            } else {
                ServerRecordsList()
            }
        }
    }
}

// ファイル名 "yyyy-MM-dd_HH.txt" を日付・時でグループ化。
private func dateOf(_ name: String) -> String { name.count >= 10 ? String(name.prefix(10)) : name }
private func hourOf(_ name: String) -> String {
    name.count >= 13 ? String(name.dropFirst(11).prefix(2)) : "--"
}

struct LocalRecordsList: View {
    @EnvironmentObject var viewModel: MainViewModel
    @State private var openDate: String? = nil
    @State private var openFile: String? = nil

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                // ヘッダー（パンくず＋更新）
                HStack {
                    let crumb: String = {
                        if let f = openFile { return "記録 › \(openDate ?? "") › \(hourOf(f))時台" }
                        if let d = openDate { return "記録 › \(d)" }
                        return "記録（日付一覧）"
                    }()
                    Text(crumb).font(.headline)
                    Spacer()
                    Button("更新") { viewModel.refresh() }
                        .buttonStyle(.bordered)
                }

                if viewModel.ui.transcripts.isEmpty {
                    Text("まだ記録がありません。").font(.caption)
                } else if let file = openFile {
                    // ---- 第3階層: 本文表示 ----
                    Button("← \(openDate ?? "") の時刻一覧へ") { openFile = nil }
                    if let item = viewModel.ui.transcripts.first(where: { $0.name == file }) {
                        TranscriptDetailCard(item: item)
                    } else {
                        Text("ファイルが見つかりません。").font(.caption)
                    }
                } else if let date = openDate {
                    // ---- 第2階層: 選択した日付の時刻一覧 ----
                    Button("← 日付一覧へ") { openDate = nil }
                    let hours = viewModel.ui.transcripts
                        .filter { dateOf($0.name) == date }
                        .sorted { $0.name > $1.name }
                    ForEach(hours) { item in
                        Button {
                            openFile = item.name
                        } label: {
                            CardView {
                                HStack {
                                    Text("\(hourOf(item.name))時台")
                                    Spacer()
                                    Text("\(item.sizeBytes) bytes ›").font(.caption).foregroundColor(.secondary)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                } else {
                    // ---- 第1階層: 日付一覧 ----
                    let byDate = Dictionary(grouping: viewModel.ui.transcripts) { dateOf($0.name) }
                    ForEach(byDate.keys.sorted(by: >), id: \.self) { date in
                        Button {
                            openDate = date
                        } label: {
                            CardView {
                                HStack {
                                    Text(date)
                                    Spacer()
                                    Text("\(byDate[date]?.count ?? 0) 件 ›").font(.caption).foregroundColor(.secondary)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .padding(16)
        }
    }
}

/// 本文と操作（共有・送信）をまとめた詳細表示。
struct TranscriptDetailCard: View {
    @EnvironmentObject var viewModel: MainViewModel
    let item: TranscriptItem
    @State private var content: String? = nil
    @State private var shareItem: URL? = nil

    var body: some View {
        CardView {
            Text(item.name).font(.subheadline.bold())
            if let content {
                ScrollView {
                    Text(content.isEmpty ? "（空です）" : content)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 420)
            } else {
                Text("読み込み中…").font(.caption)
            }
            HStack(spacing: 8) {
                Button("共有") { shareItem = URL(fileURLWithPath: item.path) }
                    .buttonStyle(.bordered)
                let sending = viewModel.ui.sendingFile == item.name
                let sent = viewModel.ui.sentFiles.contains(item.name)
                Button(sending ? "送信中…" : (sent ? "送信済み" : "サーバーへ送信")) {
                    viewModel.sendToServer(item)
                }
                .buttonStyle(.borderedProminent)
                .disabled(!viewModel.ui.account.loggedIn || viewModel.ui.sendingFile != nil || sent)
            }
        }
        .task(id: item.path) {
            content = (try? String(contentsOfFile: item.path, encoding: .utf8)) ?? "読み込み失敗"
        }
        .sheet(item: $shareItem) { url in
            ShareSheet(items: [url])
        }
    }
}

extension URL: Identifiable {
    public var id: String { absoluteString }
}

/// UIActivityViewController のラッパ（Android の ACTION_SEND 相当）。
struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}

/// サーバーに保存済みの文字起こし。サーバー文字起こしモードの最新テキストもここで読む。
struct ServerRecordsList: View {
    @EnvironmentObject var viewModel: MainViewModel
    @State private var openId: Int64? = nil

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(openId == nil ? "サーバー記録" : "サーバー記録 › 本文").font(.headline)
                    Spacer()
                    Button("更新") { viewModel.loadServerTranscripts() }
                        .buttonStyle(.bordered)
                        .disabled(!viewModel.ui.account.loggedIn || viewModel.ui.serverTranscriptsLoading)
                }

                if !viewModel.ui.account.loggedIn {
                    Text("AIHelper にログインすると、Web と同じサーバー保存済みテキストを表示できます。")
                        .font(.caption)
                } else {
                    if let err = viewModel.ui.serverTranscriptsError {
                        Text("取得エラー: \(err)").foregroundColor(.red)
                    }
                    if let selectedId = openId {
                        Button("← 一覧へ") { openId = nil }
                        let detail = viewModel.ui.serverTranscriptDetail.flatMap { $0.id == selectedId ? $0 : nil }
                        if let detail, viewModel.ui.serverTranscriptLoadingId != selectedId {
                            ServerTranscriptDetailCard(detail: detail)
                        } else {
                            HStack(spacing: 8) {
                                ProgressView().scaleEffect(0.8)
                                Text("読み込み中…").font(.caption)
                            }
                        }
                    } else if viewModel.ui.serverTranscriptsLoading && viewModel.ui.serverTranscripts.isEmpty {
                        Text("読み込み中…").font(.caption)
                    } else if viewModel.ui.serverTranscripts.isEmpty {
                        Text("サーバーに保存された記録はまだありません。").font(.caption)
                    } else {
                        ForEach(viewModel.ui.serverTranscripts) { transcript in
                            Button {
                                openId = transcript.id
                                viewModel.loadServerTranscript(transcript.id)
                            } label: {
                                CardView {
                                    Text(transcript.filename).lineLimit(1)
                                    Text("\(transcript.chars)文字 / \(formatServerTimestamp(transcript.updatedAt))"
                                         + (transcript.analyzed ? " / 解析済み" : ""))
                                        .font(.caption).foregroundColor(.secondary)
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .padding(16)
        }
        .onAppear {
            if viewModel.ui.account.loggedIn { viewModel.loadServerTranscripts() }
        }
    }
}

struct ServerTranscriptDetailCard: View {
    let detail: AiHelperClient.ServerTranscriptDetail

    var body: some View {
        CardView {
            Text(detail.filename).font(.subheadline.bold())
            Text(formatServerTimestamp(detail.updatedAt) + (detail.analyzed ? " / 解析済み" : ""))
                .font(.caption).foregroundColor(.secondary)
            if !detail.summary.isEmpty {
                Text("要約").font(.caption.bold())
                Text(detail.summary)
            }
            Text("本文").font(.caption.bold())
            ScrollView {
                Text(detail.content.isEmpty ? "（空です）" : detail.content)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 520)
        }
    }
}

func formatServerTimestamp(_ value: String) -> String {
    if value.isEmpty { return "-" }
    var s = value.replacingOccurrences(of: "T", with: " ")
    s = s.replacingOccurrences(of: #"\.\d{3}Z$"#, with: "", options: .regularExpression)
    s = s.replacingOccurrences(of: #"Z$"#, with: "", options: .regularExpression)
    return String(s.prefix(16))
}
