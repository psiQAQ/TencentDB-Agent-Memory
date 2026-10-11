# Model catalog sources

`builtin-catalog.ts` contains a normalized subset of the public Pi catalog, fetched
on 2026-10-11. It includes 85 chat models from DeepSeek, OpenAI, Anthropic and Google
(mapped to the local provider ID `gemini`). It contains metadata, not credentials.

- Endpoint: <https://pi.dev/api/models?types=chat,image,classifier>
- Original response: 902,520 bytes; SHA-256 revision:
  `sha256-3ff185d61544e1bbe1daf233d8af4b9d19a01311153d67acc4a91a1ca6f1c214`
- Protocol reference: [Pi model catalog protocol](https://github.com/earendil-works/pi/blob/ea448f454af474f3e2fe9733b331e17b0662f5d6/scripts/model-catalog-protocol.ts).
  Repository commit: `ea448f454af474f3e2fe9733b331e17b0662f5d6`;
  protocol file blob: `d151d36a5ae4534247eebb40e601b0703ac9264a`.
- Snapshot/cache design reference: [OpenCode models-dev.ts](https://github.com/anomalyco/opencode/blob/e31136bdbdb43e934d8bbd81e75a2065a2625699/packages/core/src/models-dev.ts).
  No OpenCode runtime code is included.

The revision authenticates the fetched content against its response header; it is
not a publisher signature. HTTPS authenticates the source. Remote URLs, headers,
API adapters and compatibility settings are not applied to local calls. Pi's
preferred `api` adapter does not establish a model's exclusive protocol support.
Account discovery retains provider model IDs and explicit capabilities. Local
adapter support and an actual connection test determine whether a model can be
used for a particular task. Missing model capabilities remain unknown.

Account interfaces:
[DeepSeek](https://api-docs.deepseek.com/api/list-models/),
[OpenAI API](https://developers.openai.com/api/reference/resources/models/methods/list),
[Anthropic](https://platform.claude.com/docs/en/api/models/list),
[Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai#list-models).
The OAuth and streaming adapters implement the published OpenAI
[sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in),
[profiles and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions),
[models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
and [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
contracts reviewed on 2026-10-11. No third-party application's client registration
or local login credentials are reused.

## Pi license notice

From the [Pi MIT license](https://github.com/earendil-works/pi/blob/ea448f454af474f3e2fe9733b331e17b0662f5d6/LICENSE):

MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
