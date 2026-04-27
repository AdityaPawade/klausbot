# klausbot deployment guide (local-llm-migration branch)

Optimal Pi 5 16GB setup using llama.cpp + qwen3:1.7b + prefix caching.

## Stack

```
Telegram <-> klausbot daemon <-> llama-server (HTTP) <-> qwen3:1.7b GGUF
                                       ^
                                       `-- prefix caching enabled
                                           OpenAI /v1/chat/completions API
```

Two systemd user services:
- `llama-server.service` - llama.cpp serving qwen3:1.7b at :8080
- `klausbot.service` - depends on llama-server, talks to it via OpenAI API

## Prerequisites

```bash
# Build llama.cpp (one-time, ~10 min on Pi 5)
cd /tmp && git clone --depth 1 https://github.com/ggml-org/llama.cpp.git
cd llama.cpp && cmake -B build -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=ON -DLLAMA_CURL=OFF
cmake --build build -j 4 --target llama-server llama-cli

# Install to user-local
mkdir -p ~/.local/bin ~/.local/lib
cp build/bin/llama-server build/bin/llama-cli ~/.local/bin/
cp build/bin/lib*.so ~/.local/lib/

# Download GGUF model (~1.3 GB)
mkdir -p ~/models
curl -L -o ~/models/qwen3-1.7b-q4km.gguf   https://huggingface.co/bartowski/Qwen_Qwen3-1.7B-GGUF/resolve/main/Qwen_Qwen3-1.7B-Q4_K_M.gguf
```

## Install services

```bash
# Copy unit file
cp deployment/llama-server.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now llama-server.service

# Copy config
cp deployment/klausbot.example.json ~/.klausbot/config/klausbot.json

# Restart klausbot to pick up the new backend
systemctl --user restart klausbot.service
```

## Performance (Pi 5 16GB)

- Cold first message: ~44 s (model loaded + uncached prefix)
- Warm follow-up: ~8 s (96% prefix cache hit)
- Tool routing reliability: 5/6 on standard benchmark

## Switching models

To upgrade to qwen3:4b for better quality (slower):
1. Download Qwen3-4B-Q4_K_M.gguf
2. Edit `~/.config/systemd/user/llama-server.service` --model path
3. `systemctl --user restart llama-server klausbot`

## Switching backends

To revert to Claude Code (or switch to Ollama-native):
```json
{ "backend": "claude-code" }
```
or
```json
{
  "backend": "ollama",
  "backendConfig": { "ollama": { "baseUrl": "http://localhost:11434", "engineApi": "ollama", "model": "qwen3:4b" } }
}
```

Then `systemctl --user restart klausbot`.
