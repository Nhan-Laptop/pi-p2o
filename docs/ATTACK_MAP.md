# Ánh xạ MITRE ATT&CK cho p2o

Bảng crosswalk từ 104 test WSTG trong scope sang 59 kỹ thuật [MITRE ATT&CK Enterprise](https://attack.mitre.org/) (bản ghim `v18.1`, dữ liệu đọc ngày 2026-10-28). Đây là **tập con tuyển chọn** của ATT&CK, không phải toàn bộ matrix: bản v18 có 216 technique và 475 sub-technique, bảng này giữ 59. Việc một test có technique không có nghĩa là p2o phát hiện được technique đó; độ phủ ánh xạ không phải độ phủ kiểm thử và không phải năng lực của p2o.

Dữ liệu nằm ở `src/attack-map.ts` cùng ba hàm thuần `isAttackTechnique`, `attackTechniques`, `attackForWstg`. Bảng ở cuối trang là bản đọc được; `tests/minimal/attack-map.test.ts` ép hai bản bằng nhau. Không có trường schema, trạng thái hay tool mới: kỹ thuật được suy ra từ khóa WSTG đã có trong `questionKey`.

## Nguồn và bản ghim

- Nguồn: `https://attack.mitre.org/`, bản Enterprise `v18.1`, dữ liệu đọc ngày 2026-10-28 tại `https://attack.mitre.org/versions/v18/techniques/`. v18.1 hiệu lực từ 2025-10-28 đến 2026-04-27; site hiện hành có thể đã lên bản mới hơn, nên ID và tên trong file được đối chiếu với đúng bản ghim.
- Mỗi dòng trong `ATTACK_TECHNIQUES` là `{ id, name, tactic, url }`. `tactic` là tactic chính dùng để sắp thứ tự; ATT&CK gán nhiều tactic cho một số kỹ thuật (ví dụ T1078), file chỉ giữ một tactic và không khẳng định đó là toàn bộ danh sách tactic của kỹ thuật.
- `url` theo dạng `https://attack.mitre.org/techniques/T1190/`; sub-technique dùng path `https://attack.mitre.org/techniques/T1021/001/` đúng như site in, không dùng dấu chấm trong URL.
- 59 kỹ thuật được chọn theo tiêu chí chạm được từ một engagement web/hạ tầng/AD/cloud: initial access, execution, credential và session, discovery, collection, C2/exfil, impact, cộng các nhãn infra/AD/cloud cần cho finding không gắn WSTG. Không có kỹ thuật Resource Development nào: p2o không quan sát việc kẻ tấn công tự phát triển capability.

## Cách p2o suy ra kỹ thuật

- Khóa WSTG viết thường (`wstg-athz-04`) đã là `questionKey` của work identity và coverage cell, và case/coverage đã mang khóa đó. `attackForWstg([...])` nhận đúng các khóa này và trả technique đã dedupe, sắp theo thứ tự tactic rồi id. Báo cáo in ID cạnh khóa WSTG sẵn có mà không cần model ghi thêm gì: không có trường `techniques` trong case, coverage hay bất kỳ schema nào.
- `attackTechniques(ids)` tra một danh sách ID bất kỳ (dedupe, bỏ ID lạ, sắp xác định); `isAttackTechnique(id)` chỉ kiểm tra ID có trong tập con. Không hàm nào chạm target, evidence hay coverage.
- Chưa có đường suy ra cho finding không gắn khóa WSTG. 23 kỹ thuật trong catalog không xuất hiện ở bảng dưới (ví dụ T1021 Remote Services, T1003 OS Credential Dumping, T1078.004 Cloud Accounts); chúng được giữ cho finding hạ tầng/AD/cloud nhưng hiện **không có đường suy ra**, nên đừng in chúng như thể đã suy ra từ một test.
- Không có ánh xạ 1-1. ATT&CK không có technique cho CSRF, clickjacking, business logic hay kiểm soát truy cập phía ứng dụng, nên các dòng đó trỏ tới technique gần nhất ở bước delivery/effect. Đọc ID cùng test và finding, không đọc như quan hệ nhân quả.

## Ý nghĩa cột và giới hạn

| Cột | Ý nghĩa |
|---|---|
| Key | ID WSTG viết thường, đúng dạng `wstgKey` dùng làm `questionKey`; xem tiêu đề và support trong `docs/WSTG_MAP.md`. |
| Techniques | 1–3 ID ATT&CK mà test chạm tới, cách nhau bởi dấu phẩy; thứ tự trong ô là thứ tự dữ liệu, helper sắp lại theo tactic rồi id. |

Bốn test support `O` không được ánh xạ có chủ đích: `wstg-info-01`, `wstg-conf-01`, `wstg-conf-10`, `wstg-conf-11`. Chúng nằm ngoài phạm vi tri thức của thư viện (search engine, hạ tầng mạng, DNS/cloud của bên thứ ba), nên không có dòng nào để suy ra technique. Mọi test có support khác `O` có đúng một dòng; `src/attack-map.ts` từ chối load nếu thiếu dòng, thừa dòng, khóa không phải test trong scope hoặc ID không tồn tại trong catalog.

Đây là **tri thức ánh xạ**, không phải khả năng phát hiện, không phải coverage của một lần assessment và không phải bằng chứng năng lực. Một technique trong báo cáo chỉ nói rằng test tương ứng đã chạm tới hành vi đó; nó không nói p2o chứng minh được hành vi, không nói target dính lỗi và không thay thế finding hay case.

## Bảng crosswalk WSTG → ATT&CK

Pinned to MITRE ATT&CK Enterprise v18.1, data read 2026-10-28. Key là ID WSTG viết thường dùng làm questionKey; Techniques là 1–3 ID ATT&CK mà test chạm tới. Đây là tập con tuyển chọn và là phán đoán, không phải khẳng định của ATT&CK về test. Test support `O` không có dòng.

| Key | Techniques |
|---|---|
| wstg-info-02 | T1592, T1595 |
| wstg-info-03 | T1592, T1083 |
| wstg-info-04 | T1595, T1590 |
| wstg-info-05 | T1592, T1083 |
| wstg-info-06 | T1595, T1083 |
| wstg-info-07 | T1083, T1595 |
| wstg-info-08 | T1592, T1595 |
| wstg-info-10 | T1590, T1592 |
| wstg-conf-02 | T1592, T1190 |
| wstg-conf-04 | T1083, T1552 |
| wstg-conf-05 | T1083, T1133 |
| wstg-conf-06 | T1190, T1485 |
| wstg-conf-07 | T1557, T1595 |
| wstg-conf-09 | T1083, T1552 |
| wstg-conf-12 | T1189, T1204 |
| wstg-conf-13 | T1190, T1083 |
| wstg-conf-14 | T1189, T1204 |
| wstg-conf-15 | T1548, T1190 |
| wstg-idnt-01 | T1087, T1078 |
| wstg-idnt-02 | T1136, T1087 |
| wstg-idnt-03 | T1136, T1098, T1087 |
| wstg-idnt-04 | T1087, T1110 |
| wstg-athn-02 | T1078, T1110 |
| wstg-athn-03 | T1110, T1531 |
| wstg-athn-04 | T1190, T1078 |
| wstg-athn-05 | T1555, T1539 |
| wstg-athn-06 | T1539, T1005 |
| wstg-athn-07 | T1110, T1550 |
| wstg-athn-08 | T1110, T1078 |
| wstg-athn-09 | T1098, T1531 |
| wstg-athn-10 | T1078, T1550 |
| wstg-athn-11 | T1556.006, T1110 |
| wstg-athz-01 | T1083, T1005 |
| wstg-athz-02 | T1190, T1078 |
| wstg-athz-03 | T1068, T1548 |
| wstg-athz-04 | T1213, T1078 |
| wstg-athz-05 | T1528, T1550 |
| wstg-sess-01 | T1539, T1550 |
| wstg-sess-02 | T1539 |
| wstg-sess-03 | T1539, T1550 |
| wstg-sess-04 | T1539, T1552 |
| wstg-sess-05 | T1204, T1189 |
| wstg-sess-06 | T1539 |
| wstg-sess-07 | T1539 |
| wstg-sess-08 | T1539, T1550 |
| wstg-sess-09 | T1539, T1557 |
| wstg-sess-10 | T1528, T1550 |
| wstg-sess-11 | T1539, T1078 |
| wstg-injt-01 | T1059.007, T1189, T1204 |
| wstg-injt-02 | T1059.007, T1189, T1204 |
| wstg-injt-04 | T1190 |
| wstg-injt-05 | T1190, T1213 |
| wstg-injt-06 | T1190, T1087 |
| wstg-injt-07 | T1190, T1005 |
| wstg-injt-08 | T1190, T1059, T1005 |
| wstg-injt-09 | T1190, T1213 |
| wstg-injt-10 | T1190, T1566 |
| wstg-injt-11 | T1059, T1190 |
| wstg-injt-12 | T1059, T1190 |
| wstg-injt-13 | T1190, T1068 |
| wstg-injt-14 | T1190, T1204 |
| wstg-injt-15 | T1190, T1059.007 |
| wstg-injt-16 | T1190, T1557 |
| wstg-injt-17 | T1557, T1190 |
| wstg-injt-18 | T1059, T1190 |
| wstg-injt-19 | T1190, T1090, T1046 |
| wstg-injt-20 | T1548, T1098 |
| wstg-injt-21 | T1204, T1059 |
| wstg-injt-22 | T1059.007, T1190 |
| wstg-injt-23 | T1059, T1190 |
| wstg-errh-01 | T1592 |
| wstg-cryp-01 | T1557, T1595 |
| wstg-cryp-02 | T1190, T1557 |
| wstg-cryp-03 | T1557, T1552 |
| wstg-cryp-04 | T1557 |
| wstg-busl-01 | T1565, T1190 |
| wstg-busl-02 | T1565, T1190 |
| wstg-busl-03 | T1565 |
| wstg-busl-04 | T1565, T1499 |
| wstg-busl-05 | T1110, T1499 |
| wstg-busl-06 | T1565, T1190 |
| wstg-busl-07 | T1110 |
| wstg-busl-08 | T1505, T1190 |
| wstg-busl-09 | T1505, T1059 |
| wstg-busl-10 | T1565 |
| wstg-clnt-01 | T1059.007, T1189, T1204 |
| wstg-clnt-02 | T1059.007, T1189 |
| wstg-clnt-03 | T1189, T1059.007 |
| wstg-clnt-04 | T1566, T1189 |
| wstg-clnt-05 | T1189 |
| wstg-clnt-06 | T1189, T1059.007 |
| wstg-clnt-07 | T1213 |
| wstg-clnt-09 | T1204 |
| wstg-clnt-10 | T1071, T1572, T1539 |
| wstg-clnt-11 | T1059.007, T1539 |
| wstg-clnt-12 | T1539, T1552 |
| wstg-clnt-13 | T1539, T1213 |
| wstg-clnt-14 | T1566, T1189 |
| wstg-clnt-15 | T1059.007, T1189 |
| wstg-apit-01 | T1595, T1083 |
| wstg-apit-02 | T1213, T1078 |
| wstg-apit-03 | T1213, T1078 |
| wstg-apit-04 | T1548, T1078 |
| wstg-apit-99 | T1592, T1190 |
