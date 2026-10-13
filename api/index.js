const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 1200;
const MAX_ALICE_TEXT = 1024;
const TOTAL_RESPONSE_BUDGET_MS = 3600;
const SERPER_TIMEOUT_MS = 2600;
const GEMINI_TIMEOUT_MS = 3500;
const SUPABASE_TIMEOUT_MS = 450;
const MAX_PERSISTED_HISTORY_MESSAGES = 8;

const SYSTEM_PROMPT = [
  "Ты — Еся — голосовой помощник на базе Gemini в навыке Яндекс Алисы.",
  "Когда спрашивают, кто ты, отвечай: «Я Еся, голосовой помощник на базе Gemini». Не называй себя Алисой: Алиса — платформа, через которую пользователь с тобой разговаривает.",
  "Если спрашивают, какая у тебя модель, отвечай: «Я работаю на Gemini 3.5 Flash Lite».",
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
    return "Я Еся, голосовой помощник на базе Gemini.";
  }
  if (/^(какая у тебя модель|какая модель|на какой модели ты работаешь)$/.test(normalized)) {
    return "Я работаю на Gemini 3.5 Flash Lite.";
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

async function searchWeb(query, timeoutMs) {
  const key = process.env.SERPER_API_KEY;
  if (!key || timeoutMs < 150) return "";

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

async function askGemini(text, history, searchContext, timeoutMs) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("MISSING_GEMINI_KEY");
  if (timeoutMs < 250) throw new Error("TIME_BUDGET_EXHAUSTED");

  const model = String(process.env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  const fallbackModel = String(process.env.GEMINI_FALLBACK_MODEL || "gemini-3.5-flash-lite").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(model) || !/^[A-Za-z0-9._-]+$/.test(fallbackModel)) {
    throw new Error("INVALID_MODEL_NAME");
  }

  const contents = safeHistory(history).map(item => ({
    role: item.role,
    parts: [{ text: item.text }]
  }));

  const prompt = searchContext
    ? `${text}\n\nРезультаты поиска в интернете:\n${searchContext}\nИспользуй их только там, где они относятся к вопросу.`
    : text;
  contents.push({ role: "user", parts: [{ text: prompt }] });

  const endpointFor = name => `https://generativelanguage.googleapis.com/v1beta/models/${name}:generateContent`;
  let endpoint = endpointFor(model);
  const requestOptions = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 80
        }
      })
    };
  const requestStartedAt = Date.now();
  let { response, data } = await fetchJson(
    endpoint,
    requestOptions,
    Math.min(GEMINI_TIMEOUT_MS, timeoutMs, 2300)
  );

  if (response.status === 503) {
    const elapsedMs = Date.now() - requestStartedAt;
    const fallbackTimeoutMs = Math.min(1000, timeoutMs - elapsedMs);
    if (fallbackTimeoutMs >= 400) {
      console.warn("Gemini returned HTTP 503; trying the fallback model.");
      endpoint = endpointFor(fallbackModel);
      ({ response, data } = await fetchJson(endpoint, requestOptions, fallbackTimeoutMs));
    }
  }

  if (!response.ok) {
    const status = Number(response.status);
    console.error("Gemini request failed with HTTP", status);
    if (status === 401 || status === 403) throw new Error("GEMINI_KEY_REJECTED");
    if (status === 429) throw new Error("GEMINI_QUOTA");
    throw new Error("GEMINI_REQUEST_FAILED");
  }

  const candidate = data?.candidates?.[0];
  const answer = (candidate?.content?.parts || [])
    .map(part => typeof part.text === "string" ? part.text : "")
    .join("")
    .trim();

  if (!answer) {
    if (data?.promptFeedback?.blockReason) throw new Error("GEMINI_BLOCKED");
    throw new Error("GEMINI_EMPTY_RESPONSE");
  }
  if (candidate?.finishReason === "MAX_TOKENS") {
    console.warn("Gemini reached the output token limit.");
  }
  return answer;
}

function errorForUser(error) {
  switch (error?.message) {
    case "MISSING_GEMINI_KEY":
      return "Сервер пока не настроен. Проверьте переменную GEMINI_API_KEY в настройках Vercel.";
    case "GEMINI_KEY_REJECTED":
      return "Не удалось подключиться к Gemini. Проверьте API-ключ в настройках Vercel.";
    case "GEMINI_QUOTA":
      return "Сейчас превышен лимит запросов к Gemini. Попробуйте немного позже.";
    case "GEMINI_BLOCKED":
      return "Я не смогла обработать этот запрос. Попробуйте спросить иначе.";
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
      service: "alice-gemini-serper",
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
    // повторно: это оставляет Gemini больше времени на ответ.
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
      searchContext = await searchWeb(text, Math.min(SERPER_TIMEOUT_MS, Math.max(0, remainingMs() - 400)));
      const directSearchAnswer = searchReply(searchContext);
      return res.status(200).json(aliceResponse(
        directSearchAnswer || "Не удалось быстро получить актуальные данные. Попробуйте ещё раз чуть позже.",
        false,
        oldHistory
      ));
    }

    const answer = await askGemini(
      text,
      oldHistory,
      searchContext,
      Math.max(0, Math.min(GEMINI_TIMEOUT_MS, remainingMs() - 300))
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
