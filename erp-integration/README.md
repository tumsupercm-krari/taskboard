# ต่อ ERP เข้ากับชั่วโมงทำงานของ TaskBoard

ผลลัพธ์: เวลาที่พนักงานใช้งาน ERP ถูกรวมในรายงาน "ชั่วโมงทำงาน" ของ TaskBoard แยกให้เห็นว่าอยู่ในระบบไหนเท่าไหร่ ส่วนที่ใช้สองระบบพร้อมกันนับครั้งเดียว

```
เบราว์เซอร์ + work-tracker.js  --(ทุก 30 วิ ขณะใช้งานจริง)-->  server ERP  --(API key)-->  TaskBoard
        (ไม่มีเนื้อหา/URL/คีย์บอร์ด)         รู้ว่าใครล็อกอินอยู่            POST /api/ingest/activity
```

## ขั้นตอน (ใช้เวลาประมาณครึ่งวันสำหรับทีมที่แก้ ERP ได้)

1. **ตั้งรหัสลับใน TaskBoard** สร้างข้อความสุ่มยาว 24 ตัวขึ้นไป (เช่น `openssl rand -hex 24`) แล้วตั้งตัวแปรก่อนเริ่มระบบ
   `INGEST_KEYS=erp=<รหัสลับ>`
   (ต้องการระบบอื่นเพิ่ม ใส่คั่นด้วยจุลภาค เช่น `erp=...,crm=...` แต่ละระบบมีรหัสของตัวเอง ชื่อหน้ารหัสคือชื่อที่ขึ้นในรายงาน)
2. **ใส่สคริปต์ในหน้า ERP** คัดลอก `work-tracker.js` ไปไว้ในไฟล์ static ของ ERP แล้วเพิ่มในเลย์เอาต์หลักของทุกหน้า:
   `<script src="/static/work-tracker.js" data-endpoint="/api/work-heartbeat" defer></script>`
   (ถ้า ERP ใช้ CSRF token ใส่ `data-csrf-header="X-CSRF-Token" data-csrf-meta="csrf-token"`)
3. **เพิ่ม route ใน server ERP** `POST /api/work-heartbeat` ที่ต้องล็อกอินก่อน แล้วเรียก `forwardHeartbeat(username)` โดยเอา username จาก session ของ ERP **ห้ามเอาจาก body ของคำขอ** (ไม่งั้นใครก็ส่งเวลาแทนคนอื่นได้) ตัวอย่าง Node.js อยู่ใน `forward-heartbeat.js`
4. **จับคู่ผู้ใช้** username ที่ส่งต้องตรงกับ username ใน TaskBoard (ไม่สนตัวพิมพ์เล็กใหญ่) ถ้า ERP ใช้ชื่อรูปแบบอื่น (เช่น รหัสพนักงาน) ให้แปลงก่อนส่ง หรือสร้างบัญชีใน TaskBoard ด้วย username เดียวกัน
5. **แจ้งพนักงาน** ว่าเวลาใช้งาน ERP ถูกนับรวมในรายงานชั่วโมงทำงานด้วย (ทางนโยบายบริษัทหรือประกาศภายใน)

ลองก่อนใช้จริง: `node erp-integration/demo/fake-erp.js` เปิด ERP จำลองที่ http://localhost:4000 (ใช้กับ TaskBoard ที่ตั้ง `INGEST_KEYS=erp=erp-demo-key-0123456789abcdef`)

## ตัวอย่าง server ฝั่ง ERP ภาษาอื่น

PHP:
```php
function forward_heartbeat(string $username): void {
    $ch = curl_init(getenv('TASKBOARD_URL') . '/api/ingest/activity');
    curl_setopt_array($ch, [
        CURLOPT_POST => true, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 3,
        CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Authorization: Bearer ' . getenv('TASKBOARD_API_KEY')],
        CURLOPT_POSTFIELDS => json_encode(['events' => [['username' => $username, 'at' => (int) (microtime(true) * 1000)]]]),
    ]);
    curl_exec($ch); curl_close($ch);
}
```
Python:
```python
import os, time, requests
def forward_heartbeat(username):
    requests.post(os.environ["TASKBOARD_URL"] + "/api/ingest/activity", timeout=3,
        headers={"Authorization": "Bearer " + os.environ["TASKBOARD_API_KEY"]},
        json={"events": [{"username": username, "at": int(time.time() * 1000)}]})
```
ควรเรียกไม่เกินนาทีละครั้งต่อผู้ใช้ (ตัวอย่าง Node มีตัวกันไว้แล้ว) และไม่ให้ความล้มเหลวของ TaskBoard ทำให้หน้า ERP ช้าหรือพัง (ตั้ง timeout สั้นและกลืน error)

## ใช้ log ของ ERP แทน หรือเติมย้อนหลัง

ถ้าอยากใช้ audit log ที่ ERP มีอยู่ (ไม่ต้องแก้หน้าเว็บ หรือเติมข้อมูลช่วงก่อนติดตั้งสคริปต์ ย้อนหลังได้ 31 วัน) ให้ส่งเวลาของแต่ละเหตุการณ์เป็นชุด:

```
curl -X POST "$TASKBOARD_URL/api/ingest/activity" \
  -H "Authorization: Bearer $TASKBOARD_API_KEY" -H "Content-Type: application/json" \
  -d '{"extend_minutes": 2, "events": [
        {"username": "somchai", "at": "2026-10-07T09:03:12+07:00"},
        {"username": "somchai", "at": "2026-10-07T09:05:40+07:00"}]}'
```
- `at` เป็นเวลา ISO (ควรมีโซนเวลา) หรือ epoch มิลลิวินาที, ครั้งละไม่เกิน 500 เหตุการณ์
- `extend_minutes` (0-5) นับนาทีหลังเหตุการณ์นั้นเป็นเวลาใช้งานต่ออีกกี่นาที เพราะ log บอกแค่ตอนกดทำรายการ ไม่รวมเวลาอ่านหรือค้นหา
- วิธีนี้หยาบกว่าสคริปต์ในเบราว์เซอร์ เหมาะเป็นตัวเสริม

## ความปลอดภัย
- รหัสลับอยู่ที่ server ERP เท่านั้น ห้ามใส่ในไฟล์ JavaScript ที่ส่งไปเบราว์เซอร์ ใช้ HTTPS ระหว่าง ERP กับ TaskBoard
- แต่ละระบบใช้รหัสของตัวเอง รหัสรั่วให้เปลี่ยนเฉพาะระบบนั้น (รหัสสั้นกว่า 24 ตัวถูกปฏิเสธ)
- TaskBoard ไม่รับเหตุการณ์ที่อยู่ในอนาคต (เกิน 2 นาที) หรือเก่ากว่า 31 วัน
- ข้อมูลที่ส่งมีแค่ username กับเวลา ไม่มี URL หน้าเว็บ หรือข้อมูลธุรกิจของ ERP
