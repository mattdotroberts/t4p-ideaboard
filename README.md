# T4P idea board

Public idea board for the Tech for Palestine × Thaura hackathon (Barcelona, Saturday 31 October).

Live at https://t4p-ideaboard.build.happyoperators.com

- `index.html`: the board
- `server.js`: zero-dependency Node server with a small notes API (`/api/notes`)
- Notes are saved to `$DATA_DIR/notes.json` (`/data` on build.happyoperators.com, kept across redeploys)
- `seed-notes.json`: the ideas copied over when the board moved out of the build repo; only used on first start

## What the board does

- Pin an idea (max 100 on the board at once; when it's full, new pins are refused and nothing is ever dropped)
- Upvote, one vote per idea per browser (click again to take it back), and switch between Newest and Most voted
- Anyone can edit an idea; the original text is kept and "undo edit" puts it back
- "remove" moves an idea to the Removed list, where anyone can restore it
- Live: pins, edits, removals and votes show on every open board instantly (Server-Sent Events, with a polling fallback)
- Spam guard: hidden bot-trap field, 15 pins an hour per browser and 200 per IP
- Works on phones

## Admin

Open the board with `?admin=<key>` to get bulk "remove selected", "remove everything pinned in the last 15 minutes" and "delete forever" in the Removed list.
The key is the `ADMIN_KEY` env var. If that isn't set, the server makes one on first start, saves it to `$DATA_DIR/admin-key.txt` and prints the admin link in the server log.

The full API is listed at the top of `server.js`.

Deployed through https://build.happyoperators.com/deploy. To redeploy after a push, send the same repo and name again.
