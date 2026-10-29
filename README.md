# T4P idea board

Public idea board for the Tech for Palestine × Thaura hackathon (Barcelona, Saturday 31 October).

Live at https://t4p-ideaboard.build.happyoperators.com

- `index.html`: the board
- `server.js`: zero-dependency Node server with a small notes API (`/api/notes`)
- Notes are saved to `$DATA_DIR/notes.json` (`/data` on build.happyoperators.com, kept across redeploys)
- `seed-notes.json`: the ideas copied over when the board moved out of the build repo; only used on first start

Deployed through https://build.happyoperators.com/deploy. To redeploy after a push, send the same repo and name again.
