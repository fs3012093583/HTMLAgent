import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

loadEnvFile();

const root = process.cwd();
const port = Number(process.env.PORT || 4173);
const model = process.env.OPENAI_MODEL || "gpt-5-mini";
const openaiBaseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

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

const systemInstructions = `You generate safe, useful HTML artifacts for a sandboxed iframe.

Return only valid JSON with this shape:
{
  "description": "short Chinese label",
  "html": "HTML body fragment only"
}

Rules:
- Output an HTML body fragment, not a full document.
- Do not include <script>, <iframe>, <object>, <embed>, <link>, <meta>, or external assets.
- Use semantic HTML and inline CSS only when needed.
- Keep the UI dense, practical, and directly usable.
- Add buttons or controls with data-agent-action and optional data-value when user actions should return to the agent.
- The iframe already provides base CSS classes: page, hero, grid, card, metric, muted, row, pill, btn, secondary, warning, stack, control, actions.
- Use Chinese UI text by default unless the user asks for another language.
- Do not explain the code outside the JSON.`;

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host}`);

    if (request.method === "POST" && url.pathname === "/api/generate") {
      await handleGenerate(request, response);
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

async function handleGenerate(request, response) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    sendJson(response, 500, {
      error: "OPENAI_API_KEY is not set. Create .env from .env.example or export the variable before starting the server."
    });
    return;
  }

  const body = await readJsonBody(request);
  const prompt = String(body.prompt || "").trim();
  const event = body.event || null;
  const currentHtml = String(body.currentHtml || "").slice(0, 12000);

  if (!prompt && !event) {
    sendJson(response, 400, { error: "Prompt or event is required." });
    return;
  }

  const userInput = buildUserInput(prompt, event, currentHtml);

  const upstream = await fetch(`${openaiBaseUrl}/responses`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      instructions: systemInstructions,
      input: userInput,
      max_output_tokens: 3200
    })
  });

  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    sendJson(response, upstream.status, {
      error: data.error?.message || `OpenAI API request failed with status ${upstream.status}`
    });
    return;
  }

  const text = extractResponseText(data);
  const artifact = parseArtifactJson(text);

  if (!artifact.html) {
    sendJson(response, 502, { error: "The model did not return an HTML artifact.", raw: text });
    return;
  }

  sendJson(response, 200, {
    description: String(artifact.description || "LLM HTML artifact").slice(0, 80),
    html: sanitizeArtifactHtml(String(artifact.html))
  });
}

function buildUserInput(prompt, event, currentHtml) {
  const parts = [];
  if (prompt) {
    parts.push(`User request:\n${prompt}`);
  }
  if (event) {
    parts.push(`The user interacted with the current artifact:\n${JSON.stringify(event, null, 2)}`);
  }
  if (currentHtml) {
    parts.push(`Current artifact HTML fragment for context:\n${currentHtml}`);
  }
  parts.push("Create the next best HTML artifact for the user.");
  return parts.join("\n\n");
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
