# SEATMAKER

CONKLIN OFFICE FURNITURE - RESEARCH AND DEVELOPMENT

# SEATMAKER

Turns a CAP / AutoCAD floor plan into a Visio seating plan for HR. Drop in the floor's DXF and SEATMAKER finds every seat, draws a clean floor plan with room names, and numbers the seats row by row. Remove or add seats with a click, then download a Visio file where the floor plan is locked and every seat is its own shape, ready to renumber or color by department. The drawing is read in the browser and never leaves the computer.

<span style="color:grey">OUTPUT IN VSDX FORMAT</span>

LAUNCH — https://wesprojects.github.io/SEATMAKER/

README — https://github.com/wesprojects/SEATMAKER

## Usage

1. In AutoCAD, SAVEAS **AutoCAD 2013 DXF**. Don't flatten, explode or purge first. SEATMAKER reads the CAP blocks as they are.
2. Open SEATMAKER and drop the DXF on the page, or use LOAD DXF.
3. Check the seats. Click a seat to remove it and click again to bring it back. ADD DESK and ADD CHAIR place seats by hand. UNDO steps back.
4. Type the floor name, pick the sheet, and click **VSDX**.

Runs in a current desktop browser. Chrome is recommended. Large drawings (80 MB) take a few seconds to read.

## What it finds

| Source | Seats |
|---|---|
| LaCour 60L x 33D benching blocks | 2 per block, back to back |
| CAP blocks described as a task chair | 1 per chair |
| Exploded desk linework on a DESK layer, in 60" multiples, 30–35" deep | 1 per 60" |
| Any other furniture block | set it to CHAIR, DESK or 2 SEATS in the SEAT BLOCKS list |

Loose desk-layer pieces that aren't a desk shape (such as 36 x 67 end pieces) are listed but not counted.

## Drawing handling

- **Clipped blocks (XCLIP).** A clipped core plan is trimmed to what AutoCAD shows, so other floors in the base building block don't come through.
- **Nested blocks.** Seats are found at any depth, including a whole floor wrapped in one block and chairs inside copied groups.
- **3D solids.** CAP worksurfaces and pedestals that are solid-only are ignored. The seat comes from the desk or chair block instead.
- **Hidden layers.** Layers that are off or frozen are skipped.
- **Plan layers.** Walls, doors, glazing, columns, stairs, core and fixtures go on the plan. Furniture, annotation, dimensions and hatches stay off it.

## Visio file

- One page, named from the floor name, on ANSI C 22 x 17, ARCH D 36 x 24 or Tabloid 17 x 11 at the largest architectural scale that fits (1/8" = 1'-0" for a typical floor on ANSI C).
- Layer **Floor Plan** is locked. Layer **Seats** holds one rectangle per seat with its number as the text.
- Numbering puts office chairs first, top to bottom, then each bench row from the top, left to right, front and back desk as a pair. FIRST SEAT NUMBER sets where it starts.

## Files

- `index.html` — the whole app in one file. Opens from disk or GitHub Pages.
- `src/engine.js` — DXF reader, block and clip flattening, seat detection, numbering, VSDX and ZIP writer. No page code, so it also runs in Node.
- `src/page.html` — the interface. `src/brand.html` — the Conklin header lockup.
- `build.py` — assembles `index.html`: `python3 build.py YYYY-MM-DD.N`.
- `test/test.js` — reads a DXF, writes the VSDX, and checks the seat count: `node test/test.js floor.dxf 107`. Client drawings are not kept in this repository.

## Limits

- DXF only. DWG is a closed format the browser can't read.
- Seat outlines are rectangles. Curved or L-shaped desks get their overall footprint.
- Room names come from the A-AREA-IDEN layer. Tags placed outside the building in the drawing land outside it on the plan too.
