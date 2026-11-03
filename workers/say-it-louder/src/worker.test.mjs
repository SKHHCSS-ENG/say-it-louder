import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildAzureSsml, handleRequest, LIVE_ORIGINS } from "./index.js";

const PAGES = "https://skhhcss-eng.github.io";
const WORKER = "https://say-it-louder.skhhcss-eng.workers.dev/";

function post(body, { origin = PAGES, ip = "203.0.113.10", headers = {}, env = {} } = {}) {
  return handleRequest(new Request(WORKER, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "CF-Connecting-IP": ip,
      ...headers,
    },
    body: JSON.stringify(body),
  }), env);
}

const speakNode = {
  speaker: "Mei",
  defaultLine: "What can I get you?",
  goalHint: "Order a drink",
  targetGrammar: { pattern: "Can I have…?" },
  branches: [{ id: "ok", targetNode: "node_next" }],
};

test("live origins include the SIL Pages host", () => {
  assert.ok(LIVE_ORIGINS.includes("https://skhhcss-eng.github.io"));
});

test("worker source has no Ask, Dict, or Explain paths", () => {
  const source = readFileSync(new URL("./index.js", import.meta.url), "utf8");
  assert.equal(source.includes("askPrompt"), false);
  assert.equal(source.includes("ALLOWED_PAGES"), false);
  assert.equal(/\bAsk\b/.test(source), false);
  assert.equal(/\bExplain\b/.test(source), false);
  assert.equal(/\bDict\b/.test(source), false);
  assert.equal(source.includes('mode === "ask"'), false);
  assert.equal(source.includes("sk-"), false);
  assert.equal(source.includes("DEEPSEEK_API_KEY"), true);
  assert.equal(source.includes("AZURE_SPEECH_KEY"), true);
});

test("OPTIONS from the Pages origin allows POST", async () => {
  const res = await handleRequest(new Request(WORKER, {
    method: "OPTIONS",
    headers: { Origin: PAGES },
  }), {});
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), PAGES);
  assert.match(res.headers.get("Access-Control-Allow-Methods"), /POST/);
});

test("rejects a foreign origin", async () => {
  const res = await post({ mode: "tts", text: "Hello" }, { origin: "https://evil.example" });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
});

test("localhost is allowed for local preview", async () => {
  const res = await handleRequest(new Request(WORKER, {
    method: "OPTIONS",
    headers: { Origin: "http://127.0.0.1:8787" },
  }), {});
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "http://127.0.0.1:8787");
});

test("rejects removed Eng modes", async () => {
  for (const [ip, body] of [
    ["203.0.113.21", { mode: "ask", message: "What is a linker?", turn: 1 }],
    ["203.0.113.22", { page: "Cohesion", label: "and", sample: "fish and chips" }],
    ["203.0.113.23", { mode: "dict", text: "hello" }],
  ]) {
    const res = await post(body, { ip });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "Unsupported mode.");
  }
});

test("tts requires text and caps length", async () => {
  const missing = await post({ mode: "tts", text: "  " }, { ip: "203.0.113.30" });
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error, "Text is required for TTS.");

  const long = await post({ mode: "tts", text: "a".repeat(501) }, { ip: "203.0.113.31" });
  assert.equal(long.status, 400);
  assert.equal((await long.json()).error, "TTS text is too long.");
});

test("tts uses Azure when a key is set, then en-GB MP3 fallback", async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("tts.speech.microsoft.com")) {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "Content-Type": "audio/mpeg" },
      });
    }
    return new Response("nope", { status: 500 });
  };
  try {
    const res = await post({
      mode: "tts",
      text: "Can I have a tea?",
      voice: "en-GB-SoniaNeural",
      style: "cheerful",
      rate: "+5%",
      pitch: "-2%",
    }, {
      ip: "203.0.113.40",
      env: { AZURE_SPEECH_KEY: "azure-secret", AZURE_SPEECH_REGION: "eastasia" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("X-TTS-Engine"), "azure-neural");
    assert.equal(res.headers.get("Content-Type"), "audio/mpeg");
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), PAGES);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.headers["Ocp-Apim-Subscription-Key"], "azure-secret");
    assert.match(calls[0].init.body, /en-GB-SoniaNeural/);
    assert.match(calls[0].init.body, /cheerful/);
    assert.equal(calls[0].init.body.includes("azure-secret"), false);
  } finally {
    globalThis.fetch = original;
  }
});

test("tts falls back to an en-GB MP3 when Azure is unset", async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(new Uint8Array([9]), {
      status: 200,
      headers: { "Content-Type": "audio/mpeg" },
    });
  };
  try {
    const res = await post({
      mode: "tts",
      text: "Hello there",
      voice: "en-HK-SamNeural",
    }, { ip: "203.0.113.41", env: {} });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("X-TTS-Engine"), "cloud-en-gb-free");
    assert.equal(calls.length, 1);
    assert.match(calls[0], /translate\.googleapis\.com/);
    assert.match(calls[0], /tl=en-GB/);
  } finally {
    globalThis.fetch = original;
  }
});

test("speaknovel calls DeepSeek and returns the router JSON", async () => {
  const secret = "deepseek-test-secret";
  let seenAuth = "";
  let seenBody = null;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seenAuth = init.headers.Authorization;
    seenBody = JSON.parse(init.body);
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            chosen_target_node: "node_next",
            used_target_grammar: true,
            grammar_score: 5,
            character_reaction: "Lovely, one tea coming up.",
            teacher_tip: "Can I have a tea? works well here.",
          }),
        },
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const res = await post({
      mode: "speaknovel",
      episode: "ep1_boba",
      nodeKey: "node_start",
      transcript: "Can I have a milk tea?",
      node: speakNode,
    }, { ip: "203.0.113.50", env: { DEEPSEEK_API_KEY: secret } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.chosen_target_node, "node_next");
    assert.equal(body.grammar_score, 5);
    assert.equal(seenAuth, "Bearer " + secret);
    assert.equal(seenBody.model, "deepseek-chat");
    assert.equal(seenBody.response_format.type, "json_object");
    assert.equal(seenBody.temperature, 0.35);
    assert.match(seenBody.messages[0].content, /Say It Louder!/);
    assert.match(seenBody.messages[1].content, /Can I have a milk tea\?/);
    assert.equal(JSON.stringify(body).includes(secret), false);
  } finally {
    globalThis.fetch = original;
  }
});

test("speaknovel without a key does not call upstream", async () => {
  let called = false;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    called = true;
    return new Response("no", { status: 500 });
  };
  try {
    const res = await post({
      mode: "speaknovel",
      transcript: "Hello",
      node: speakNode,
    }, { ip: "203.0.113.51", env: {} });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, "SpeakNovel AI router is not configured yet.");
    assert.equal(called, false);
  } finally {
    globalThis.fetch = original;
  }
});

test("speaknovel rejects a payload without branches", async () => {
  const res = await post({
    mode: "speaknovel",
    transcript: "Hello",
    node: { speaker: "Mei" },
  }, { ip: "203.0.113.52" });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "Invalid SpeakNovel payload.");
});

test("non-JSON and oversized bodies are rejected", async () => {
  const bad = await handleRequest(new Request(WORKER, {
    method: "POST",
    headers: {
      Origin: PAGES,
      "Content-Type": "application/json",
      "CF-Connecting-IP": "203.0.113.60",
    },
    body: "not-json",
  }), {});
  assert.equal(bad.status, 400);

  const huge = await handleRequest(new Request(WORKER, {
    method: "POST",
    headers: {
      Origin: PAGES,
      "Content-Type": "application/json",
      "Content-Length": "999999",
      "CF-Connecting-IP": "203.0.113.61",
    },
    body: "{}",
  }), {});
  assert.equal(huge.status, 413);
});

test("ssml escapes text and keeps the en-GB voice", () => {
  const ssml = buildAzureSsml({
    text: `Tom & "Jerry" <b>`,
    voice: "en-GB-RyanNeural",
    style: "general",
    rate: "0%",
    pitch: "0%",
  });
  assert.match(ssml, /xml:lang="en-GB"/);
  assert.match(ssml, /en-GB-RyanNeural/);
  assert.match(ssml, /Tom &amp; &quot;Jerry&quot; &lt;b&gt;/);
  assert.equal(ssml.includes("<b>"), false);
});
