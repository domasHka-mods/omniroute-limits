# herdr-omniroute-limits

Herdr status-bar mod showing OmniRoute quota limits (`5h` / `7d` sums across accounts) for your configured models.

## Install

1. Clone into `~/.config/herdr-app/mods/omniroute-limits`:
   ```sh
   git clone git@github.com:tehrelt/herdr-omniroute-limits.git ~/.config/herdr-app/mods/omniroute-limits
   ```
2. Add to your layout's status bar (e.g. `layouts/main-orca.json`):
   ```json
   {
     "id": "status",
     "type": "row",
     "size": { "px": 28 },
     "children": [
       { "id": "workspace-status", "type": "block", "size": { "weight": 1 }, "content": { "mod": "workspace-status" } },
       { "id": "omniroute-limits", "type": "block", "size": { "px": 210 }, "content": { "mod": "omniroute-limits" } }
     ]
   }
   ```
3. Click `OmniRoute: auth` in the status bar to log in with your OmniRoute dashboard password or Bearer token.
