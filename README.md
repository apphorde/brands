# Brand Oracle

Run the app with `npm start` after installing dependencies. Configure these
environment variables in the runtime:

- `OPENAI_API_KEY` — API key used for the brand summary.
- `OPENAI_MODEL` — optional summary model; defaults to `gpt-6-luna`.
- `OLLAMA_URL` — required base URL for the local Ollama-compatible service,
  including protocol and port, for example `http://ollama.example:11434`.

The app appends `/v1/systemone` to `OLLAMA_URL` for page verdicts and follow-up
decisions. It does not contain a baked-in Ollama host.
