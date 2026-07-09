# Riot Games API README (LoL + TFT)

A practical reference for building with Riot's official League of Legends and Teamfight Tactics APIs. This document collects the main documentation entry points, core endpoint groups, routing rules, and a basic request flow so the API surface is easier to navigate.[cite:7][cite:15]

## Official docs

The main Riot API index is the central starting point for browsing all available API products, including shared services like `account-v1` and game-specific surfaces for League of Legends and Teamfight Tactics.[cite:7] TFT also has a dedicated documentation page that explains routing, policy limits, match history notes, and static data access through Data Dragon.[cite:15]

- Riot API index: [https://developer.riotgames.com/apis](https://developer.riotgames.com/apis) [cite:7]
- TFT docs: [https://developer.riotgames.com/docs/tft](https://developer.riotgames.com/docs/tft) [cite:15]

## Authentication

Requests require a Riot API key obtained through the Riot Developer Portal, and the Riot documentation distinguishes between development access and production-ready access patterns.[cite:15] Some integrations also involve Riot Sign On or game-policy review depending on the application type and whether users are authorizing account access.[cite:5][cite:15]

In practice, send the API key in the `X-Riot-Token` request header for normal server-side calls.[cite:9]

## Routing model

Riot uses two routing layers: **platform routing** for many live game and summoner endpoints, and **regional routing** for cross-platform services such as account lookups and match history in supported APIs.[cite:7][cite:15]

### Platform routes

These are commonly used for summoner, league, status, mastery, and spectator-style requests.[cite:7]

- `br1.api.riotgames.com`
- `eun1.api.riotgames.com`
- `euw1.api.riotgames.com`
- `jp1.api.riotgames.com`
- `kr.api.riotgames.com`
- `la1.api.riotgames.com`
- `la2.api.riotgames.com`
- `na1.api.riotgames.com`
- `oc1.api.riotgames.com`
- `tr1.api.riotgames.com`
- `ru.api.riotgames.com`
- `ph2.api.riotgames.com`
- `sg2.api.riotgames.com`
- `th2.api.riotgames.com`
- `tw2.api.riotgames.com`
- `vn2.api.riotgames.com` [cite:7]

### Regional routes

The regional clusters documented by Riot for shared or match-oriented APIs are:[cite:7]

- `americas.api.riotgames.com`
- `asia.api.riotgames.com`
- `europe.api.riotgames.com` [cite:7]

The TFT docs explicitly note that TFT requests must be sent to the correct host based on the endpoint's routing style, which is especially important when combining `account-v1`, `tft-summoner-v1`, and `tft-match-v1` in one workflow.[cite:15]

## League of Legends APIs

The Riot API index lists the main League of Legends endpoint groups below.[cite:7]

| API | Purpose |
|---|---|
| `account-v1` | Riot account lookup by PUUID, game name, or tag line across regional routing.[cite:7] |
| `champion-mastery-v4` | Champion mastery progression for a summoner.[cite:7] |
| `champion-v3` | Champion rotation data.[cite:7] |
| `clash-v1` | Clash team, tournament, and player information.[cite:7] |
| `league-exp-v4` | Experimental ranked-league style endpoints.[cite:7] |
| `league-v4` | Ranked tiers, divisions, entries, and ladders.[cite:7] |
| `lol-challenges-v1` | Challenges progression and leaderboard-style data.[cite:7] |
| `lol-rso-match-v1` | Match access tied to RSO-authenticated user flows.[cite:7] |
| `lol-status-v4` | Service/platform status information.[cite:7] |
| `match-v5` | Match IDs, full match payloads, and timeline-oriented history surfaces for LoL.[cite:7] |
| `spectator-v5` | Current game and featured game live spectator data.[cite:7] |
| `summoner-v4` | Summoner profile and identity information.[cite:7] |
| `tournament-stub-v5` | Testing flow for tournaments and tournament codes.[cite:7] |
| `tournament-v5` | Tournament provider registration, codes, and tournament operations.[cite:7] |

## Teamfight Tactics APIs

The Riot API index also exposes a TFT-specific API set, and the dedicated TFT page adds usage notes that matter for production tools.[cite:7][cite:15]

| API | Purpose |
|---|---|
| `tft-league-v1` | TFT ranked tiers, entries, and league ladders.[cite:7] |
| `tft-match-v1` | TFT match IDs and detailed match payloads keyed by match ID or PUUID.[cite:7] |
| `tft-status-v1` | TFT shard/service status info.[cite:7] |
| `tft-summoner-v1` | TFT summoner-level identity data on platform routing.[cite:7] |
| `spectator-tft-v5` | Live/current spectator access for TFT.[cite:7] |

The TFT documentation also describes restrictions around products that provide real-time strategic advantage, and it gives guidance on approved versus unapproved use cases for companion tools and overlays.[cite:15]

## TFT match history notes

Riot's TFT docs explain that match payloads evolved over time and that `data_version` changes are used when the structure of the response changes.[cite:15] The docs also note historical limitations in early TFT data and recommend focusing on recent patches when building reliable analytics pipelines.[cite:15]

This matters if a parser is being written for a thesis project, dashboard, or ingestion service, because field coverage and semantic meaning may vary across old and new match records.[cite:15]

## Data Dragon

Static game data is served separately from live APIs through Data Dragon, which Riot documents on the TFT page with versioned assets and JSON files.[cite:15] Riot provides a versions endpoint at `https://ddragon.leagueoflegends.com/api/versions.json`, which returns valid content versions for static assets.[cite:15]

Examples of TFT static JSON assets documented by Riot include:[cite:15]

- `tft-arena.json`
- `tft-augments.json`
- `tft-champion.json`
- `tft-item.json`
- `tft-queues.json`
- `tft-regalia.json`
- `tft-tactician.json`
- `tft-trait.json` [cite:15]

These files are useful for resolving IDs into names, icons, traits, item stats, and localized display content when building match viewers or comp-analysis tools.[cite:15]

## Common request flows

### LoL player to match history

A common League flow is:

1. Resolve a Riot account with `account-v1` on a regional route.[cite:7]
2. Use the returned PUUID with `summoner-v4` or directly with `match-v5`, depending on the data needed.[cite:7]
3. Fetch match IDs from `match-v5` and then request individual match payloads by match ID.[cite:7]

### TFT player to match history

A common TFT flow is:

1. Resolve the Riot account with `account-v1` on `americas`, `asia`, or `europe`.[cite:7]
2. Query `tft-summoner-v1` on the platform host using the player's PUUID.[cite:7]
3. Fetch match IDs using `tft-match-v1` on the regional host.[cite:7]
4. Retrieve each TFT match payload by its match ID.[cite:7]

The TFT docs specifically emphasize selecting the correct host for each request type, because mixing platform and regional routes incorrectly is a common integration mistake.[cite:15]

## Example URLs

```text
GET https://europe.api.riotgames.com/riot/account/v1/accounts/by-riot-id/{gameName}/{tagLine}
GET https://euw1.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/{puuid}
GET https://europe.api.riotgames.com/lol/match/v5/matches/by-puuid/{puuid}/ids
GET https://europe.api.riotgames.com/lol/match/v5/matches/{matchId}
GET https://euw1.api.riotgames.com/tft/summoner/v1/summoners/by-puuid/{puuid}
GET https://europe.api.riotgames.com/tft/match/v1/matches/by-puuid/{puuid}/ids
GET https://europe.api.riotgames.com/tft/match/v1/matches/{matchId}
```

The Riot API portal and TFT docs remain the source of truth for parameters, rate limits, and response schemas, so they should be checked before implementing a production client.[cite:7][cite:15]

## Practical notes

- Use PUUID as the stable cross-endpoint identifier whenever possible.[cite:7]
- Separate static asset fetching from live API polling; Data Dragon is versioned and does not belong in the same refresh loop as match or status data.[cite:15]
- Expect policy review if the tool goes beyond personal experimentation into public or production usage.[cite:15][cite:5]
- For TFT analytics, recent data is safer than very old historical samples because Riot explicitly documents past payload limitations.[cite:15]

## Useful links

- [Riot Developer Portal](https://developer.riotgames.com/)[cite:7]
- [API catalog](https://developer.riotgames.com/apis)[cite:7]
- [TFT developer docs](https://developer.riotgames.com/docs/tft)[cite:15]
- [OAuth / RSO docs](https://support-developer.riotgames.com/hc/en-us/articles/22897607341075-OAuth-Client-Documentation)[cite:5]
- [Riot API tutorial example](https://apipheny.io/riot-games-api/)[cite:9]


```bash
# convenience: local Postgres + Redis via Docker
docker run -d --name tft-pg   -e POSTGRES_USER=tft -e POSTGRES_PASSWORD=tft \
  -e POSTGRES_DB=tft -p 5432:5432 postgres:16
docker run -d --name tft-redis -p 6379:6379 redis:7
```

## Setup

```bash
npm install
cp .env.example .env          # then paste your RIOT_API_KEY (and confirm TFT_PATCH)
npm run db:migrate            # applies db/migrations/*.sql
npm run data:load             # loads the current set's catalog from Community Dragon
npm run dev                   # starts Next.js on http://localhost:3000
```