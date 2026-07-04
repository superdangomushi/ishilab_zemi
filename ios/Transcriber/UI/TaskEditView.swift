import SwiftUI

/// 予定・課題の編集ダイアログ（Android の TaskEditDialog の移植）。
struct TaskEditView: View {
    let task: AiHelperClient.Task
    let saving: Bool
    let onSave: (String, String, String, String) -> Void
    let onDelete: () -> Void
    let onDismiss: () -> Void

    @State private var type: String
    @State private var content: String
    @State private var details: String
    @State private var deadline: String

    init(task: AiHelperClient.Task, saving: Bool,
         onSave: @escaping (String, String, String, String) -> Void,
         onDelete: @escaping () -> Void,
         onDismiss: @escaping () -> Void) {
        self.task = task
        self.saving = saving
        self.onSave = onSave
        self.onDelete = onDelete
        self.onDismiss = onDismiss
        _type = State(initialValue: task.type)
        _content = State(initialValue: task.content)
        _details = State(initialValue: task.details)
        _deadline = State(initialValue: editableDeadline(task.deadline, dateOnly: task.dateOnly))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("予定・課題を編集").font(.headline)
            HStack {
                RadioRow(selected: type != "yotei", enabled: !saving) { type = "kadai" } label: {
                    Text("課題")
                }
                RadioRow(selected: type == "yotei", enabled: !saving) { type = "yotei" } label: {
                    Text("予定")
                }
            }
            LabeledField(label: "内容", text: $content, disabled: saving)
            LabeledField(label: "期限（YYYY-MM-DD または YYYY-MM-DD HH:MM）", text: $deadline, disabled: saving)
            LabeledField(label: "詳細", text: $details, disabled: saving, multiline: true)
            HStack {
                Button("削除", role: .destructive, action: onDelete)
                    .disabled(saving)
                Spacer()
                Button("キャンセル", action: onDismiss)
                    .disabled(saving)
                Button(saving ? "保存中…" : "保存") {
                    onSave(type, content, details, deadline)
                }
                .buttonStyle(.borderedProminent)
                .disabled(saving || content.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            Spacer()
        }
        .padding(16)
        .presentationDetents([.medium, .large])
    }
}

/// ラベル付きテキスト入力（OutlinedTextField 相当）。
struct LabeledField: View {
    let label: String
    @Binding var text: String
    var disabled = false
    var multiline = false
    var secure = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.caption).foregroundColor(.secondary)
            Group {
                if secure {
                    SecureField("", text: $text)
                } else if multiline {
                    TextField("", text: $text, axis: .vertical)
                        .lineLimit(2...5)
                } else {
                    TextField("", text: $text)
                }
            }
            .textFieldStyle(.roundedBorder)
            .autocorrectionDisabled()
            .textInputAutocapitalization(.never)
            .disabled(disabled)
        }
    }
}

func editableDeadline(_ deadline: String?, dateOnly: Bool) -> String {
    guard let deadline, !deadline.isEmpty else { return "" }
    let s = deadline.replacingOccurrences(of: "T", with: " ")
    return String(s.prefix(dateOnly ? 10 : 16))
}

/// サーバーの deadline 文字列を "YYYY-MM-DD HH:MM"（日付のみなら日付）へ整形。
func formatDeadline(_ deadline: String?, dateOnly: Bool) -> String {
    guard let deadline, !deadline.isEmpty else { return "未定" }
    let s = deadline.replacingOccurrences(of: "T", with: " ")
    return String(s.prefix(dateOnly ? 10 : 16))
}
