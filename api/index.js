
const DEFAULT_MODEL = "gpt-4.1-mini";
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 1200;
const MAX_ALICE_TEXT = 1024;
const OPENAI_TIMEOUT_MS = 3200;

const SYSTEM_PROMPT = [
  "Ты — ChatGPT, голосовой помощник в навыке Яндекс Алисы.",
  "Отвечай на русском языке естественно и понятно.",
  "Обычно используй от одного до трёх коротких предложений.",
  "Не используй Markdown, таблицы и длинные списки.",
  "Помни контекст предыдущих сообщений в текущем разговоре.",
  "Если не знаешь ответа, честно скажи об этом.",
  "Не утверждай, что имеешь доступ к актуальным данным интернета."
].join(" ");

function fitAliceText(value) {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!text) return "Не удалось подготовить ответ.";
  if (text.length <= MAX_ALICE_TEXT) return text;

  const candidate = text.slice(0, MAX_ALICE_TEXT - 1);
  const lastSpace = candidate.lastIndexOf(" ");
  return (lastSpace > 200 ? candidate.slice(0, lastSpace) : candidate).trim() + "…";
}

function aliceResponse(text, endSession = false, history = []) {
  return {
    version: "1.0",
    response: {
      text: fitAliceText(text),
      end_session: endSession
    },
    session_state: { history },
    user_state_update: { history }
  };
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .filter(item =>
      item &&
      (item.role === "user" || item.role === "assistant") &&
      typeof item.text === "string"
    )
    .slice(-MAX_HISTORY_MESSAGES)
    .map(item => ({
      role: item.role,
      text: item.text.slice(0, MAX_HISTORY_MESSAGE_CHARS)
    }));
}

async function askOpenAI(text, history) {
  const key = process.env.OPENAI_API_KEY;

  if (!key) throw new Error("MISSING_OPENAI_KEY");

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.map(item => ({
      role: item.role,
      content: item.text
    })),
    { role: "user", content: text }
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  try {
    const response = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || DEFAULT_MODEL,
          messages,
          temperature: 0.5,
          max_completion_tokens: 180
        }),
        signal: controller.signal
      }
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error(
        "OpenAI HTTP:",
        response.status,
        "Code:",
        data?.error?.code || "unknown"
      );

      if (data?.error?.code === "unsupported_country_region_territory") {
        throw new Error("UNSUPPORTED_REGION");
      }
      if (response.status === 401) throw new Error("INVALID_OPENAI_KEY");
      if (response.status === 429) throw new Error("OPENAI_LIMIT");
      throw new Error("OPENAI_REQUEST_FAILED");
    }

    const answer = data?.choices?.[0]?.message?.content?.trim();

    if (!answer) throw new Error("EMPTY_OPENAI_RESPONSE");

    return answer;
  } finally {
    clearTimeout(timer);
  }
}

function errorForUser(error) {
  switch (error?.message) {
    case "MISSING_OPENAI_KEY":
      return "Не настроен ключ OpenAI на сервере.";
    case "INVALID_OPENAI_KEY":
      return "Ключ OpenAI не принят сервером.";
    case "UNSUPPORTED_REGION":
      return "OpenAI отклонил запрос из региона сервера.";
    case "OPENAI_LIMIT":
      return "Достигнут лимит запросов OpenAI. Попробуйте позже.";
    case "AbortError":
      return "Не успела подготовить ответ. Повтори вопрос.";
    default:
      return "Не удалось получить ответ ChatGPT. Попробуйте ещё раз.";
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "alice-openai",
      model: process.env.OPENAI_MODEL || DEFAULT_MODEL,
      message: "Webhook is ready."
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};

  const text = String(
    body?.request?.command ||
    body?.request?.original_utterance ||
    ""
  ).trim();

 const oldHistory = safeHistory(
  body?.state?.session?.history ??
  body?.state?.user?.history
);

  if (!text) {
    return res.status(200).json(aliceResponse(
      "Привет! Я ChatGPT. О чём хочешь поговорить?",
      false,
      oldHistory
    ));
  }

  try {
    const answer = await askOpenAI(text, oldHistory);

    const history = [
      ...oldHistory,
      {
        role: "user",
        text: text.slice(0, MAX_HISTORY_MESSAGE_CHARS)
      },
      {
        role: "assistant",
        text: answer.slice(0, MAX_HISTORY_MESSAGE_CHARS)
      }
    ].slice(-MAX_HISTORY_MESSAGES);

    return res.status(200).json(
      aliceResponse(answer, false, history)
    );
  } catch (error) {
    console.warn("OpenAI fallback:", error?.message || "unknown");

    return res.status(200).json(
      aliceResponse(errorForUser(error), false, oldHistory)
    );
  }
}

export { aliceResponse, fitAliceText, safeHistory };
