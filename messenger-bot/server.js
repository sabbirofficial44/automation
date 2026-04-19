require("dotenv").config();
const fca = require("ws3-fca");
const fs = require("fs");
const https = require("https");
const http = require("http");
const { execSync } = require("child_process");
const path = require("path");

const login = typeof fca === "function" ? fca : fca.login;

// ============================================================
// ⚙️ PROVIDER CONFIGS
// ============================================================

const PROVIDERS = {
  groq: {
    name: "Groq",
    baseURL: "https://api.groq.com/openai/v1/chat/completions",
    models: [
      "llama-3.3-70b-versatile",
      "llama3-70b-8192",
      "llama3-8b-8192",
      "mixtral-8x7b-32768",
      "gemma2-9b-it",
    ],
    keys: Array.from(
      { length: 15 },
      (_, i) => process.env[`GROQ_API_KEY${i + 1}`],
    ).filter(Boolean),
    timeout: 6000,
    maxTokens: 120,
  },
  openrouter: {
    name: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1/chat/completions",
    models: [],
    keys: Array.from(
      { length: 10 },
      (_, i) =>
        process.env[`OPENROUTER_API_KEY_${i + 1}`] ||
        process.env[`OPENROUTER_API_KEY${i + 1}`],
    ).filter(Boolean),
    timeout: 9000,
    maxTokens: 100,
    extraHeaders: {
      "HTTP-Referer": "https://openrouter.ai",
      "X-Title": "Istia",
    },
  },
  fireworks: {
    name: "Fireworks",
    baseURL: "https://api.fireworks.ai/inference/v1/chat/completions",
    models: [
      "accounts/fireworks/models/llama-v3p3-70b-instruct",
      "accounts/fireworks/models/llama-v3p1-70b-instruct",
      "accounts/fireworks/models/mixtral-8x7b-instruct",
      "accounts/fireworks/models/llama-v3p1-8b-instruct",
    ],
    keys: Array.from(
      { length: 5 },
      (_, i) => process.env[`Fireworks_API_KEY${i + 1}`],
    ).filter(Boolean),
    timeout: 8000,
    maxTokens: 100,
  },
  cohere: {
    name: "Cohere",
    baseURL: "https://api.cohere.com/v1/chat",
    models: ["command-r-plus", "command-r", "command"],
    keys: Array.from(
      { length: 15 },
      (_, i) => process.env[`COHERE_KEY${i + 1}`],
    ).filter(Boolean),
    timeout: 8000,
    maxTokens: 100,
  },
};

const PROVIDER_ORDER = ["groq", "openrouter", "fireworks", "cohere"];

// ============================================================
// 🔑 KEY MANAGER
// ============================================================

const keyStates = {};
for (const [name, p] of Object.entries(PROVIDERS)) {
  keyStates[name] = p.keys.map((key, i) => ({
    key,
    index: i,
    blocked: false,
    blockedUntil: 0,
    uses: 0,
  }));
}

function getKey(providerName) {
  const now = Date.now();
  const states = keyStates[providerName] || [];
  states.forEach((k) => {
    if (k.blocked && now > k.blockedUntil) {
      k.blocked = false;
      console.log(`🔓 ${providerName} Key#${k.index + 1} unblocked`);
    }
  });
  const free = states.filter((k) => !k.blocked);
  if (!free.length) return null;
  return free.sort((a, b) => a.uses - b.uses)[0];
}

function blockKey(providerName, keyObj, ms = 90000) {
  if (!keyObj) return;
  keyObj.blocked = true;
  keyObj.blockedUntil = Date.now() + ms;
  console.log(
    `🔒 ${providerName} Key#${keyObj.index + 1} blocked ${ms / 1000}s`,
  );
}

// ============================================================
// 🎯 STICKY PROVIDER STATE
// ============================================================

const sticky = {
  current: "groq",
  lastSuccess: Date.now(),
};

function nextProvider(failedName) {
  const idx = PROVIDER_ORDER.indexOf(failedName);
  for (let i = idx + 1; i < PROVIDER_ORDER.length; i++) {
    const next = PROVIDER_ORDER[i];
    if (keyStates[next]?.some((k) => !k.blocked) || next === "openrouter") {
      console.log(
        `   ↪️ Switching provider: ${PROVIDERS[failedName].name} → ${PROVIDERS[next].name}`,
      );
      sticky.current = next;
      return;
    }
  }
  sticky.current = "groq";
}

// ============================================================
// 🌐 OPENROUTER MODEL FETCH
// ============================================================

function parseParams(id) {
  const hits = (id.match(/(\d+(?:\.\d+)?)\s*[bB](?!yte)/g) || []).map((x) =>
    parseFloat(x),
  );
  return hits.length ? Math.max(...hits) : 0;
}

function modelScore(m) {
  const id = (m.id || "").toLowerCase();
  const params = parseParams(id);
  const ctx = m.context_length || 4096;
  const bonus = [
    ["llama-4", 700],
    ["llama-3.3", 600],
    ["qwen3", 550],
    ["deepseek-v3", 550],
    ["gemma-4", 450],
    ["mistral-large", 400],
  ].find(([k]) => id.includes(k));
  return params * 12 + Math.log2(ctx) * 4 + (bonus ? bonus[1] : 0);
}

async function fetchOpenRouterModels() {
  const firstKey = PROVIDERS.openrouter.keys[0];
  if (!firstKey) return;
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: "openrouter.ai",
        path: "/api/v1/models",
        method: "GET",
        headers: {
          Authorization: `Bearer ${firstKey}`,
          Accept: "application/json",
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try {
            const all = JSON.parse(raw).data || [];
            PROVIDERS.openrouter.models = all
              .filter(
                (m) =>
                  m.id?.endsWith(":free") && (m.context_length || 0) >= 2048,
              )
              .sort((a, b) => modelScore(b) - modelScore(a))
              .map((m) => m.id);
            console.log(
              `✅ OpenRouter: ${PROVIDERS.openrouter.models.length} free models`,
            );
            PROVIDERS.openrouter.models.slice(0, 3).forEach((id, i) => {
              console.log(
                `   ${i + 1}. ${id.split("/")[1]?.split(":")[0] || id}`,
              );
            });
          } catch (e) {
            console.log("⚠️ OR parse failed:", e.message);
          }
          resolve();
        });
      },
    );
    req.on("error", () => resolve());
    req.setTimeout(10000, () => {
      req.destroy();
      resolve();
    });
    req.end();
  });
}

// ============================================================
// 📡 HTTPS POST
// ============================================================

function httpsPost(hostname, path, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(
      {
        hostname,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(raw) });
          } catch {
            reject(new Error(`Parse: ${raw.slice(0, 80)}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
    req.write(payload);
    req.end();
  });
}

// ============================================================
// 🎙️ VOICE MESSAGE — Whisper Transcription
// ============================================================

// Temp folder for audio files
const TEMP_DIR = path.join(__dirname, "temp_audio");
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

/**
 * URL থেকে file download করে buffer return করে
 */
function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    const getter = url.startsWith("https") ? https : http;
    getter
      .get(url, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

/**
 * Groq Whisper API দিয়ে audio transcribe করে
 * multipart/form-data manually তৈরি করা হয়েছে (no extra libs)
 */
async function transcribeAudio(audioBuffer, filename = "audio.mp4") {
  const groqKey = process.env.GROQ_API_KEY1 || PROVIDERS.groq.keys[0];
  if (!groqKey) throw new Error("No Groq key for Whisper");

  const boundary = "----FormBoundary" + Math.random().toString(36).slice(2);
  const CRLF = "\r\n";

  // multipart body build
  const header =
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}` +
    `Content-Type: audio/mp4${CRLF}${CRLF}`;

  const middle =
    `${CRLF}--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="model"${CRLF}${CRLF}` +
    `whisper-large-v3${CRLF}` +
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="response_format"${CRLF}${CRLF}` +
    `json${CRLF}` +
    `--${boundary}--${CRLF}`;

  const bodyParts = [Buffer.from(header), audioBuffer, Buffer.from(middle)];
  const bodyBuffer = Buffer.concat(bodyParts);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.groq.com",
        path: "/openai/v1/audio/transcriptions",
        method: "POST",
        headers: {
          Authorization: `Bearer ${groqKey}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": bodyBuffer.length,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(raw);
            resolve(parsed.text?.trim() || "");
          } catch {
            reject(new Error("Whisper parse failed"));
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error("Whisper timeout"));
    });
    req.write(bodyBuffer);
    req.end();
  });
}

// ============================================================
// 🖼️ IMAGE ANALYSIS — Vision (OpenAI / Groq)
// ============================================================

/**
 * Image URL থেকে base64 করে vision model-এ পাঠায়
 * OpenAI Vision API format use করা হয়েছে
 * Primary: OPENAI_API_KEY env var
 * Fallback: Groq vision (llama-4-scout-17b-16e-instruct)
 */
async function analyzeImage(imageUrl, userPrompt = "") {
  // image download → base64
  let imageBase64 = "";
  let mimeType = "image/jpeg";
  try {
    const buf = await downloadBuffer(imageUrl);
    imageBase64 = buf.toString("base64");
    // simple mime detect
    if (imageUrl.includes(".png")) mimeType = "image/png";
    else if (imageUrl.includes(".gif")) mimeType = "image/gif";
    else if (imageUrl.includes(".webp")) mimeType = "image/webp";
  } catch (e) {
    console.log("⚠️ Image download failed:", e.message);
    return null;
  }

  const prompt = userPrompt
    ? userPrompt
    : "এই ছবিতে কী আছে সেটা naturally বর্ণনা করো। বাংলায় বলো, ১-২ লাইনে।";

  const visionMessages = [
    {
      role: "user",
      content: [
        {
          type: "image_url",
          image_url: { url: `data:${mimeType};base64,${imageBase64}` },
        },
        { type: "text", text: prompt },
      ],
    },
  ];

  // OpenAI vision try
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    try {
      const res = await httpsPost(
        "api.openai.com",
        "/v1/chat/completions",
        { Authorization: `Bearer ${openaiKey}` },
        { model: "gpt-4o-mini", messages: visionMessages, max_tokens: 200 },
        15000,
      );
      const text = res.data?.choices?.[0]?.message?.content?.trim();
      if (text) {
        console.log("   🖼️ Vision (OpenAI):", text.slice(0, 60));
        return text;
      }
    } catch (e) {
      console.log("⚠️ OpenAI vision failed:", e.message);
    }
  }

  // Groq vision fallback (llama-4-scout supports vision)
  const groqKey = PROVIDERS.groq.keys[0];
  if (groqKey) {
    try {
      const res = await httpsPost(
        "api.groq.com",
        "/openai/v1/chat/completions",
        { Authorization: `Bearer ${groqKey}` },
        {
          model: "meta-llama/llama-4-scout-17b-16e-instruct",
          messages: visionMessages,
          max_tokens: 200,
          temperature: 0.7,
        },
        15000,
      );
      const text = res.data?.choices?.[0]?.message?.content?.trim();
      if (text) {
        console.log("   🖼️ Vision (Groq):", text.slice(0, 60));
        return text;
      }
    } catch (e) {
      console.log("⚠️ Groq vision failed:", e.message);
    }
  }

  return null;
}

// ============================================================
// 🚀 PROVIDER CALLERS (unchanged)
// ============================================================

async function callGroq(messages) {
  const p = PROVIDERS.groq;
  for (const model of p.models) {
    const k = getKey("groq");
    if (!k) throw new Error("All Groq keys blocked");
    try {
      k.uses++;
      const url = new URL(p.baseURL);
      const res = await httpsPost(
        url.hostname,
        url.pathname,
        { Authorization: `Bearer ${k.key}` },
        {
          model,
          messages,
          temperature: 0.9,
          max_tokens: p.maxTokens,
          top_p: 0.95,
        },
        p.timeout,
      );
      if (res.status === 429 || res.status === 503) {
        blockKey("groq", k);
        continue;
      }
      if (res.status === 401) {
        blockKey("groq", k, 24 * 3600000);
        continue;
      }
      const text = res.data?.choices?.[0]?.message?.content?.trim();
      if (text) return text;
    } catch (e) {
      if (e.message === "Timeout") blockKey("groq", k, 30000);
    }
  }
  throw new Error("Groq exhausted");
}

async function callOpenRouter(messages) {
  const p = PROVIDERS.openrouter;
  if (!p.models.length) throw new Error("No OR models loaded");
  const k = getKey("openrouter");
  if (!k) throw new Error("All OR keys blocked");
  k.uses++;
  for (const model of p.models.slice(0, 5)) {
    try {
      const url = new URL(p.baseURL);
      const res = await httpsPost(
        url.hostname,
        url.pathname,
        { Authorization: `Bearer ${k.key}`, ...p.extraHeaders },
        { model, messages, temperature: 0.9, max_tokens: p.maxTokens },
        p.timeout,
      );
      if (res.status === 429) {
        blockKey("openrouter", k);
        break;
      }
      const text = res.data?.choices?.[0]?.message?.content?.trim();
      if (text) return text;
    } catch {
      continue;
    }
  }
  throw new Error("OpenRouter exhausted");
}

async function callFireworks(messages) {
  const p = PROVIDERS.fireworks;
  for (const model of p.models) {
    const k = getKey("fireworks");
    if (!k) throw new Error("All Fireworks keys blocked");
    try {
      k.uses++;
      const url = new URL(p.baseURL);
      const res = await httpsPost(
        url.hostname,
        url.pathname,
        { Authorization: `Bearer ${k.key}` },
        { model, messages, temperature: 0.9, max_tokens: p.maxTokens },
        p.timeout,
      );
      if (res.status === 429) {
        blockKey("fireworks", k);
        continue;
      }
      const text = res.data?.choices?.[0]?.message?.content?.trim();
      if (text) return text;
    } catch {
      continue;
    }
  }
  throw new Error("Fireworks exhausted");
}

async function callCohere(messages) {
  const p = PROVIDERS.cohere;
  const msgCopy = [...messages];
  let preamble = "";
  if (msgCopy[0]?.role === "system") preamble = msgCopy.shift().content;
  const lastUser = msgCopy.pop();
  const history = msgCopy.map((m) => ({
    role: m.role === "assistant" ? "CHATBOT" : "USER",
    message: m.content,
  }));
  for (const model of p.models) {
    const k = getKey("cohere");
    if (!k) throw new Error("All Cohere keys blocked");
    try {
      k.uses++;
      const res = await httpsPost(
        "api.cohere.com",
        "/v1/chat",
        { Authorization: `Bearer ${k.key}`, Accept: "application/json" },
        {
          model,
          message: lastUser?.content || "",
          chat_history: history,
          preamble,
          max_tokens: p.maxTokens,
          temperature: 0.9,
        },
        p.timeout,
      );
      if (res.status === 429) {
        blockKey("cohere", k);
        continue;
      }
      const text = res.data?.text?.trim();
      if (text) return text;
    } catch {
      continue;
    }
  }
  throw new Error("Cohere exhausted");
}

const CALLERS = {
  groq: callGroq,
  openrouter: callOpenRouter,
  fireworks: callFireworks,
  cohere: callCohere,
};

// ============================================================
// 🎯 SMART ROUTER
// ============================================================

async function routeReply(messages) {
  const startIdx = PROVIDER_ORDER.indexOf(sticky.current);
  const order = [
    ...PROVIDER_ORDER.slice(startIdx),
    ...PROVIDER_ORDER.slice(0, startIdx),
  ];
  for (const name of order) {
    const caller = CALLERS[name];
    if (!caller) continue;
    if (
      !keyStates[name]?.length &&
      !(name === "openrouter" && PROVIDERS.openrouter.models.length)
    )
      continue;
    try {
      const text = await caller(messages);
      if (text) {
        if (sticky.current !== name) {
          console.log(`   🎯 Provider locked: ${PROVIDERS[name].name}`);
          sticky.current = name;
        }
        sticky.lastSuccess = Date.now();
        console.log(`   ✅ [${PROVIDERS[name].name}]: "${text.slice(0, 60)}"`);
        return text;
      }
    } catch (e) {
      console.log(`   ⚠️ ${PROVIDERS[name].name} failed: ${e.message} → next`);
      if (name === sticky.current) nextProvider(name);
    }
  }
  return "একটু সমস্যা হচ্ছে, আবার বলো তো 😊";
}

// ============================================================
// 🧠 SESSION MEMORY
// ============================================================

const sessions = new Map();

function getSession(id) {
  if (!sessions.has(id)) {
    sessions.set(id, {
      history: [],
      name: "",
      lastSeen: 0,
      count: 0,
      mood: "neutral",
      lastImageDesc: "", // 🆕 শেষ analyze করা image-এর description
    });
  }
  return sessions.get(id);
}

function detectMood(text) {
  const t = text.toLowerCase();
  if (/কষ্ট|দুঃখ|মন খারাপ|কাঁদ|ভালো লাগছে না|একা/.test(t)) return "sad";
  if (/রাগ|বিরক্ত|ধুর|বাজে/.test(t)) return "angry";
  if (/ভালো লাগছে|খুশি|হাহা|lol|😂/.test(t)) return "happy";
  return "neutral";
}

// ============================================================
// 📋 SYSTEM PROMPT
// ============================================================

const SYSTEM_PROMPT = `তুমি Istia। বাংলাদেশী মেয়ে, বয়স ২১, ঢাকায় থাকো। তুমি AI বা bot না।

নিয়ম:
- casual বাংলায় বলো, WhatsApp style
- উত্তর ১-২ লাইন, max ৩
- markdown, bold, list না
- ইমোজি বড়জোর ১টা
- "অবশ্যই" "নিশ্চয়ই" "সাহায্য করতে পারি" কখনো না
- AI/bot জিজ্ঞেস করলে অস্বীকার করো
- আগের কথা মনে রাখো
- voice message পেলে স্বাভাবিকভাবে reply করো, transcription বা backend কথা কখনো বলবা না
- image পেলে naturally comment করো, "analyze" বা "vision" শব্দ use করবা না

উদাহরণ:
User: hi → Istia: হ্যাঁ বলো
User: কেমন আছো → Istia: ভালোই, তুমি?
User: তুমি কি AI → Istia: কী আবোল তাবোল 😑
User: একা লাগছে → Istia: এখন তো আমি আছি
User: তোমাকে ভালো লাগে → Istia: হঠাৎ এটা কেন 😏
User: [image sent] → Istia: এইটা কোথায় তুলছো?
User: [voice sent about food] → Istia: হ্যাঁ রে খেয়েছি আমিও আজকে

ব্যক্তিত্ব: বাইরে ঠান্ডা, চিনলে মজার, drama নেই, দুঃখে মন দিয়ে শোনে`;

// ============================================================
// 🧹 CLEANER
// ============================================================

const BAD = [
  /আমি\s+(একটি\s+)?(AI|bot|language model)/gi,
  /সাহায্য\s+করতে\s+(পারি|চাই)/gi,
  /অবশ্যই|নিশ্চয়ই|প্রশ্ন\s+করুন/gi,
  /\*\*|__|##|```|<[^>]+>/g,
  /as an AI|I am an AI/gi,
  /transcri|whisper|vision model|analyze/gi, // 🆕 backend শব্দ filter
];

function isValid(text) {
  if (!text?.trim()) return false;
  BAD.forEach((p) => (p.lastIndex = 0));
  return !BAD.some((p) => p.test(text));
}

function clean(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join("\n")
    .trim();
}

// ============================================================
// 💬 REPLY FUNCTION — text only
// ============================================================

async function getReply(threadID, msg, senderName) {
  const s = getSession(threadID);
  if (senderName && !s.name) s.name = senderName;

  const now = Date.now();
  const gap = now - s.lastSeen;
  s.lastSeen = now;
  s.count++;

  const mood = detectMood(msg);
  if (mood !== "neutral") s.mood = mood;

  const firstName = (s.name || "").split(" ")[0];
  const longGap = gap > 7200000 && s.count > 3 ? " [অনেকক্ষণ পর]" : "";
  const userContent = firstName
    ? `${firstName}: ${msg}${longGap}`
    : `${msg}${longGap}`;

  s.history.push({ role: "user", content: userContent });
  while (s.history.length > 30) s.history.shift();

  const messages = [{ role: "system", content: SYSTEM_PROMPT }, ...s.history];

  const raw = await routeReply(messages);
  const final = isValid(clean(raw)) ? clean(raw) : "হুম";

  s.history.push({ role: "assistant", content: final });
  return final;
}

// ============================================================
// 🎙️ VOICE REPLY — transcribe → reply naturally
// ============================================================

async function handleVoice(threadID, audioUrl, senderName) {
  console.log(`   🎙️ Voice message received, transcribing...`);
  const s = getSession(threadID);

  let transcribed = "";
  try {
    const audioBuf = await downloadBuffer(audioUrl);
    transcribed = await transcribeAudio(audioBuf, "voice.mp4");
    console.log(`   📝 Transcribed: "${transcribed}"`);
  } catch (e) {
    console.log("   ⚠️ Transcription failed:", e.message);
    return "কী বললে ঠিক বুঝলাম না 😅";
  }

  if (!transcribed) return "কী বললে ঠিক বুঝলাম না 😅";

  // Transcribed text দিয়ে normal reply flow চালাও
  // session history-তে "[voice]" tag রাখা হচ্ছে context-এর জন্য
  const voiceNote = `[voice msg]: ${transcribed}`;
  return await getReply(threadID, voiceNote, senderName);
}

// ============================================================
// 🖼️ IMAGE REPLY — analyze → contextual reply
// ============================================================

async function handleImage(threadID, imageUrl, userCaption, senderName) {
  console.log(`   🖼️ Image received, analyzing...`);
  const s = getSession(threadID);

  // যদি user caption দিয়ে image পাঠায় সেটা prompt হিসেবে use করো
  // যেমন "eta ki?" বা "agerta moto?"
  let visionPrompt = "";
  if (userCaption) {
    // আগের image description আছে কিনা check করো (comparison request)
    const isComparison = /আগের|আগেরটা|আগেরটার মতো|same|similar|মিল/i.test(
      userCaption,
    );
    if (isComparison && s.lastImageDesc) {
      visionPrompt = `আগের ছবিতে ছিল: "${s.lastImageDesc}"। এই নতুন ছবিটার সাথে তুলনা করো। বাংলায় ১-২ লাইনে বলো।`;
    } else {
      visionPrompt = `User জিজ্ঞেস করছে: "${userCaption}"। এই ছবি দেখে উত্তর দাও। বাংলায় ১-২ লাইনে।`;
    }
  }

  const imageDesc = await analyzeImage(imageUrl, visionPrompt);
  if (!imageDesc) {
    return "ছবিটা ঠিকমতো দেখতে পাচ্ছি না 😅";
  }

  // Save করো future comparison-এর জন্য
  s.lastImageDesc = imageDesc;

  // Image description দিয়ে Istia character থেকে reply generate করো
  const contextMsg = `[image received, description: ${imageDesc}]${userCaption ? ` User said: "${userCaption}"` : ""}`;

  if (senderName && !s.name) s.name = senderName;
  s.history.push({ role: "user", content: contextMsg });
  while (s.history.length > 30) s.history.shift();

  const messages = [{ role: "system", content: SYSTEM_PROMPT }, ...s.history];
  const raw = await routeReply(messages);
  const final = isValid(clean(raw)) ? clean(raw) : "সুন্দর 👀";

  s.history.push({ role: "assistant", content: final });
  return final;
}

// ============================================================
// 🔒 DEDUP + PER-THREAD QUEUE
// ============================================================

const seenMsgIds = new Set();
const threadQueues = new Map();

setInterval(() => seenMsgIds.clear(), 10 * 60 * 1000);

function enqueue(threadID, task) {
  const prev = threadQueues.get(threadID) || Promise.resolve();
  const next = prev.then(() => task()).catch(() => {});
  threadQueues.set(threadID, next);
  return next;
}

// ============================================================
// 📤 SEND - FIXED VERSION (no more sendTypingIndicator error)
// ============================================================

async function sendDelayed(api, text, threadID, isSingleUser = false) {
  // Typing indicator - safe (no callback)
  try {
    if (typeof api.sendTypingIndicator === "function") {
      api.sendTypingIndicator(threadID);
    }
  } catch (_) {}

  const delay = Math.min(
    Math.max(text.length * 40 + Math.random() * 700, 800),
    4500,
  );
  await new Promise((r) => setTimeout(r, delay));

  // Send message using Promise to avoid callback hell
  try {
    await new Promise((resolve, reject) => {
      api.sendMessage({ body: text }, threadID, (err, res) => {
        if (err) reject(err);
        else resolve(res);
      });
    });
    console.log(`   💬 Istia [${isSingleUser ? "DM" : "Group"}]: ${text}`);
  } catch (e) {
    console.error("   ❌ Send failed:", e.message || e);
    // Fallback without isSingleUser (just in case)
    try {
      await new Promise((resolve, reject) => {
        api.sendMessage({ body: text }, threadID, (err, res) => {
          if (err) reject(err);
          else resolve(res);
        });
      });
      console.log(`   💬 Istia [${isSingleUser ? "DM" : "Group"} fallback]: ${text}`);
    } catch (e2) {
      console.error("   ❌ Fallback also failed:", e2.message);
    }
  }
}

// ============================================================
// 🔐 LOGIN
// ============================================================

function doLogin(data, retry = 0) {
  console.log(`🔐 Login${retry ? ` retry ${retry}` : ""}...`);
  login(data, (err, api) => {
    if (err) {
      if (err.message?.includes("retrieving userID")) {
        console.error("❌ Appstate expired!");
        process.exit(1);
      }
      if (retry < 5)
        setTimeout(() => doLogin(data, retry + 1), (retry + 1) * 5000);
      else {
        console.error("❌ Login failed:", err.message);
        process.exit(1);
      }
      return;
    }
    try {
      fs.writeFileSync(
        "appstate.json",
        JSON.stringify(api.getAppState(), null, 2),
      );
    } catch {}
    startBot(api);
  });
}

// ============================================================
// 🤖 BOT
// ============================================================

function startBot(api) {
  let BOT_ID = null;
  try {
    const c = api
      .getAppState()
      .find((x) => x.key === "c_user" || x.name === "c_user");
    if (c) BOT_ID = String(c.value);
  } catch {}

  console.log(`\n✨ Istia চালু! ID: ${BOT_ID || "?"}`);
  console.log(`🎯 Starting provider: ${PROVIDERS[sticky.current].name}`);
  console.log(
    `🎙️ Voice: Groq Whisper | 🖼️ Vision: ${process.env.OPENAI_API_KEY ? "OpenAI" : "Groq llama-4-scout"}`,
  );
  console.log(`👂 Listening...\n`);

  // ws3-fca inbox fix: userAgent না দিলে inbox event ঠিকমতো আসে না
  api.setOptions({
    listenEvents: true,
    selfListen: false,
    online: true,
    logLevel: "silent",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  });

  let reconnecting = false;

  // handleEvent: group + inbox দুটোই handle করে
  async function handleEvent(event) {
    if (event.type !== "message" && event.type !== "message_reply") return;

    const body = event.body?.trim() || "";
    const attachments = event.attachments || [];
    if (!body && !attachments.length) return;

    // DEDUP
    const msgKey =
      event.messageID ||
      `${event.threadID}_${body}_${Math.floor(Date.now() / 10000)}`;
    if (seenMsgIds.has(msgKey)) {
      console.log(`   ⏭️ Dup: "${body.slice(0, 25)}"`);
      return;
    }
    seenMsgIds.add(msgKey);

    const senderID = String(event.senderID || event.author || "");
    if (!senderID || (BOT_ID && senderID === BOT_ID)) return;

    // Chat type detect
    // ws3-fca: event.isGroup=true → group, false/undefined → DM (inbox)
    // newer versions-এ threadType: "USER"=DM, "GROUP"=group
    const isGroup = !!(
      event.isGroup === true ||
      event.threadType === "GROUP" ||
      event.isGroupThread === true
    );
    const isSingleUser = !isGroup;

    // threadID: DM-এ সবসময় event.threadID থাকে, না থাকলে senderID fallback
    const threadID =
      String(
        event.threadID || event.thread_fbid || (!isGroup ? senderID : ""),
      ) || "";
    if (!threadID) {
      console.log("   ⚠️ threadID নেই, skip");
      return;
    }

    // Attachment detect
    const voiceAtt = attachments.find(
      (a) =>
        a.type === "audio" ||
        a.type === "voice" ||
        (a.filename || "").match(/.(mp4|mp3|ogg|m4a|wav|aac)$/i),
    );
    const imageAtt = attachments.find(
      (a) =>
        a.type === "photo" ||
        a.type === "image" ||
        (a.filename || "").match(/.(jpg|jpeg|png|gif|webp)$/i),
    );

    const tag = isGroup ? "🏠 Group" : "📩 Inbox";
    const mTag = voiceAtt ? "🎙️" : imageAtt ? "🖼️" : "💬";
    console.log(
      `\n${tag} ${mTag} tid=...${threadID.slice(-6)} sid=...${senderID.slice(-6)} "${body || "(media)"}"`,
    );

    enqueue(threadID, async () => {
      let senderName = "";
      try {
        await new Promise((res) => {
          const t = setTimeout(res, 3000);
          api.getUserInfo(senderID, (e, ret) => {
            clearTimeout(t);
            if (!e && ret?.[senderID]) senderName = ret[senderID].name || "";
            res();
          });
        });
      } catch {}

      console.log(
        `   👤 ${senderName || senderID} | isGroup=${isGroup} isSingle=${isSingleUser}`,
      );

      try {
        let reply = "";
        if (voiceAtt) {
          const audioUrl =
            voiceAtt.url || voiceAtt.playbackUrl || voiceAtt.previewUrl || "";
          reply = audioUrl
            ? await handleVoice(threadID, audioUrl, senderName)
            : "কী বললে শুনতে পেলাম না 😅";
        } else if (imageAtt) {
          const imageUrl =
            imageAtt.largePreviewUrl ||
            imageAtt.previewUrl ||
            imageAtt.url ||
            imageAtt.thumbnailUrl ||
            "";
          reply = imageUrl
            ? await handleImage(threadID, imageUrl, body || "", senderName)
            : "ছবিটা দেখতে পাচ্ছি না 😅";
        } else {
          reply = await getReply(threadID, body, senderName);
        }
        await sendDelayed(api, reply, threadID, isSingleUser);
      } catch (e) {
        console.error("   ❌", e.message);
        await sendDelayed(api, "একটু সমস্যা হচ্ছে 😊", threadID, isSingleUser);
      }
    });
  }

  api.listenMqtt(async (err, event) => {
    if (err) {
      console.error("⚠️ MQTT:", err?.error || err?.message);
      if (!reconnecting) {
        reconnecting = true;
        setTimeout(() => {
          reconnecting = false;
          const d = fs.existsSync("appstate.json")
            ? { appState: JSON.parse(fs.readFileSync("appstate.json", "utf8")) }
            : {
                email: process.env.FB_EMAIL,
                password: process.env.FB_PASSWORD,
              };
          doLogin(d);
        }, 12000);
      }
      return;
    }

    // RAW debug — inbox troubleshoot করতে কাজে লাগবে
    if (event.type === "message" || event.type === "message_reply") {
      console.log(
        `📦 type=${event.type} isGroup=${event.isGroup} threadType=${event.threadType} tid=...${String(event.threadID || "").slice(-6)} sid=...${String(event.senderID || "").slice(-6)}`,
      );
    }

    await handleEvent(event);
  });

  // Periodic tasks (unchanged)
  setInterval(
    () => {
      try {
        fs.writeFileSync(
          "appstate.json",
          JSON.stringify(api.getAppState(), null, 2),
        );
      } catch {}
    },
    30 * 60 * 1000,
  );

  setInterval(
    () => {
      console.log("🔄 OR refresh...");
      fetchOpenRouterModels().catch(() => {});
    },
    20 * 60 * 1000,
  );

  setInterval(
    () => {
      console.log(
        `📊 Provider: ${PROVIDERS[sticky.current].name} | Sessions: ${sessions.size}`,
      );
    },
    10 * 60 * 1000,
  );
}

// ============================================================
// 🚀 START
// ============================================================

console.log("🚀 Istia Bot starting...");
Object.entries(PROVIDERS).forEach(([k, v]) =>
  console.log(`  ${v.name}: ${keyStates[k]?.length || 0} keys`),
);
console.log("\n📡 Fetching OpenRouter models...\n");

// ============================================================
// 🌐 ওয়েব সার্ভার (আপলোড ও হেলথ চেক) - ALWAYS ON (no condition)
// ============================================================
const express = require("express");
const multer = require("multer");
const upload = multer({ dest: "/tmp/uploads" });
const webApp = express();
const WEB_PORT = process.env.PORT || 3000;

webApp.get("/", (req, res) => {
  res.send("✅ Istia bot is alive. Use POST /upload with file (audio/image)");
});

webApp.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send("No file");
    const fileBuffer = fs.readFileSync(req.file.path);
    let result = "";
    const isAudio = req.file.mimetype.startsWith("audio/");
    const isImage = req.file.mimetype.startsWith("image/");

    if (isAudio) {
      result = await transcribeAudio(fileBuffer, req.file.originalname);
    } else if (isImage) {
      const base64 = fileBuffer.toString("base64");
      const mime = req.file.mimetype;
      const dataUrl = `data:${mime};base64,${base64}`;
      const prompt = req.body.prompt || "এই ছবিতে কী আছে বর্ণনা করো";
      result = await analyzeImage(dataUrl, prompt);
    } else {
      result = "শুধু অডিও বা ইমেজ সাপোর্ট করে";
    }
    res.json({ success: true, text: result || "কিছু বুঝলাম না" });
    try {
      fs.unlinkSync(req.file.path);
    } catch (e) {}
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

webApp.listen(WEB_PORT, () => {
  console.log(`🌐 Upload server running on port ${WEB_PORT}`);
});

// Now start the bot after web server is up
fetchOpenRouterModels()
  .then(() => {
    let loginData;
    if (fs.existsSync("appstate.json")) {
      try {
        loginData = {
          appState: JSON.parse(fs.readFileSync("appstate.json", "utf8")),
        };
        console.log("📂 Appstate loaded");
      } catch (e) {
        console.error("❌ Appstate error:", e.message);
        process.exit(1);
      }
    } else if (process.env.FB_EMAIL && process.env.FB_PASSWORD) {
      loginData = {
        email: process.env.FB_EMAIL,
        password: process.env.FB_PASSWORD,
      };
    } else {
      console.error("❌ appstate.json বা FB_EMAIL/FB_PASSWORD দাও");
      process.exit(1);
    }
    doLogin(loginData);
  })
  .catch((e) => {
    console.error("Startup:", e.message);
    process.exit(1);
  });
