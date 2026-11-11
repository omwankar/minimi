# Minimi

A chat agent with web search and a memory of what you asked. It resolves "Monday" and "3 November" in code, recalls that day's notes, and searches only to check whether the old answer is still true.

## Run

```bash
npm install
npm run dev
```

Open http://localhost:8787

```bash
cp .env.example .env
```

Set `DEEPSEEK_API_KEY`. One key is enough. Search uses DuckDuckGo when no search key is set, so that part costs nothing.

`npm test` checks date resolution, recall, and the memory file. It does not call the network.

Notes live in `.data/` and survive restarts. New chat starts a thread. It does not wipe memory.

## Keys

| Variable | Required | Purpose |
|---|---|---|
| `DEEPSEEK_API_KEY` | yes | Chat model. https://platform.deepseek.com/api_keys |
| `LLM_MODEL` | no | Default `deepseek-flash`. Thinking is forced off. |
| `DEEPSEEK_BASE_URL` | no | Default `https://api.deepseek.com` |
| `BRAVE_SEARCH_API_KEY` | no | Sharper search. https://api.search.brave.com |
| `TAVILY_API_KEY` | no | Alternative search. Basic depth only. |
| `SEARCH_PROVIDER` | no | `auto` (default), `duckduckgo`, `brave`, or `tavily` |
| `USER_TIMEZONE` | no | IANA zone for "Monday". Defaults to the machine zone. |
| `PORT` | no | Default `8787` |
| `MAX_SEARCHES` | no | Default `5`, hard cap 5 |

If you use Brave's monthly credit, attribute Brave Search in your about page. That is their term for the credit.

How the turn is put together, and what was rejected, is in [DESIGN.md](DESIGN.md).
