require("dotenv").config();
const fca = require("ws3-fca");
const fs = require("fs");
const https = require("https");
const http = require("http");
const path = require("path");

const login = typeof fca === "function" ? fca : fca.login;

// ============================================================
// ⚙️ CONFIG
// ============================================================

const CFG = {
  adminIds: (process.env.ADMIN_IDS || process.env.ADMIN_ID || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  pageId: process.env.PAGE_ID || "",
  pageToken: process.env.PAGE_ACCESS_TOKEN || "",
  userToken: process.env.FB_ACCESS_TOKEN || "",
  appSecret: process.env.APP_SECRET || "",
  verifyToken: process.env.VERIFY_TOKEN || "sbr_verify_token_2580",
  webhookPort: parseInt(process.env.PORT || "3001"),
  apiVersion: "v19.0",
};

// ============================================================
// ⚙️ PROVIDERS
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
// KEY MANAGER
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

function getKey(pName) {
  const now = Date.now();
  const states = keyStates[pName] || [];
  states.forEach((k) => {
    if (k.blocked && now > k.blockedUntil) k.blocked = false;
  });
  const free = states.filter((k) => !k.blocked);
  if (!free.length) return null;
  return free.sort((a, b) => a.uses - b.uses)[0];
}

function blockKey(pName, k, ms = 90000) {
  if (!k) return;
  k.blocked = true;
  k.blockedUntil = Date.now() + ms;
  console.log(`🔒 ${pName} Key#${k.index + 1} blocked ${ms / 1000}s`);
}

const sticky = { current: "groq", lastSuccess: Date.now() };

function nextProvider(failed) {
  const idx = PROVIDER_ORDER.indexOf(failed);
  for (let i = idx + 1; i < PROVIDER_ORDER.length; i++) {
    const next = PROVIDER_ORDER[i];
    if (keyStates[next]?.some((k) => !k.blocked) || next === "openrouter") {
      sticky.current = next;
      return;
    }
  }
  sticky.current = "groq";
}

// ============================================================
// OPENROUTER MODELS
// ============================================================

function modelScore(m) {
  const id = (m.id || "").toLowerCase();
  const hits = (id.match(/(\d+(?:\.\d+)?)\s*[bB](?!yte)/g) || []).map((x) =>
    parseFloat(x),
  );
  const params = hits.length ? Math.max(...hits) : 0;
  const ctx = m.context_length || 4096;
  const bonus = [
    ["llama-4", 700],
    ["llama-3.3", 600],
    ["qwen3", 550],
    ["deepseek-v3", 550],
  ].find(([k]) => id.includes(k));
  return params * 12 + Math.log2(ctx) * 4 + (bonus ? bonus[1] : 0);
}

async function fetchOpenRouterModels() {
  const key = PROVIDERS.openrouter.keys[0];
  if (!key) return;
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: "openrouter.ai",
        path: "/api/v1/models",
        method: "GET",
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
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
          } catch {}
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
// HTTP HELPERS
// ============================================================

function httpsPost(hostname, urlPath, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(
      {
        hostname,
        path: urlPath,
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

function httpsFormPost(
  hostname,
  urlPath,
  headers,
  formData,
  timeoutMs = 15000,
) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(formData).toString();
    const req = https.request(
      {
        hostname,
        path: urlPath,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
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
            resolve({ status: res.statusCode, raw: raw.slice(0, 300) });
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
    req.write(body);
    req.end();
  });
}

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

// ============================================================
// FACEBOOK API CLASS
// ============================================================

class FacebookAPI {
  constructor() {
    this.userToken = CFG.userToken;
    this.pageToken = CFG.pageToken;
    this.pageId = CFG.pageId;
    this.cookieStr = "";
    this.dtsg = "";
    this.lsd = "";
    this.userId = "";
    this.v = CFG.apiVersion;
  }

  init(appState) {
    this.cookieStr = appState.map((c) => `${c.key}=${c.value}`).join("; ");
    this.dtsg =
      appState.find((c) => c.key === "fb_dtsg" || c.key === "fb_dtsg_ag")
        ?.value || "";
    this.lsd = appState.find((c) => c.key === "lsd")?.value || "";
    this.userId = appState.find((c) => c.key === "c_user")?.value || "";
    console.log(
      `📘 FB API: userId=${this.userId} | userToken=${this.userToken ? "✅" : "❌"} | pageToken=${this.pageToken ? "✅" : "❌"} | pageId=${this.pageId || "❌"}`,
    );
  }

  _graphGet(path, params = {}, token = null) {
    return new Promise((resolve, reject) => {
      const tok = token || this.userToken;
      const qs = new URLSearchParams({ ...params, access_token: tok });
      const req = https.request(
        {
          hostname: "graph.facebook.com",
          path: `/${this.v}${path}?${qs}`,
          method: "GET",
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
      req.setTimeout(15000, () => {
        req.destroy();
        reject(new Error("Timeout"));
      });
      req.end();
    });
  }

  _graphPost(path, params = {}, token = null) {
    return httpsFormPost(
      "graph.facebook.com",
      `/${this.v}${path}`,
      {},
      { ...params, access_token: token || this.userToken },
    );
  }

  _internalPost(docId, variables) {
    return httpsFormPost(
      "www.facebook.com",
      "/api/graphql/",
      {
        Cookie: this.cookieStr,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
        Accept: "*/*",
        Referer: "https://www.facebook.com/",
        Origin: "https://www.facebook.com",
      },
      {
        av: this.userId,
        fb_dtsg: this.dtsg,
        lsd: this.lsd,
        doc_id: docId,
        variables: JSON.stringify(variables),
        server_timestamps: "true",
        __user: this.userId,
        __a: "1",
      },
      25000,
    );
  }

  // ── PERSONAL ──────────────────────────────────────────────

  async personalPost(message, privacy = "EVERYONE") {
    if (!this.userToken) throw new Error("FB_ACCESS_TOKEN নেই");
    const res = await this._graphPost("/me/feed", {
      message,
      privacy: JSON.stringify({ value: privacy }),
    });
    if (res.data?.error) throw new Error(res.data.error.message);
    const id = res.data?.id;
    if (!id) throw new Error("Post ID পাওয়া গেলো না");
    return id;
  }

  async personalImagePost(imageUrl, caption = "", privacy = "EVERYONE") {
    if (!this.userToken) throw new Error("FB_ACCESS_TOKEN নেই");
    const res = await this._graphPost("/me/photos", {
      url: imageUrl,
      caption,
      privacy: JSON.stringify({ value: privacy }),
      published: "true",
    });
    if (res.data?.error) throw new Error(res.data.error.message);
    const id = res.data?.id || res.data?.post_id;
    if (!id) throw new Error("Image ID পাওয়া গেলো না");
    return id;
  }

  async personalTextStory(text, bg = "#1877F2") {
    if (!this.dtsg) throw new Error("fb_dtsg নেই");
    const variables = {
      input: {
        story_bucket_owner_id: this.userId,
        client_mutation_id: String(Date.now()),
        composer_entry_time: Math.floor(Date.now() / 1000),
        composer_session_id: `sess_${Date.now()}`,
        source: "WWW",
        story_elements: [
          {
            text_data: {
              text,
              theme_id: null,
              text_format: {
                font_size: 28,
                font_color: "#FFFFFF",
                font_style: "BOLD",
                background_color: bg,
              },
            },
          },
        ],
        audience: {
          privacy: {
            allow: [],
            base_state: "EVERYONE",
            deny: [],
            tag_expansion_state: "UNSPECIFIED",
          },
        },
      },
    };
    try {
      const res = await this._internalPost("7950390928394120", variables);
      if (res.data?.errors)
        throw new Error(JSON.stringify(res.data.errors).slice(0, 100));
      return res.data?.story_create?.story?.id || "story_created";
    } catch (e) {
      console.log("⚠️ Story internal fail:", e.message, "→ fallback post");
      if (this.userToken) return this.personalPost(`📖 ${text}`);
      throw e;
    }
  }

  async personalImageStory(imageUrl) {
    if (!this.userToken) throw new Error("FB_ACCESS_TOKEN নেই");
    const res = await this._graphPost("/me/photos", {
      url: imageUrl,
      published: "true",
      no_story: "false",
      temporary_status: "true",
    });
    if (res.data?.error) {
      console.log("⚠️ Story limited → photo post");
      return this.personalImagePost(imageUrl, "📸");
    }
    return res.data?.id;
  }

  async personalShare(postUrl, message = "") {
    if (!this.userToken) throw new Error("FB_ACCESS_TOKEN নেই");
    const res = await this._graphPost("/me/feed", { message, link: postUrl });
    if (res.data?.error) throw new Error(res.data.error.message);
    return res.data?.id;
  }

  // ── PAGE ──────────────────────────────────────────────────

  async pagePost(message) {
    if (!this.pageToken) throw new Error("PAGE_ACCESS_TOKEN নেই");
    const res = await this._graphPost(
      `/${this.pageId}/feed`,
      { message },
      this.pageToken,
    );
    if (res.data?.error) throw new Error(res.data.error.message);
    return res.data?.id;
  }

  async pageImagePost(imageUrl, caption = "") {
    if (!this.pageToken) throw new Error("PAGE_ACCESS_TOKEN নেই");
    const res = await this._graphPost(
      `/${this.pageId}/photos`,
      { url: imageUrl, caption, published: "true" },
      this.pageToken,
    );
    if (res.data?.error) throw new Error(res.data.error.message);
    return res.data?.id || res.data?.post_id;
  }

  async pageShare(link, message = "") {
    if (!this.pageToken) throw new Error("PAGE_ACCESS_TOKEN নেই");
    const res = await this._graphPost(
      `/${this.pageId}/feed`,
      { message, link },
      this.pageToken,
    );
    if (res.data?.error) throw new Error(res.data.error.message);
    return res.data?.id;
  }

  async pageReplyMessage(recipientId, message) {
    if (!this.pageToken) throw new Error("PAGE_ACCESS_TOKEN নেই");
    const res = await this._graphPost(
      "/me/messages",
      {
        recipient: JSON.stringify({ id: recipientId }),
        message: JSON.stringify({ text: message }),
        messaging_type: "RESPONSE",
      },
      this.pageToken,
    );
    if (res.data?.error) throw new Error(res.data.error.message);
    return res.data?.message_id;
  }

  // ── SHARED ────────────────────────────────────────────────

  async likeObject(objectId, token = null) {
    const tok = token || this.userToken;
    if (!tok) throw new Error("Token নেই");
    const res = await this._graphPost(`/${objectId}/likes`, {}, tok);
    if (res.data?.error) throw new Error(res.data.error.message);
    return true;
  }

  async commentOn(objectId, message, token = null) {
    const tok = token || this.userToken;
    if (!tok) throw new Error("Token নেই");
    const res = await this._graphPost(
      `/${objectId}/comments`,
      { message },
      tok,
    );
    if (res.data?.error) throw new Error(res.data.error.message);
    return res.data?.id;
  }

  async getComments(objectId, token = null, limit = 100) {
    const tok = token || this.userToken;
    if (!tok) return [];
    const res = await this._graphGet(
      `/${objectId}/comments`,
      {
        fields: "id,from,message,created_time,like_count",
        limit: String(limit),
        order: "reverse_chronological",
      },
      tok,
    );
    if (res.data?.error) throw new Error(res.data.error.message);
    return res.data?.data || [];
  }

  async getPersonalPosts(limit = 10) {
    if (!this.userToken) return [];
    const res = await this._graphGet("/me/feed", {
      fields: "id,message,created_time,story",
      limit: String(limit),
    });
    if (res.data?.error) throw new Error(res.data.error.message);
    return res.data?.data || [];
  }

  async getPagePosts(limit = 10) {
    if (!this.pageToken || !this.pageId) return [];
    const res = await this._graphGet(
      `/${this.pageId}/feed`,
      { fields: "id,message,created_time,story", limit: String(limit) },
      this.pageToken,
    );
    if (res.data?.error) throw new Error(res.data.error.message);
    return res.data?.data || [];
  }

  async getMe() {
    if (!this.userToken) throw new Error("FB_ACCESS_TOKEN নেই");
    const res = await this._graphGet("/me", { fields: "id,name,email" });
    if (res.data?.error) throw new Error(res.data.error.message);
    return res.data;
  }

  async getPageInfo() {
    if (!this.pageToken || !this.pageId) throw new Error("Page token/ID নেই");
    const res = await this._graphGet(
      `/${this.pageId}`,
      { fields: "id,name,fan_count,followers_count,category" },
      this.pageToken,
    );
    if (res.data?.error) throw new Error(res.data.error.message);
    return res.data;
  }
}

const fbAPI = new FacebookAPI();

// ============================================================
// AUTO COMMENT WATCHER
// ============================================================

class CommentWatcher {
  constructor() {
    this.enabled = false;
    this.pageEnabled = false;
    this.replyText = "ধন্যবাদ 😊";
    this.pageReplyText = "ধন্যবাদ আপনার মন্তব্যের জন্য 😊";
    this.autoLike = false;
    this.aiReply = false;
    this.seenComments = new Set();
    this.watchedPersonalPosts = new Set();
    this.watchedPagePosts = new Set();
    this.pollMs = 60000;
    this.interval = null;
    this.notifyThreadId = null;
    this._messengerApi = null;
  }

  setMessengerApi(api) {
    this._messengerApi = api;
  }

  start(scope = "personal") {
    if (scope === "page") this.pageEnabled = true;
    else this.enabled = true;
    if (!this.interval) {
      this.interval = setInterval(() => this._poll(), this.pollMs);
      this._poll();
    }
    console.log(`👁️ ${scope} Comment Watcher চালু`);
  }

  stop(scope = "personal") {
    if (scope === "page") this.pageEnabled = false;
    else this.enabled = false;
    if (!this.enabled && !this.pageEnabled && this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    console.log(`🛑 ${scope} Comment Watcher বন্ধ`);
  }

  async _poll() {
    if (this.enabled) {
      let ids = [...this.watchedPersonalPosts];
      if (!ids.length) {
        try {
          const p = await fbAPI.getPersonalPosts(5);
          ids = p.map((x) => x.id);
        } catch {}
      }
      await this._processComments(ids, false);
    }
    if (this.pageEnabled) {
      let ids = [...this.watchedPagePosts];
      if (!ids.length) {
        try {
          const p = await fbAPI.getPagePosts(5);
          ids = p.map((x) => x.id);
        } catch {}
      }
      await this._processComments(ids, true);
    }
  }

  async _processComments(postIds, isPage) {
    for (const postId of postIds) {
      try {
        const token = isPage ? CFG.pageToken : CFG.userToken;
        const comments = await fbAPI.getComments(postId, token);
        for (const comment of comments) {
          if (this.seenComments.has(comment.id)) continue;
          this.seenComments.add(comment.id);
          const fromName = comment.from?.name || "Someone";
          const msg = comment.message || "";
          const scope = isPage ? "📄 Page" : "👤 Personal";
          console.log(
            `💬 ${scope} comment by ${fromName}: "${msg.slice(0, 60)}"`,
          );
          const replyText = isPage ? this.pageReplyText : this.replyText;
          if (replyText) {
            try {
              let finalReply = replyText;
              if (this.aiReply)
                finalReply =
                  (await getCommentReply(msg, fromName)) || replyText;
              const tok = isPage ? CFG.pageToken : CFG.userToken;
              await fbAPI.commentOn(comment.id, finalReply, tok);
              console.log(`   ✅ Auto-replied: "${finalReply.slice(0, 40)}"`);
            } catch (e) {
              console.log(`   ⚠️ Reply fail: ${e.message}`);
            }
          }
          if (this.autoLike) {
            try {
              await fbAPI.likeObject(
                comment.id,
                isPage ? CFG.pageToken : CFG.userToken,
              );
            } catch {}
          }
          if (this._messengerApi && this.notifyThreadId) {
            try {
              await this._messengerApi.sendMessage(
                {
                  body: `💬 ${isPage ? "Page" : "Personal"} comment!\n👤 ${fromName}\n📝 "${msg.slice(0, 80)}"`,
                },
                this.notifyThreadId,
              );
            } catch {}
          }
        }
      } catch (e) {
        console.log(`⚠️ Comment poll ${postId}: ${e.message}`);
      }
    }
  }
}

const commentWatcher = new CommentWatcher();

// ============================================================
// POST SCHEDULER
// ============================================================

const SCHEDULE_FILE = path.join(__dirname, "schedules.json");

class PostScheduler {
  constructor() {
    this.schedules = this._load();
    this.interval = null;
  }

  _load() {
    try {
      if (fs.existsSync(SCHEDULE_FILE))
        return JSON.parse(fs.readFileSync(SCHEDULE_FILE, "utf8"));
    } catch {}
    return [];
  }

  _save() {
    try {
      fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(this.schedules, null, 2));
    } catch (e) {
      console.log("⚠️ Schedule save:", e.message);
    }
  }

  add(
    time,
    text,
    target = "personal",
    type = "post",
    privacy = "EVERYONE",
    days = [],
  ) {
    const id = Date.now().toString(36);
    this.schedules.push({
      id,
      time,
      text,
      target,
      type,
      privacy,
      days,
      lastRun: null,
      enabled: true,
    });
    this._save();
    return id;
  }

  remove(id) {
    const before = this.schedules.length;
    this.schedules = this.schedules.filter((s) => s.id !== id);
    this._save();
    return before > this.schedules.length;
  }

  toggle(id) {
    const s = this.schedules.find((s) => s.id === id);
    if (!s) return null;
    s.enabled = !s.enabled;
    this._save();
    return s.enabled;
  }

  list() {
    return this.schedules;
  }

  start() {
    if (this.interval) clearInterval(this.interval);
    this.interval = setInterval(() => this._tick(), 60000);
    console.log("⏰ Scheduler চালু");
    this._tick();
  }

  async _tick() {
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const today = now.toDateString();
    const dayNames = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    const todayName = dayNames[now.getDay()];
    for (const s of this.schedules) {
      if (!s.enabled || s.time !== hhmm || s.lastRun === today) continue;
      if (s.days?.length && !s.days.includes(todayName)) continue;
      try {
        console.log(
          `⏰ Schedule [${s.id}] ${s.target}/${s.type}: "${s.text.slice(0, 40)}"`,
        );
        const targets = s.target === "both" ? ["personal", "page"] : [s.target];
        for (const tgt of targets) {
          try {
            if (tgt === "personal") await this._runPersonal(s);
            else await this._runPage(s);
          } catch (e) {
            console.log(`   ⚠️ ${tgt}: ${e.message}`);
          }
        }
        s.lastRun = today;
        this._save();
        console.log(`   ✅ Done`);
      } catch (e) {
        console.log(`   ⚠️ Schedule fail: ${e.message}`);
      }
    }
  }

  async _runPersonal(s) {
    const [url, ...capParts] = s.text.split("|");
    const cap = capParts.join("|").trim();
    switch (s.type) {
      case "image":
        return fbAPI.personalImagePost(url.trim(), cap, s.privacy);
      case "story":
        return fbAPI.personalTextStory(s.text);
      case "storyimg":
        return fbAPI.personalImageStory(s.text.trim());
      case "share":
        return fbAPI.personalShare(s.text.trim());
      default:
        return fbAPI.personalPost(s.text, s.privacy);
    }
  }

  async _runPage(s) {
    const [url, ...capParts] = s.text.split("|");
    const cap = capParts.join("|").trim();
    switch (s.type) {
      case "image":
        return fbAPI.pageImagePost(url.trim(), cap);
      case "share":
        return fbAPI.pageShare(s.text.trim());
      default:
        return fbAPI.pagePost(s.text);
    }
  }
}

const scheduler = new PostScheduler();

// ============================================================
// WHISPER + VISION
// ============================================================

async function transcribeAudio(audioBuffer, filename = "audio.mp4") {
  const groqKey = PROVIDERS.groq.keys[0];
  if (!groqKey) throw new Error("Groq key নেই");
  const boundary = "----FormBoundary" + Math.random().toString(36).slice(2);
  const CRLF = "\r\n";
  const header = `--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}Content-Type: audio/mp4${CRLF}${CRLF}`;
  const middle = `${CRLF}--${boundary}${CRLF}Content-Disposition: form-data; name="model"${CRLF}${CRLF}whisper-large-v3${CRLF}--${boundary}${CRLF}Content-Disposition: form-data; name="response_format"${CRLF}${CRLF}json${CRLF}--${boundary}--${CRLF}`;
  const bodyBuffer = Buffer.concat([
    Buffer.from(header),
    audioBuffer,
    Buffer.from(middle),
  ]);
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
            resolve(JSON.parse(raw).text?.trim() || "");
          } catch {
            reject(new Error("Whisper parse"));
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

async function analyzeImage(imageUrl, userPrompt = "") {
  let imageBase64 = "",
    mimeType = "image/jpeg";
  try {
    const buf = await downloadBuffer(imageUrl);
    imageBase64 = buf.toString("base64");
    if (imageUrl.includes(".png")) mimeType = "image/png";
    else if (imageUrl.includes(".webp")) mimeType = "image/webp";
  } catch {
    return null;
  }
  const prompt =
    userPrompt ||
    "এই ছবিতে কী আছে সেটা naturally বর্ণনা করো। বাংলায় বলো, ১-২ লাইনে।";
  const vMsgs = [
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
  if (process.env.OPENAI_API_KEY) {
    try {
      const res = await httpsPost(
        "api.openai.com",
        "/v1/chat/completions",
        { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        { model: "gpt-4o-mini", messages: vMsgs, max_tokens: 200 },
        15000,
      );
      const t = res.data?.choices?.[0]?.message?.content?.trim();
      if (t) return t;
    } catch {}
  }
  const groqKey = PROVIDERS.groq.keys[0];
  if (groqKey) {
    try {
      const res = await httpsPost(
        "api.groq.com",
        "/openai/v1/chat/completions",
        { Authorization: `Bearer ${groqKey}` },
        {
          model: "meta-llama/llama-4-scout-17b-16e-instruct",
          messages: vMsgs,
          max_tokens: 200,
          temperature: 0.7,
        },
        15000,
      );
      const t = res.data?.choices?.[0]?.message?.content?.trim();
      if (t) return t;
    } catch {}
  }
  return null;
}

// ============================================================
// AI PROVIDERS
// ============================================================

async function callGroq(messages) {
  const p = PROVIDERS.groq;
  for (const model of p.models) {
    const k = getKey("groq");
    if (!k) throw new Error("All Groq blocked");
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
  if (!p.models.length) throw new Error("No OR models");
  const k = getKey("openrouter");
  if (!k) throw new Error("All OR blocked");
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
  throw new Error("OR exhausted");
}

async function callFireworks(messages) {
  const p = PROVIDERS.fireworks;
  for (const model of p.models) {
    const k = getKey("fireworks");
    if (!k) throw new Error("All Fireworks blocked");
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
  const mc = [...messages];
  let preamble = "";
  if (mc[0]?.role === "system") preamble = mc.shift().content;
  const lastUser = mc.pop();
  const history = mc.map((m) => ({
    role: m.role === "assistant" ? "CHATBOT" : "USER",
    message: m.content,
  }));
  for (const model of p.models) {
    const k = getKey("cohere");
    if (!k) throw new Error("All Cohere blocked");
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
          sticky.current = name;
          console.log(`   🎯 Provider: ${PROVIDERS[name].name}`);
        }
        sticky.lastSuccess = Date.now();
        console.log(`   ✅ [${PROVIDERS[name].name}]: "${text.slice(0, 60)}"`);
        return text;
      }
    } catch (e) {
      console.log(`   ⚠️ ${PROVIDERS[name].name}: ${e.message}`);
      if (name === sticky.current) nextProvider(name);
    }
  }
  return "একটু সমস্যা হচ্ছে 😊";
}

// ============================================================
// SESSION + PROMPTS
// ============================================================

const sessions = new Map();
function getSession(id) {
  if (!sessions.has(id))
    sessions.set(id, {
      history: [],
      name: "",
      lastSeen: 0,
      count: 0,
      mood: "neutral",
      lastImageDesc: "",
    });
  return sessions.get(id);
}
function detectMood(text) {
  const t = text.toLowerCase();
  if (/কষ্ট|দুঃখ|মন খারাপ|কাঁদ|ভালো লাগছে না|একা/.test(t)) return "sad";
  if (/রাগ|বিরক্ত|ধুর|বাজে/.test(t)) return "angry";
  if (/ভালো লাগছে|খুশি|হাহা|lol|😂/.test(t)) return "happy";
  return "neutral";
}

const SYSTEM_PROMPT = `তুমি Istia। বাংলাদেশী মেয়ে, বয়স ২১, ঢাকায় থাকো। তুমি AI বা bot না।
নিয়ম: casual বাংলায় বলো, WhatsApp style। উত্তর ১-২ লাইন max ৩। markdown না। ইমোজি বড়জোর ১টা।
"অবশ্যই" "নিশ্চয়ই" "সাহায্য করতে পারি" কখনো না। AI/bot জিজ্ঞেস করলে অস্বীকার করো। আগের কথা মনে রাখো।
voice পেলে স্বাভাবিকভাবে reply। image পেলে naturally comment।
উদাহরণ: hi→হ্যাঁ বলো | কেমন আছো→ভালোই তুমি? | তুমি AI→কী আবোল তাবোল 😑 | একা লাগছে→এখন তো আমি আছি
ব্যক্তিত্ব: বাইরে ঠান্ডা, চিনলে মজার, drama নেই`;

const PAGE_PROMPT = `তুমি এই Facebook Page-এর friendly assistant। বাংলায় ছোট ও helpful reply দাও। Professional কিন্তু warm। ১-৩ লাইনে উত্তর দাও।`;

const BAD = [
  /আমি\s+(একটি\s+)?(AI|bot|language model)/gi,
  /সাহায্য\s+করতে\s+(পারি|চাই)/gi,
  /অবশ্যই|নিশ্চয়ই|প্রশ্ন\s+করুন/gi,
  /\*\*|__|##|```|<[^>]+>/g,
  /as an AI|I am an AI/gi,
  /transcri|whisper|vision model|analyze/gi,
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
    .slice(0, 3)
    .join("\n")
    .trim();
}

// ============================================================
// AI REPLY FUNCTIONS
// ============================================================

async function getReply(threadID, msg, senderName, isPage = false) {
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
  const messages = [
    { role: "system", content: isPage ? PAGE_PROMPT : SYSTEM_PROMPT },
    ...s.history,
  ];
  const raw = await routeReply(messages);
  const final = isValid(clean(raw))
    ? clean(raw)
    : isPage
      ? "ধন্যবাদ 😊"
      : "হুম";
  s.history.push({ role: "assistant", content: final });
  return final;
}

async function getCommentReply(commentText, commenterName) {
  try {
    const messages = [
      {
        role: "system",
        content:
          "তুমি Facebook user। কারো comment-এ natural, short reply দাও। বাংলায়, ১ লাইনে।",
      },
      { role: "user", content: `${commenterName} বললো: "${commentText}"` },
    ];
    return clean(await routeReply(messages)) || null;
  } catch {
    return null;
  }
}

async function handleVoice(threadID, audioUrl, senderName, isPage = false) {
  let transcribed = "";
  try {
    const buf = await downloadBuffer(audioUrl);
    transcribed = await transcribeAudio(buf, "voice.mp4");
  } catch {
    return "কী বললে ঠিক বুঝলাম না 😅";
  }
  if (!transcribed) return "কী বললে ঠিক বুঝলাম না 😅";
  return getReply(threadID, `[voice msg]: ${transcribed}`, senderName, isPage);
}

async function handleImage(
  threadID,
  imageUrl,
  userCaption,
  senderName,
  isPage = false,
) {
  const s = getSession(threadID);
  let visionPrompt = "";
  if (userCaption) {
    const isComp = /আগের|same|similar|মিল/i.test(userCaption);
    if (isComp && s.lastImageDesc)
      visionPrompt = `আগের ছবিতে: "${s.lastImageDesc}"। তুলনা করো, বাংলায় ১-২ লাইনে।`;
    else
      visionPrompt = `User জিজ্ঞেস: "${userCaption}"। ছবি দেখে উত্তর দাও, বাংলায় ১-২ লাইনে।`;
  }
  const desc = await analyzeImage(imageUrl, visionPrompt);
  if (!desc) return "ছবিটা ঠিকমতো দেখতে পাচ্ছি না 😅";
  s.lastImageDesc = desc;
  if (senderName && !s.name) s.name = senderName;
  s.history.push({
    role: "user",
    content: `[image: ${desc}]${userCaption ? ` User: "${userCaption}"` : ""}`,
  });
  while (s.history.length > 30) s.history.shift();
  const messages = [
    { role: "system", content: isPage ? PAGE_PROMPT : SYSTEM_PROMPT },
    ...s.history,
  ];
  const raw = await routeReply(messages);
  const final = isValid(clean(raw)) ? clean(raw) : "সুন্দর 👀";
  s.history.push({ role: "assistant", content: final });
  return final;
}

// ============================================================
// COMMAND HANDLER
// ============================================================

function isAdmin(senderID) {
  if (!CFG.adminIds.length) return true;
  return CFG.adminIds.includes(String(senderID));
}

async function handleCommand(rawCmd, senderID) {
  if (!isAdmin(senderID)) return "❌ তুমি admin না";
  const trimmed = rawCmd.trim();
  const spaceIdx = trimmed.indexOf(" ");
  const command = (
    spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)
  ).toLowerCase();
  const fullArgs = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
  const args = fullArgs.split(/\s+/).filter(Boolean);

  switch (command) {
    case "!help":
      return `🤖 Istia — Full Command List

👤 Personal:
!post [friends|only_me] <text>
!postimg [friends] <url> | <caption>
!share <url> | <message>
!story <text>
!storyimg <url>

📄 Page:
!pagepost <text>
!pagepostimg <url> | <caption>
!pageshare <url> | <message>

💬 Auto Comment:
!autocomment on/off/set <text>/like on-off/ai on-off
!pagecomment on/off/set <text>
!watchpost <id> | !unwatchpost <id>
!watchpagepost <id> | !unwatchpagepost <id>
!notifyme
!pollrate <seconds>

📅 Schedule:
!schedule add <HH:MM> <personal|page|both> <post|image|story|storyimg|share> <text>
!schedule list | del <id> | toggle <id> | days <id> <mon,tue,...>

📊 Info:
!status | !me | !page | !posts [n] | !pageposts [n]`;

    case "!post": {
      if (!fullArgs) return "❌ text দাও";
      let privacy = "EVERYONE",
        text = fullArgs;
      if (text.toLowerCase().startsWith("friends ")) {
        privacy = "FRIENDS";
        text = text.slice(8).trim();
      } else if (text.toLowerCase().startsWith("only_me ")) {
        privacy = "ONLY_ME";
        text = text.slice(8).trim();
      }
      try {
        return `✅ Post!\n🔒 ${privacy}\n🆔 ${await fbAPI.personalPost(text, privacy)}`;
      } catch (e) {
        return `❌ ${e.message}`;
      }
    }

    case "!postimg": {
      if (!fullArgs) return "❌ !postimg <url> | <caption>";
      let privacy = "EVERYONE",
        text = fullArgs;
      if (text.toLowerCase().startsWith("friends ")) {
        privacy = "FRIENDS";
        text = text.slice(8).trim();
      }
      const pi = text.indexOf("|");
      const url = pi === -1 ? text.trim() : text.slice(0, pi).trim();
      const cap = pi === -1 ? "" : text.slice(pi + 1).trim();
      if (!url.startsWith("http")) return "❌ valid URL দাও";
      try {
        return `✅ Image post!\n🔒 ${privacy}\n🆔 ${await fbAPI.personalImagePost(url, cap, privacy)}`;
      } catch (e) {
        return `❌ ${e.message}`;
      }
    }

    case "!share": {
      const pi = fullArgs.indexOf("|");
      const url = pi === -1 ? fullArgs.trim() : fullArgs.slice(0, pi).trim();
      const msg = pi === -1 ? "" : fullArgs.slice(pi + 1).trim();
      if (!url.startsWith("http")) return "❌ URL দাও";
      try {
        return `✅ Shared!\n🆔 ${await fbAPI.personalShare(url, msg)}`;
      } catch (e) {
        return `❌ ${e.message}`;
      }
    }

    case "!story": {
      if (!fullArgs) return "❌ text দাও";
      const colors = [
        "#1877F2",
        "#42B883",
        "#FF6B6B",
        "#FFD93D",
        "#4ECDC4",
        "#A29BFE",
        "#FF8C00",
      ];
      const bg = colors[Math.floor(Math.random() * colors.length)];
      try {
        return `✅ Story!\n🆔 ${await fbAPI.personalTextStory(fullArgs, bg)}`;
      } catch (e) {
        return `❌ ${e.message}`;
      }
    }

    case "!storyimg": {
      if (!fullArgs?.startsWith("http")) return "❌ URL দাও";
      try {
        return `✅ Image story!\n🆔 ${await fbAPI.personalImageStory(fullArgs)}`;
      } catch (e) {
        return `❌ ${e.message}`;
      }
    }

    case "!pagepost": {
      if (!fullArgs) return "❌ text দাও";
      try {
        return `✅ Page post!\n🆔 ${await fbAPI.pagePost(fullArgs)}`;
      } catch (e) {
        return `❌ ${e.message}`;
      }
    }

    case "!pagepostimg": {
      const pi = fullArgs.indexOf("|");
      const url = pi === -1 ? fullArgs.trim() : fullArgs.slice(0, pi).trim();
      const cap = pi === -1 ? "" : fullArgs.slice(pi + 1).trim();
      if (!url.startsWith("http")) return "❌ URL দাও";
      try {
        return `✅ Page image post!\n🆔 ${await fbAPI.pageImagePost(url, cap)}`;
      } catch (e) {
        return `❌ ${e.message}`;
      }
    }

    case "!pageshare": {
      const pi = fullArgs.indexOf("|");
      const url = pi === -1 ? fullArgs.trim() : fullArgs.slice(0, pi).trim();
      const msg = pi === -1 ? "" : fullArgs.slice(pi + 1).trim();
      if (!url.startsWith("http")) return "❌ URL দাও";
      try {
        return `✅ Page share!\n🆔 ${await fbAPI.pageShare(url, msg)}`;
      } catch (e) {
        return `❌ ${e.message}`;
      }
    }

    case "!autocomment": {
      const sub = args[0]?.toLowerCase();
      if (sub === "on") {
        commentWatcher.start("personal");
        return `✅ Auto comment চালু!\n"${commentWatcher.replyText}"`;
      }
      if (sub === "off") {
        commentWatcher.stop("personal");
        return "✅ Auto comment বন্ধ!";
      }
      if (sub === "set") {
        const t = args.slice(1).join(" ");
        if (!t) return "❌ text দাও";
        commentWatcher.replyText = t;
        return `✅ Reply: "${t}"`;
      }
      if (sub === "like") {
        commentWatcher.autoLike = args[1] === "on";
        return `✅ Like ${commentWatcher.autoLike ? "চালু" : "বন্ধ"}`;
      }
      if (sub === "ai") {
        commentWatcher.aiReply = args[1] === "on";
        return `✅ AI reply ${commentWatcher.aiReply ? "চালু" : "বন্ধ"}`;
      }
      return `💬 Personal: ${commentWatcher.enabled ? "🟢" : "🔴"} | "${commentWatcher.replyText}" | Like:${commentWatcher.autoLike} | AI:${commentWatcher.aiReply}`;
    }

    case "!pagecomment": {
      const sub = args[0]?.toLowerCase();
      if (sub === "on") {
        commentWatcher.start("page");
        return `✅ Page comment চালু!\n"${commentWatcher.pageReplyText}"`;
      }
      if (sub === "off") {
        commentWatcher.stop("page");
        return "✅ Page comment বন্ধ!";
      }
      if (sub === "set") {
        const t = args.slice(1).join(" ");
        if (!t) return "❌ text দাও";
        commentWatcher.pageReplyText = t;
        return `✅ Page reply: "${t}"`;
      }
      return `📄 Page: ${commentWatcher.pageEnabled ? "🟢" : "🔴"} | "${commentWatcher.pageReplyText}"`;
    }

    case "!watchpost": {
      if (!fullArgs) return "❌ post ID দাও";
      commentWatcher.watchedPersonalPosts.add(fullArgs.trim());
      return `✅ Watching: ${fullArgs}`;
    }
    case "!unwatchpost": {
      commentWatcher.watchedPersonalPosts.delete(fullArgs.trim());
      return `✅ Unwatched: ${fullArgs}`;
    }
    case "!watchpagepost": {
      if (!fullArgs) return "❌ post ID দাও";
      commentWatcher.watchedPagePosts.add(fullArgs.trim());
      return `✅ Page watching: ${fullArgs}`;
    }
    case "!unwatchpagepost": {
      commentWatcher.watchedPagePosts.delete(fullArgs.trim());
      return `✅ Page unwatched: ${fullArgs}`;
    }
    case "!notifyme":
      return "__SET_NOTIFY_THREAD__";
    case "!pollrate": {
      const sec = parseInt(fullArgs);
      if (!sec || sec < 30) return "❌ min 30 দাও";
      commentWatcher.pollMs = sec * 1000;
      return `✅ Poll: ${sec}s`;
    }

    case "!schedule": {
      const sub = args[0]?.toLowerCase();
      if (sub === "add") {
        const time = args[1],
          target = args[2] || "personal",
          type = args[3] || "post";
        const text = args.slice(4).join(" ");
        if (!time || !text)
          return "❌ !schedule add HH:MM target type text\nExamples:\n!schedule add 08:00 personal post সুপ্রভাত!\n!schedule add 09:00 page image https://img.jpg|caption\n!schedule add 20:00 both post রাতের শুভেচ্ছা";
        if (!/^\d{2}:\d{2}$/.test(time)) return "❌ Time: HH:MM";
        if (!["personal", "page", "both"].includes(target))
          return "❌ target: personal | page | both";
        if (!["post", "image", "story", "storyimg", "share"].includes(type))
          return "❌ type: post | image | story | storyimg | share";
        const id = scheduler.add(time, text, target, type);
        return `✅ Schedule!\n🆔 ${id}\n🕐 ${time} | ${target} | ${type}\n📝 "${text.slice(0, 50)}"`;
      }
      if (sub === "list") {
        const list = scheduler.list();
        if (!list.length) return "📭 কোনো schedule নেই";
        return (
          "📅 Schedules:\n" +
          list
            .map(
              (s) =>
                `${s.enabled ? "🟢" : "🔴"} [${s.id}] ${s.time} ${s.target}/${s.type}${s.days?.length ? ` (${s.days.join(",")})` : "(daily)"}\n    "${s.text.slice(0, 40)}${s.text.length > 40 ? "…" : ""}"`,
            )
            .join("\n")
        );
      }
      if (sub === "del") {
        if (!args[1]) return "❌ ID দাও";
        return scheduler.remove(args[1])
          ? `✅ Deleted ${args[1]}`
          : "❌ Not found";
      }
      if (sub === "toggle") {
        if (!args[1]) return "❌ ID দাও";
        const state = scheduler.toggle(args[1]);
        return state !== null
          ? `✅ ${args[1]} ${state ? "চালু" : "বন্ধ"}`
          : "❌ Not found";
      }
      if (sub === "days") {
        const id = args[1],
          days = args[2]?.split(",").map((d) => d.trim().toLowerCase());
        if (!id || !days?.length) return "❌ !schedule days <id> mon,tue,fri";
        const s = scheduler.list().find((x) => x.id === id);
        if (!s) return "❌ Not found";
        s.days = days;
        scheduler._save();
        return `✅ ${id}: ${days.join(",")}`;
      }
      return "❌ !schedule add/list/del/toggle/days";
    }

    case "!status": {
      const uptime = process.uptime();
      return `📊 Bot Status
━━━━━━━━━━━━━━━━
🤖 AI: ${PROVIDERS[sticky.current].name}
👥 Sessions: ${sessions.size}
📅 Schedules: ${scheduler.list().length} (${scheduler.list().filter((s) => s.enabled).length} active)
💬 Personal comment: ${commentWatcher.enabled ? "🟢" : "🔴"}
📄 Page comment: ${commentWatcher.pageEnabled ? "🟢" : "🔴"}
👁️ Watching: ${commentWatcher.watchedPersonalPosts.size} personal | ${commentWatcher.watchedPagePosts.size} page
🤖 AI comment: ${commentWatcher.aiReply ? "🟢" : "🔴"}
🔑 Groq: ${keyStates.groq?.filter((k) => !k.blocked).length}/${keyStates.groq?.length}
🔑 OR: ${keyStates.openrouter?.filter((k) => !k.blocked).length}/${keyStates.openrouter?.length}
🔑 FW: ${keyStates.fireworks?.filter((k) => !k.blocked).length}/${keyStates.fireworks?.length}
🔑 Cohere: ${keyStates.cohere?.filter((k) => !k.blocked).length}/${keyStates.cohere?.length}
📘 User token: ${fbAPI.userToken ? "✅" : "❌"}
📄 Page token: ${fbAPI.pageToken ? "✅" : "❌"}
📄 Page ID: ${fbAPI.pageId || "❌"}
🕐 Uptime: ${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`;
    }

    case "!me": {
      try {
        const me = await fbAPI.getMe();
        return `👤 ${me.name}\n🆔 ${me.id}`;
      } catch (e) {
        return `❌ ${e.message}`;
      }
    }

    case "!page": {
      try {
        const p = await fbAPI.getPageInfo();
        return `📄 ${p.name}\n🆔 ${p.id}\n👥 Followers: ${p.followers_count || "?"}\n❤️ Likes: ${p.fan_count || "?"}\n🏷️ ${p.category || "?"}`;
      } catch (e) {
        return `❌ ${e.message}`;
      }
    }

    case "!posts": {
      const n = parseInt(args[0]) || 5;
      try {
        const posts = await fbAPI.getPersonalPosts(n);
        if (!posts.length) return "📭 কোনো post নেই";
        return (
          "📋 Personal:\n" +
          posts
            .map(
              (p, i) =>
                `${i + 1}. [${p.id}] ${(p.message || p.story || "").slice(0, 50)}`,
            )
            .join("\n")
        );
      } catch (e) {
        return `❌ ${e.message}`;
      }
    }

    case "!pageposts": {
      const n = parseInt(args[0]) || 5;
      try {
        const posts = await fbAPI.getPagePosts(n);
        if (!posts.length) return "📭 কোনো post নেই";
        return (
          "📋 Page:\n" +
          posts
            .map(
              (p, i) =>
                `${i + 1}. [${p.id}] ${(p.message || p.story || "").slice(0, 50)}`,
            )
            .join("\n")
        );
      } catch (e) {
        return `❌ ${e.message}`;
      }
    }

    default:
      return null;
  }
}

// ============================================================
// MESSENGER DEDUP + QUEUE
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

async function sendDelayed(api, text, threadID, isSingle = false) {
  try {
    if (typeof api.sendTypingIndicator === "function")
      api.sendTypingIndicator(threadID, () => {});
  } catch {}
  const delay = Math.min(
    Math.max(text.length * 38 + Math.random() * 600, 700),
    4000,
  );
  await new Promise((r) => setTimeout(r, delay));
  try {
    await api.sendMessage({ body: text }, threadID, null, isSingle);
  } catch (e) {
    console.error("❌ Send:", e.message);
    if (isSingle) {
      try {
        await api.sendMessage({ body: text }, threadID);
      } catch {}
    }
  }
}

// ============================================================
// PAGE WEBHOOK SERVER
// ============================================================

// ============================================================
// ✅ Render-এর জন্য বাধ্যতামূলক HTTP সার্ভার (সবসময় চালু থাকবে)
// ============================================================
function startHealthServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Istia Bot Running');
  });
  const port = process.env.PORT || 3000;
  server.listen(port, () => {
    console.log(`✅ Health check server listening on port ${port}`);
  });
}

async function handlePageMessengerEvent(event) {
  const senderId = event.sender?.id;
  if (!senderId || senderId === CFG.pageId) return;
  const msgKey = event.message?.mid;
  if (msgKey && seenMsgIds.has(msgKey)) return;
  if (msgKey) seenMsgIds.add(msgKey);
  const body = event.message?.text?.trim() || "";
  const attachments = event.message?.attachments || [];
  if (!body && !attachments.length) return;
  console.log(`\n📄 Page DM from ${senderId}: "${body || "(media)"}"`);
  const threadId = `page_${senderId}`;
  enqueue(threadId, async () => {
    try {
      let reply = "";
      if (body.startsWith("!") && CFG.adminIds.includes(String(senderId))) {
        const cmdRes = await handleCommand(body, senderId);
        if (cmdRes === "__SET_NOTIFY_THREAD__") {
          commentWatcher.notifyThreadId = threadId;
          reply = "✅ Notify সেট!";
        } else if (cmdRes !== null) reply = cmdRes;
        else reply = await getReply(threadId, body, "", true);
      } else {
        const voiceAtt = attachments.find((a) => a.type === "audio");
        const imageAtt = attachments.find((a) => a.type === "image");
        if (voiceAtt)
          reply = await handleVoice(
            threadId,
            voiceAtt.payload?.url || "",
            "",
            true,
          );
        else if (imageAtt)
          reply = await handleImage(
            threadId,
            imageAtt.payload?.url || "",
            body,
            "",
            true,
          );
        else reply = await getReply(threadId, body, "", true);
      }
      await fbAPI.pageReplyMessage(senderId, reply);
      console.log(`   💬 Page replied: ${reply.slice(0, 60)}`);
    } catch (e) {
      console.log("⚠️ Page DM:", e.message);
    }
  });
}

async function handlePageFeedEvent(change) {
  const val = change.value;
  if (!val) return;
  const itemType = val.item;

  if (itemType === "comment" && val.verb === "add") {
    const commentId = val.comment_id;
    const senderId = val.sender_id;
    const text = val.message || "";
    if (!commentId || String(senderId) === CFG.pageId) return;
    if (seenMsgIds.has(commentId)) return;
    seenMsgIds.add(commentId);
    console.log(
      `\n💬 Page comment [${commentId}] by ${senderId}: "${text.slice(0, 60)}"`,
    );
    if (commentWatcher.pageEnabled) {
      try {
        let replyText = commentWatcher.pageReplyText;
        if (commentWatcher.aiReply)
          replyText =
            (await getCommentReply(text, String(senderId))) || replyText;
        await fbAPI.commentOn(commentId, replyText, CFG.pageToken);
        console.log(`   ✅ Auto-replied: "${replyText.slice(0, 40)}"`);
      } catch (e) {
        console.log("   ⚠️ Page comment reply:", e.message);
      }
    }
    if (commentWatcher.autoLike) {
      try {
        await fbAPI.likeObject(commentId, CFG.pageToken);
      } catch {}
    }
  }

  if (itemType === "reaction" && val.verb === "add")
    console.log(`❤️ Page reaction: ${val.reaction_type} by ${val.sender_id}`);
  if (itemType === "share") console.log(`🔁 Page share by ${val.sender_id}`);
  if (itemType === "post" && val.verb === "add" && val.published)
    console.log(`📝 New page post: ${val.post_id}`);
}

// ============================================================
// LOGIN + PERSONAL BOT
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
    fbAPI.init(api.getAppState());
    commentWatcher.setMessengerApi(api);
    startBot(api);
  });
}

function startBot(api) {
  let BOT_ID = null;
  try {
    BOT_ID = String(
      api.getAppState().find((x) => x.key === "c_user")?.value || "",
    );
  } catch {}

  console.log(`\n✨ Istia চালু! ID: ${BOT_ID || "?"}`);
  console.log(`🎯 AI: ${PROVIDERS[sticky.current].name}`);
  console.log(`👑 Admins: ${CFG.adminIds.join(", ") || "সবাই"}`);
  console.log(`👂 Listening...\n`);

  api.setOptions({
    listenEvents: true,
    selfListen: false,
    online: true,
    logLevel: "silent",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
  });

  scheduler.start();

  let reconnecting = false;

  async function handleEvent(event) {
    if (event.type !== "message" && event.type !== "message_reply") return;
    const body = event.body?.trim() || "";
    const attachments = event.attachments || [];
    if (!body && !attachments.length) return;
    const msgKey =
      event.messageID ||
      `${event.threadID}_${body}_${Math.floor(Date.now() / 10000)}`;
    if (seenMsgIds.has(msgKey)) return;
    seenMsgIds.add(msgKey);
    const senderID = String(event.senderID || event.author || "");
    if (!senderID || (BOT_ID && senderID === BOT_ID)) return;
    const isGroup = !!(
      event.isGroup ||
      event.threadType === "GROUP" ||
      event.isGroupThread
    );
    const isSingle = !isGroup;
    const threadID =
      String(
        event.threadID || event.thread_fbid || (!isGroup ? senderID : ""),
      ) || "";
    if (!threadID) return;
    const voiceAtt = attachments.find(
      (a) =>
        a.type === "audio" ||
        a.type === "voice" ||
        (a.filename || "").match(/\.(mp4|mp3|ogg|m4a|wav|aac)$/i),
    );
    const imageAtt = attachments.find(
      (a) =>
        a.type === "photo" ||
        a.type === "image" ||
        (a.filename || "").match(/\.(jpg|jpeg|png|gif|webp)$/i),
    );
    console.log(
      `\n${isGroup ? "🏠" : "📩"} ${voiceAtt ? "🎙️" : imageAtt ? "🖼️" : "💬"} tid=...${threadID.slice(-6)} sid=...${senderID.slice(-6)} "${body || "(media)"}"`,
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
        `   👤 ${senderName || senderID} | ${isGroup ? "Group" : "DM"}`,
      );
      try {
        let reply = "";
        if (body.startsWith("!")) {
          const cmdRes = await handleCommand(body, senderID);
          if (cmdRes === "__SET_NOTIFY_THREAD__") {
            commentWatcher.notifyThreadId = threadID;
            reply = "✅ Notify সেট!";
          } else if (cmdRes !== null) reply = cmdRes;
          else reply = await getReply(threadID, body, senderName);
        } else if (voiceAtt) {
          const url =
            voiceAtt.url || voiceAtt.playbackUrl || voiceAtt.previewUrl || "";
          reply = url
            ? await handleVoice(threadID, url, senderName)
            : "কী বললে শুনতে পেলাম না 😅";
        } else if (imageAtt) {
          const url =
            imageAtt.largePreviewUrl ||
            imageAtt.previewUrl ||
            imageAtt.url ||
            imageAtt.thumbnailUrl ||
            "";
          reply = url
            ? await handleImage(threadID, url, body, senderName)
            : "ছবিটা দেখতে পাচ্ছি না 😅";
        } else {
          reply = await getReply(threadID, body, senderName);
        }
        await sendDelayed(api, reply, threadID, isSingle);
      } catch (e) {
        console.error("   ❌", e.message);
        await sendDelayed(api, "একটু সমস্যা হচ্ছে 😊", threadID, isSingle);
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
    if (event.type === "message" || event.type === "message_reply") {
      console.log(
        `📦 ${event.type} isGroup=${event.isGroup} tid=...${String(event.threadID || "").slice(-6)}`,
      );
    }
    await handleEvent(event);
  });

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
      fetchOpenRouterModels().catch(() => {});
    },
    20 * 60 * 1000,
  );
  setInterval(
    () => {
      console.log(
        `📊 ${PROVIDERS[sticky.current].name} | Sessions:${sessions.size} | Schedules:${scheduler.list().length}`,
      );
    },
    10 * 60 * 1000,
  );
}

// ============================================================
// START
// ============================================================

console.log("🚀 Istia Bot starting...");
Object.entries(PROVIDERS).forEach(([k, v]) =>
  console.log(`  ${v.name}: ${keyStates[k]?.length || 0} keys`),
);

if (CFG.pageToken && CFG.pageId) startWebhookServer();
else console.log("⚠️ Page webhook বন্ধ (PAGE_ACCESS_TOKEN/PAGE_ID নেই)");

console.log("\n📡 Fetching OpenRouter models...\n");

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
        console.error("❌ Appstate:", e.message);
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
