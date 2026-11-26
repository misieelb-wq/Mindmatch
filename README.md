# MindMatch

Бүртгэлгүй, аноним 1:1 санамсаргүй чат болон QPay v2 төлбөрийн холболттой веб апп.

## Файлын бүтэц
```text
mindmatch/
├── package.json
├── server.js
├── README.md
└── public/
    ├── index.html
    └── terms.html
```

## Суулгах ба ажиллуулах
1. Node.js 18+ суулгасан байх.
2. Хамаарлуудыг суулгах:
   ```bash
   npm install
   ```
3. Орчны хувьсагчдыг тохируулах:
   ```bash
   export PORT=3000
   export ADMIN_KEY="хүчтэй-нууц-түлхүүр"
   export PUBLIC_URL="https://таны-домэйн.mn"
   export QPAY_URL="https://merchant.qpay.mn/v2"
   export QPAY_USER="таны_qpay_user"
   export QPAY_PASS="таны_qpay_pass"
   export QPAY_INVOICE_CODE="таны_invoice_code"
   ```
4. Ажиллуулах:
   ```bash
   npm start
   # Production дээр: pm2 start server.js --name mindmatch
   ```

## Админ API-ууд (`x-admin-key` header-ээр)
- Багц идэвхжүүлэх: `POST /admin/activate` `{"token":"...", "plan":"d1|d3|d5|d7|m1|m3|y1"}`
- Report авсан хэрэглэгчдийг харах: `GET /admin/reports`
- Хориг тайлах: `POST /admin/unban` `{"token":"..."}`

## Зөвлөмж
- HTTPS тохируулахдаа Nginx эсвэл Caddy reverse proxy ашиглана уу (WebSocket upgrade header-үүдийг нээх).
- `db.json` болон `reports.log` файлуудыг өдөр бүр автоматаар нөөцөлж хадгална уу.
