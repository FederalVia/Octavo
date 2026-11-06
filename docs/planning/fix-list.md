# Octavo fix list

Things to fix and add in Octavo, based on one night of heavy use by Claude and its agents (about 350 notes and roughly 1,000 tool calls). Most important first within each section.

## Already done (thank you)
- [x] `random_note`, `get_note_region` / `set_note_region`, atlas trail (the wishlist)
- [x] `merge_notes`, weekly/monthly notes, due dates
- [x] `list_tasks` status filter: `[?]` questions are no longer listed as to-dos
- [x] Real version number reported to Claude
- [x] Phone performance with big vaults

## Bugs to fix

- [x] **1. Renames mark every linking note as modified.**
  - **What happens:** `rename_note` (and probably `merge_notes`) re-saves every note that links to the moved one, even when the link text doesn't change, since links are by name. After 219 moves, nearly the whole vault showed "updated" at the same moment.
  - **Effects:** "Recently updated" in `get_vault_overview` stops meaning anything. `random_note`'s `prefer_old` can't find old notes. Version history probably fills up with versions where nothing changed.
  - **Fix:** only write a note if its content actually changed.

- [x] **2. Clicking a link to a deleted note recreates it empty.**
  - **What happens:** I trashed `Test.md`, but an old journal line still said `[[Test]]`. A click on that faded link created a blank `Test.md`.
  - **Fix ideas:** when a link points to a note in `.trash`, offer "restore" instead of "create". Or, on delete, offer to unlink or strike through backlinks.
  - The empty `Test.md` is still in the vault.

- [x] **3. `append_to_note` lands below a trailing `#tag` line.**
  - **What happens:** appending to the last section, or under a new heading, puts the content after a closing `#tags` line or a "Back to Home" footer.
  - **Fix ideas:** insert above a trailing tags-only line, or add an optional `before` anchor.
  - My current workaround is to put tags in frontmatter.

- [x] **4. `Journal.md` vs. `Journal/`.**
  - **What happens:** the starter Home links `[[Journal]]` (`packages/server/src/seed.ts`, line 16), but `log_to_journal` writes to `Journal/YYYY-MM-DD.md`, so the linked note stays empty.
  - **Fix ideas:** have `log_to_journal` keep a `Journal.md` index up to date, or seed Home with a link to today's note.

- [x] **5. Claude sessions get stuck on an old tool list after an update.**
  - **What happens:** the new server was running (`read_note` showed regions), but a long-running session never saw the new tools, even after a forced refresh, until the server was renamed. It's probably client-side caching keyed by server name.
  - **Fix ideas:** try sending MCP's `notifications/tools/list_changed`. Otherwise, document the workaround: rename the server or start a new conversation.

## Features to add

- [x] **Region counts in `get_vault_overview`**, e.g. "Frontal 25 · Parietal 165 · …", so Claude can see the balance without listing every note.
- [x] **Orphans and dead ends over MCP.** The app and CLI can find them, but Claude can't. A `find_orphans` tool would make tending a big vault much easier.
- [x] **Bulk region setting.** Let `set_note_region` take a list of notes or a whole folder. The agents had to hand-edit 93 notes one at a time.
- [x] **Typed or "surprise" links drawn differently in the atlas**, e.g. `[[note|surprise]]` or a property. The vault's Surprise map links cross regions far more than folders do, so highlighting them would look great.
- [x] **A `random_note` that also favors under-linked notes**, not just old ones, so forgotten notes get connected.

## Please check
- [x] **Is the atlas trail showing Claude's reads?** I can't see it from my side.

---

## Done in 0.3.9

- **Bug 1:** saving identical content is now a no-op (no write, no version, no new mtime), and moves only rewrite notes whose text actually changes.
- **Bug 2:** a link to a trashed note offers to restore it with its old content instead of creating a blank note. `read_note` on a trashed note says so, and the new `restore_note` tool brings it back.
- **Bug 3:** `append_to_note` inserts above a trailing footer (tags-only lines, "Back to …" lines and a `---` rule just above them).
- **Bug 4:** the starter Home no longer links `[[Journal]]`. If a note named after the daily folder exists (e.g. `Journal.md`), each new daily note is added to it as `- [[YYYY-MM-DD]]`.
- **Bug 5:** the stdio server sends `notifications/tools/list_changed` right after connecting, and CONNECT_CLAUDE.md documents the rename workaround.
- **Region counts:** already in the overview ("Brain regions:" line).
- **`find_orphans`:** new tool (orphans, dead ends, missing link targets; folder and limit filters).
- **Bulk regions:** `set_note_region` takes `path`, `paths[]` or `folder`, and `region: "auto"` clears the override.
- **Surprise links:** notes tagged `#surprise` (or `surprise: true`) get dashed, highlighted links in the atlas. New view option "Bridges between regions" dims links inside a region and brightens links between them (hub notes excluded).
- **`random_note` favor:** `favor: "old" | "unlinked" | "both" | "none"`.
- **Atlas trail:** the Claude Desktop (stdio) process now writes reads to a small activity file in the temp folder, and the open app tails it, so reads show on the trail.

## Triage notes (before starting)

- **Region counts in `get_vault_overview`**: already there since 0.2.1 (the "Brain regions:" line). Probably mark done; maybe make it more prominent.
- **Bug 1 (renames rewrite every linking note)**: confirmed in code. `Vault.linkRewrites()` returns a rewrite for every note with a link to the moved note, even when the new link text is identical (moving between folders keeps `[[Name]]`). Fix: skip notes whose content is unchanged; same in `merge`. Also check `write()` never snapshots or bumps mtime for identical content.
- **Bug 5 (stale tool list)**: the user's Claude Desktop kept the first-connection tool list until the server entry was renamed. Try sending `notifications/tools/list_changed` on connect; document the rename workaround in CONNECT_CLAUDE.md troubleshooting.
- **"Is the atlas trail showing Claude's reads?"**: probably not with Claude Desktop. Its stdio MCP server is a separate Octavo process, so "note read" events never reach the open app (file changes do, through the watcher). Fix: when the stdio server reads a note, also notify the running app (e.g. POST to the app's local server, with the token, when it's reachable), or share events through a small file in `.octavo/`.
- Also from the same night: someone reorganized the vault (Concepts/Nuclear split into subfolders). That was probably another Claude session; it's fine, but it's a reason to do bug 1 first.
