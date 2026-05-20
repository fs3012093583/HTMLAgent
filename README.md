# HTMLAgent

HTMLAgent is a local prototype for using sandboxed HTML artifacts as the interaction layer between an AI agent and a user.

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

The browser calls the local `/api/generate` endpoint. The OpenAI API key stays on the server and is never exposed to the page.

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
