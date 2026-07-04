import SwiftUI

/// どのタブからでも呼び出せる秘書チャット（Android の AssistantChatDialog 相当）。
struct AssistantChatView: View {
    @EnvironmentObject var viewModel: MainViewModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 10) {
            HStack {
                Text("AI秘書").font(.headline)
                Spacer()
                Button("閉じる") { dismiss() }
            }
            SecretaryChatPanel(expandMessages: true)
        }
        .padding(16)
        .onAppear {
            if viewModel.ui.account.loggedIn { viewModel.loadChatHistory() }
        }
    }
}

/// 秘書チャット: 「今日の予定は？」と聞けば回答、「予定入れといて」で登録まで実行。
struct SecretaryChatPanel: View {
    @EnvironmentObject var viewModel: MainViewModel
    var expandMessages = false
    @State private var question = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !viewModel.ui.account.loggedIn {
                Text("AIHelper にログインすると、予定・課題・文字起こしを見ながら相談できます。")
                    .font(.caption)
            }
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        if viewModel.ui.chatHistoryLoading && viewModel.ui.chatLog.isEmpty {
                            Text("履歴を読み込み中…").font(.caption)
                        } else if viewModel.ui.chatLog.isEmpty {
                            Text("例) 今日の予定は？ / 来週月曜10時にゼミ入れといて / 数学の宿題が出てるらしい")
                                .font(.caption)
                        } else {
                            ForEach(viewModel.ui.chatLog.suffix(50)) { msg in
                                ChatBubble(msg: msg)
                                    .id(msg.id)
                            }
                        }
                        if viewModel.ui.askInProgress {
                            HStack(spacing: 8) {
                                ProgressView().scaleEffect(0.7)
                                Text("考え中…").font(.caption)
                            }
                        }
                    }
                }
                .frame(maxHeight: expandMessages ? .infinity : 320)
                .onChange(of: viewModel.ui.chatLog.count) { _ in
                    if let last = viewModel.ui.chatLog.last {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }
            HStack(spacing: 8) {
                TextField("メッセージ", text: $question, axis: .vertical)
                    .lineLimit(1...3)
                    .textFieldStyle(.roundedBorder)
                    .disabled(!viewModel.ui.account.loggedIn || viewModel.ui.askInProgress)
                Button {
                    viewModel.ask(question)
                    question = ""
                } label: {
                    if viewModel.ui.askInProgress {
                        ProgressView().scaleEffect(0.7)
                    } else {
                        Text("送信")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(!viewModel.ui.account.loggedIn || viewModel.ui.askInProgress
                          || question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }
}

struct ChatBubble: View {
    let msg: ChatMessage

    var body: some View {
        HStack {
            if msg.fromUser { Spacer(minLength: 40) }
            Text(msg.text)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(msg.fromUser ? AppTheme.primaryContainer : AppTheme.surfaceVariant)
                .foregroundColor(msg.fromUser ? AppTheme.onPrimaryContainer : .primary)
                .cornerRadius(10)
            if !msg.fromUser { Spacer(minLength: 40) }
        }
        .frame(maxWidth: .infinity, alignment: msg.fromUser ? .trailing : .leading)
    }
}
