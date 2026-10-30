# Daily games Discord bot

A Node.js bot that records daily game results pasted into a Discord text channel. It includes Krillion, Maptap, Codenames Daily, and Music Timeliner, per-game and overall leaderboards, user score lookups, and commands to add games without editing code. Scores live in a local SQLite database.

## Setup

Requires Node.js 24 or newer.

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications). On its Bot page, enable **Message Content Intent** and obtain a bot token. Discord requires this intent to read ordinary shared messages: [official documentation](https://docs.discord.com/developers/events/gateway#message-content-intent).
2. Install the app into your server using the `bot` and `applications.commands` scopes. Give the bot **View Channel**, **Read Message History**, **Send Messages**, and **Embed Links** in the relevant channels.
3. Copy `.env.example` to `.env`. Enter the bot token, application ID, and server ID. Enable Developer Mode in Discord to copy server IDs. Keep `.env` private.
4. From this directory, run:

   ```powershell
   npm install
   npm run register
   npm start
   ```

5. In your server, run `/track channel:#daily-games`. Repeat for every channel you want to track. This requires **Manage Server** permission and automatically adds Krillion, Maptap, Codenames Daily, and Music Timeliner.
6. Paste a result into any tracked channel, then run `/leaderboard` or `/score game:krillion`.

The bot must remain running to collect new posts. Registration installs this project's commands into the server named by `DISCORD_GUILD_ID`; repeat registration for each server where you install the bot. Running registration replaces this application's server command list.

## Commands

| Command | Purpose |
| --- | --- |
| `/explain-dailys` | Read game scoring, leaderboard rules, and all player commands; no admin permission required |
| `/track channel` | Add a tracked channel without replacing others; requires Manage Server |
| `/untrack channel` | Stop tracking a channel and retain recorded scores; requires Manage Server |
| `/channels [page]` | List tracked channels, 20 per page; requires Manage Server |
| `/leaderboard [game] [period]` | Monthly totals by default; choose All Time; interactive menus and 5 players per page |
| `/score [game] [user] [period]` | User total, games, and average; defaults to your monthly overall score |
| `/game list` | List games, templates, and score direction |
| `/game add key name template direction` | Add a game; requires Manage Server |
| `/game disable game` | Pause collection and hide that game's scores; requires Manage Server |
| `/game enable game` | Resume collection and restore stored scores; requires Manage Server |
| `/backfill [limit] [channel]` | Import 1–10,000 messages per tracked channel, default 100; optionally select one channel; requires Manage Server |

Replies are private to the person who runs the command. Tracking is configured separately for each server; scores never cross server boundaries.

`/explain-dailys` opens a paginated guide with Previous/Next buttons. It explains each configured game (including custom games and their active conversion ranges), monthly/all-time totals, duplicate results, points/game counts/averages, and usage examples for every non-admin command. Servers without configured games see the built-in game guide. Run `npm run register` for each server and restart after updating to make the command available.

A server can track any number of text channels with no bot-imposed channel limit. Use `/track` to add each one, `/channels` to list them, and `/untrack` to stop collecting new posts from one. All channels contribute to the same server leaderboards. Existing single-channel settings migrate automatically on restart.

Use `/backfill limit:10000` to scan up to 10,000 messages **per tracked channel**. To import only one, use `/backfill channel:#daily-games limit:10000`. Channels are scanned sequentially in batches of at most 100 messages, with progress updates every 1,000 messages and between channels. Each channel stops at the requested limit or the beginning of its history. Unavailable channels are reported while other channels continue. Reimporting existing messages updates scores without duplicating them. A player's result for the same game and puzzle counts once across all channels; the newest source post wins. One backfill can run per server at a time; keep the bot running until it finishes. Re-register commands after updating to add `/untrack`, `/channels`, and the backfill channel option.

The leaderboard defaults to **Monthly**, ranking by total points earned during the current calendar month. Choose **All Time** from the period dropdown to rank by average points per game across all recorded results. All-time cards still show total points, games, and average points. Both views work for Overall and individual games. You can also run `/leaderboard period:alltime` or `/leaderboard game:maptapp period:monthly`.

The card shows each player as a separate block: their medal/rank and name, then indented lines for pts, the number of results (such as `97 games`), and average pts. The average is the displayed total divided by that player's game count in the selected period. Overall cards add scores converted to 0–100 per result; per-game cards add native scores. `/score` shows the same totals for one player. The game dropdown, period dropdown, Previous/Next, and Refresh update the same private reply. Changing a game or period resets to page 1. The footer shows the month or All Time, page, player count, and update time. Only the person who opened the leaderboard can use its controls. If a game is disabled while the card is open, the next interaction returns to Overall; if a page disappears, it moves to the last available page. Discord may expire old private replies; run `/leaderboard` again when needed.

`/score` defaults to your own current-month overall total. Use `/score period:alltime` for your all-time overall score, `/score user:@Alice period:monthly` for another user's monthly total, or `/score game:maptapp user:@Alice period:alltime` to total one game. Replies include points, game count, and average points using the leaderboard's period, normalization, and deduplication rules. A user without results gets 0 points and 0 games. The former puzzle-specific score lookup has been replaced by these summaries; re-register commands and restart after updating. Existing saved results require no backfill for this command change.

Monthly boundaries use the original Discord message posting timestamp in `America/Denver`, configured in `src/daily-game-tracker/leaderboard-period.js`. This also applies to games that include a puzzle date: the posting date decides leaderboard membership. Backfill uses the original timestamp, and edits do not move a message to the current month. The view switches automatically when a new calendar month begins; Refresh loads the current month's standings. Changing the time-zone setting requires a restart. Re-register commands once to add the `period` option, then restart the bot. Existing stored scores can be totaled immediately, without a new backfill for this leaderboard change.

## Monthly winners announcements

While the bot is running, it checks every 30 seconds for **6:00 pm on the last calendar day of the month**, using the same `America/Denver` time zone as monthly standings. Each configured server gets one public winners announcement in its text channel named **general**. The bot needs **View Channel**, **Send Messages**, **Embed Links**, and **Read Message History** there. For a differently named channel or multiple channels named general, set a server-to-channel ID entry in `src/daily-game-tracker/announcements-config.js`.

The announcement lists the first three players on the **monthly overall leaderboard by total converted points**, showing total pts, games, and average pts. It uses results posted through the 6:00 pm cutoff, including earlier versions of cross-posted results when a later repost is after the cutoff. The winner snapshot is saved before sending, so retrying does not change the winners. Exactly three players are selected when available; ties use the leaderboard's stable user-ID ordering. If fewer than three players have results, the available players are announced; months without results are skipped.

If the Discord username **inklingbot_** is absent from the three winners, the message includes **Nice try, Gabe 😈**. Current winner usernames are checked when available, falling back to the latest recorded username. Winner mentions are displayed without notification pings.

Receipts in SQLite prevent repeated announcements after normal restarts. Pending sends retry automatically, including after month rollover. If sending succeeded but saving its receipt failed, the bot checks channel history before retrying; a deterministic Discord nonce also guards against duplicate requests. Keep the bot online at the deadline. Restarting later on the same evening also creates the announcement; months with no scheduled attempt before the date rolls over are not retrospectively created. Monthly leaderboards continue accumulating later posts after 6:00 pm, while announced winners remain frozen at the cutoff.

Restart after updating to activate this scheduler. No new commands or command registration are needed. Tests simulate Discord sends; they do not publish announcements to a live server.

## Adding games

Templates contain exactly one `{puzzle}` and one `{score}` token. Replace the changing puzzle number or date with `{puzzle}` and the changing score with `{score}`. Scores may be signed or decimal numbers. Puzzles may be nonnegative integers, ISO dates such as `2026-10-20`, day-month-year dates such as `22.10.2026`, or English month dates such as `October 20` or `October 20, 2026`.

All other characters are literal, matching ignores letter case, and trailing text on each line (such as emojis) is allowed. Use the literal characters `\n` for a line break in a Discord command. An optional `{skip}` token on its own line between other template lines skips zero or more lines of results.

Krillion is preconfigured as:

```text
Krillion #{puzzle}\n{score}
```

It matches:

```text
Krillion #100 🦐
340

🫧🐟🫧🦑🏮🏮🦑
```

To add numeric Wordle results:

```text
/game add key:wordle name:Wordle template:Wordle {puzzle} {score}/6 direction:lower
```

Maptap is included automatically with the key `maptapp` and higher scores ranked first. Restart to add it to an existing tracked server, then run `/backfill` to import earlier posts. Existing games with that key and their enabled/disabled settings are preserved. Its built-in template reads the date and final score, skipping the individual results:

```text
www.maptap.gg {puzzle}\n{skip}\nFinal score: {score}
```

This template records `434` from the example below and skips the individual scores:

```text
www.maptap.gg October 26

94 97 60 32 9

Final score: 434
```

Date puzzles are stored as `YYYY-MM-DD`. When the share omits the year, the bot uses the date closest to the original message's UTC timestamp, considering the preceding, current, and following year. This keeps historical imports stable across restarts and avoids merging different years. A share posted many months after its puzzle can have an ambiguous year; use a template matching an explicit year when available. View your Maptap monthly total with `/score game:maptapp`.

Then run `/backfill` if you want to import existing posts. This version supports 25 games per server. Each message can contribute one result per matching game. Failure symbols such as Wordle `X/6`, times such as `1:23`, other nonnumeric puzzle IDs, and scores requiring calculations need future parser extensions. Failed results are currently ignored. Templates can be checked locally with the parser tests; editing an existing game's template is not yet exposed as a command.

## Codenames Daily

Codenames has a built-in parser because its score must be calculated from three main rounds and an optional fourth bonus round. It uses the game key `codenames` and is added automatically to existing tracked servers when the bot restarts, as well as new servers when `/track` runs. No `/game add` command is needed. Existing custom games with the same key are preserved.

The bot reads the `CODENAMES DAILY` heading, the `day.month.year` date, and three or four clue/result lines. A fourth line is accepted only if the first three rounds are all correct. Blank lines, the optional "Can you beat this?" footer, and the game's share link are supported. The publisher's [share example](https://www.czechgames.com/news/popular-daily-challenges-from-the-codenames-app-come-to-your-browser) uses `✅` for correct guesses and `❌` for an incorrect guess.

```text
CODENAMES DAILY

22.10.2026

ROMEO 2 ✅✅
POWERFUL 3 ✅✅✅
MEDIEVAL 4 ✅✅✅✅
SOUND 3 ✅✅✅
```

The configured scoring rule is:

```text
floor(
  30 × (correct guesses in round 1 / target words in round 1)
  + 30 × (correct guesses in round 2 / target words in round 2)
  + 30 × (correct guesses in round 3 / target words in round 3)
  + 10 × (correct guesses in round 4 / target words in round 4)
)
```

The example earns `floor(30 + 30 + 30 + 10) = 100`. Each of the first three rounds independently earns up to 30 points, regardless of its target count. Three-round results have a maximum of 90. If the first three are perfect, the optional fourth round adds up to 10 bonus points, for a maximum of 100. Only the final total is rounded down. Two perfect main rounds with zero in the third earn 60. Correct guesses before a `❌` earn partial credit, and remaining unguessed words earn none. For example, `FERRARI 3 ✅✅❌`, `PAINFUL 5 ✅✅✅✅✅`, and `SOVIET 3 ✅✅✅` earn 80 points. Fewer than three rounds, more than four rounds, malformed rounds, and bonus rounds following any main-round mistake are rejected.

Run `/backfill` to import older Codenames shares, or recalculate previously imported shares after a scoring change. Use `/score game:codenames` for your monthly total or `/leaderboard game:codenames` for standings. Individual Codenames results score up to 100; the period total can exceed 100. `/game disable game:codenames` pauses it without deleting saved scores. Old stored results retain their previous scoring until their source messages are reimported; backfill the relevant messages after updating.

## Music Timeliner

Music Timeliner is included automatically with the game key `musictimeliner`. Restart the bot to add it to existing tracked servers; `/game add` is not needed. Existing custom games with that key are preserved.

The parser reads the puzzle number and green/red result squares, with 12.5 points per green square and zero per red square. Only the final total is rounded down to an integer: three green squares earn `floor(37.5) = 37`, and eight earn the maximum score of 100. Results with more than eight squares are rejected. It supports actual Unicode emojis (`🟩` and `🟥`) and literal Discord aliases (`:green_square:` and `:red_square:`), including results spread across multiple lines. The website link is optional.

```text
Music Timeliner #29

🟩🟩🟥🟩🟥🟩🟩🟩

https://musictimeliner.com/
```

This example records a score of `75` for puzzle `29` (six green squares × 12.5). A result containing only red squares records `0`; a title and link without any squares records nothing. Results must include the square characters in the Discord message text.

After restarting, run `/backfill` to import existing shares or recalculate scores saved under the previous scoring rule, `/leaderboard game:musictimeliner` for standings, or `/score game:musictimeliner` for your monthly total. Music Timeliner contributes up to 100 points per result to the overall leaderboard.

## Ranking rules

Per-game Monthly leaderboards rank players by their total recorded score in the current month. All Time leaderboards rank by average score per game, calculated as total points divided by games played. Higher or lower values win according to the game's configured direction; equal ranking values share ranks. These boards and `/score` keep Krillion and Maptap's native scoring units. Each Codenames and Music Timeliner result scores out of 100. Totals can exceed a single game's maximum. Overall uses the same monthly-total/all-time-average rule after converting results to 0–100.

The overall leaderboard converts each result to a score between 0 and 100 using a fixed game range:

```text
Higher is better: 100 × (score − minimum) / (maximum − minimum)
Lower is better:  100 × (maximum − score) / (maximum − minimum)
```

Each converted result is clamped to 0–100, then all converted results in the selected period are added together. For example, Krillion 350/700 contributes 50, Maptap 434/1000 contributes 43.4, Music Timeliner 75 contributes 75, and Codenames 100 contributes 100: the overall total is 268.4. Another perfect Krillion result adds 100 to reach 368.4; the Krillion-only total would be 350 + 700 = 1050. Each game result can contribute up to 100 overall points, so playing more daily puzzles adds more points. The accumulated total is not capped at 100. Other players' submissions do not change a player's points.

Score ranges are configured only in `src/daily-game-tracker/scoring-config.js`. Built-in ranges are Krillion 0–700, Maptap 0–1000, and Codenames/Music Timeliner 0–100. Wordle is configured as 1–6. Maptap's [official scoring FAQ](https://maptap.gg/faq) explains its 1,000-point total. The Krillion daily scale is configured for seven 100-point rounds. Games without an entry in the code default to 0–100. For a game where lower scores win, the minimum maps to 100 and the maximum maps to 0. Use `/game list` to inspect ranges, or edit the code, for example:

```javascript
export const GAME_SCORE_RANGES = {
  krillion: [0, 700],
  maptapp: [0, 1000],
  maptap: [0, 1000],
  codenames: [0, 100],
  musictimeliner: [0, 100],
  wordle: [1, 6],
};
```

Restart the bot after editing score ranges; existing raw scores are converted using the new ranges without backfill. Previously saved database ranges are ignored in favor of the code settings. Run `npm run register` once to remove the old scale subcommand and range options from Discord, then restart. The Codenames round-scoring change requires `/backfill` to recalculate stored results using the original round data; the latest 10,000 messages can be scanned with `/backfill limit:10000`.

Unplayed games add no points. Participation counts the daily results included in the selected period, across all enabled games for Overall or within the selected game. Repeated posts still count only once per player, game, and puzzle. Tied totals share ranks. Both Krillion and any added games use their configured higher/lower direction; confirm the correct rule when adding a game.

## Optional AI daily player: lnklingbot

The AI player starts at **11:00 am America/Denver** and competes using the existing Discord bot account. Its leaderboard and score name is **lnklingbot**; use `/score user:@YourBot` to query it. Codenames posts to `#codenames-daily`; the other games post to `#daily-games`. Destination channel IDs are configured per server. The existing `/track` command must already track both destinations.

The implementation is **disabled by default and has not yet passed live game validation**. Each game uses a bounded screenshot-driven Playwright agent rather than relying on an undocumented game API. Headless/headed compatibility, Krillion timing, Maptap globe interaction, native share capture, and Music Timeliner audio capture must be verified on the hosting machine. The code never substitutes a model-written result for a missing native share result.

Install the optional browser runtime separately, leaving the score tracker's dependency installation unchanged:

```powershell
npm run daily:setup
npm run daily:browser
```

Add `OPENAI_API_KEY` to `.env`. Sol uses `gpt-6.1-sol` with medium reasoning through the Responses API. Music defaults to the free local Qwen2-Audio listener described below. If your project has OpenAI audio access, set `DAILY_AUDIO_BACKEND=openai` to use `gpt-audio-1.5` through Chat Completions with the same key. There is no daily dollar cap for OpenAI calls. Each game is limited to 60 total model requests (including local audio) and 15 minutes, with the game's shorter timers still applying. Model access and listener readiness are checked before starting an attempt, and usage records are stored in SQLite.

The music listener captures the audio from the game's Play control and sends neutral PCM WAV bytes, with no source URL, track identifier, hidden title, or release metadata. If browser media capture is blocked by cross-origin restrictions, it can decode the observed audio response for that exact played element and extract only the portion already played, up to 12 seconds. It does not use fingerprinting, catalogs, or external searches. The audio model reports possible identity/era and uncertainty; Sol uses that assessment and previously revealed timeline cards to place the next song. Wrong guesses count normally; missing/silent audio or API failures stop that attempt as a technical error. Recognition accuracy remains unverified.

Run these checks before enabling automation:

```powershell
npm run daily -- --preflight
npm run daily -- --list-models
npm run daily -- --preflight --game krillion
npm run daily -- --inspect --game krillion
npm run daily -- --dry-run --game krillion
npm run daily -- --dry-run --game codenames
npm run daily -- --dry-run --game maptapp
npm run daily -- --dry-run --game musictimeliner
```

`--inspect` opens a game and saves its initial screenshot and visible text without an API key. `--dry-run` plays a complete attempt using temporary browser state and saves the captured result and API usage under `data/daily-player/dry-runs`. Neither command logs into Discord or writes competitive scores. Dry runs do make game requests and, except inspection, paid OpenAI requests. Add `--headed` to observe or debug a game in a visible browser. A dry run does not automatically mark a game verified.

Each CLI run prints its `run.log` and `review.jsonl` locations before preflight and saves progress continuously, including failures. `run.log` identifies browser launch, page loading, model decisions, UI actions, audio capture, and local/OpenAI requests, with a waiting message every 10 seconds. It also includes each model-provided decision summary, self-reported confidence and audio assessment. These are explicit output explanations; private internal reasoning is not requested or recorded.

`review.jsonl` contains timestamped events linking each numbered step to its visible game text, `step-001.png` style screenshot, decision summary, exact action, audio assessment, request token usage/timing, and subsequent visible game feedback. `latest-screen.png` also remains available. An `action_result` with `status: executed` means the UI action ran, not that the answer was correct; use the next observation and final native share result to judge success. The final summary records score and per-model call counts. Confidence is the model's own estimate, not a measured probability. Logs and step screenshots survive failed runs and may contain game clues, typed answers and revealed song details; they stay local and are not posted to Discord. API credentials, raw API responses, audio bytes and hidden track metadata are excluded. The local listener's terminal also reports inference progress. If a run appears stuck, share the final lines of `run.log` and the listener output.

If audio preflight returns HTTP 404, the configured audio model cannot be resolved for your key/project. Run `npm run daily -- --list-models` to list available audio-named models. To choose a different model, set `OPENAI_AUDIO_MODEL` in `.env` to a model documented to accept audio through Chat Completions; listing alone does not guarantee endpoint compatibility. No automatic model substitution occurs. A game-specific preflight or dry run for Krillion, Codenames or Maptap checks only Sol, so unavailable music audio access does not block those games or consume a music attempt.

### Free local music listener

The local backend uses the trained [Qwen2-Audio-7B-Instruct](https://huggingface.co/Qwen/Qwen2-Audio-7B-Instruct) model with 4-bit NF4 quantization and FP16 computation, without fingerprinting or a song catalog. It accepts only captured WAV audio; no hidden game metadata is provided. Its observations are passed to Sol for placement. Inference has no API fee, although Sol's gameplay calls remain paid. Initial setup downloads several gigabytes of Python dependencies and approximately 17 GB of model files; subsequent inference uses cached weights.

Use a working Python 3.12 installation with the Windows Python launcher. If your current `python` reports a missing executable from another virtual environment, install or repair Python before creating this project's environment. Do not reuse another project's environment.

```powershell
py -3.12 -m venv local-audio/.venv
local-audio/.venv/Scripts/python.exe -m pip install --upgrade pip
local-audio/.venv/Scripts/python.exe -m pip install torch==2.6.0 --index-url https://download.pytorch.org/whl/cu126
local-audio/.venv/Scripts/python.exe -m pip install -r local-audio/requirements.txt
npm run daily:audio
```

The server binds only to `127.0.0.1:8765`. Wait until it prints `Local listener ready`, then leave that terminal running. The bot checks the loaded model identity before starting Music Timeliner. Set `DAILY_AUDIO_BACKEND=local` in `.env` (also the code default), then in another terminal run:

```powershell
npm run daily -- --preflight --game musictimeliner
npm run daily -- --dry-run --game musictimeliner
```

If the listener exits during loading, rerun `npm run daily:audio` and inspect `data/local-audio/startup.log`. The launcher saves stdout/stderr, enables Python fault tracebacks, and prints the process exit code in decimal and hexadecimal. Startup output includes installed library versions, the current load stage, and available GPU memory. An exit before `Local listener ready` is treated as a failure even if Python returns code zero. The last warning printed is not necessarily the cause of a native crash.

The 4-bit runner requires CUDA-enabled PyTorch and an NVIDIA GPU. This machine reports an RTX 2060 SUPER with 8 GB VRAM and 32 GB system RAM; compatibility, available VRAM during browser use, inference speed, and music accuracy still need a live test. If loading runs out of GPU memory, close other GPU-heavy programs and retry the listener before starting gameplay. Listener setup or inference errors do not fall back to a catalog or silently place songs without audio. `npm run daily:audio -- --download-only` downloads and checks model loading without starting the server. Model cache files live under `data/local-audio-models`; the Python environment and model cache are ignored by Git.

After a game's complete dry run succeeds, edit `src/daily-player/daily-player-config.js`: set its `enabled` and `verified` to `true`, and set `headless: false` only if headed mode was required. Configure `servers` using Discord IDs, for example:

```js
servers: {
  'YOUR_SERVER_ID': {
    dailyChannelId: 'DAILY_GAMES_CHANNEL_ID',
    codenamesChannelId: 'CODENAMES_DAILY_CHANNEL_ID',
  },
},
```

Set the top-level `enabled: true` and restart the bot. No command registration is required. The bot needs View Channel, Send Messages, Embed Links, and Read Message History in both score channels and `#general`.

The scheduler catches up after 11 am on the current Denver date, without replaying missed dates. Each game has independent persistent browser state. One completed result is reused across servers configured and eligible when the attempt began; enabling a new server does not import the AI's past games. Results are saved before delivery, and persistent receipts plus a history check prevent retries from duplicating scores or replaying games. Keep `data/scores.sqlite` and `data/daily-player/profiles` across restarts. Run only one bot process against a given database/browser profile directory.

Failed attempts are not automatically replayed. After a crash, stale running attempts become failed after the runtime limit plus one minute; they are not restarted because a native game might already have consumed the attempt. Later days use the retained browser profile. Delivery failures retry independently, including after a date change. Delayed scores count in the month of the actual Discord post, matching human submissions. Disable the top-level player switch to stop automation, or disable an individual game to pause that game's attempts and pending deliveries.

AI scores use the same normalization and leaderboard rules as human scores and are eligible for monthly winners. At the existing 6 pm Denver month-end cutoff, a **separate message in #general** celebrates every human with strictly more overall monthly points than lnklingbot. Ties do not qualify, and no celebration is sent if the AI has no monthly results. Celebrations have independent persistent receipts and retries. The existing Gabe easter egg is unchanged.

## Storage and corrections

- Discord user IDs identify players even after a username change. The submitting username is also stored, and commands display Discord user mentions, with the AI competitor displayed as lnklingbot. Unrelated bots are ignored; only AI posts backed by this bot's saved delivery receipts can be recovered during backfill.
- Only one result per player, game, and puzzle counts. If multiple messages exist, the newest posted message wins; editing an older post does not move it ahead of a newer post.
- Reimporting a message is safe. Message edits replace its parsed results; removing the recognizable result removes its score. Deleting the winning message restores an earlier matching post if one is stored.
- Message edits and deletions are processed while connected. `/backfill` refreshes existing posts but cannot discover posts deleted while the bot was offline; those require a future reconciliation feature.
- Disabled games retain their saved scores. Re-enable and backfill to import posts shared while disabled.
- Adding a tracked channel keeps all existing channels. Untracking retains scores already recorded; subsequent posts and edits from that channel are ignored. Backfill scans all currently tracked channels unless one is selected explicitly.
- Data defaults to `data/scores.sqlite`; set `DATABASE_PATH` to change it. Stop the bot before copying the database for a simple consistent backup. Retain the database across redeployments.

## Development

Source and tests are grouped by responsibility:

```text
src/daily-player/           Browser automation, model clients, scheduling, and player identity
src/daily-game-tracker/     Discord entrypoint, commands, parsing, storage, and leaderboards
test/daily-player/          Player automation and model integration tests
test/daily-game-tracker/    Tracking, scoring, command, and leaderboard tests
```

The optional `browser-runtime/` and Python `local-audio/` environments remain at the project root. Existing npm commands run from the project root.

```powershell
npm test
```

The tests exercise parsing, real SQLite persistence and correction behavior, server isolation, and equal game weighting without connecting to Discord. Live Discord behavior requires a configured token and server.

Source modules: `src/daily-game-tracker/parser.js` reads share templates; `src/daily-game-tracker/codenames.js` parses and scores Codenames results; `src/daily-game-tracker/musictimeliner.js` counts Music Timeliner result squares; `src/daily-game-tracker/store.js` persists submissions; `src/daily-game-tracker/rankings.js` calculates standings; `src/daily-game-tracker/commands.js` defines slash commands; `src/daily-game-tracker/handlers.js` handles requests; `src/daily-game-tracker/index.js` handles Discord events. SQLite uses [Node's built-in SQLite API](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html).
