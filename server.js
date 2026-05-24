import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

loadEnvFile();

const root = process.cwd();
const port = Number(process.env.PORT || 4173);
const provider = process.env.LLM_PROVIDER || "openai";
const apiType = process.env.LLM_API_TYPE || (provider === "openai" ? "responses" : "chat_completions");
const model = process.env.LLM_MODEL || process.env.OPENAI_MODEL || defaultModelFor(provider);
const baseUrl = trimTrailingSlash(process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || defaultBaseUrlFor(provider));

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg"
};

const systemInstructions = `You generate recursive hypertext knowledge pages for an AI-powered pseudo-web browser.

Return only valid JSON with this shape:
{
  "title": "short page title",
  "summary": "one concise paragraph",
  "html": "HTML body fragment for the page content",
  "links": [
    {
      "label": "clickable concept label",
      "topic": "full topic to expand next",
      "description": "why this concept is worth opening"
    }
  ]
}

Rules:
- Output a knowledge page, not a chat message.
- The page should read like a compact web article with sections, examples, and conceptual structure.
- Output an HTML fragment, not a full document.
- Do not include <script>, <iframe>, <object>, <embed>, <link>, <meta>, or external assets.
- Do not include real <a href> links. Clickable expansion targets must be declared only in the links array.
- Use semantic HTML: section, h2, h3, p, ul, ol, table, code, pre, blockquote.
- Keep the page dense, navigable, and useful for recursive exploration.
- Include 6 to 10 links for broad root pages, and 4 to 8 links for focused child pages.
- Use Chinese UI text by default unless the user asks for another language.
- Do not explain the code outside the JSON.`;

const placementInstructions = `You route a new user question into an existing recursive knowledge tree.

Return only valid JSON with this shape:
{
  "placement": "root" | "child",
  "parentId": "candidate node id or null",
  "topic": "normalized topic to generate",
  "label": "short label for the new node",
  "reason": "brief Chinese reason"
}

Rules:
- Choose "root" when the new question is a separate top-level topic from existing roots.
- Choose "child" when the new question explains, narrows, compares, or depends on an existing node.
- Prefer the most specific matching node, not just the root.
- If the question is ambiguous but clearly related to the active path, choose the best node in that path.
- Do not invent parent IDs. Use only IDs from candidates.
- Keep topic self-contained enough for page generation.
- Do not explain outside the JSON.`;

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host}`);

    if (request.method === "POST" && url.pathname === "/api/page") {
      await handlePage(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/expand") {
      await handleExpand(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/place") {
      await handlePlace(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/generate") {
      await handleLegacyGenerate(request, response);
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }

    await serveStatic(url.pathname, response, request.method === "HEAD");
  } catch (error) {
    sendJson(response, 500, { error: error.message || "Internal server error" });
  }
});

server.listen(port, () => {
  console.log(`HTMLAgent running at http://localhost:${port}`);
});

async function handlePage(request, response) {
  const body = await readJsonBody(request);
  const topic = String(body.topic || body.prompt || "").trim();

  if (!topic) {
    sendJson(response, 400, { error: "Topic is required." });
    return;
  }

  await generateAndSendPage(response, buildRootPageInput(topic));
}

async function handleExpand(request, response) {
  const body = await readJsonBody(request);
  const topic = String(body.topic || "").trim();
  const label = String(body.label || topic).trim();
  const parentTitle = String(body.parentTitle || "").trim();
  const parentSummary = String(body.parentSummary || "").trim();
  const contextPath = Array.isArray(body.contextPath) ? body.contextPath.map(String) : [];

  if (!topic) {
    sendJson(response, 400, { error: "Topic is required." });
    return;
  }

  await generateAndSendPage(response, buildExpandPageInput({
    topic,
    label,
    parentTitle,
    parentSummary,
    contextPath
  }));
}

async function handlePlace(request, response) {
  const apiKey = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    sendJson(response, 500, {
      error: "LLM_API_KEY is not set. Create .env from .env.example or export the variable before starting the server."
    });
    return;
  }

  const body = await readJsonBody(request);
  const question = String(body.question || body.topic || "").trim();
  const activePath = Array.isArray(body.activePath) ? body.activePath.map(String) : [];
  const candidates = Array.isArray(body.candidates) ? body.candidates.slice(0, 80) : [];

  if (!question) {
    sendJson(response, 400, { error: "Question is required." });
    return;
  }

  if (!candidates.length) {
    sendJson(response, 200, {
      placement: "root",
      parentId: null,
      topic: question,
      label: question.slice(0, 48),
      reason: "当前没有可归属的节点，作为新的根主题。"
    });
    return;
  }

  const result = apiType === "responses"
    ? await generateWithResponses(apiKey, buildPlacementInput(question, candidates, activePath), placementInstructions, 900)
    : await generateWithChatCompletions(apiKey, buildPlacementInput(question, candidates, activePath), placementInstructions, 900);

  if (result.error) {
    sendJson(response, result.status, { error: result.error });
    return;
  }

  sendJson(response, 200, normalizePlacement(result.artifact, question, candidates));
}

async function handleLegacyGenerate(request, response) {
  const body = await readJsonBody(request);
  const topic = String(body.prompt || "").trim();

  if (!topic) {
    sendJson(response, 400, { error: "Prompt is required." });
    return;
  }

  await generateAndSendPage(response, buildRootPageInput(topic));
}

async function generateAndSendPage(response, userInput) {
  const apiKey = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    sendJson(response, 500, {
      error: "LLM_API_KEY is not set. Create .env from .env.example or export the variable before starting the server."
    });
    return;
  }

  const pageResult = apiType === "responses"
    ? await generateWithResponses(apiKey, userInput, systemInstructions, 3200)
    : await generateWithChatCompletions(apiKey, userInput, systemInstructions, 3200);

  if (pageResult.error) {
    sendJson(response, pageResult.status, { error: pageResult.error });
    return;
  }

  if (!pageResult.artifact.html) {
    sendJson(response, 502, {
      error: "The model did not return a hypertext page.",
      raw: pageResult.raw
    });
    return;
  }

  sendJson(response, 200, {
    title: String(pageResult.artifact.title || "Untitled").slice(0, 80),
    summary: String(pageResult.artifact.summary || "").slice(0, 600),
    html: sanitizeArtifactHtml(String(pageResult.artifact.html)),
    links: normalizeLinks(pageResult.artifact.links)
  });
}

async function generateWithResponses(apiKey, userInput, instructions = systemInstructions, maxOutputTokens = 3200) {
  const upstream = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      instructions,
      input: userInput,
      max_output_tokens: maxOutputTokens
    })
  });

  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    return {
      error: data.error?.message || `LLM API request failed with status ${upstream.status}`,
      status: upstream.status
    };
  }

  const text = extractResponseText(data);
  return {
    artifact: parseArtifactJson(text),
    raw: text
  };
}

async function generateWithChatCompletions(apiKey, userInput, instructions = systemInstructions, maxOutputTokens = 3200) {
  const upstream = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: instructions },
        { role: "user", content: userInput }
      ],
      max_tokens: maxOutputTokens
    })
  });

  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    return {
      error: data.error?.message || data.base_resp?.status_msg || `LLM API request failed with status ${upstream.status}`,
      status: upstream.status
    };
  }

  const text = data.choices?.[0]?.message?.content || "";
  return {
    artifact: parseArtifactJson(text),
    raw: text
  };
}

function buildRootPageInput(topic) {
  return `Create the root hypertext knowledge page for this topic:
${topic}

The page should introduce the topic broadly, then provide clickable expansion concepts in the links array.
Make it suitable as the first page of a recursive knowledge tree.`;
}

function buildExpandPageInput({ topic, label, parentTitle, parentSummary, contextPath }) {
  return `Create a child hypertext knowledge page for a concept the user clicked.

Clicked label: ${label}
Expansion topic: ${topic}
Parent page title: ${parentTitle}
Parent page summary: ${parentSummary}
Context path: ${contextPath.join(" > ")}

The child page should focus on the clicked concept, explain how it relates to the parent path, and provide deeper clickable concepts in the links array.`;
}

function buildPlacementInput(question, candidates, activePath) {
  return `New user question:
${question}

Active path:
${activePath.join(" > ") || "(none)"}

Existing tree candidates:
${JSON.stringify(candidates, null, 2)}

Decide where this new question belongs in the tree.`;
}

function extractResponseText(data) {
  if (typeof data.output_text === "string") {
    return data.output_text;
  }

  const chunks = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) {
        chunks.push(content.text);
      }
    }
  }
  return chunks.join("\n").trim();
}

function parseArtifactJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      return JSON.parse(fenced[1]);
    }

    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }

    return {};
  }
}

function sanitizeArtifactHtml(html) {
  return html
    .replace(/<\s*script\b[\s\S]*?<\s*\/\s*script\s*>/gi, "")
    .replace(/<\s*(iframe|object|embed|link|meta|base)\b[\s\S]*?>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*[^\s>]+/gi, "");
}

function normalizeLinks(links) {
  if (!Array.isArray(links)) return [];
  return links.slice(0, 12)
    .map((link, index) => ({
      id: `link_${index}_${slugify(link.label || link.topic || "topic")}`,
      label: String(link.label || link.topic || "继续展开").slice(0, 48),
      topic: String(link.topic || link.label || "").slice(0, 160),
      description: String(link.description || "").slice(0, 180)
    }))
    .filter((link) => link.topic);
}

function normalizePlacement(placement, question, candidates) {
  const candidateIds = new Set(candidates.map((candidate) => String(candidate.id)));
  const requestedParentId = placement?.parentId == null ? null : String(placement.parentId);
  const validChild = placement?.placement === "child" && requestedParentId && candidateIds.has(requestedParentId);

  return {
    placement: validChild ? "child" : "root",
    parentId: validChild ? requestedParentId : null,
    topic: String(placement?.topic || question).slice(0, 200),
    label: String(placement?.label || placement?.topic || question).slice(0, 64),
    reason: String(placement?.reason || (validChild ? "归属到最相关节点。" : "作为新的平行主题。")).slice(0, 240)
  };
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "topic";
}

async function serveStatic(pathname, response, headOnly) {
  const safePath = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(root, safePath === "/" ? "index.html" : safePath);

  if (!filePath.startsWith(root)) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }

  const content = await readFile(filePath);
  response.writeHead(200, {
    "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
    "Cache-Control": "no-store"
  });

  if (!headOnly) {
    response.end(content);
  } else {
    response.end();
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function defaultModelFor(currentProvider) {
  if (currentProvider === "deepseek") return "deepseek-chat";
  if (currentProvider === "minimax") return "MiniMax-M2.7";
  return "gpt-5-nano";
}

function defaultBaseUrlFor(currentProvider) {
  if (currentProvider === "deepseek") return "https://api.deepseek.com/v1";
  if (currentProvider === "minimax") return "https://api.minimax.io/v1";
  return "https://api.openai.com/v1";
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, "");
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
    if (Buffer.concat(chunks).length > 128 * 1024) {
      throw new Error("Request body is too large.");
    }
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function loadEnvFile() {
  try {
    const envPath = join(process.cwd(), ".env");
    const text = readFileSync(envPath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const separator = trimmed.indexOf("=");
      if (separator === -1) continue;

      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env is optional; environment variables can be provided by the shell.
  }
}
