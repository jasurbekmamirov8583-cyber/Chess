# ZAMIN — 3D Chess Arena

Telegram Mini App ichida ishlaydigan, GPU’da chiziladigan 3D shaxmat. Backend — FastAPI/Python, ma’lumotlar va real-time — Supabase, hosting — Render.

## Nimalar tayyor

- To‘liq legal yurishlar: rokировка, en passant, promotion (queen/rook/bishop/knight), shax va mot.
- Pat, yetarli bo‘lmagan material, 3/5 karra takrorlanish, 50/75 yurish qoidalari.
- Server-authoritative yurish tekshiruvi (`python-chess`) va versiya orqali parallel yurishdan himoya.
- 3D kamera, yoritish, soyalar, legal katak indikatorlari va urib olishda qilich/bolg‘a animatsiyasi.
- 4 darajali brauzer AI. Hisob foydalanuvchi qurilmasida bajariladi, Render CPU’sini band qilmaydi.
- Telegram challenge linki va 7 belgili kod orqali multiplayer.
- Supabase Realtime orqali yurishlarni jonli qabul qilish; backend’da WebSocket saqlanmaydi.
- 3+0, 10+3 va 15+10 vaqt nazoratlari, timeout va durang/taslim bo‘lish amallari.
- Profil, telefon, ELO, natijalar, FEN va har bir yurish Supabase’da saqlanadi.
- Mobil Telegram oynasi va desktop uchun alohida responsive ko‘rinish.

## Tuzilma

Loyiha ataylab ixcham qilingan:

```text
static/index.html   — barcha ekranlar va modallar
static/style.css    — to‘liq vizual tizim va responsive dizayn
static/app.js       — Three.js, shaxmat UI, AI va Supabase Realtime
server.py           — FastAPI, Telegram webhook, auth va game API
schema.sql          — Supabase jadvallari, indekslar va RLS
render.yaml         — Render Blueprint
requirements.txt   — Python paketlari
```

## 1. Supabase tayyorlash

1. [Supabase](https://supabase.com/dashboard) da yangi loyiha yarating.
2. `SQL Editor` ni ochib, `schema.sql` faylining hammasini bir marta ishga tushiring.
3. `Authentication → Providers/Sign In → Anonymous Sign-ins` ni yoqing. Bu Telegram foydalanuvchisini Supabase Realtime sessiyasiga xavfsiz bog‘lash uchun kerak; foydalanuvchidan email/parol so‘ralmaydi.
4. Project `Connect` oynasidan quyidagilarni oling:
   - Project URL (`https://PROJECT_REF.supabase.co`) → `SUPABASE_URL`
   - Publishable key (`sb_publishable_...`) → `SUPABASE_PUBLISHABLE_KEY`
   - Secret key (`sb_secret_...`) → `SUPABASE_SECRET_KEY`

`SUPABASE_SECRET_KEY` faqat Render environment’da turishi kerak. Uni GitHub yoki frontend kodiga yozmang. Loyiha eski `anon`/`service_role` kalitlari bilan ham mos ishlaydi, ammo yangi kalitlar tavsiya qilinadi.

`SUPABASE_URL` maydoniga `postgresql://...` bilan boshlanadigan Database/Pooler connection string yozmang. Project URL doim `https://...supabase.co` shaklida bo‘ladi. Backend keng tarqalgan Supabase connection string’lardan Project URL’ni avtomatik aniqlay oladi, lekin Render environment’da to‘g‘ri URL saqlash tavsiya qilinadi.

## 2. Telegram bot va Mini App

1. Telegram’da `@BotFather` orqali `/newbot` bering va tokenni oling.
2. `/newapp` orqali shu bot uchun Mini App yarating. Short name sifatida, masalan, `play` yozing.
3. Render deploy tugagach Mini App URL’iga `https://SIZNING-SERVICE.onrender.com` ni kiriting.
4. Bot username’ini `@` belgisiz saqlang.

Kerakli qiymatlar:

```env
BOT_TOKEN=123456:ABC...
BOT_USERNAME=zamin_chess_bot
BOT_APP_SHORT_NAME=play
APP_URL=https://zamin-3d-chess.onrender.com
```

## 3. GitHub va Render deploy

1. Papkadagi fayllarni GitHub repository’ga push qiling. `.env` faylini push qilmang.
2. Render’da `New → Blueprint` tanlang va repository’ni ulang. `render.yaml` servisni avtomatik yaratadi.
3. Render so‘ragan secret qiymatlarni kiriting:
   - `BOT_TOKEN`
   - `BOT_USERNAME`
   - `APP_URL`
   - `SUPABASE_URL`
   - `SUPABASE_PUBLISHABLE_KEY`
   - `SUPABASE_SECRET_KEY`
4. `TELEGRAM_WEBHOOK_SECRET` va `APP_SECRET` Blueprint tomonidan avtomatik yaratiladi. Deploy tugagach Render Environment bo‘limidan webhook secret qiymatini ko‘rib oling.
5. Agar Render bergan URL oldindan noma’lum bo‘lsa, birinchi deploy’dan keyin `APP_URL` ni to‘g‘ri URL bilan yangilang va `Manual Deploy` bering.

Render avtomatik ishlatadigan buyruqlar:

```text
Build: pip install -r requirements.txt
Start: uvicorn server:app --host 0.0.0.0 --port $PORT
Health: /api/health
```

## 4. Telegram webhook

Qo‘lda buyruq bajarish shart emas. Har bir Render deploy vaqtida backend avtomatik ravishda:

- webhook’ni `APP_URL/telegram/webhook` manziliga o‘rnatadi;
- `/start`, `/play` va `/privacy` buyruqlarini ro‘yxatdan o‘tkazadi;
- chat pastidagi `3D SHAXMAT` Web App menyu tugmasini yaratadi.

Render logida quyidagilar ko‘rinishi kerak:

```text
Telegram webhook configured: https://<SERVICE>.onrender.com/telegram/webhook
Telegram Web App menu button configured
```

So‘ng botga `/start` yuboring. Bot telefonni Telegram’ning rasmiy `request_contact` tugmasi bilan oladi. Foydalanuvchi Web App’ni to‘g‘ridan-to‘g‘ri ochsa ham, ism va xalqaro formatdagi telefon kiritilmaguncha o‘yin yaratish/yopiq challenge’ga qo‘shilish bloklanadi.

## Xavfsizlik modeli

- Telegram `initData` HMAC-SHA256 bilan backend’da tekshiriladi va 24 soatdan eski sessiya qabul qilinmaydi.
- Supabase Anonymous Auth tokeni Supabase’ning o‘z `/auth/v1/user` endpointida tekshiriladi.
- Browser uchun alohida 12 soatlik API token beriladi; `APP_SECRET` tashqariga chiqmaydi.
- Telefon `games` jadvaliga yozilmaydi va raqibga yuborilmaydi.
- RLS foydalanuvchiga faqat o‘zi qatnashgan o‘yinlarni o‘qishga ruxsat beradi.
- Barcha yozish amallari Python API orqali o‘tadi. Browser Supabase’ga yurish yoza olmaydi.
- Service/secret key faqat backend’da ishlatiladi.

## Bepul tarif haqida

Render Free web service 15 daqiqa trafik bo‘lmasa uyquga ketishi mumkin; birinchi ochilishda uyg‘onish taxminan bir daqiqagacha cho‘zilishi ehtimoli bor. O‘yin boshlanganidan keyin yurish holati Supabase’da saqlanadi va real-time trafik Render WebSocket’iga bog‘liq emas. Render qayta ishga tushsa ham o‘yinlar yo‘qolmaydi.

## Render log yuborishda

Xato chiqsa quyidagilarni yuboring (secret qiymatlarini yashiring):

- Render `Deploy logs` dagi birinchi traceback;
- `/api/health` javobi;
- Supabase SQL Editor ko‘rsatgan xato bo‘lsa, to‘liq xabar;
- muammo `/start`, profil, game yaratish, join yoki yurishda ekanini.
