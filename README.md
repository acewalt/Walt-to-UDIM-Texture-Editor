# Walt to UDIM Texture Editor

Browser-based tool for organizing, previewing, editing, renaming, and exporting UDIM texture sets.

## Live Demo

[Open the GitHub Pages demo](https://acewalt.github.io/Walt-to-UDIM-Texture-Editor/)

## What It Does

Walt to UDIM Texture Editor is built to prepare texture assets for DCC tools, game engines, and real-time pipelines. It is not only a texture viewer: the main goal is to organize UDIM tiles, reorder them, rename them correctly, preview them on a model, and export the final texture set without modifying the original files.

## Main Modules

### UV Layout Editor

The UV Layout Editor is the main workspace for inspecting and adjusting how a model uses UDIM tiles.

- Import FBX or OBJ models.
- View the model in a Blender-inspired 3D viewport.
- Switch between Object Mode and Edit Mode.
- Select vertices, edges, faces, or islands.
- Use shortcuts inspired by Blender:
  - `Tab` switches Object/Edit mode.
  - `1`, `2`, `3`, `4` switch selection mode.
  - `G`, `S`, `R` move, scale, and rotate UV selections.
  - `Ctrl + Z` and redo support UV edit history.
  - `Ctrl + I` inverts the current selection.
- Select faces or full UV islands from the 3D viewport.
- Show selected UVs in the UV editor.
- Move selected UVs to a target UDIM.
- Navigate UDIMs with a tile selector.
- View the active UDIM texture behind the UV layout.
- Toggle model UV/wire overlays.
- Use projection actions such as Project From View, Planar, Box, Cylindrical, and Spherical projection.
- Use UV cleanup tools such as Normalize, Straight, Gridify, and Rectify on the current selection.

### UV/Image Editor

The UV/Image Editor is used to organize texture tiles by channel and UDIM.

- Import multiple texture files.
- Drag and drop images directly into the editor.
- Organize textures by channel:
  - BaseColor / Diffuse
  - Roughness
  - Normal
  - Metallic
  - AO
  - Custom
- Reorder tiles with drag and drop.
- Move textures between channels.
- Preview each tile with:
  - thumbnail
  - original filename
  - final export name
  - channel
  - UDIM
- Sort tiles by UDIM.
- Overlay UVs over the texture tiles to verify that each texture matches the correct UDIM.
- Resize the UV/Image Editor panel and zoom the tile view.

### Texture Projection / Image Ripper

Texture Projection is a separate workspace for preparing images before applying them to UVs.

- Import one or more reference images.
- Drag and drop images directly into the Image Ripper area.
- Add multiple ripper regions.
- Edit corner points to select and deform a region.
- Correct perspective-like regions before saving.
- Preview the extracted result in a Texture Atlas panel.
- Move, scale, and rotate atlas pieces with Blender-style shortcuts:
  - `G` move
  - `S` scale
  - `R` rotate
- Select atlas pieces by clicking them.
- Keep prepared images in an internal Prepared Projections list.
- Store each prepared projection with name, thumbnail, resolution, creation date, and status.
- Adjust brightness, contrast, opacity, and atlas placement.
- Add configurable bevels per atlas corner:
  - straight bevel
  - rounded bevel
- Use a magnifier while moving ripper points for more precise placement.

Prepared images are not applied automatically. They are saved first, then used later inside the UV Layout Editor.

### 3D Preview

The viewport is designed to feel closer to Blender navigation while staying inside the browser.

- Import FBX or OBJ models.
- Drag and drop supported model files into the viewport.
- Preview textures on the model.
- Use the first UDIM tile for material preview when needed.
- Show UDIM material coverage with flat colors.
- Switch preview modes:
  - Lit
  - Flat
  - Clay
  - Normals
  - Coverage
  - X-Ray
- View a 3D axis/gizmo indicator.
- Reset camera manually.
- Navigate with Blender-like mouse controls:
  - middle mouse rotates
  - Shift + middle mouse pans
  - Ctrl + middle mouse zooms
  - scroll wheel zooms

### Texture Paint

Texture Paint is an experimental painting mode for directly painting on the model and writing changes back into the active texture set.

- Brush cursor in the 3D viewport.
- Brush presets.
- Brush size and strength controls.
- Color picker with primary and secondary colors.
- `F` adjusts brush size.
- `Shift + F` adjusts brush strength.
- `X` swaps primary and secondary colors.
- Optional pen pressure toggle.
- Optional symmetry toggle.
- Painted changes are included when exporting renamed textures.

### Export Tools

The app keeps source files intact and exports renamed results.

- Export renamed textures as a ZIP.
- Preserve original file blobs when possible.
- Export texture names using the configured base name, channel, separator, UDIM, and extension settings.
- Choose whether the UDIM separator is `.` or `_`.
- Choose whether to include the file extension.
- Export updated texture paint changes.
- Export the edited model as OBJ.
- Exclude internal helper objects from model export.

## Validation

The app warns about common UDIM and texture organization problems:

- repeated UDIMs in the same channel
- missing tiles
- duplicated final export names
- normal maps in the wrong channel
- unsupported texture extensions

## Typical Workflow

1. Import a model from `File > Import Model`.
2. Import textures into the correct channel.
3. Reorder texture tiles in the UV/Image Editor.
4. Verify UDIM placement with the UV overlay.
5. Use the UV Layout Editor to select faces or islands if UV changes are needed.
6. Use Texture Projection / Image Ripper to prepare extra image patches.
7. Apply prepared projections to selected islands or faces.
8. Paint or adjust textures if needed.
9. Export renamed textures as a ZIP.
10. Export the edited model if UVs were changed.

## Tech Stack

- Vite
- React
- TypeScript
- Three.js
- @react-three/fiber
- @react-three/drei
- JSZip
- dnd-kit

## Local Development

```bash
pnpm install
pnpm dev
pnpm build
```

## GitHub Pages Deployment

This project supports two GitHub Pages deployment modes.

### Static Folder Deployment

Use this if you want GitHub Pages to read a ready-to-serve folder.

1. Run `pnpm build`.
2. Copy `dist/` into `docs/`.
3. Commit and push `docs/`.
4. In GitHub, open `Settings > Pages`.
5. Select `Deploy from a branch`.
6. Use branch `main` and folder `/docs`.

### GitHub Actions Deployment

Use this if you want GitHub to build and publish the app automatically.

1. In GitHub, open `Settings > Pages`.
2. Select `GitHub Actions` as the source.
3. Push to `main`.
4. The `Deploy GitHub Pages` workflow builds the app and publishes `dist`.

## Support

If you found this helpful and would like to support its development, you can buy me a coffee. Thank you so much for your support!

[https://paypal.me/waltDx](https://paypal.me/waltDx)
