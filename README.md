# محمّل الفيديو (Video Saver)

تشارك رابط فيديو من فيسبوك / تيك توك / إنستغرام / X / يوتيوب وغيرها إلى التطبيق، فيُنزَّل الفيديو ويُحفظ في معرض الهاتف.

## كيف يعمل
```
[ تطبيق أندرويد ]  --الرابط-->  [ خادم FastAPI + yt-dlp ]  --ملف mp4-->  [ المعرض ]
```
الاستخراج يتم في الخادم لأن yt-dlp (الأداة التي تدعم مئات المواقع) تعمل بالبايثون ولا تعمل داخل الهاتف مباشرة.

> ملاحظة: لم يُشغَّل هذا الكود بعد، لأن بيئة البناء لا تصل إلى pypi ولا npm. فحصتُ صياغة الخادم فقط. جرّبه محليًا أولًا بالخطوات أدناه.

## 1) تشغيل الخادم

محليًا:
```bash
cd server
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
# ويلزم ffmpeg مثبتًا على الجهاز
API_KEY=my-secret uvicorn main:app --host 0.0.0.0 --port 8000
```
اختبار:
```bash
curl http://localhost:8000/health
curl -X POST http://localhost:8000/info -H "X-API-Key: my-secret" \
  -H "Content-Type: application/json" -d '{"url":"رابط_فيديو_عام"}'
```

للنشر (Render / Railway / Fly.io / أي VPS): استخدم `server/Dockerfile` كما هو، وعرّف متغيّر البيئة `API_KEY`.

مهم: المنصات تغيّر نفسها باستمرار، فإذا توقف موقع عن العمل حدّث الأداة: `pip install -U yt-dlp` (أو أعد بناء صورة Docker).

## نشر الخادم على Render بنقرات قليلة
1. ادخل إلى render.com وسجّل بحساب GitHub.
2. اختر New ← Blueprint، ثم اختر هذا المستودع. سيقرأ Render الملف `render.yaml` تلقائيًا.
3. اضغط Apply. ينشئ Render مفتاح `API_KEY` عشوائيًا لك.
4. بعد انتهاء النشر: انسخ عنوان الخدمة (https://video-saver-xxxx.onrender.com)، ومن تبويب Environment انسخ قيمة `API_KEY`.
5. افتح التطبيق ← ⚙️ الإعدادات، وأدخل العنوان والمفتاح.
اختبر الخادم بفتح `العنوان/health` في المتصفح، فيجب أن يظهر `{"ok":true,...}`.

## 2) بناء التطبيق (أندرويد)

الحزم لم تُثبَّت بعد، لذلك أنشئ مشروع Expo جديدًا ثم انسخ ملفاتنا فوقه:
```bash
npx create-expo-app@latest videosaver --template blank-typescript
cd videosaver
npx expo install expo-share-intent expo-media-library expo-file-system
```
ثم انسخ من مجلد `app/` هنا إلى `videosaver/`:
`App.tsx` و `app.json` و `eas.json` و `src/config.ts` (واستبدل الملفات الموجودة).

عدّل `src/config.ts` بعنوان الخادم ومفتاح `API_KEY`.

للحصول على ملف APK تثبّته على هاتفك:
```bash
npm i -g eas-cli
eas login
eas build -p android --profile preview
```
ثبّت الـ APK، ثم من أي تطبيق اضغط مشاركة على الفيديو واختر "محمّل الفيديو".

ملاحظات:
- المشاركة من التطبيقات الأخرى لا تعمل داخل Expo Go، بل تحتاج نسخة مبنية (APK) كما في الأعلى.
- يتطلب الكود Expo SDK 54 أو أحدث (يستخدم `expo-file-system/legacy`).

## بناء الـ APK تلقائيًا من GitHub
عند رفع الكود إلى الفرع `main` (أو من تبويب Actions ← Build Android APK ← Run workflow) يبني GitHub ملف APK ويضعه في صفحة **Releases** بالمستودع. حمّله من هناك على هاتفك وثبّته، ثم افتح ⚙️ الإعدادات داخل التطبيق وأدخل عنوان الخادم ومفتاح `API_KEY`.
المفتاح يُدخل داخل التطبيق ولا يُكتب في الكود، لأن المستودع عام.

## حدود وتنبيهات
- يعمل مع الفيديوهات العامة فقط. المحتوى الخاص أو الذي يتطلب تسجيل دخول قد يفشل.
- حمّل فقط ما تملك حق تنزيله أو للاستخدام الشخصي، والتزم بشروط كل منصة وبحقوق صاحب الفيديو. وإعادة نشر فيديوهات الآخرين دون إذنهم قد تخالف حقوق النشر.
- متاجر التطبيقات (Google Play وApple) ترفض عادةً تطبيقات تنزيل الفيديو من المنصات، فالأنسب التوزيع كملف APK لاستخدامك الشخصي.
- الخادم يمنع الروابط الداخلية (SSRF) ويحدّد الطول (ساعة) والحجم (500 MB) ومعدل الطلبات، ويحتاج مفتاح `API_KEY`.
