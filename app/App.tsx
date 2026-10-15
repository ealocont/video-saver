import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Linking,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
  I18nManager,
} from "react-native";
import * as FileSystem from "expo-file-system/legacy";
import * as MediaLibrary from "expo-media-library/legacy";
import { useShareIntent } from "expo-share-intent";
import AsyncStorage from "@react-native-async-storage/async-storage";
import mobileAds, { BannerAd, BannerAdSize, TestIds } from "react-native-google-mobile-ads";
import { API_KEY as DEFAULT_KEY, BANNER_AD_UNIT_ID, SERVER_URL as DEFAULT_URL } from "./src/config";

const STORE_URL = "vs_server_url";
const STORE_KEY = "vs_api_key";

async function loadConfig() {
  const [url, key] = await Promise.all([AsyncStorage.getItem(STORE_URL), AsyncStorage.getItem(STORE_KEY)]);
  return { url: (url ?? DEFAULT_URL).trim().replace(/\/+$/, ""), key: (key ?? DEFAULT_KEY).trim() };
}

const STORE_RECENT = "vs_recent";
type Item = { id: string; title?: string; thumbnail?: string; at: number };

type Status = "idle" | "loading" | "downloading" | "done" | "error";
type Meta = { title?: string; thumbnail?: string; uploader?: string };

const extractLink = (text: string) => text.match(/https?:\/\/[^\s]+/)?.[0]?.replace(/[).,;]+$/, "") ?? "";

export default function App() {
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntent();
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");
  const [meta, setMeta] = useState<Meta | null>(null);
  const [progress, setProgress] = useState(0);
  const busy = useRef(false);
  const [showSettings, setShowSettings] = useState(false);
  const [serverUrl, setServerUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const taps = useRef({ n: 0, t: 0 });

  useEffect(() => {
    AsyncStorage.getItem(STORE_RECENT)
      .then((v) => v && setItems(JSON.parse(v)))
      .catch(() => {});
  }, []);

  // Hidden developer menu: tap the title 7 times quickly.
  function onTitleTap() {
    const now = Date.now();
    taps.current.n = now - taps.current.t > 1500 ? 1 : taps.current.n + 1;
    taps.current.t = now;
    if (taps.current.n >= 7) {
      taps.current.n = 0;
      setShowSettings((v) => !v);
    }
  }

  async function openItem(item: Item) {
    try {
      await Linking.openURL(`content://media/external/video/media/${item.id}`);
    } catch {
      setStatus("error");
      setMessage("تعذّر فتح الفيديو. ربما حُذف من المعرض.");
    }
  }

  useEffect(() => {
    mobileAds().initialize().catch(() => {});
  }, []);

  useEffect(() => {
    loadConfig().then((c) => {
      setServerUrl(c.url);
      setApiKey(c.key);
    });
  }, []);

  async function saveSettings() {
    await AsyncStorage.setItem(STORE_URL, serverUrl.trim());
    await AsyncStorage.setItem(STORE_KEY, apiKey.trim());
    setShowSettings(false);
    setStatus("idle");
    setMessage("");
  }

  // When the user shares a link to this app from Facebook / TikTok / Instagram / ...
  useEffect(() => {
    if (!hasShareIntent) return;
    const text = shareIntent.webUrl || shareIntent.text || "";
    const link = extractLink(text);
    resetShareIntent();
    if (link) {
      setInput(link);
      run(link);
    }
  }, [hasShareIntent]);

  async function run(raw: string) {
    const link = extractLink(raw);
    if (!link) {
      setStatus("error");
      setMessage("لم أجد رابطًا صالحًا. ألصق رابط الفيديو.");
      return;
    }
    if (busy.current) return;
    busy.current = true;
    setMeta(null);
    setProgress(0);

    try {
      const { url: SERVER_URL, key: API_KEY } = await loadConfig();
      if (!SERVER_URL || SERVER_URL.includes("YOUR-SERVER")) {
        throw new Error("التطبيق غير مهيأ بعد. تواصل مع المطوّر.");
      }

      // 1) ask for permission to save into the gallery
      const perm = await MediaLibrary.requestPermissionsAsync(true);
      if (!perm.granted) throw new Error("نحتاج إذن حفظ الفيديو في المعرض.");

      // 2) fetch title / thumbnail
      setStatus("loading");
      setMessage("جارٍ فحص الرابط…");
      const infoRes = await fetch(`${SERVER_URL}/info`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": API_KEY },
        body: JSON.stringify({ url: link }),
      });
      if (!infoRes.ok) throw new Error(await errorText(infoRes));
      const info: Meta = await infoRes.json();
      setMeta(info);

      // 3) download the file from the server into app storage
      setStatus("downloading");
      setMessage("جارٍ التنزيل…");
      const target = `${FileSystem.cacheDirectory}video_${Date.now()}.mp4`;
      const dl = FileSystem.createDownloadResumable(
        `${SERVER_URL}/download?url=${encodeURIComponent(link)}`,
        target,
        { headers: { "X-API-Key": API_KEY } },
        (p) => {
          if (p.totalBytesExpectedToWrite > 0) {
            setProgress(p.totalBytesWritten / p.totalBytesExpectedToWrite);
          }
        }
      );
      const result = await dl.downloadAsync();
      if (!result || result.status !== 200) {
        let detail = "فشل التنزيل.";
        if (result?.uri) {
          try {
            const body = await FileSystem.readAsStringAsync(result.uri);
            detail = JSON.parse(body).detail ?? detail;
          } catch {}
          await FileSystem.deleteAsync(result.uri, { idempotent: true });
        }
        throw new Error(detail);
      }

      // 4) save into the phone gallery, then clean the temp file
      const asset = await MediaLibrary.createAssetAsync(result.uri);
      await FileSystem.deleteAsync(result.uri, { idempotent: true });

      const next = [{ id: asset.id, title: info.title, thumbnail: info.thumbnail, at: Date.now() }, ...items].slice(0, 20);
      setItems(next);
      AsyncStorage.setItem(STORE_RECENT, JSON.stringify(next)).catch(() => {});

      setStatus("done");
      setMessage("تم حفظ الفيديو في المعرض ✅");
      setInput("");
    } catch (e: any) {
      setStatus("error");
      setMessage(e?.message ?? "حدث خطأ غير متوقع.");
    } finally {
      busy.current = false;
    }
  }

  return (
    <SafeAreaView style={s.root}>
      <StatusBar barStyle="dark-content" />
      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
      <View style={s.card}>
        <Pressable onPress={onTitleTap}>
          <Text style={s.title}>محمّل الفيديو</Text>
        </Pressable>
        <Text style={s.hint}>
          شارك رابط الفيديو إلى هذا التطبيق من فيسبوك أو تيك توك أو إنستغرام، أو ألصقه هنا.
        </Text>

        <TextInput
          style={s.input}
          value={input}
          onChangeText={setInput}
          placeholder="https://..."
          placeholderTextColor="#999"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />

        <Pressable
          style={[s.button, (status === "loading" || status === "downloading") && s.buttonDisabled]}
          disabled={status === "loading" || status === "downloading"}
          onPress={() => run(input)}
        >
          <Text style={s.buttonText}>تنزيل</Text>
        </Pressable>

        {(status === "loading" || status === "downloading") && (
          <View style={s.row}>
            <ActivityIndicator />
            <Text style={s.status}>
              {message}
              {status === "downloading" && progress > 0 ? ` ${Math.round(progress * 100)}%` : ""}
            </Text>
          </View>
        )}

        {status === "done" && <Text style={[s.status, s.ok]}>{message}</Text>}
        {status === "error" && <Text style={[s.status, s.err]}>{message}</Text>}

        {meta?.thumbnail ? <Image source={{ uri: meta.thumbnail }} style={s.thumb} /> : null}
        {meta?.title ? (
          <Text style={s.metaTitle} numberOfLines={2}>
            {meta.title}
          </Text>
        ) : null}

        {showSettings && (
          <View style={{ gap: 8 }}>
            <TextInput
              style={s.input}
              value={serverUrl}
              onChangeText={setServerUrl}
              placeholder="عنوان الخادم https://..."
              placeholderTextColor="#999"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
            <TextInput
              style={s.input}
              value={apiKey}
              onChangeText={setApiKey}
              placeholder="مفتاح API"
              placeholderTextColor="#999"
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
            />
            <Pressable style={s.button} onPress={saveSettings}>
              <Text style={s.buttonText}>حفظ الإعدادات</Text>
            </Pressable>
          </View>
        )}
      </View>

      {items.length > 0 && (
        <View style={s.card}>
          <Text style={s.sectionTitle}>تنزيلاتي</Text>
          {items.map((it) => (
            <Pressable key={it.id + it.at} style={s.item} onPress={() => openItem(it)}>
              {it.thumbnail ? <Image source={{ uri: it.thumbnail }} style={s.itemThumb} /> : <View style={s.itemThumb} />}
              <Text style={s.itemTitle} numberOfLines={2}>
                {it.title || "فيديو"}
              </Text>
              <Text style={s.open}>▶ فتح</Text>
            </Pressable>
          ))}
        </View>
      )}
      </ScrollView>

      <View style={s.adBox}>
        <BannerAd unitId={BANNER_AD_UNIT_ID || TestIds.BANNER} size={BannerAdSize.ANCHORED_ADAPTIVE_BANNER} />
      </View>
    </SafeAreaView>
  );
}

async function errorText(res: Response) {
  try {
    const j = await res.json();
    return j.detail ?? `خطأ ${res.status}`;
  } catch {
    return `خطأ ${res.status}`;
  }
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#f3f4f6" },
  scroll: { padding: 16, paddingBottom: 90, gap: 16, flexGrow: 1, justifyContent: "center" },
  card: { backgroundColor: "#fff", borderRadius: 16, padding: 20, gap: 12 },
  title: { fontSize: 24, fontWeight: "700", textAlign: "right" },
  hint: { fontSize: 14, color: "#555", textAlign: "right", lineHeight: 22 },
  input: {
    borderWidth: 1,
    borderColor: "#d1d5db",
    borderRadius: 10,
    padding: 12,
    fontSize: 15,
    textAlign: "left",
  },
  button: { backgroundColor: "#2563eb", padding: 14, borderRadius: 10, alignItems: "center" },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  row: { flexDirection: I18nManager.isRTL ? "row-reverse" : "row", gap: 10, alignItems: "center" },
  status: { fontSize: 14, textAlign: "right" },
  ok: { color: "#15803d" },
  err: { color: "#b91c1c" },
  thumb: { width: "100%", height: 180, borderRadius: 10, backgroundColor: "#e5e7eb" },
  metaTitle: { fontSize: 14, textAlign: "right", color: "#333" },
  adBox: { position: "absolute", bottom: 0, left: 0, right: 0, alignItems: "center" },
  sectionTitle: { fontSize: 18, fontWeight: "700", textAlign: "right" },
  item: { flexDirection: I18nManager.isRTL ? "row-reverse" : "row", alignItems: "center", gap: 10 },
  itemThumb: { width: 64, height: 64, borderRadius: 8, backgroundColor: "#e5e7eb" },
  itemTitle: { flex: 1, fontSize: 14, textAlign: "right", color: "#333" },
  open: { color: "#2563eb", fontSize: 14, fontWeight: "600" },
});
