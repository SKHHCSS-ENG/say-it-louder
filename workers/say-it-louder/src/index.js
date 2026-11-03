/**
 * Say It Louder Worker.
 * mode "tts": Azure Speech neural voices, then a zero-key en-GB MP3 fallback.
 * mode "speaknovel": DeepSeek live ESL role-play evaluation and reaction.
 * Secrets: DEEPSEEK_API_KEY (SpeakNovel), optional AZURE_SPEECH_KEY and AZURE_SPEECH_REGION.
 * Do not hardcode keys, and do not log them.
 */

/** Browser origins that may call this Worker. Paths are not part of Origin. */
export const LIVE_ORIGINS = [
  "https://skhhcss-eng.github.io",
  "https://learning.hcs.edu.hk",
];

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const MODEL = "deepseek-chat";
const MAX_BODY_BYTES = 4096;
const MAX_SPEAKNOVEL_BYTES = 12288;
const MAX_MODEL_CHARS = 800;
const RATE_LIMIT = 10;
const TTS_RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 20000;

const ALLOWED_TTS_VOICES = [
  "en-GB-RyanNeural",
  "en-GB-SoniaNeural",
  "en-GB-LibbyNeural",
  "en-GB-ThomasNeural",
  "en-HK-YanNeural",
  "en-HK-SamNeural",
];

const ALLOWED_TTS_STYLES = [
  "general",
  "cheerful",
  "sad",
  "angry",
  "friendly",
  "excited",
  "customerservice",
];

const LIMITS = {
  ttsText: 500,
  transcript: 500,
};

// Isolate-local counters for the rate limit. Not request-scoped user data.
const buckets = new Map();
const ttsBuckets = new Map();

function originAllowed(origin) {
  if (!origin || typeof origin !== "string") return false;
  if (LIVE_ORIGINS.indexOf(origin) !== -1) return true;
  let url;
  try {
    url = new URL(origin);
  } catch (e) {
    return false;
  }
  if (url.origin !== origin) return false;
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

function clientIp(request) {
  const cf = request.headers.get("CF-Connecting-IP");
  if (cf && cf.trim()) return cf.trim().slice(0, 80);
  return "unknown";
}

function allowRateInMap(map, limit, ip, now) {
  const t = now || Date.now();
  let bucket = map.get(ip);
  if (!bucket || t - bucket.start >= RATE_WINDOW_MS) {
    bucket = { start: t, count: 0 };
    map.set(ip, bucket);
  }
  bucket.count += 1;
  if (map.size > 4000) {
    for (const [key, value] of map) {
      if (t - value.start >= RATE_WINDOW_MS) map.delete(key);
    }
  }
  return bucket.count <= limit;
}

function allowRate(ip, now) {
  return allowRateInMap(buckets, RATE_LIMIT, ip, now);
}

function corsHeaders(origin, extraHeaders) {
  const headers = new Headers(extraHeaders || {});
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type");
    headers.set("Access-Control-Allow-Private-Network", "true");
  }
  return headers;
}

function jsonResponse(status, body, origin, extraHeaders) {
  const headers = corsHeaders(origin, extraHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { status: status, headers });
}

function asLimitedString(value, max) {
  if (typeof value !== "string") return { ok: false, empty: true };
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return { ok: true, value: "" };
  if (trimmed.length > max) return { ok: false, empty: false };
  return { ok: true, value: trimmed };
}

function escapeXml(unsafe) {
  return String(unsafe || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildAzureSsml(fields) {
  const voice = ALLOWED_TTS_VOICES.indexOf(fields.voice) !== -1 ? fields.voice : "en-GB-RyanNeural";
  const style = ALLOWED_TTS_STYLES.indexOf(fields.style) !== -1 ? fields.style : "general";
  const rate = fields.rate || "0%";
  const pitch = fields.pitch || "0%";
  const lang = voice.startsWith("en-HK") ? "en-HK" : "en-GB";
  const escaped = escapeXml(fields.text);

  const inner = `<prosody rate="${escapeXml(rate)}" pitch="${escapeXml(pitch)}">${escaped}</prosody>`;
  const body = style !== "general"
    ? `<mstts:express-as style="${escapeXml(style)}">${inner}</mstts:express-as>`
    : inner;

  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${lang}"><voice name="${voice}">${body}</voice></speak>`;
}

function readTtsFields(data) {
  const text = asLimitedString(data.text, LIMITS.ttsText);
  if (!text.ok) return { mode: "tts", error: "field" };
  if (!text.value) return { mode: "tts", error: "required" };
  const voice = typeof data.voice === "string" && ALLOWED_TTS_VOICES.indexOf(data.voice) !== -1
    ? data.voice
    : "en-GB-RyanNeural";
  const style = typeof data.style === "string" && ALLOWED_TTS_STYLES.indexOf(data.style) !== -1
    ? data.style
    : "general";
  const rate = typeof data.rate === "string" && /^[-+]?\d{1,2}%$/.test(data.rate.trim())
    ? data.rate.trim()
    : "0%";
  const pitch = typeof data.pitch === "string" && /^[-+]?\d{1,2}%$/.test(data.pitch.trim())
    ? data.pitch.trim()
    : "0%";
  return {
    mode: "tts",
    fields: {
      text: text.value,
      voice: voice,
      style: style,
      rate: rate,
      pitch: pitch,
    },
  };
}

function readSpeakNovelFields(data) {
  const transcript = asLimitedString(data.transcript, LIMITS.transcript);
  if (!transcript.ok || !transcript.value) return { mode: "speaknovel", error: "required" };
  const node = data.node && typeof data.node === "object" ? data.node : null;
  if (!node || !Array.isArray(node.branches)) return { mode: "speaknovel", error: "field" };
  return {
    mode: "speaknovel",
    fields: {
      episode: typeof data.episode === "string" ? data.episode.slice(0, 60) : "ep1_boba",
      nodeKey: typeof data.nodeKey === "string" ? data.nodeKey.slice(0, 60) : "node_start",
      transcript: transcript.value,
      node: node,
    },
  };
}

function readFields(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  if (data.mode === "tts") return readTtsFields(data);
  if (data.mode === "speaknovel") return readSpeakNovelFields(data);
  return { error: "mode" };
}

function messageText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  let out = "";
  for (let i = 0; i < content.length; i++) {
    const part = content[i];
    if (typeof part === "string") out += part;
    else if (part && typeof part.text === "string") out += part.text;
  }
  return out.trim();
}

function capModelText(text, max) {
  const limit = max || MAX_MODEL_CHARS;
  if (text.length <= limit) return text;
  return text.slice(0, limit).trim();
}

export function buildSpeakNovelPrompt(fields) {
  const node = fields.node || {};
  const nodeKey = fields.nodeKey || "node_start";
  const speaker = node.speaker || "Character";
  return `You are the AI Game Master and ESL Speaking Coach for a Hong Kong secondary school interactive visual novel ("Say It Louder!"). Always use British English.
Current Node ID: "${nodeKey}"
Current Speaker: "${speaker}"
Character's Current Line: "${node.defaultLine || ""}"
Student's Mission Goal: "${node.goalHint || ""}"
Target Grammar: ${JSON.stringify(node.targetGrammar || {})}
Available Branches: ${JSON.stringify(node.branches || [])}
Student said: "${fields.transcript}"

ROUTING & SPONTANEOUS IMPROVISATION RULES (OPTION A):
1. POSITIVE BRANCH (TARGET GRAMMAR USED): Short, natural spoken English (5-12 words) that communicates the mission goal using a target grammar pattern/keyword must be rewarded with "used_target_grammar": true, "grammar_score": 4 or 5, and routed to the positive/success branch targetNode.
2. SPONTANEOUS IN-CHARACTER IMPROVISATION (UNPLANNED / OFF-SCRIPT / CREATIVE ANSWERS):
   - NEVER output a canned "Excuse me, I don't understand what you mean" message for unplanned, funny, creative, or tangential English!
   - If the student asks an unexpected question, makes a joke, offers something off-script, or chats with the character without completing the target grammar yet:
     * If it clearly matches a silly/meme branch in Available Branches, route to that meme targetNode.
     * Otherwise, set "chosen_target_node": "${nodeKey}" (keeping the student on the current scene!) and write a lively, witty, 100% spontaneous 1-2 sentence "character_reaction" in character as ${speaker} reacting directly to the student's exact words, then naturally steering them back toward "${node.goalHint || ""}".
3. UNDERSTANDABLE ATTEMPT WITHOUT TARGET GRAMMAR: If the student tries to answer the prompt directly (or is rude) without using the target grammar, set "used_target_grammar": false and either keep them on "${nodeKey}" with a spontaneous in-character nudge OR route to the retry/clarification/fail branch (never Golden).
4. TRUE GIBBERISH ONLY: Only if the input is completely unintelligible keyboard mashing with zero recognisable English meaning, set "chosen_target_node": "${nodeKey}", "used_target_grammar": false, "grammar_score": 1, and write a fresh, in-character puzzled reaction as ${speaker}.
5. Write a short, encouraging 1-sentence "teacher_tip" in British English acknowledging what the student said and showing how to use the target grammar pattern.

Return valid JSON only:
{
  "chosen_target_node": "branch_targetNode_or_${nodeKey}",
  "used_target_grammar": true,
  "grammar_score": 5,
  "character_reaction": "Spontaneous, natural in-character reply in British English reacting directly to what the student said",
  "teacher_tip": "Short encouraging tip in British English"
}`;
}

function concatBytes(chunks) {
  let total = 0;
  for (let i = 0; i < chunks.length; i++) total += chunks[i].byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (let i = 0; i < chunks.length; i++) {
    out.set(chunks[i], offset);
    offset += chunks[i].byteLength;
  }
  return out;
}

async function readLimitedText(request, maxBytes) {
  if (!request.body) return { raw: "", byteLen: 0 };
  const reader = request.body.getReader();
  const chunks = [];
  let byteLen = 0;
  try {
    while (true) {
      const step = await reader.read();
      if (step.done) break;
      const value = step.value;
      byteLen += value.byteLength;
      if (byteLen > maxBytes) {
        try { await reader.cancel(); } catch (e) { /* already failed */ }
        return { tooLarge: true, byteLen: byteLen };
      }
      chunks.push(value);
    }
  } catch (e) {
    return { error: true };
  }
  const raw = new TextDecoder("utf-8").decode(concatBytes(chunks));
  return { raw: raw, byteLen: byteLen };
}

async function handleTtsSynthesis(env, fields, origin) {
  const azureKey = env && typeof env.AZURE_SPEECH_KEY === "string" ? env.AZURE_SPEECH_KEY.trim() : "";
  const azureRegion = env && typeof env.AZURE_SPEECH_REGION === "string" && env.AZURE_SPEECH_REGION.trim()
    ? env.AZURE_SPEECH_REGION.trim()
    : "eastasia";

  // Tier 1: Official Microsoft Azure Speech Neural TTS (Free F0 tier: 500,000 neural chars/month)
  if (azureKey) {
    try {
      const ssml = buildAzureSsml(fields);
      const res = await fetch(`https://${azureRegion}.tts.speech.microsoft.com/cognitiveservices/v1`, {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": azureKey,
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": "audio-24khz-96kbitrate-mono-mp3",
          "User-Agent": "SKHHCSS-SayItLouder-Worker",
        },
        body: ssml,
      });
      if (res.ok && res.body) {
        const headers = corsHeaders(origin, {
          "Content-Type": "audio/mpeg",
          "Cache-Control": "public, max-age=86400",
          "X-TTS-Engine": "azure-neural",
        });
        return new Response(res.body, { status: 200, headers });
      }
      console.error(JSON.stringify({ message: "azure_tts_failed", status: res.status }));
    } catch (e) {
      console.error(JSON.stringify({ message: "azure_tts_failed" }));
    }
  }

  // Tier 2: Zero-Key Free Cloud British English (en-GB) MP3 Fallback
  try {
    const cleanQ = fields.text.slice(0, 200);
    const tl = fields.voice && fields.voice.startsWith("en-HK") ? "en-GB" : "en-GB";
    const fallbackUrl = `https://translate.googleapis.com/translate_tts?ie=UTF-8&tl=${tl}&client=tw-ob&q=${encodeURIComponent(cleanQ)}`;
    const res = await fetch(fallbackUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
      },
    });
    if (res.ok && res.body) {
      const headers = corsHeaders(origin, {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "public, max-age=86400",
        "X-TTS-Engine": "cloud-en-gb-free",
      });
      return new Response(res.body, { status: 200, headers });
    }
    console.error(JSON.stringify({ message: "fallback_tts_failed", status: res.status }));
  } catch (e) {
    console.error(JSON.stringify({ message: "fallback_tts_failed" }));
  }

  return jsonResponse(502, { error: "Voice synthesis is unavailable just now." }, origin);
}

async function callDeepSeek(env, userMessage, options) {
  const opts = options || {};
  const system = opts.system;
  const maxTokens = opts.maxTokens || 220;
  const unavailable = opts.unavailable || "SpeakNovel is unavailable just now.";
  const unconfigured = opts.unconfigured || "SpeakNovel is not configured yet.";
  const maxChars = opts.maxChars || MAX_MODEL_CHARS;
  if (!system) {
    console.error(JSON.stringify({ message: "missing_system_prompt" }));
    return { ok: false, status: 500, error: unavailable };
  }
  const key = env && env.DEEPSEEK_API_KEY;
  if (!key || typeof key !== "string" || !key.trim()) {
    return { ok: false, status: 503, error: unconfigured };
  }
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, UPSTREAM_TIMEOUT_MS);
  let res;
  try {
    const payload = {
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userMessage },
      ],
      temperature: opts.temperature != null ? opts.temperature : 0.3,
      max_tokens: maxTokens,
      stream: false,
    };
    if (opts.jsonMode) {
      payload.response_format = { type: "json_object" };
    }
    res = await fetch(DEEPSEEK_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + key.trim(),
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error(JSON.stringify({ message: "deepseek_fetch_failed" }));
    return { ok: false, status: 502, error: unavailable };
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    console.error(JSON.stringify({ message: "deepseek_upstream", status: res.status }));
    return { ok: false, status: 502, error: unavailable };
  }
  let data;
  try {
    data = await res.json();
  } catch (e) {
    console.error(JSON.stringify({ message: "deepseek_bad_json" }));
    return { ok: false, status: 502, error: unavailable };
  }
  const choice = data && data.choices && data.choices[0] && data.choices[0].message;
  const text = capModelText(messageText(choice && choice.content), maxChars);
  if (!text) {
    console.error(JSON.stringify({ message: "deepseek_empty" }));
    return { ok: false, status: 502, error: unavailable };
  }
  return { ok: true, text: text };
}

export async function handleRequest(request, env) {
  const originHeader = request.headers.get("Origin");
  const allowed = originAllowed(originHeader);
  const origin = allowed ? originHeader : "";

  if (!allowed) {
    return jsonResponse(403, { error: "Origin not allowed." }, "");
  }

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": origin,
        "Vary": "Origin",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Private-Network": "true",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  if (request.method !== "POST") {
    return jsonResponse(405, { error: "Use POST." }, origin);
  }

  const contentType = request.headers.get("Content-Type") || "";
  if (contentType.toLowerCase().indexOf("application/json") === -1) {
    return jsonResponse(415, { error: "Send JSON." }, origin);
  }

  const declaredHeader = request.headers.get("Content-Length");
  const declaredLen = declaredHeader ? Number(declaredHeader) : NaN;
  if (Number.isFinite(declaredLen) && declaredLen > MAX_SPEAKNOVEL_BYTES) {
    return jsonResponse(413, { error: "Request is too large." }, origin);
  }

  const read = await readLimitedText(request, MAX_SPEAKNOVEL_BYTES);
  if (read.error) {
    return jsonResponse(400, { error: "Request body must be JSON." }, origin);
  }
  if (read.tooLarge) {
    return jsonResponse(413, { error: "Request is too large." }, origin);
  }
  const raw = read.raw;
  const byteLen = read.byteLen;

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    if (byteLen > MAX_BODY_BYTES) {
      return jsonResponse(413, { error: "Request is too large." }, origin);
    }
    return jsonResponse(400, { error: "Request body must be JSON." }, origin);
  }

  const isSpeakNovel = data && typeof data === "object" && data.mode === "speaknovel";
  const isTts = data && typeof data === "object" && data.mode === "tts";
  const maxAllowedBytes = isSpeakNovel ? MAX_SPEAKNOVEL_BYTES : MAX_BODY_BYTES;

  console.log(JSON.stringify({
    message: "sil_request",
    method: request.method,
    mode: isTts ? "tts" : isSpeakNovel ? "speaknovel" : "rejected",
  }));

  if ((Number.isFinite(declaredLen) && declaredLen > maxAllowedBytes) || byteLen > maxAllowedBytes) {
    return jsonResponse(413, { error: "Request is too large." }, origin);
  }

  const ip = clientIp(request);
  if (isTts) {
    if (!allowRateInMap(ttsBuckets, TTS_RATE_LIMIT, ip)) {
      return jsonResponse(429, { error: "Too many voice requests. Wait a moment." }, origin, {
        "Retry-After": "60",
      });
    }
  } else if (!allowRate(ip)) {
    return jsonResponse(429, { error: "Too many requests. Wait a minute and try again." }, origin, {
      "Retry-After": "60",
    });
  }

  const parsed = readFields(data);
  if (!parsed) {
    return jsonResponse(400, { error: "Request body must be JSON." }, origin);
  }
  if (parsed.error === "mode") {
    return jsonResponse(400, { error: "Unsupported mode." }, origin);
  }
  if (parsed.mode === "tts") {
    if (parsed.error === "required") {
      return jsonResponse(400, { error: "Text is required for TTS." }, origin);
    }
    if (parsed.error === "field") {
      return jsonResponse(400, { error: "TTS text is too long." }, origin);
    }
    return handleTtsSynthesis(env, parsed.fields, origin);
  }
  if (parsed.mode === "speaknovel") {
    if (parsed.error) {
      return jsonResponse(400, { error: "Invalid SpeakNovel payload." }, origin);
    }
    const snResult = await callDeepSeek(env, parsed.fields.transcript, {
      system: buildSpeakNovelPrompt(parsed.fields),
      maxTokens: 320,
      maxChars: 1200,
      temperature: 0.35,
      jsonMode: true,
      unavailable: "SpeakNovel AI router is unavailable just now.",
      unconfigured: "SpeakNovel AI router is not configured yet.",
    });
    if (!snResult.ok) {
      return jsonResponse(snResult.status, { error: snResult.error }, origin);
    }
    try {
      const parsedJson = JSON.parse(snResult.text);
      return jsonResponse(200, parsedJson, origin);
    } catch (e) {
      return jsonResponse(502, { error: "Invalid JSON from AI router." }, origin);
    }
  }

  return jsonResponse(400, { error: "Unsupported mode." }, origin);
}

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
};
