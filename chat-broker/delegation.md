# Danh mục uỷ quyền cho AI

Mỗi loại việc AI làm thay một người có một id và một mức. Chat broker nhúng file này và trả nó ở
`GET /v1/delegation`. Chỉ đổi file này qua commit và deploy broker.

Mức:

- `ai`: AI tự làm.
- `ai-report`: AI tự làm, rồi ghi một dòng vào Cần lưu ý của chủ để chủ xem lại.
- `human`: chủ quyết. AI chuẩn bị đủ (bằng chứng, lựa chọn, lệnh viết sẵn), đưa lên Cần lưu ý của chủ, và trả lời
  người hỏi rằng việc này chờ chủ quyết. Persona không đổi được mức của nhóm này.

Persona của mỗi người chỉnh mức cho AI của chính người đó bằng cách nêu id, ví dụ "`mr.merge`: ai". Persona không
chỉnh được id mức `human` và không đặt tên loại việc mới. Việc không có trong danh mục là `ai-report`, trừ khi nó chạm
một loại `human`.

Tin AI gửi có quyết định thay chủ thì kết thúc bằng một dòng căn cứ:

- `Delegation: <id> · <handle>` khi AI quyết theo mức `ai` hoặc `ai-report`.
- `Decided by <handle>: <message-key>` khi việc mức `human` đã được chính người đó quyết. `<message-key>` là key của
  tin người đó tự gõ trong cùng cuộc trò chuyện, không qua agent. Broker kiểm dòng này; thiếu hay sai thì việc được
  đưa lên Cần lưu ý của chủ.

| id | Việc | Mức |
|---|---|---|
| `chat.reply` | Trả lời tin nhắn thay chủ | ai |
| `status.answer` | Trả lời trạng thái tra được: MR, pipeline, task, ai đang làm gì | ai |
| `investigate.read` | Điều tra chỉ-đọc, kể cả trên prod | ai |
| `work.coordinate` | Giao, nhắc, chuyển việc cho đồng đội; mở nhóm chat | ai |
| `mr.review` | Review MR và kết luận approve hay changes-requested | ai |
| `docs.write` | Viết, sửa doc và file review | ai |
| `mr.merge` | Merge MR đã có review approve đúng SHA; merge mà tự deploy prod thuộc `prod.irreversible` | ai-report |
| `ops.reversible` | Thao tác vận hành đảo ngược được: restart pod, retry job, sửa Jira | ai-report |
| `priority.team` | Chốt ưu tiên giữa các task trong team | ai-report |
| `policy.team` | Chính sách kỹ thuật áp cho cả team: CI gate, ADR chung | ai-report |
| `prod.irreversible` | Deploy prod, chạy migration, sửa hoặc xoá data prod | human |
| `people` | Nghỉ phép, lương, thưởng, đánh giá hiệu suất, tuyển dụng | human |
| `commitment.external` | Hứa deadline hay nhận scope với cấp trên, PM, khách hàng, vendor | human |
| `access` | Cấp hoặc thu hồi credential, rotate key, thêm quyền admin | human |
