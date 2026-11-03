# Say It Louder

ESL speaking visual novel (Drive School → Site → Say It Louder). This is its own project — not part of the Eng subject site (`skhhcss-eng.github.io`). The Eng hub will link out. There is no Ask/Explain floater from the Eng core site.

Play: https://skhhcss-eng.github.io/say-it-louder/

Cloud voice (`mode: "tts"`) and speech judging (`mode: "speaknovel"`) use the Say It Louder Worker by default (`https://say-it-louder.skhhcss-eng.workers.dev`). Students do not need a DeepSeek API key. Teacher Controls can override that Worker URL or add a key.

Worker source is `workers/say-it-louder/`. From that folder, set `DEEPSEEK_API_KEY` (and optional `AZURE_SPEECH_KEY` / `AZURE_SPEECH_REGION`) with `npx wrangler secret put`, then `npx wrangler deploy`. Do not commit key values.

Online 2D Anime Art stays on by default (embedded stills in the page) until Muse packs `./assets/` and `plates/`. Missing plate files may 404; that is expected until those folders are filled.
