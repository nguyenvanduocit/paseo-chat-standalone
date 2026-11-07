# Chat broker: API và lưu trữ

Chat broker (crate Rust `chat-broker/`) là tiến trình duy nhất đọc và ghi thư mục chat. Phần server của chat plugin trên cùng máy gọi nó qua HTTP và nghe sự kiện qua SSE. Vì sao một daemon phục vụ nhiều người và danh tính đến từ client: [`standalone.md`](standalone.md).

## Thành phần

| Thành phần | Ở đâu | Việc |
|---|---|---|
| Chat broker | Binary `chat-broker`, một tiến trình trên máy chạy daemon, mặc định `http://127.0.0.1:8080` | Giữ chat trong bộ nhớ, ghi từng thay đổi xuống file, đẩy sự kiện |
| Dữ liệu | `CHAT_BROKER_DATA_DIR` | Layout file ở dưới |
| Danh tính | Khóa `CHAT_BROKER_KEY` của daemon và header `X-Chat-Handle` | Handle là người client đã chọn |
| Phân loại | OpenRouter, model `CHAT_BROKER_CLASSIFY_MODEL` | Gắn `task`, `severity`, `notify`, `needsReply` cho mỗi tin mới |
| Client | `chat-plugin/server/chat.ts` (`openChatClient`) | Gọi API, mở luồng sự kiện cho từng người, đưa sự kiện tới tab, inbox, assistant và watch của agent |

Cấu hình của chat broker (biến môi trường): `CHAT_BROKER_KEY` (bắt buộc, ít nhất 16 ký tự, đúng khóa daemon có), `BIND` (`127.0.0.1`), `PORT` (8080), `METRICS_PORT` (9090, cổng riêng của `GET /metrics`), `CHAT_BROKER_DATA_DIR` (`/data`), `CHAT_BROKER_MAX_IMAGE_STORE_BYTES` (4 GiB), `OPENROUTER_KEY` (không có thì không phân loại), `OPENROUTER_URL` (`https://openrouter.ai/api/v1`), `CHAT_BROKER_CLASSIFY_MODEL` (`anthropic/claude-haiku-5.5`), `GRAFANA_TOKEN` và `GRAFANA_URL` (đặt cả hai hoặc không cái nào; không có thì không kéo alert), `SIGNAL_POLL_SECONDS` (30).

## Xác thực

Mọi route trừ `GET /healthz` và `GET /v1/images/<sha256>` đòi `Authorization: Bearer <CHAT_BROKER_KEY>` và `X-Chat-Handle: <handle>`. `GET /metrics` nằm ở cổng riêng. Ảnh không cần khóa để Markdown của Paseo vẽ thẳng từ URL bằng thẻ ảnh thường; id của ảnh là SHA-256 của byte, chỉ người đã thấy tin hoặc đang giữ ảnh mới biết.

1. Khóa sai hoặc thiếu thì `401 {"error":"unauthorized"}`. Khóa được so qua SHA-256, nên thời gian so không lộ khóa khớp được bao nhiêu.
2. Handle là header `X-Chat-Handle`. Thiếu header hoặc header không khớp `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` thì `400 {"error":"bad_handle"}`.

Khóa chỉ chặn tiến trình khác trên máy gọi vào cổng; handle là lời của client. Mọi người dùng chung daemon cùng một OS user, nên broker không giữ được bí mật giữa họ.

Lỗi luôn có dạng `{"error": "<mã>", "message": "<câu cho người đọc>"}`, `message` viết tiếng Việt vì plugin đưa thẳng nó ra màn hình.

## Kiểu dữ liệu

- **Conversation id** (chuỗi): `dm:<handle>,<handle>,...` (handle sắp xếp, không trùng, 2 đến 10 người) hoặc `room:<encodeURIComponent(project)>/<encodeURIComponent(room)>` (project và room mỗi cái 1 đến 200 ký tự). Id khác dạng này trả `400 bad_conversation`. Tin nhắn riêng mà người gọi không là thành viên trả `403 not_a_member`.
- **Message** (đúng như trên file): `{ key, id, author, body, createdAt, attachments: [{ id, mime, width, height }], replyTo?, via?: { agent, agentId? }, priority: "normal"|"urgent", wait?: true, status?: Status }`. Tin trên file không có `priority` đọc là `normal`. `wait` chỉ có khi agent chờ trả lời; `status` chỉ có trên tin trả lời.
- **Status**: `"working"|"input-required"|"completed"|"failed"|"canceled"`. Ba trạng thái cuối đóng yêu cầu.
- **Yêu cầu**: tin có `wait` mà chưa nằm trong chuỗi `replyTo` của một yêu cầu khác. Mọi tin trong chuỗi trả lời của nó thuộc nó. Trạng thái của yêu cầu là `status` mới nhất trong chuỗi, `open` khi chưa có.
- **MessageView**: Message cộng:
  - `reply`: Message được trả lời (bản đầy đủ) hoặc `null`. Plugin tự tạo đoạn trích (`preview`).
  - `classification`: Classification hoặc `null` khi chưa phân loại.
  - `request`: `{ key, state, at }` của yêu cầu mà tin mở hoặc nằm trong, hoặc `null`. `state` là `open` hoặc một Status; `at` là key của tin đặt trạng thái đó.
- **Classification**: `{ task: bool, severity: "low"|"medium"|"high"|"critical", notify: bool, needsReply: bool, reason, decision?, model, classifiedAt }`. `decision` là id trong danh mục uỷ quyền của loại việc mà tin do AI gửi quyết thay một người; không có khi tin không quyết gì.
- **Key**: `<13 chữ số ms>-<id>`, id khớp `^[A-Za-z0-9-]{8,64}$`. Chat broker cấp ms bằng `max(giờ hiện tại, ms của key mới nhất trong cuộc trò chuyện + 1)`, nên key tăng ngặt trong mỗi cuộc trò chuyện.
- **Person**: `{ handle, presence: "active"|"afk"|"offline", lastSeenAt, activeAt, projects, agents }`. `offline` khi `at` cũ hơn 60 giây; `afk` khi còn online mà `activeAt` cũ hơn 5 phút; số `agents` báo cách đây quá 60 giây tính là 0. Sắp theo handle.
- **Summary**: `{ id, conversation: <id>, last: Message|null, unread, mentioned, urgent, lastRead }`. `unread` đếm tin của người khác có key lớn hơn `lastRead`; `mentioned` là có tin chưa đọc nào nhắc `@<handle người gọi>`; `urgent` là có tin chưa đọc nào `priority: "urgent"` gửi tới người gọi: trong DM, hoặc nhắc `@<handle người gọi>` trong room.

## Route

`c` là conversation id. Route có thân nhận JSON; thân tối đa 15 MiB. Thân phải tới đủ trong 15 giây, riêng `POST /v1/images` trong 120 giây; quá hạn thì `408 timeout`.

| Route | Thân / query | Trả về | Việc |
|---|---|---|---|
| `GET /healthz` | | `{ok:true}` | Không cần credential |
| `POST /v1/presence` | `{ projects?: string[], idleMs?: int }` | `{}` | Người gọi đang mở Paseo. Không có `projects` thì giữ project đã lưu. Ghi `people/<handle>.json` ngay khi trạng thái active/afk đổi, nếu không thì tối đa 20 giây một lần. `idleMs` là cách đây bao lâu cửa sổ có input. Có thể phát sự kiện `people` |
| `POST /v1/agents` | `{ running: int ≥ 0 }` | `{}` | Số agent đang chạy của host. Ghi ngay khi số đổi, giữ nguyên thì tối đa 20 giây một lần |
| `POST /v1/register` | | `{}` | Đưa handle vào `people/` nếu chưa có (`{at:0, projects:[]}`) |
| `GET /v1/inbox` | | `{ me, conversations: Summary[], people: Person[], focus: {conversation, at}\|null }` | Summary sắp theo key tin cuối, mới trước |
| `GET /v1/people` | | `Person[]` | |
| `GET /v1/delegation` | | `{ version, categories: {id, work, level}[], text }` | Danh mục uỷ quyền broker được build cùng (`chat-broker/delegation.md`). `level` là `ai`, `ai-report` hoặc `human`; `version` là 16 ký tự đầu SHA-256 của `text` |
| `GET /v1/conversations` | | `string[]` | Id của room người gọi đã đọc, viết hoặc được mời, và tin nhắn riêng có người gọi |
| `GET /v1/messages` | `c`, `after` (key, 13 chữ số ms, hoặc rỗng), `limit` (1..200, mặc định 200) | `{ messages: MessageView[] }` | Tin có key lớn hơn `after`, cũ trước. Không đánh dấu đã đọc |
| `GET /v1/messages/latest` | `c`, `limit` (1..200) | `{ messages: MessageView[] }` | `limit` tin mới nhất, cũ trước |
| `POST /v1/messages` | `{ conversation, id, body, attachments: string[], replyTo?, via?, priority?, wait?, status? }` | `{ message: MessageView }` | Gửi. Thứ tự kiểm ở dưới |
| `POST /v1/reads` | `{ conversation, key? }` | `{}` | Đánh dấu đã đọc tới `key`, không có `key` thì tới tin mới nhất. Không bao giờ lùi con trỏ |
| `POST /v1/joins` | `{ conversation }` | `{}` | Tạo cuộc trò chuyện nếu chưa có, ghi `reads/<handle>.json` = `{key:""}` nếu chưa có |
| `POST /v1/focus` | `{ conversation }` | `{}` | Ghi `focus/<handle>.json`, phát sự kiện `focus` cho chính handle đó |
| `GET /v1/assistant` | | `AssistantState\|null` | `{ workspaceId: string\|null, from: string, delivered: {[id]: key} }`; file sai dạng đọc thành `null` |
| `PUT /v1/assistant` | `AssistantState` | `{}` | |
| `GET /v1/deliveries` | | `{ deliveries: {agent, conversation, mentions: MessageView[], replies: MessageView[]}[] }` | Những gì đang chờ giao cho agent của host người gọi. Quy tắc chọn tin ở mục **Watch** dưới đây |
| `POST /v1/deliveries` | `{ agent, conversation, through }` | `{}` | Agent đã nhận tới key `through`: con trỏ tiến tới đó, mention tới đó hết chờ. Không bao giờ lùi |
| `POST /v1/watches/end` | `{ agent, conversation }` | `{}` | Agent không còn trên host: bỏ watch của nó ở cuộc trò chuyện đó |
| `GET /v1/search` | `q` (1..200 ký tự), `c` (không có thì tìm mọi cuộc trò chuyện của người gọi) | `{ messages: (MessageView & {conversation})[] }` | Mỗi từ của `q` phải là đầu một từ trong tin, không phân biệt hoa thường và dấu. Tối đa 50, mới trước |
| `POST /v1/images` | thân là byte ảnh | `{ attachment }` | Thứ tự kiểm ở dưới |
| `GET /v1/images/<sha256>` | | byte ảnh, `Content-Type` theo metadata | Không cần credential. `Cache-Control: private, max-age=31536000, immutable` |
| `GET /v1/events` | | `text/event-stream` | Luồng sự kiện ở dưới |
| `POST /v1/signals` | `{ alert }` | `{ signal: Signal }` | Tạo signal. Tên sai mẫu `400 bad_alert`, đã có `409 signal_exists` |
| `POST /v1/signals/delete` | `{ alert }` | `{}` | Xóa signal, subscription và `active`, giữ lịch sử room. Không có `404 signal_not_found`, không phải người tạo `403 not_creator` |
| `GET /v1/signals` | | `{ signals: Signal[] }` | Mọi signal, theo tên |
| `POST /v1/signals/subscribe` | `{ alert, agent?: string\|null }` | `{ signal }` | Subscription của người gọi, thay cái cũ. `agent` sai dạng `400 bad_request`, không có signal `404 signal_not_found` |
| `POST /v1/signals/unsubscribe` | `{ alert }` | `{ signal }` | Bỏ subscription của người gọi; chưa có thì không đổi gì |

**Gửi tin** đọc `priority` cùng các trường khác trước mọi kiểm tra: vắng hoặc `null` là `normal`, khác `normal`/`urgent` thì `400 bad_request`. `status` khác năm giá trị Status thì `400 bad_request`. `wait: true` chỉ hợp lệ khi có `via.agentId`, không thì `400 bad_request`. Rồi kiểm theo thứ tự: `id` khớp mẫu (`400 bad_id`); thân không trống hoặc có ảnh (`400 empty`); thân tối đa 4000 ký tự (`400 too_long`); tối đa 4 ảnh (`400 too_many_images`); `status` cần `replyTo` (`400 bad_request`); tin có status đóng yêu cầu không được `wait` (`400 bad_request`); quyền thành viên. Sau đó, đã có tin cùng `id` trong cuộc trò chuyện thì trả tin đó nếu cùng tác giả, cùng thân, cùng `priority` và cùng `status`, không thì `409 id_taken`. Tiếp theo: `replyTo` phải có trong cuộc trò chuyện (`400 reply_not_found`); tin có `status` phải trả lời một tin thuộc một yêu cầu (`400 not_a_request`); giới hạn tốc độ của handle (`429 rate_limited`); tin có `via` thì thêm giới hạn tốc độ tin agent của cuộc trò chuyện, 20 tin một lúc rồi 1 tin mỗi 30 giây cho mọi agent cộng lại (`429 slow_down`, `message` bảo agent nhắn chậm lại và gửi lại sau bao nhiêu giây); mọi ảnh phải đã tải lên (`400 image_missing`). Có `wait` thì ghi watch của `via.agentId`: con trỏ là key mới, hạn ít nhất 24 giờ kể từ giờ. Tin không có `via` mà nhắc agent (`@[title](agent:<id>)`) thì ghi watch cho mỗi agent đó, kèm key tin vào `mentions`. Watch ghi vào `watches/<handle>.json` trước tin, để một lần thử lại sau lỗi ghi vẫn có watch. Ghi tin, ghi `reads/<handle>.json` bằng key mới, và với room thì ghi `invited/<h>.json` = `{by, at}` cho mỗi handle được nhắc (không tính người gửi) có trong `people/`. Cuối cùng phát sự kiện `message`, và `deliveries` cho mỗi handle có watch còn hạn ở cuộc trò chuyện đó.

**Tải ảnh**: giới hạn tốc độ (`429 rate_limited`), tối đa 10 MiB (`413 too_large`), loại ảnh từ byte (`400 not_an_image`), xóa metadata, id là SHA-256 của byte đã xóa metadata. Đã có id đó thì trả luôn; tổng kho vượt giới hạn thì `507 store_full`. Ghi `images/<id>` rồi mới ghi `images/<id>.json` = `{mime, width, height, size}`.

## Signal

Quy tắc nằm ở `chat-broker/src/signals.rs`.

- Tên alert khớp `^[a-z0-9][a-z0-9-]{0,62}$`; room của nó là `room:signals/<alert>`.
- **Signal** = `{ alert, conversation, createdBy, createdAt, firing, lastChangeAt: ms|null, subscriptions: [{ handle, agent: string|null, at, handedOverAt: ms|null }] }`. `firing` là số alert trong `active`; `lastChangeAt` là ms của key tin cuối do `grafana` viết vào room. `agent: null` là AI Assistant của handle.
- **Kéo alert**: có `GRAFANA_TOKEN` thì cứ `SIGNAL_POLL_SECONDS` giây chat broker gọi `GET {GRAFANA_URL}/api/alertmanager/grafana/api/v2/alerts?active=true&silenced=false&inhibited=false&filter=signal=~".+"` với `Authorization: Bearer <token>`, timeout 10 giây, thân tối đa 5 MiB, ngoài khóa của chat. Trả khác `200`, thân quá lớn, sai JSON, hoặc có alert thiếu `fingerprint` (1-64 ký tự) hay `startsAt` là lần kéo lỗi: chỉ tăng `polls_total{result="error"}`, log một dòng warning khi bắt đầu lỗi và một dòng info khi hết lỗi, không đổi signal nào. Nhãn `signal` chọn signal, alert có nhãn không ứng với signal nào chỉ được đếm (`unrouted_alerts`).
- **Mỗi lần kéo thành công**, với từng signal: alert có mặt mà chưa ở `active` là alert mới, cùng nằm trong một tin firing; alert ở `active` mà vắng lần này và cả lần kéo thành công trước là resolved; vắng lần đầu thì chỉ được nhớ (trong bộ nhớ), có mặt lại trước lần vắng thứ hai thì không viết gì. Tin firing có `id` = `f` + 40 ký tự hex đầu của SHA-256(tên signal, `createdAt` và các `fingerprint|startsAt` đã sắp xếp, mỗi thứ một dòng). Các alert resolved cùng lần và cùng tin firing thành một tin resolved, `replyTo` là tin firing đó nếu nó còn trong room, `id` = `r` + 40 hex của SHA-256(key tin firing và các fingerprint đã sắp xếp). Tin viết trước, file `signals/<alert>.json` (`active`) ghi sau; tin có `id` đã có trong room thì không viết lại, nên một bước làm lại sau lần ghi lỗi không ra tin trùng. Một signal ghi lỗi thì được đếm (`store_errors_total`) và các signal khác vẫn đi tiếp trong lần kéo đó. Mỗi tin ghi qua đúng đường của `POST /v1/messages` (file, read cursor, `invited`, sự kiện `message` và `deliveries`), tác giả `grafana`, không `via`, không ảnh, `priority: normal`.
- **Thân tin** (Markdown, tối đa 4000 ký tự, cắt từ cuối kèm `…`): dòng đầu `**[FIRING]** N alert` hoặc `**[RESOLVED]** N alert`, rồi mỗi alert một dòng, tối đa 20 dòng, phần còn lại là `- và N alert khác`. Dòng firing: `alertname`, `summary` (không có thì `description`, tối đa 300 ký tự), tối đa 4 nhãn khác `alertname`, `signal` và `__…`, link `[Grafana](<generatorURL>)` khi URL là http(s). Dòng resolved: `alertname` và `startsAt`. Nhãn và giá trị nằm trong code span, bỏ backtick và ký tự điều khiển, nên không thành Markdown hay mention.
- **Subscribe có `agent`**: chat broker thêm watch của agent đó ở room vào `watches/<handle>.json`, con trỏ là key mới nhất của room (`""` khi room trống); watch agent đã có thì giữ con trỏ. **`POST /v1/watches/end`** cho agent đang là đích subscription của người gọi ở room đó: đổi `agent` thành `null`, ghi `handedOverAt`, rồi mới xóa watch.

## Watch

Quy tắc nằm ở `chat-broker/src/watches.rs`.

- **Sống** khi còn trong hạn (`until`, 24 giờ kể từ lần cuối agent gửi có `wait` hoặc được nhắc), hoặc khi chủ watch đã subscribe agent đó vào signal của room (sống chừng nào subscription còn trỏ tới agent). Ngoài hai điều đó, watch vẫn sống khi agent đã viết vào một yêu cầu còn mở trong cuộc trò chuyện và yêu cầu đó gửi chưa quá 14 ngày, hoặc khi người khác đã đóng yêu cầu bằng một tin sau con trỏ. Watch không sống thì không được tính, và bị xóa ở lần ghi `watches/<handle>.json` kế tiếp.
- **`mentions`**: tin người gọi nhắc agent mà agent chưa nhận.
- **`replies`**: tin của người khác sau con trỏ, không phải `working`, và liên quan tới agent. Liên quan nghĩa là tin đó:
  - nằm trong yêu cầu agent đã viết vào; hoặc
  - trả lời (qua chuỗi `replyTo`) một tin agent đã gửi; hoặc
  - không trả lời tin nào, trong DM, trong room của signal mà agent là đích subscription, hoặc trong room khi watch còn trong hạn 24 giờ; hoặc
  - là tin của `grafana` trong room của signal mà agent là đích subscription (tin resolved trả lời tin firing).

## Sự kiện (`GET /v1/events`)

Mỗi sự kiện là `event: <loại>` và `data: <JSON>`. Mỗi 15 giây chat broker gửi một dòng comment `: ping` để proxy ở giữa (nếu có) không đóng kết nối. Không có replay: client vừa (kết nối lại) thì đọc lại trạng thái qua route thường rồi mới dựa vào sự kiện.

| Loại | Dữ liệu | Ai nhận |
|---|---|---|
| `ready` | `{ me }` | Người vừa kết nối, ngay khi luồng mở |
| `message` | `{ conversation, key, author }` | Mọi người với room, chỉ thành viên với tin nhắn riêng |
| `classified` | `{ conversation, key, classification }` | Giống `message` |
| `delegation` | `{ conversation, key, decision }` | Chỉ tác giả của tin: tin có `via` quyết một loại việc mức `human` mà không có dòng `Decided by <handle>: <key>` trỏ tới một tin trước nó trong cùng cuộc trò chuyện, do chính `<handle>` viết, không có `via` |
| `read` | `{ conversation, key }` | Chỉ người đã đọc (để các cửa sổ khác của họ cập nhật) |
| `focus` | `{ conversation, at }` | Chỉ handle đó |
| `people` | `{}` | Mọi người, khi presence hoặc số agent của ai đó đổi |
| `deliveries` | `{}` | Chỉ handle có watch ở cuộc trò chuyện vừa có tin: có thể có thứ cần giao, đọc `GET /v1/deliveries` |

## Lưu trữ

Layout giữ nguyên như khi plugin còn ghi file, nên dữ liệu cũ đọc được ngay và host vẫn đọc được bằng shell:

```
threads/<h(project)>/project.json                 { project }
threads/<h(project)>/<h(room)>/room.json          { project, room }
dms/<h(members joined by ",")>/conversation.json  { members }
<conversation>/messages/<key>.json                Message, ghi một lần
<conversation>/classifications/<key>.json         Classification của tin đó, ghi một lần sau tin
<conversation>/reads/<handle>.json                { key }
<conversation>/invited/<handle>.json              { by, at }
people/<handle>.json                              { at, activeAt, projects }   (ms)
agents/<handle>.json                              { at, running }
focus/<handle>.json                               { conversation, at }
images/<sha256>, images/<sha256>.json             byte ảnh, rồi metadata
assistant/<handle>.json                           AssistantState
watches/<handle>.json                             [{ agent, conversation, after, until, mentions }]
signals/<alert>.json                              { alert, createdBy, createdAt, subscriptions: [{ handle, agent, at, handedOverAt }], active: { <fingerprint>: { message, startsAt, alertname } } }
```

Yêu cầu và số tin agent liên tiếp không lưu ở đâu: broker tính lại chúng từ các tin, mỗi lần nạp và mỗi tin mới.

`h(x)` là 32 ký tự hex đầu của SHA-256 của `x`. Mọi lần ghi là ghi ra `<path>.<6 byte hex>.partial` rồi rename. Lúc khởi động, chat broker nạp toàn bộ, bỏ qua (có ghi log) file không hợp lệ và file `.partial`, và bỏ một tin nhắn riêng khi thư mục của nó không đúng với `h(members)`. Chat broker trả lời một request chỉ sau khi đã ghi xong file.

## Phân loại

Có `OPENROUTER_KEY` thì sau mỗi tin có chữ, chat broker hỏi model (tối đa 4 tin cùng lúc, mỗi lần chờ tối đa 30 giây) bằng tin đó, 6 tin trước nó và tin nó trả lời. Câu trả lời đúng schema thì broker ghi `classifications/<key>.json` rồi phát `classified`. Gửi tin không chờ bước này. OpenRouter lỗi hoặc trả sai schema thì tin ở lại `classification: null`, và log có dòng warning `message <key> in <c> stays unclassified: <lý do>`, không chứa nội dung tin. Lúc khởi động, broker phân loại các tin trong 60 phút gần nhất còn thiếu classification. Tin chỉ có ảnh thì không phân loại.

## Metric (`GET /metrics`)

Cổng `METRICS_PORT`, định dạng text của Prometheus, không cần credential. Mọi route khác ở cổng này trả `404`. Lúc khởi động chat broker in `metrics on <ip>:<port>` trước `listening on <ip>:<port>`; `METRICS_PORT=0` chọn cổng trống (binary `chat-broker-harness` tự dùng 0 khi không có `METRICS_PORT`). Counter và histogram đếm từ lúc tiến trình chạy; gauge tính lúc scrape.

| Metric | Kiểu | Giá trị |
|---|---|---|
| `chat_broker_messages_sent_total` | counter | Mọi tin đã ghi (người, agent, `grafana`) |
| `chat_broker_event_streams` | gauge | Luồng `GET /v1/events` đang mở |
| `chat_broker_deliveries_oldest_pending_seconds` | gauge | Tuổi tin cũ nhất đang chờ giao cho agent (`mentions`, `replies` của mọi watch còn sống); 0 khi không có |
| `chat_broker_signal_polls_total{result}` | counter | Lần kéo alert: `ok`, `error` |
| `chat_broker_signal_last_poll_success_timestamp_seconds` | gauge | Giờ của lần kéo thành công cuối, tính bằng giây; 0 khi chưa lần nào |
| `chat_broker_signal_unrouted_alerts` | gauge | Số alert có nhãn `signal` không ứng với signal nào ở lần kéo thành công cuối |
| `chat_broker_signal_firing{alert}` | gauge | Số alert trong `active` của signal |
| `chat_broker_signal_messages_total{alert,status}` | counter | Tin firing/resolved chat broker đã viết |
| `chat_broker_signal_subscriptions{alert,target}` | gauge | Số subscription có `agent` (`agent`) và `agent: null` (`assistant`) |
| `chat_broker_signal_oldest_pending_seconds{alert}` | gauge | Tuổi tin cũ nhất trong room chưa tới một subscriber: với `agent`, tin đang chờ ở watch của nó; với `assistant`, tin của người khác sau con trỏ `max(delivered[room], from)` của `assistant/<handle>.json`. Không tính tin trước `at` của subscription. 0 khi không có |
| `chat_broker_signal_delivery_seconds{target}` | histogram | Mỗi tin của `grafana` mà con trỏ vượt qua: `agent` khi `POST /v1/deliveries` tiến con trỏ watch, `assistant` khi `PUT /v1/assistant` của một handle có subscription `agent: null` ở signal đó tiến `delivered[room]` (không tính phần trước `from` và trước `at` của subscription; AI Assistant không subscribe cũng đi qua room signal nhưng không tính). Giá trị là giờ hiện tại trừ ms của key. Bucket 1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600, 21600 giây |
| `chat_broker_signal_handovers_total{alert}` | counter | Số lần đích agent mất và AI Assistant nhận thay |
| `chat_broker_signal_store_errors_total{alert}` | counter | Số lần kéo thành công mà bước của signal không ghi được (tin hoặc `signals/<alert>.json`). Signal khác vẫn chạy; lần kéo sau làm lại bước đó, `id` cố định nên không ra tin trùng |
| `chat_broker_delegation_breaches_total{handle}` | counter | Số sự kiện `delegation` đã phát, theo chủ của AI gửi tin |

## Vận hành

- Build: `cargo build --release` trong `chat-broker/`; binary ở `target/release/chat-broker`.
- Chạy: `CHAT_BROKER_KEY=<khóa> CHAT_BROKER_DATA_DIR=~/.paseo/chat-broker ./target/release/chat-broker`; daemon Paseo chạy với cùng `CHAT_BROKER_KEY`.
- Kiểm tra: `curl http://127.0.0.1:8080/healthz`.
- Test: `cargo test` trong `chat-broker/`; end to end với chat plugin: `npm test` trong `chat-plugin/` (tự build `chat-broker` bằng cargo, hoặc dùng binary ở `CHAT_BROKER_BIN`).
