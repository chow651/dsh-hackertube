# HackerTube for DeepSeek Harness

[简体中文](README.md) | English

Browse and watch the videos Hacker News has recommended over two decades, without leaving the DeepSeek Harness panel. A high-quality English video library within reach, which makes the harness a richer and more enjoyable place to work.

![Home](docs/home-en.png)

The dataset comes from [HackerTube](https://karpathy.bearblog.dev/hacker-tube/) by Andrej Karpathy. The site ships a complete data export, and the author describes its purpose in his post:

> Export of the site's data available to give to your agent to easily create your own version.

This plugin consumes that official export. It is an unofficial project and is not affiliated with Andrej Karpathy, Hacker News, or YouTube.

The original site works fine on its own. Moving it into the panel changes two things. You no longer switch windows, and the interface is fully available in Chinese, including titles, categories, summaries, and comments.

## Browse by category

The 6,454 videos sort into 16 areas, and each area splits into subcategories, 150 in total. When you do not know what to watch, start from the categories page.

![Categories page](docs/categories-en.png)

| Area | Subcategories | Videos |
|---|---:|---:|
| Software Engineering & Languages | 11 | 980 |
| Systems, Networks & Security | 10 | 702 |
| AI, Machine Learning & Data | 9 | 576 |
| Mathematics & Theoretical CS | 9 | 360 |
| Hardware & Electronics | 8 | 582 |
| Computing History & Culture | 8 | 1026 |
| Design, Graphics & Visual Media | 9 | 439 |
| Business, Startups & Economics | 9 | 644 |
| Politics, History & Society | 9 | 1018 |
| Physics, Space & Chemistry | 8 | 600 |
| Life Sciences, Mind & Health | 11 | 598 |
| Earth, Energy & Environment | 8 | 354 |
| Engineering, Transport & Making | 12 | 805 |
| Games & Game Development | 8 | 355 |
| Arts, Comedy, Music & Film | 12 | 1344 |
| Ideas, Learning & Language | 9 | 689 |

A video can belong to more than one area, so the video counts add up to more than 6,454.

## Installation

Requires DeepSeek Harness.

### Let your agent install it

Paste this into a DeepSeek Harness session. The agent installs the plugin, enables it, and checks the result:

```
Install and enable the HackerTube plugin: plugin_manager install_bundle target=dsh-hackertube.
If npm fails, use target=github:chow651/dsh-hackertube instead.
Then confirm dsh-hackertube is enabled in the plugin list and remind me to refresh the page.
```

### Install with the plugin manager

The package is published on npm:

```
plugin_manager install_bundle target=dsh-hackertube
```

It can also be installed straight from the Git repository, though how the host parses the install argument depends on its version:

```
plugin_manager install_bundle target=github:chow651/dsh-hackertube
```

### Install with npm or pnpm

```
npm install dsh-hackertube
```

```
pnpm add dsh-hackertube
```

DSH loads plugins from its profile directory, so installing into an ordinary project has no effect. Install inside that profile directory, add the package name to its `dsh.profile.bundles` array, then restart DSH. The `plugin_manager` command above does all three steps for you. Take the manual route only for scripting or bulk deployment.

After installing, enable `dsh-hackertube` in the plugin list and refresh the page. No configuration, no API key, and no data to fetch beforehand.

## Features

![Watch page](docs/watch-en.png)

The panel holds 6,454 videos across 16 areas and 150 categories, ordered by how strongly Hacker News recommends them. The home grid loads 60 cards at first and appends more as you scroll.

The watch page has the player, the Hacker News discussion for that video, and a related rail on the right. The rail has a second pane for AI questions. It hands the model the subtitle lines within three minutes of the current playhead, so you can ask what a particular segment covers.

Search works with English and Chinese queries. A Chinese query matches both the Chinese title and the English tags.

Likes, watch later, and history live on the host side, so clearing browser data does not lose them.

### Keyboard shortcuts

| Key | Action |
|---|---|
| `/` | Focus the search field |
| `j` `k` | Move between cards |
| `Enter` | Open the focused card |
| `l` | Like |
| `w` | Add to watch later |
| `h` | Back to home |
| `?` | Show all shortcuts |
| `Esc` | Close overlay |

## A tool for your agent

The plugin registers a tool named `hackertube_search`. Once installed, your agent can search this video library from any conversation, without opening the panel.

### One full exchange

You ask:

> Which video should I actually watch to understand backpropagation?

The agent calls `hackertube_search({ query: "backpropagation", limit: 5, lang: "en" })`, and the tool returns (excerpt):

```
1. The spelled-out intro to neural networks and backpropagation: building micrograd — Andrej Karpathy · 146 min · 4.4M views · 17 recommenders
   HN: HN treats it as the best starting point for really understanding backprop and neural nets…
   https://www.youtube.com/watch?v=VMj-3S1tku0

2. Backpropagation, intuitively | Deep Learning Chapter 3 — 3Blue1Brown · 13 min · 6.4M views · 4 recommenders
   HN: Recommended as the most accessible introduction to backprop for people who struggle with the pure math.
   https://www.youtube.com/watch?v=Ilg3gGewQ5U
```

The agent answers:

> Start with Karpathy's "building micrograd", 146 min. It has 17 recommenders, the strongest signal HN gives, and it builds backpropagation from scratch in code instead of explaining it on paper. If you want the intuition first, watch the 3Blue1Brown chapter (13 min) before it.
> https://www.youtube.com/watch?v=VMj-3S1tku0

### Good requests for it

- Any talk explaining Raft consensus
- A few lectures on compiler optimization
- Which Karpathy video covers backpropagation

### What it does

Searches titles, channels, tags and categories in English and Chinese, plus each video's summary and Hacker News recommendation note. Results carry title, channel, duration, view count, recommender count, the recommendation note and a link, ordered by how strongly Hacker News recommends them. Chinese queries work, and titles come back in Chinese when a translation exists.

| Parameter | Meaning |
|---|---|
| `query` | Search terms, English or Chinese |
| `limit` | Result count, default 5, max 15 |
| `lang` | Language for the returned text, `zh` or `en`, default `zh` |

## First launch

The plugin starts downloading the official export as soon as it loads, 17.8 MB in one request, and at the same time requests upstream pages to fill in YouTube duration, view count, and publish date. The list is only complete once both finish. A skeleton screen covers the panel in the meantime.

| Scenario | Measured |
|---|---|
| First install, empty cache | about 10 seconds |
| Later launches, list load | 45 ms |
| Opening a watch page | 10 ms |
| Related, the 3,778 videos with co-recommendation data | 2 ms |
| Related, the other 2,676 videos, by vector similarity | about 0.7 s on first use |
| Machine translation of summary and recommendation note | 0.4 to 1.8 s on first use |

The export stays valid for seven days. YouTube metadata is cached for twenty-four hours.

## Chinese support

Every interface string goes through `tx(lang, 中文, English)`, so neither language mode shows mixed text. Number units follow the language, with 万 and 亿 in Chinese and K and M in English.

Content-level Chinese comes from four places.

| Content | Source | When it applies |
|---|---|---|
| 6,454 video titles | Translation table shipped in the repository | Immediately after install |
| 166 category names | Shipped in the repository | Immediately after install |
| Summary, recommendation note, quoted comment | Translated when the page opens | Model first, machine translation as fallback |
| Hacker News comment bodies | Per comment or in bulk, on demand | About 1 second, then cached |

Model output and machine translation are stored separately. Once a model is configured, its translations replace the machine output rather than being blocked by it.

Machine translation uses the public Google web translate endpoint. Comment bodies stay in English by default. Translation is an explicit action.

## Dependencies and degradation

| Capability | Requires | Without it |
|---|---|---|
| List, categories, search, playback | The DSH web server and network access | The panel or the player does not load |
| Chinese titles and category names | Nothing | Shipped with the repository |
| Chinese for summary and the other two fields | A model or network access | English source text is shown |
| AI questions | A model configured in DSH | The panel reports the model is unavailable, everything else works |
| Comment translation | Network access | The button does nothing and the text stays as written |
| Subtitles and direct-stream fallback | `yt-dlp` and `ffmpeg` on PATH | Video still plays, the AI answers lose subtitle context |

Both `yt-dlp` and `ffmpeg` are optional. They affect two things only, whether AI answers can use subtitles and whether playback can fall back to a direct stream when YouTube refuses the embed.

## Data source

`https://hackertube.org/download/hackertube-data.zip`, 17.8 MB, exported on 31 October 2026.

```
videos.jsonl       6,454 videos with title, channel, summary, recommendation note, tags, categories, HN stats
mentions.jsonl    39,834 HN comments with author, month, stance, and body
related.jsonl      3,778 co-recommendation rows
embeddings.npy     6,454 × 384 float16 vectors, used to fill in videos without co-recommendation data
embedding_ids.json Row index to video id
taxonomy.json      150 categories in 16 areas
```

Unpacking uses the zlib module built into Node, so the plugin ships with no npm runtime dependencies.

The export has no duration, view count, publish date, or thumbnail, since those are YouTube metadata. The list therefore still requests 65 upstream pages in parallel to fill them in, cached for one day.

## Cache

Everything lives under `$DSH_PROFILE_DIR/.dsh-hackertube/`, by default `~/.dsh/.dsh-hackertube/`. Deleting the directory resets the plugin to a clean state.

```
export/               Unpacked official data, about 48 MB
i18n/zh-titles.json   Title translations
i18n/zh-taxonomy.json Category translations
i18n/zh.json          Model translations for detail text
i18n/zh-mt.json       Machine translations for detail text
i18n/zh-comments.json Comment translation cache
list.json             YouTube metadata and list snapshot
prefs.json            Likes, watch later, history
subs/                 Subtitles
```

## Known limitations

Title translations are model output checked by rules. Most read naturally, and roughly a thousand remain close to word-for-word.

A Chinese query is machine translated into English before it can reach English tags. That costs one request per query, debounced by 300 ms and cached in memory. Offline, only local matching applies.

YouTube embeds follow upstream policy. Age-restricted and region-restricted videos are only available on YouTube.

The playback relay listens on `127.0.0.1:18090`, falling back to 18091 and 18092 when the port is taken.

## Credits

Thanks to Andrej Karpathy for building HackerTube and for publishing its data export. This plugin builds on that work.

Discussion content comes from [Hacker News](https://news.ycombinator.com). Videos are hosted on YouTube.

## License

MIT
