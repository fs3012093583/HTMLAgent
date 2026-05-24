# HTMLAgent

HTMLAgent is a local prototype for turning linear AI chat into a recursive hypertext knowledge browser.

Instead of appending markdown messages, the model generates pseudo-web pages. Each page exposes clickable concepts, and clicking a concept asks the model to generate a child page under the current node. The result is a browsable knowledge tree.

New user questions are also routed into the tree. For example, after "What is Transformer?", a new question like "What is CNN?" becomes a parallel root topic, while "What is self-attention?" is inserted under the Transformer node.

## Run

Create a local environment file:

```bash
cp .env.example .env
```

Set `LLM_API_KEY` in `.env`, then start the local server:

```bash
npm start
```

Then visit:

```text
http://localhost:4173/index.html
```

The browser calls local API endpoints. The provider API key stays on the server and is never exposed to the page.

## Hyperpage API

Create a root page:

```text
POST /api/page
```

Route a new user question into the current tree:

```text
POST /api/place
```

Expand a clicked concept into a child page:

```text
POST /api/expand
```

The model returns structured JSON:

```json
{
  "title": "Transformer",
  "summary": "A compact page summary.",
  "html": "<section>...</section>",
  "links": [
    {
      "label": "RoPE",
      "topic": "Rotary Position Embedding",
      "description": "A deeper concept to open next"
    }
  ]
}
```

## Providers

DeepSeek:

```env
LLM_PROVIDER=deepseek
LLM_API_TYPE=chat_completions
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_MODEL=deepseek-chat
LLM_API_KEY=your-deepseek-key
```

MiniMax:

```env
LLM_PROVIDER=minimax
LLM_API_TYPE=chat_completions
LLM_BASE_URL=https://api.minimax.io/v1
LLM_MODEL=MiniMax-M2.7
LLM_API_KEY=your-minimax-key
```

OpenAI:

```env
LLM_PROVIDER=openai
LLM_API_TYPE=responses
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-5-nano
LLM_API_KEY=your-openai-key
```
