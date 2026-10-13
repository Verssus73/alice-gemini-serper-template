const DEFAULT_MODEL = "deepseek-chat";
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 1200;
const MAX_ALICE_TEXT = 1024;
const TOTAL_RESPONSE_BUDGET_MS = 4300;
const SERPER_TIMEOUT_MS = 2600;
const WEATHER_TIMEOUT_MS = 2600;
const DEEPSEEK_TIMEOUT_MS = 3500;
const SUPABASE_TIMEOUT_MS = 450;
const MAX_PERSISTED_HISTORY_MESSAGES = 8;

const SYSTEM_PROMPT = [
  "Ты — Еся — голосовой помощник на базе DeepSeek в навыке Яндекс Алисы.",
  "Когда спрашивают, кто ты, отвечай: «Я Еся, голосовой помощник на базе DeepSeek». Не называй себя Алисой: Алиса — платформа, через которую пользователь с тобой разговаривает.",
  "Если спрашивают, какая у тебя модель, отвечай: «Я работаю на DeepSeek Chat».",
  "Отвечай естественно, по-русски, кратко и так, чтобы ответ было удобно слушать.",
  "Обычно используй 1–3 коротких предложения. Не используй Markdown, таблицы, списки с символами или длинные вступления.",
  "Если вопрос требует актуальных данных и переданы результаты поиска, опирайся на них; не выдумывай отсутствующие факты.",
  "Если не знаешь ответа, честно скажи об этом."
].join(" ");

function aliceResponse(text, endSession = false, history = []) {
  return {
    version: "1.0",
    response: {
      text: fitAliceText(text),
      end_session: endSession
    },
    session_state: { history }
  };
}

function memoryConversationId(body) {
  const session = body?.session || {};
  const skillId = String(session.skill_id || "").trim();
  const userId = String(session?.user?.user_id || session?.application?.application_id || "").trim();
  if (!skillId || !userId) return "";
  return (skillId + ":" + userId).slice(0, 500);
}

function isForgetCommand(text) {
  return /^забудь\s+(?:всё|все)\s*[.!?]*$/i.test(String(text || "").trim());
}


function instantReply(text) {
  const normalized = String(text || "").toLowerCase().replace(/[!?.,]/g, "").trim();
  if (/^(кто ты|ты кто|представься)$/.test(normalized)) {
    return "Я Еся, голосовой помощник на базе DeepSeek.";
  }
  if (/^(какая у тебя модель|какая модель|на какой модели ты работаешь)$/.test(normalized)) {
    return "Я работаю на DeepSeek Chat.";
  }
  return "";
}

function supabaseConfig() {
  const url = String(process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  return url && key ? { url, key } : null;
}

async function supabaseRequest(path, options, timeoutMs) {
  const config = supabaseConfig();
  if (!config || timeoutMs < 100) return null;
  return fetchJson(config.url + "/rest/v1/" + path, {
    ...options,
    headers: {
      apikey: config.key,
      Authorization: "Bearer " + config.key,
      ...(options.headers || {})
    }
  }, Math.min(SUPABASE_TIMEOUT_MS, timeoutMs));
}

async function loadPersistentHistory(conversationId, fallback, timeoutMs) {
  if (!conversationId) return fallback;
  try {
    const result = await supabaseRequest(
      "alice_memory?conversation_id=eq." + encodeURIComponent(conversationId) + "&select=history",
      { method: "GET" },
      timeoutMs
    );
    if (!result?.response?.ok) return fallback;
    const row = Array.isArray(result.data) ? result.data[0] : null;
    return row ? safeHistory(row.history).slice(-MAX_PERSISTED_HISTORY_MESSAGES) : fallback;
  } catch (error) {
    console.warn("Supabase memory read skipped:", error?.message || "unknown error");
    return fallback;
  }
}

async function savePersistentHistory(conversationId, history, timeoutMs) {
  if (!conversationId) return;
  try {
    const result = await supabaseRequest(
      "alice_memory?on_conflict=conversation_id",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal"
        },
        body: JSON.stringify({
          conversation_id: conversationId,
          history: safeHistory(history).slice(-MAX_PERSISTED_HISTORY_MESSAGES),
          updated_at: new Date().toISOString()
        })
      },
      timeoutMs
    );
    if (result && !result.response.ok) console.warn("Supabase memory write failed with HTTP", result.response.status);
  } catch (error) {
    console.warn("Supabase memory write skipped:", error?.message || "unknown error");
  }
}

async function clearPersistentHistory(conversationId, timeoutMs) {
  if (!conversationId) return;
  try {
    const result = await supabaseRequest(
      "alice_memory?conversation_id=eq." + encodeURIComponent(conversationId),
      { method: "DELETE", headers: { Prefer: "return=minimal" } },
      timeoutMs
    );
    if (result && !result.response.ok) console.warn("Supabase memory delete failed with HTTP", result.response.status);
  } catch (error) {
    console.warn("Supabase memory delete skipped:", error?.message || "unknown error");
  }
}

function fitAliceText(value) {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (text.length <= MAX_ALICE_TEXT) return text || "Не удалось подготовить ответ.";

  const candidate = text.slice(0, MAX_ALICE_TEXT - 1);
  const sentenceEnd = Math.max(
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("! "),
    candidate.lastIndexOf("? ")
  );
  if (sentenceEnd >= 300) return candidate.slice(0, sentenceEnd + 1).trim();

  const lastSpace = candidate.lastIndexOf(" ");
  return (lastSpace > 200 ? candidate.slice(0, lastSpace) : candidate).trim() + "…";
}

function isSearchIntent(text) {
  return /\b(latest|today|current|news|weather|price|exchange rate|recent|search|look up)\b|сегодня|сейчас|последн|новост|погод|курс валют|найди|поищи|актуальн|сколько стоит|свежие данные/i.test(text);
}

function searchReply(searchContext) {
  const firstLine = String(searchContext || "").split("\n")[0]
    .replace(/^Краткий ответ поисковика:\s*/i, "")
    .replace(/^\d+\.\s*[^:]{0,180}:\s*/, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return firstLine ? "По данным поиска: " + firstLine : "";
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(item => item && (item.role === "user" || item.role === "model") && typeof item.text === "string")
    .slice(-MAX_HISTORY_MESSAGES)
    .map(item => ({ role: item.role, text: item.text.slice(0, MAX_HISTORY_MESSAGE_CHARS) }));
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

function weatherDescription(code) {
  const labels = {
    0: "ясно", 1: "преимущественно ясно", 2: "переменная облачность", 3: "пасмурно",
    45: "туман", 48: "изморозевый туман", 51: "морось", 53: "морось", 55: "сильная морось",
    61: "небольшой дождь", 63: "дождь", 65: "сильный дождь", 71: "небольшой снег",
    73: "снег", 75: "сильный снег", 80: "ливень", 81: "ливень", 82: "сильный ливень",
    95: "гроза", 96: "гроза с градом", 99: "сильная гроза с градом"
  };
  return labels[Number(code)] || "без уточнения";
}

function weatherLocation(body, text) {
  const entities = Array.isArray(body?.request?.nlu?.entities) ? body.request.nlu.entities : [];
  const geo = entities.find(item => item?.type === "YANDEX.GEO" && item?.value?.city);
  if (geo) return String(geo.value.city).trim();
  const match = String(text || "").match(/(?:погод[ауеы]?\s+(?:в|во)\s+)([^?!,.]+)/i);
  return match ? match[1].trim() : "";
}

async function currentWeather(city, timeoutMs) {
  if (!city || timeoutMs < 500) return "";
  try {
    const locationUrl = "https://geocoding-api.open-meteo.com/v1/search?name=" +
      encodeURIComponent(city) + "&count=1&language=ru&countryCode=RU";
    const location = await fetchJson(locationUrl, { method: "GET" }, Math.min(1200, timeoutMs));
    const place = Array.isArray(location.data?.results) ? location.data.results[0] : null;
    if (!location.response.ok || !place || !Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)) return "";

    const remaining = Math.max(500, timeoutMs - 1200);
    const forecastUrl = "https://api.open-meteo.com/v1/forecast?latitude=" + encodeURIComponent(place.latitude) +
      "&longitude=" + encodeURIComponent(place.longitude) +
      "&current=temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m&timezone=auto";
    const forecast = await fetchJson(forecastUrl, { method: "GET" }, remaining);
    const current = forecast.data?.current;
    if (!forecast.response.ok || !current || !Number.isFinite(current.temperature_2m)) return "";

    const placeName = String(place.name || city);
    const temp = Math.round(current.temperature_2m);
    const feels = Number.isFinite(current.apparent_temperature) ? ", ощущается как " + Math.round(current.apparent_temperature) + "°" : "";
    const wind = Number.isFinite(current.wind_speed_10m) ? ", ветер " + Math.round(current.wind_speed_10m) + " км/ч" : "";
    const precipitation = Number(current.precipitation || 0) > 0 ? ", осадки " + Number(current.precipitation).toFixed(1) + " мм" : "";
    return "Сейчас в " + placeName + ": " + temp + "°, " + weatherDescription(current.weather_code) + feels + wind + precipitation + ".";
  } catch (error) {
    console.warn("Weather request did not finish in time; continuing with search.");
    return "";
  }
}

async function searchWeb(query, timeoutMs) {
  const key = process.env.SERPER_API_KEY;
  if (!key || timeoutMs < 150) return "";

  const requestStartedAt = Date.now();
  try {
    const { response, data } = await fetchJson(
      "https://google.serper.dev/search",
      {
        method: "POST",
        headers: {
          "X-API-KEY": key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ q: query, gl: "ru", hl: "ru", num: 3 })
      },
      Math.min(SERPER_TIMEOUT_MS, timeoutMs)
    );

    console.warn("Serper response received in", Date.now() - requestStartedAt, "ms");

    if (!response.ok) {
      console.warn("Serper request failed with HTTP", response.status);
      return "";
    }

    const items = (Array.isArray(data.organic) ? data.organic : [])
      .slice(0, 3)
      .map((item, i) => {
        const title = String(item.title || "").slice(0, 180);
        const snippet = String(item.snippet || "").slice(0, 350);
        const link = String(item.link || "").slice(0, 240);
        return `${i + 1}. ${title}: ${snippet} ${link}`.trim();
      });

    const answerBox = data.answerBox?.answer || data.answerBox?.snippet;
    if (answerBox) items.unshift(`Краткий ответ поисковика: ${String(answerBox).slice(0, 350)}`);
    return items.length ? items.join("\n") : "";
  } catch (error) {
    console.warn("Serper request did not finish in time; continuing without search.");
    return "";
  }
}

async function askDeepSeek(text, history, timeoutMs) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("MISSING_DEEPSEEK_KEY");
  if (timeoutMs < 500) throw new Error("TIME_BUDGET_EXHAUSTED");

  const model = String(process.env.DEEPSEEK_MODEL || "deepseek-chat").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new Error("INVALID_MODEL_NAME");

  const controller = new AbortController();
  const requestStartedAt = Date.now();
  let receivedResponseHeaders = false;
  const timer = setTimeout(() => controller.abort(), Math.max(500, timeoutMs));
  try {
    console.warn("DeepSeek request started");
    const response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + key
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...safeHistory(history).map(item => ({
            role: item.role === "model" ? "assistant" : "user",
            content: item.text
          })),
          { role: "user", content: text }
        ],
        temperature: 0.3,
        max_tokens: 60,
        stream: true
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const status = Number(response.status);
      console.error("DeepSeek request failed with HTTP", status);
      if (status === 401 || status === 403) throw new Error("DEEPSEEK_KEY_REJECTED");
      if (status === 429) throw new Error("DEEPSEEK_QUOTA");
      throw new Error("DEEPSEEK_REQUEST_FAILED");
    }

    if (!response.body) throw new Error("DEEPSEEK_EMPTY_RESPONSE");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let answer = "";

    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return answer.trim();
        try {
          const delta = String(JSON.parse(payload)?.choices?.[0]?.delta?.content || "");
          answer += delta;
          if (answer.length >= 16 && /[.!?…]\s*$/.test(answer)) {
            await reader.cancel();
            return answer.trim();
          }
        } catch {
          // Skip a malformed streaming event and continue reading.
        }
      }
      if (done) return answer.trim();
    }
  } finally {
    console.warn("DeepSeek request finished in", Date.now() - requestStartedAt, "ms; headers received:", receivedResponseHeaders);
    clearTimeout(timer);
    controller.abort();
  }
}
function errorForUser(error) {
  switch (error?.message) {
    case "MISSING_DEEPSEEK_KEY":
      return "Сервер пока не настроен. Проверьте переменную DEEPSEEK_API_KEY в настройках Vercel.";
    case "DEEPSEEK_KEY_REJECTED":
      return "Не удалось подключиться к DeepSeek. Проверьте API-ключ в настройках Vercel.";
    case "DEEPSEEK_QUOTA":
      return "Сейчас превышен лимит запросов к DeepSeek. Попробуйте немного позже.";
    case "TIME_BUDGET_EXHAUSTED":
    case "AbortError":
      return "Не успела подготовить ответ. Попробуйте задать вопрос ещё раз, чуть короче.";
    default:
      return "Не получилось получить ответ от нейросети. Попробуйте ещё раз чуть позже.";
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "alice-deepseek-serper",
      message: "Webhook is ready. Yandex Dialogs should send POST requests to /api."
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const startedAt = Date.now();
  const remainingMs = () => TOTAL_RESPONSE_BUDGET_MS - (Date.now() - startedAt);
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const text = String(body?.request?.command || body?.request?.original_utterance || "").trim();
  const sessionHistory = safeHistory(body?.state?.session?.history);
  const conversationId = memoryConversationId(body);
  let oldHistory = sessionHistory;

  const localAnswer = instantReply(text);
  if (localAnswer) {
    return res.status(200).json(aliceResponse(localAnswer, false, oldHistory));
  }

  if (!text) {
    return res.status(200).json(aliceResponse(
      "Привет! Я могу ответить на вопрос или найти актуальную информацию. Что хочешь узнать?",
      false,
      oldHistory
    ));
  }

  try {
    // Яндекс уже передаёт историю в рамках текущей сессии. Не ждём базу
    // повторно: это оставляет модели больше времени на ответ.
    if (!sessionHistory.length) {
      oldHistory = await loadPersistentHistory(
        conversationId,
        sessionHistory,
        Math.min(SUPABASE_TIMEOUT_MS, Math.max(0, remainingMs() - 3500))
      );
    }

    if (isForgetCommand(text)) {
      await clearPersistentHistory(conversationId, Math.max(0, remainingMs() - 300));
      return res.status(200).json(aliceResponse(
        "Хорошо, я забыл историю этого разговора.",
        false,
        []
      ));
    }

    let searchContext = "";
    if (isSearchIntent(text)) {
      if (!process.env.SERPER_API_KEY) {
        return res.status(200).json(aliceResponse(
          "Поиск актуальных данных сейчас не настроен. Попробуйте задать обычный вопрос.",
          false,
          oldHistory
        ));
      }
      const city = weatherLocation(body, text);
      if (city) {
        const weather = await currentWeather(
          city,
          Math.min(WEATHER_TIMEOUT_MS, Math.max(0, remainingMs() - 400))
        );
        if (weather) return res.status(200).json(aliceResponse(weather, false, oldHistory));
      }

      searchContext = await searchWeb(text, Math.min(SERPER_TIMEOUT_MS, Math.max(0, remainingMs() - 400)));
      const directSearchAnswer = searchReply(searchContext);
      return res.status(200).json(aliceResponse(
        directSearchAnswer || "Не удалось быстро получить актуальные данные. Попробуйте ещё раз чуть позже.",
        false,
        oldHistory
      ));
    }

    const answer = await askDeepSeek(
      text,
      oldHistory,
      Math.max(0, Math.min(DEEPSEEK_TIMEOUT_MS, remainingMs() - 400))
    );

    const history = [
      ...oldHistory,
      { role: "user", text: text.slice(0, MAX_HISTORY_MESSAGE_CHARS) },
      { role: "model", text: answer.slice(0, MAX_HISTORY_MESSAGE_CHARS) }
    ].slice(-MAX_HISTORY_MESSAGES);

    await savePersistentHistory(conversationId, history, Math.max(0, remainingMs() - 250));
    return res.status(200).json(aliceResponse(answer, false, history));
  } catch (error) {
    const safeError = error?.name === "AbortError" || error?.message === "AbortError" || error?.message === "This operation was aborted"
      ? new Error("TIME_BUDGET_EXHAUSTED")
      : error;
    console.warn("Alice webhook returned a fallback response:", safeError?.message || "unknown error");
    return res.status(200).json(aliceResponse(errorForUser(safeError), false, oldHistory));
  }
}

export { aliceResponse, fitAliceText, isSearchIntent, safeHistory };
