# ZAMIN — 3D Chess Arena

Telegram Mini App ichida ishlaydigan, GPU’da chiziladigan 3D shaxmat. Backend va jonli aloqa — FastAPI/Python, ma’lumotlar — Supabase, hosting — Render.

## Nimalar tayyor

- To‘liq legal yurishlar: rokировка, en passant, promotion (queen/rook/bishop/knight), shax va mot.
- Pat, yetarli bo‘lmagan material, 3/5 karra takrorlanish, 50/75 yurish qoidalari.
- Server-authoritative yurish tekshiruvi (`python-chess`) va versiya orqali parallel yurishdan himoya.
- Har biri keskin farqlanadigan procedural Staunton 3D donalari, haqiqiy otga yaqin bosh/tumshuq/quloq/yol geometriyasi, qora donalarni ajratadigan muvozanatli old yoritish, mobil kamera va legal katak indikatorlari.
- Foydalanuvchi tanlaydigan klassik yashil 2D taxta yoki kinematik 3D arena; tanlov qurilmada eslab qolinadi va o‘yin davomida ham almashtiriladi.
- 2D’da operatsion tizim shriftiga bog‘liq bo‘lmagan, yirik va to‘liq SVG Staunton siluetlari; ot, fil, shoh, vazir va turalar bir qarashda ajraladi. 2D va 3D’da oxirgi yurish hamda shax ostidagi shoh katagi alohida yoritiladi.
- Jonli o‘yin davomida tarix bo‘ylab orqaga-oldinga ko‘rish, yurish yozuviga bosib sakrash va bir tegishda `LIVE` pozitsiyaga qaytish.
- Optimistic yurish: dona server javobini kutmasdan darhol siljiydi, server rad etsa ishonchli holat avtomatik tiklanadi.
- Urib olishda qurol, sakrash va yiqilish animatsiyasi; yurish va urishda klassik yog‘och dona zarbasi uslubidagi Web Audio tovushlari.
- O‘yin yakunida taxta yopilmaydi: 2D shoh egilish impulsi, 3D shoh yiqilishi, taxta ichidagi natija animatsiyasi hamda darhol replay/tahlil/revansh amallari ko‘rinadi.
- 4 darajali brauzer AI. Hisob foydalanuvchi qurilmasida bajariladi, Render CPU’sini band qilmaydi.
- Telegram challenge linki va 7 belgili kod orqali multiplayer; do‘st botdagi `Start`ni bosishi bilan aynan o‘sha challenge serverda qabul qilinadi.
- FastAPI WebSocket orqali yurishlarni jonli qabul qilish; uzilishda avtomatik HTTP fallback.
- 3+0, 10+3 va 15+10 vaqt nazoratlari, server nazoratidagi timeout, ko‘rinadigan durang/taslim bo‘lish amallari.
- Uch karra pozitsiya takrorlanishi va 50 yurish holati avtomatik durang; besh karra/75 yurish, pat va material yetishmasligi ham serverda tekshiriladi.
- Profil, telefon, ELO, natijalar, FEN va har bir yurish Supabase’da saqlanadi.
- Mobil Telegram oynasi va desktop uchun alohida responsive ko‘rinish.
- Premove, avtomatik qayta ulanish, saqlangan xavfsiz sessiya va faol jangni tiklash: ulashish oynasi Telegram Mini App’ni minimallashtirsa ham qaytilganda aynan o‘sha taxta ochiladi, jang va soatlar davom etadi.
- Jonli tomoshabin rejimi, online ishtirokchilar soni va Telegram’da yuboriladigan xavfsiz `?watch=` havolasi.
- Kinematik replay, revansh va brauzerda ishlaydigan ZAMIN Coach: aniqlik foizi, burilish nuqtalari va yurish tasnifi.
- Har kuni almashadigan taktik ekspeditsiya, vaqt, puzzle reytingi, kunlik seriya va Army XP.
- Professional yashil-krem, yong‘oq, slate va yuqori kontrast taxta palitralari; Staunton, Modern va Royal dona proporsiyalari; turnir, yumshoq va ko‘tarilgan ramka shakllari. Bular arena mavzusidan mustaqil tanlanadi va Supabase’da saqlanadi.
- Registan, Cyber, Muzlik va Vulqon arenalari; avtomatik, yuqori sifat va batareyani tejash grafik rejimlari.
- Foydalanuvchi ayni o‘yinda online bo‘lmasa, raqib yurishi, shax, durang taklifi, challenge qabul qilinishi va o‘yin natijasi Telegram bot orqali keladi; xabardagi tugma aynan o‘sha jangni ochadi.
- XP bilan rivojlanadigan dona aura/zirhlari, clan yaratish yoki kod bilan kirish, clan XP va arena turnirlari.
- Klassik FIDE rejimidan tashqari `Taxt uchun jang` (shoh markazga yetadi) va `Uch karra shax` variantlari.

## Tuzilma

Loyiha ataylab ixcham qilingan:

```text
static/index.html   — barcha ekranlar va modallar
static/style.css    — to‘liq vizual tizim va responsive dizayn
static/app.js       — Three.js, shaxmat UI, AI va WebSocket multiplayer
server.py           — FastAPI, Telegram webhook, auth va game API
schema.sql          — Supabase jadvallari, indekslar va RLS
render.yaml         — Render Blueprint
requirements.txt   — Python paketlari
```

## 1. Supabase tayyorlash

1. [Supabase](https://supabase.com/dashboard) da yangi loyiha yarating.
2. `SQL Editor` ni ochib, `schema.sql` faylining hammasini ishga tushiring. Oldingi versiya o‘rnatilgan bo‘lsa ham yangi platforma ustunlari, puzzle, clan va turnir jadvallarini qo‘shish uchun yangilangan faylni yana bir marta to‘liq `Run` qiling; SQL idempotent yozilgan.
3. Project `Connect` oynasidan quyidagilarni oling:
   - Project URL (`https://PROJECT_REF.supabase.co`) → `SUPABASE_URL`
   - Secret key (`sb_secret_...`) → `SUPABASE_SECRET_KEY`

`SUPABASE_SECRET_KEY` faqat Render environment’da turishi kerak. Uni GitHub yoki frontend kodiga yozmang. Loyiha eski `anon`/`service_role` kalitlari bilan ham mos ishlaydi, ammo yangi kalitlar tavsiya qilinadi.

`SUPABASE_URL` maydoniga `postgresql://...` bilan boshlanadigan Database/Pooler connection string yozmang. Project URL doim `https://...supabase.co` shaklida bo‘ladi. Backend keng tarqalgan Supabase connection string’lardan Project URL’ni avtomatik aniqlay oladi, lekin Render environment’da to‘g‘ri URL saqlash tavsiya qilinadi.

## 2. Telegram bot va Mini App

1. Telegram’da `@BotFather` orqali `/newbot` bering va tokenni oling.
2. `/newapp` orqali shu bot uchun Mini App yarating. Short name sifatida, masalan, `play` yozing.
3. Render deploy tugagach Mini App URL’iga `https://SIZNING-SERVICE.onrender.com` ni kiriting.
4. Bot username’ini `@` belgisiz saqlang.

Bot profilidagi `Open App` tugmasi uchun oddiy Website maydonini emas, `@BotFather → /mybots → Bot Settings → Configure Mini App → Enable Mini App` bo‘limini sozlang. Shu yerda URL sifatida Render manzilini va short name sifatida `BOT_APP_SHORT_NAME` bilan bir xil qiymatni (`play`) kiriting. To‘g‘ri direct Mini App havolasi `https://t.me/BOT_USERNAME/play` ko‘rinishida bo‘ladi; xom Render URL’ini oddiy link sifatida ochish Telegram foydalanuvchi imzosini bermaydi.

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
- `/start`, `/play`, `/name` va `/privacy` buyruqlarini ro‘yxatdan o‘tkazadi;
- chat pastidagi `3D SHAXMAT` Web App menyu tugmasini yaratadi.

Render logida quyidagilar ko‘rinishi kerak:

```text
Telegram webhook configured: https://<SERVICE>.onrender.com/telegram/webhook
Telegram Web App menu button configured
```

So‘ng botga `/start` yuboring. Bot avval ism-familiyani so‘raydi, keyin telefonni Telegram’ning rasmiy `request_contact` tugmasi bilan oladi. Avval ro‘yxatdan o‘tgan foydalanuvchi ismini `/name` buyrug‘i bilan yangilashi mumkin. Foydalanuvchi Web App’ni to‘g‘ridan-to‘g‘ri ochsa ham, ism va xalqaro formatdagi telefon kiritilmaguncha o‘yin yaratish/yopiq challenge’ga qo‘shilish bloklanadi.

Web App’ni botning yangi xabaridagi `ARENANI OCHISH` tugmasidan oching. Ayrim Telegram mijozlari chatning doimiy menyu tugmasidan ochilganda `initData` yubormasligi mumkin. Shu holat uchun bot inline tugmaga 10 daqiqalik shaxsiy, bir martalik kirish chiptasini qo‘shadi. Eski xabarlardagi tugmalar qayta yozilmaydi; har bir deploydan keyin sinov uchun botga yangidan `/start` yuboring.

## Xavfsizlik modeli

- Telegram `initData` HMAC-SHA256 bilan backend’da tekshiriladi va 24 soatdan eski sessiya qabul qilinmaydi.
- Telegram `initData` kelmagan mijozlar uchun bot yuborgan inline tugmada foydalanuvchiga bog‘langan, 10 daqiqalik bir martalik launch ticket ishlatiladi. U sessiyaga almashtirilishi bilan darhol yaroqsiz qilinadi va frontend manzil satridan olib tashlaydi.
- Browser uchun Telegram imzosidan keyin alohida 12 soatlik API token beriladi; `APP_SECRET` tashqariga chiqmaydi.
- Telefon `games` jadvaliga yozilmaydi va raqibga yuborilmaydi.
- Browser Supabase’ga to‘g‘ridan-to‘g‘ri ulanmaydi; barcha o‘qish va yozishlar ruxsat tekshiradigan Python API orqali o‘tadi.
- Barcha yozish amallari Python API orqali o‘tadi. Browser Supabase’ga yurish yoza olmaydi.
- Service/secret key faqat backend’da ishlatiladi.

## Bepul tarif haqida

Render Free web service 15 daqiqa trafik bo‘lmasa uyquga ketishi mumkin; birinchi ochilishda uyg‘onish taxminan bir daqiqagacha cho‘zilishi ehtimoli bor. O‘yin holati Supabase’da saqlanadi, jonli yurishlar ixcham WebSocket xabarlari bilan yuboriladi. Render qayta ishga tushsa ham o‘yinlar yo‘qolmaydi.

Telegram Mini App yopilishi o‘yinni taslim bo‘lish deb hisoblamaydi va soatni pauza qilmaydi. FEN, yurishlar va qolgan vaqt Supabase’da turadi. Raqib online qolsa backend timeoutni mustaqil yakunlaydi; ikkala tomon ham chiqib ketsa birinchi qayta ulanishdayoq o‘tgan vaqt hisoblanib natija bazaga yoziladi. Taslim bo‘lish uchun o‘yin ekranidagi alohida `TASLIM` tugmasi bosiladi.

## Render log yuborishda

Xato chiqsa quyidagilarni yuboring (secret qiymatlarini yashiring):

- Render `Deploy logs` dagi birinchi traceback;
- `/api/health` javobi;
- Supabase SQL Editor ko‘rsatgan xato bo‘lsa, to‘liq xabar;
- muammo `/start`, profil, game yaratish, join yoki yurishda ekanini.
