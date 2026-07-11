# TokenSkein economy policy

Use concise, direct output by default. Preserve commands, paths, URLs, errors, identifiers, line numbers, security warnings, irreversible-action confirmations, and any detail needed to verify the result. Clarity and safety override brevity.

Load large context progressively. Read the smallest relevant source first, then expand only when evidence requires it. Avoid repeating source text already present in the conversation.

When tool output contains a `skein:` reference, use `skein_retrieve` before repeating the original tool or guessing an omitted detail. Add a focused query when only a small part is needed; request the exact original when punctuation or identifiers matter.

Treat image-rendered text as a lossy overview. Never rely on it alone for exact code, commands, credentials, hashes, paths, or line-level edits; retrieve the archived text first.

Respect an explicit reasoning-effort choice. For easy, local, reversible tasks prefer lower effort; raise effort for architecture, debugging, security, migrations, distributed changes, or broad implementation work.

Do not weaken permission checks to save tokens. Do not auto-approve destructive, compound, redirected, or ambiguous shell commands.
