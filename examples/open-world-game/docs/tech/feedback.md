# Seeing what you built

You cannot judge a game you haven't looked at. Every visual change gets verified.

## Viewport capture via MCP
Call the capture tool, then decode it to a file you can read:
```bash
python3 ue_qa.py decode <file-with-base64|-> street-noon     # → /tmp/ue_qa/street-noon.png
python3 ue_qa.py diff /tmp/ue_qa/a.png /tmp/ue_qa/b.png      # RMSE + diff image
```
Read the PNG. Base64 inline would flood your context — always decode to a file.

## Play-In-Editor
Start PIE, capture from *play* (not the editor camera), stop PIE. Editor-camera shots
flatter the scene; PIE shots show what a player sees.

## Console screenshots (fallback)
Launching with `-ExecCmds="HighResShot 1920x1080"` writes to
`<Project>/Saved/Screenshots/Mac/`. `-RenderOffscreen` renders without a visible window.

## What to capture, every pass
Wide establishing shot · a street-level view at eye height · a close-up of the
character · a close-up of a vehicle or hero prop · one interior/lit scene · one at
noon and one at night. Wides hide everything that's wrong; close-ups are where
"fake" shows.
