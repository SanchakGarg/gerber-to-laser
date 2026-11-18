# Gerber → Laser

A small web app that turns a set of Gerber + Excellon files into ready-to-run **xTool projects
(`.xcs`)**, one per board side, for making PCBs on a laser by ablating copper or spray-painted
copper-clad board. It can also write the older laser-ready SVGs, one file per layer and side. It is the web version of the
[PCB Fab Laser](https://github.com/saikhurana98/kicad-plugin-pcb-fab-laser) KiCad plugin and uses the
same export rules, but works from Gerbers, so any EDA tool's output works (KiCad, Altium, Eagle, EasyEDA…).

- Upload a `.zip`, a folder, or the loose files (drill file included).
- **Layers**: every detected layer, with show/hide (per layer or per side) and a dropdown to fix a wrongly guessed layer type.
- **2D view**: all layers stacked, pan/zoom, top/bottom flip, cursor position in mm.
- **3D view**: the board built from the layers (substrate, copper, mask, silkscreen, holes).
- **Mounting holes**: click *Pick mounting holes*, the board fades and you click the holes your jig uses.
- **Bake XCS**: a live preview of the front and back xTool projects on the laser bed, a show/hide toggle per
  layer, X/Y offsets for the cut and etch lasers, and download links for `front.xcs`, `back.xcs` or both as a zip.
- **More formats**: the per-layer SVG (+PNG) zip, with mirroring and a preview of every file.

## Run it

```bash
cp .env.example .env      # optional: change PORT and other settings
docker compose up --build
```

Open http://localhost:8000 (or whatever `PORT` you set).

## Settings (`.env`)

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8000` | Port the app listens on and is published on |
| `HOST` | `0.0.0.0` | Bind address inside the container |
| `LOG_LEVEL` | `info` | Uvicorn log level |
| `CORS_ORIGINS` | *(empty)* | Comma-separated origins allowed to call the API from another site |
| `MAX_UPLOAD_MB` | `50` | Max total upload size |
| `MAX_FILES` | `64` | Max files per upload (after unzipping) |
| `SESSION_TTL_MINUTES` | `60` | How long a parsed board stays in memory after its last use |
| `MAX_SESSIONS` | `32` | Max boards kept in memory (oldest dropped first) |
| `ARC_TOLERANCE_MM` | `0.005` | Max chord error when turning arcs into polygons (same as the plugin) |
| `PREVIEW_SIMPLIFY_MM` | `0.002` | Simplification for on-screen previews only; exports are never simplified |
| `BOARD_THICKNESS_MM` | `1.6` | Board thickness in the 3D view |
| `DEFAULT_DPI` / `MAX_DPI` | `1000` / `2400` | PNG resolution default and limit |
| `DEFAULT_MIRROR_FRONT` / `DEFAULT_MIRROR_BACK` | `false` / `true` | Initial mirror checkboxes |
| `HOLE_TOLERANCE_MM` | `0.2` | Initial hole tolerance: drill holes/slots are cut this much smaller in diameter (negative = larger) |
| `XCS_BED_WIDTH_MM` / `XCS_BED_HEIGHT_MM` | `220` / `220` | Laser work area; the board is centred on it (xTool F2 Ultra) |
| `MOUNTING_HOLE_MM` | `2.0` | Initial diameter of the jig holes in the *Mounting holes* layer |
| `XCS_PRESETS` | *(empty)* | Path to a laser presets file; empty = `backend/app/xcs_presets.json` |

## xTool `.xcs` export

Two projects, `<board>_front.xcs` and `<board>_back.xcs`, that open in xTool Studio / xTool Creative Space.
In each one the board's bounding box is centred on the bed, and the back side is mirrored because it is
worked on after flipping the board. Every job is its own layer, with its own colour:

| Layer | Colour | Process | Offset | Content |
|---|---|---|---|---|
| Mounting holes | `#A23CF0` | cut | etch | a 2 mm hole (configurable) centred on each hole you picked, for drilling your jig |
| Copper · engrave | `#000000` | fill engrave | etch | board outline − copper (negative; **Invert copper** burns the traces instead) |
| Silkscreen · etch | `#2E6BFF` | fill engrave | etch | silkscreen ∩ outline |
| Solder mask · etch | `#19A974` | fill engrave | etch | solder-mask openings ∩ outline |
| Holes · engrave | `#E1C000` | fill engrave | etch | every hole/slot, filled, shrunk by the hole tolerance |
| Holes · cut | `#FF7F56` | cut | cut | every hole/slot outline, shrunk by the hole tolerance |
| Board outline · cut | `#FE0002` | cut | cut | the outline, with inner cut-outs as their own paths |

- **Show/hide**: a hidden layer is left out of that side's file completely.
- **Offsets**: the cut laser and the etch laser rarely land on exactly the same spot. *Cut* moves the cut
  layers and *Etch* moves the engrave/etch layers (±10 mm, 0.05 mm steps). The mounting holes follow the etch
  offset, so they sit on the etched artwork. Offsets, the jig-hole size and hidden layers are remembered
  in the browser.
- **Mounting holes** are extra. The picked holes still get cut at their real size in the hole layers.
- **Laser settings** (power, speed, passes, light source) come from
  [`backend/app/xcs_presets.json`](backend/app/xcs_presets.json). They were copied from an xTool Studio
  project for the F2 Ultra. Silkscreen and mask have no measured values yet, so treat them as starting
  points and tune them in xTool. xTool's own kerf compensation is off, because the hole tolerance already
  covers it.

The `.xcs` format is xTool's JSON project file; the writer (`backend/app/xcs.py`) documents what is known about it.

## SVG output (More formats)

Files are named `<board>_<side>_<kind>.svg`, with `<side>` = `front` or `back`. Every file uses the
board outline's bounding box, in millimetres at 1:1 scale, so all of them line up in the laser software.

| Kind | Content | Laser job |
|---|---|---|
| `copper` | board outline − copper (**negative**) | burn paint off everything that isn't a trace, so traces stay masked for etching |
| `silk` | silkscreen ∩ outline | silkscreen artwork, as its own job |
| `mask` | solder-mask openings ∩ outline | after etching, burn the leftover paint off the pads so they can be soldered (the plugin's `pads` pass) |
| `cut` | outline only, red 0.1 mm stroke, no background | cut the board out |
| `drill` | hole and slot outlines, red 0.1 mm stroke, no background, shrunk by the hole tolerance. **One file only**, from the front (or the back if only back is exported); the name says which | cut the holes out |

Black means "laser fires here". **Mirror** flips X per side. Back files are mirrored by default because
that artwork is seen through the board. **Invert copper** writes positive copper instead, if your
process needs it. **Hole tolerance** (default 0.2 mm) makes every drill hole and slot that much smaller in
diameter/width than its real size, to make up for the laser's kerf; it never goes below 0.1 mm, and a
negative value makes holes larger. **Also PNG** rasterizes each SVG at the chosen DPI (the Docker image includes `rsvg-convert`).

Suggested order per side, same as the plugin: **copper → etch → drill → cut → mask**.

Every download is a plain link to the server (`GET /api/session/<id>/download/<token>`, sent as an
attachment), so the browser's own download manager saves it. That is what makes downloads work in Arc and Dia
as well as Chrome, Edge, Safari and Firefox.

### How layers are recognised

In order: Gerber X2 `%TF.FileFunction` attributes, then standard extensions (`.gtl .gbl .gto .gbo .gts
.gbs .gtp .gbp .gko .gm1`, Eagle `.cmp .sol .plc .pls .stc .sts`), then names like `F_Cu`,
`B.SilkS`, `Edge_Cuts`, `top_mask`. Excellon files are detected by content. If a guess is wrong, change it
from the dropdown next to that layer.

The board outline is built from the outline layer's line centrelines; loops nested inside it become cutouts.
If there is no closed outline, the artwork's bounding box + 1 mm is used and the sidebar shows a warning.

### Differences from the KiCad plugin

Gerbers are the fab output, so they reflect your CAM settings: KiCad clips silkscreen against mask
openings, and mask openings include the solder-mask expansion. NPTH holes have no copper. On the same board
the outline, bbox and copper match the plugin to within µm, apart from those cases.

## Development

```bash
# backend (Python 3.12)
cd backend
python -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest
PORT=8000 .venv/bin/python -m app.main     # serves the API (+ frontend/dist if built)

# frontend (Node 22)
cd frontend
npm install
npm run dev        # Vite on :5173, proxies /api to the backend on $PORT
npm run build      # outputs frontend/dist
```

Layout:

```
backend/app/
  config.py     settings from env
  loader.py     upload unpacking + layer role detection
  geometry.py   gerber/excellon → shapely polygons (polarity, arcs, outline, drills)
  frame.py      board-relative coordinates, Y-down, mirroring, SVG path output
  board.py      a parsed upload and its derived geometry / API view
  exporter.py   laser SVG/PNG/ZIP export (port of the plugin's exporter)
  xcs.py        xTool .xcs project export (front/back, layers, offsets, mounting holes)
  xcs_presets.json  laser settings written into every .xcs
  main.py       FastAPI routes + download links + static UI
frontend/src/
  main.ts        wiring, steps, pick mode
  sidebar.ts     board ticket, notes, Gerber layer list
  view2d.ts      2D board view + mounting-hole picking
  view3d.ts      3D board view (three.js)
  xcsPanel.ts    "Bake XCS": bed previews, layer toggles, offsets, downloads
  moreFormats.ts SVG/PNG zip export
  styles/riso.css  the risograph look (palette mirrored in palette.ts)
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the commit message convention.
