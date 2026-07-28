# Local Second Brain for Obsidian

A local-first automation engine that turns an [Obsidian](https://obsidian.md) vault
into a semantically searchable "second brain" — using only models that run on your
own machine via [Ollama](https://ollama.com). No document content, embeddings, or
queries are ever sent to a cloud AI provider.

It watches your vault in real time, ingests external documents (PDF, Word,
PowerPoint, plain text), extracts and structures their content, embeds and indexes
everything into a local vector store, and — optionally — proposes tags and links
between related notes. A companion Obsidian plugin adds an in-app search box backed
by the same local index.

This repository accompanies a short paper on the design decisions and failure modes
encountered while building it:

📄 **[Building a Private Second Brain: What Breaks When You Keep AI Local, and Why That's the Point](paper/building-a-private-second-brain.pdf)**
(also available as [Markdown](paper/building-a-private-second-brain.md))

It's meant to be read and adapted, not run as-is out of the box on someone else's
machine — file paths, model names, and the daily-schedule mechanism are all things
you'll want to tune to your own setup.

## Why local?

Three reasons drove every design decision here:

1. **Privacy by construction.** Personal and work notes often contain sensitive
   material. Routing them through a third-party AI API means trusting that
   provider's retention policy. Running embeddings and language models locally
   removes that dependency entirely — the trust boundary is your own laptop.
2. **Cost.** Indexing and re-indexing a growing vault, plus generating tags and
   summaries continuously, adds up fast on metered APIs. Local inference is
   effectively free after the one-time cost of downloading the models.
3. **No rate limits, no outages.** The system works offline, and doesn't depend on
   a third party's uptime.

The trade-off is hardware-bound quality and speed (see "Lessons learned" below) —
this project treats that trade-off as a first-class design constraint, not an
afterthought.

## Architecture

```
                     ┌──────────────────────────┐
  cloud drives  ───▶ │ index_external_folders.py│──▶ Notes/  (read-only ingestion,
  (shared, no        │  (daily, no copying)     │           no duplication)
  cloning wanted)    └──────────────────────────┘
                                                          │
  manually dropped                                        ▼
  documents      ───▶ Sources/ ──▶ watcher.py ──▶ text extraction (PDF/DOCX/PPTX)
  (PDF/DOCX/PPTX)                     │                    │
                                      │                    ▼
                                      │              Notes/*.md  (generated notes)
                                      │                    │
                                      ▼                    ▼
                              chunking + Ollama      tag/link suggestions
                              embeddings  ──▶  Chroma  (Ollama LLM, appended
                                (nomic-embed-text)      inline for generated
                                      │                 notes; kept separate
                                      ▼                 for hand-written ones)
                              search.py / Obsidian plugin
                                (semantic search)

  digest.py (daily) ──▶ Reviews/YYYY-MM-DD.md   (LLM-written summary of the day's changes)
```

### Components

- **`watcher.py`** — a long-running process that watches the vault, converts source
  documents dropped into `Sources/<project>/` into notes, keeps the vector index in
  sync, and generates tag/link suggestions.
- **`index_external_folders.py`** — indexes external folders (cloud drives, shared
  libraries) **without cloning them**: it reads files in place, extracts text, and
  writes only the resulting note. Meant for scheduled (e.g. daily) runs against
  folders you don't want to duplicate or watch in real time.
- **`digest.py`** — writes a daily summary note of what changed in the vault.
- **`search.py`** — one-shot semantic search CLI, also used by the Obsidian plugin.
- **`common.py`** — shared helpers: chunking, Ollama calls, document extraction,
  version/format deduplication.
- **`obsidian-plugin/`** — a minimal Obsidian plugin exposing an in-app search box
  backed by `search.py`.

### Models used (all via Ollama, all local)

- `nomic-embed-text` — embeddings
- `llama3.2` — tag/link suggestions and the daily digest

Both are small enough to run comfortably on a laptop CPU. See "Lessons learned" for
why larger/multimodal models were tried and abandoned for parts of this pipeline.

## Setup

```bash
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
cp external_folders_config.example.py external_folders_config.py  # if you want external-folder indexing
```

Set `SECOND_BRAIN_VAULT` (defaults to `~/Documents/SecondBrain`) and
`SECOND_BRAIN_HOME` (defaults to `~/.second-brain`) if you want them elsewhere.
`OLLAMA_URL` defaults to `http://localhost:11434`.

Run the watcher in the foreground to try it out:

```bash
./venv/bin/python watcher.py
```

For always-on background operation, wrap `watcher.py`, `digest.py`, and (if used)
`index_external_folders.py` in your OS's service manager (launchd on macOS, systemd
on Linux, Task Scheduler on Windows) — this repo doesn't ship service unit files
since paths and scheduling preferences are inherently personal.

To build the Obsidian plugin:

```bash
cd obsidian-plugin
npm install
npm run build   # produces main.js
```

Copy the `obsidian-plugin/` folder into `<your-vault>/.obsidian/plugins/second-brain-search/`,
then enable it from Obsidian's Community Plugins settings.

## Lessons learned

These are the design decisions this project got wrong on the first try, kept here
because the failure mode is more instructive than the fix.

- **Local vision models are not ready for slide/diagram captioning.** An early
  version extracted embedded images from decks and captioned them with a small
  local vision model (`moondream`) to make diagrams searchable. In practice the
  model returned empty output for non-English prompts, and even in English it
  confidently hallucinated content on business diagrams (describing an
  architecture diagram as "a close-up of nerves in a brain"). A wrong caption
  silently indexed as fact is worse than no caption — the feature was removed
  entirely rather than shipped as "mostly working." Images are now left out of
  the index; the diagram itself is simply not represented as text.
- **Never trust a model to reproduce a file path.** An earlier version asked the
  LLM to write out full Obsidian wikilinks as free text. It occasionally invented
  paths that didn't exist, or merged two real paths into one that looked
  plausible but pointed nowhere. The fix: show the model a *numbered* list of
  candidate related notes and ask it to pick indices, then have the code build
  the actual link from the known, correct path. The model chooses; the code
  writes.
- **Two notes can legitimately share a filename.** Documents from different
  projects sometimes carry the same filename in different folders. A short-form
  wikilink is ambiguous in that case — Obsidian can't tell which note you mean.
  The system now detects this collision and automatically falls back to a
  fully-qualified path only when needed, keeping links short everywhere else.
- **A parallel "metadata" folder tree doubles the file count and the cognitive
  load.** An earlier design mirrored every note with a matching file in a
  separate `_Suggestions/` folder, so tags and links never touched the original.
  For hand-written notes that caution is warranted. But for notes the pipeline
  itself generated from a source document, there's no user content to protect —
  so those suggestions are now appended directly to the note, guarded by a
  content hash to avoid a rewrite loop, cutting the visible file count roughly in
  half.
- **Removing redundant duplicates needs a policy, not vigilance.** A folder
  synced from multiple contributors accumulates near-duplicates: `report_v01.pptx`,
  `report_v03.pptx`, `report_vFINAL.pptx`, plus a lighter `report_v03.pdf` export
  of the same deck. Two simple, composable rules — keep the highest version
  number (`vFINAL` always wins), then prefer a PDF over an Office file with the
  same name — turned out to cover the overwhelming majority of real-world
  clutter, and are cheap to apply automatically every time new files appear.
- **"Local" storage claims need to be checked, not assumed.** Partway through
  this project, checking `~/Documents` revealed it was a symlink into a
  cloud-drive sync folder set up by the OS-level "back up your folders"
  feature — meaning every file written to the vault had been silently
  syncing to a cloud account the whole time. The AI *processing* was local;
  the *storage* wasn't, and those are two different guarantees that are easy to
  conflate. Worth an explicit check before claiming "nothing leaves this
  machine."
- **A daily-cadence, read-only ingestion pass is often the right answer for
  shared/external content** — not because real-time file watching is technically
  hard, but because a folder you don't own (a shared drive, a colleague's
  export) doesn't need instant reactivity, and treating it read-only (no
  copying, no deletion of the archive if a file disappears upstream) is the
  conservative default that avoids surprises.

## What this repository deliberately does not include

- Any actual vault content, extracted document text, or personal configuration —
  this is the engine, not a dataset.
- OS-level service files (launchd/systemd) — these encode personal paths and
  scheduling preferences.
- A hosted or one-click deployment — this is meant to be read, adapted, and run on
  your own machine, not operated as a service.

## License

MIT — see `LICENSE`.
