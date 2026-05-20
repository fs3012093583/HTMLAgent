# HTMLAgent

HTMLAgent is a local prototype for using sandboxed HTML artifacts as the interaction layer between an AI agent and a user.

## Run

Create a local environment file:

```bash
cp .env.example .env
```

Set `OPENAI_API_KEY` in `.env`, then start the local server:

```bash
npm start
```

Then visit:

```text
http://localhost:4173/index.html
```

The browser calls the local `/api/generate` endpoint. The OpenAI API key stays on the server and is never exposed to the page.
