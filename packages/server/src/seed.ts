import type { Vault } from '@ultron/core';

const HOME = `# Home

Welcome to **Ultron Mind**, a knowledge base of plain Markdown files that you and Claude share.

- Link notes with \`[[double brackets]]\`, like [[How to use Ultron Mind]].
- Tag notes with \`#tags\`. #meta
- Every note is a point in the **brain**. Click one to open it.
- Claude reads and writes this vault through MCP, so it remembers things between conversations.

## Areas

- [[People]]
- [[Projects]]
- [[Journal]]
`;

const GUIDE = `---
tags: [meta]
---
# How to use Ultron Mind

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| Ctrl/Cmd + O | Quick switcher (open or create a note) |
| Ctrl/Cmd + Shift + F | Search all notes |
| Ctrl/Cmd + E | Toggle edit / preview |
| Ctrl/Cmd + G or Esc | Close the note and return to the brain |
| Ctrl/Cmd + D | Today's journal note |

## Linking

- \`[[Note name]]\` links to a note, and \`[[Note name|label]]\` shows a different label.
- \`[[Note name#Heading]]\` links to a section of a note.
- Links to notes that don't exist yet appear faded. Click one to create the note.
- Renaming a note updates every link that points to it.

## Claude

Claude uses the same vault as its memory. It searches it at the start of a conversation, saves decisions and facts as notes, and keeps a log in [[Journal]] notes. Anything Claude writes appears here live.

Back to [[Home]].
`;

/** Give a brand-new, empty vault a couple of starter notes. */
export async function seedIfEmpty(vault: Vault): Promise<boolean> {
  if (vault.list().length > 0) return false;
  await vault.write('Home.md', HOME);
  await vault.write('How to use Ultron Mind.md', GUIDE);
  return true;
}
