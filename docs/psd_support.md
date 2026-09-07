# PSD Support

This document describes the current state of PSD import support in DPaint-js.

## Supported

- PSD import.
- Basic PSD export.
- Standard PSD files with signature `8BPS` and version `1`.
- 8-bit per channel images.
- RGB color mode.
- Grayscale color mode.
- Layered PSD files.
- Layer names.
- Layer visibility.
- Layer opacity.
- Common layer blend modes where there is a close match in canvas compositing.
- Raw channel data (`compression = 0`).
- PackBits/RLE channel data (`compression = 1`).
- Composite image decoding.
- Layer image decoding with per-layer alpha channel when present.
- Layer placement using the PSD layer bounds.
- Export of the current frame as an 8-bit RGB PSD with layers.
- Export of layer names.
- Export of layer visibility.
- Export of layer opacity.
- Export of basic blend modes.
- Export of a merged composite image.
- Optional PackBits/RLE compression when exporting PSD.

## Not Supported
- PSB large document files.
- Indexed color PSD files.
- CMYK, Lab, Duotone, Multichannel, Bitmap mode, and other non-RGB/non-grayscale modes.
- 16-bit and 32-bit channel depth PSD files.
- ZIP-compressed PSD image data.
- Vector layers.
- Text layers as editable text.
- Smart objects.
- Adjustment layers as editable adjustments.
- Layer effects.
- Clipping masks.
- Layer masks and vector masks.
- Channels beyond the basic image/layer color and transparency channels.
- Paths, guides, slices, and most image resource metadata.
- Full Photoshop group/folder behavior.
- Exact Photoshop blend behavior for modes that do not map 1:1 to browser canvas compositing.
- PSD animation export.
- PSD export with Photoshop-specific effects, masks, smart objects, editable text, or adjustment data.

## Current Behavior Notes

- PSD import is dependency-free and implemented with the app's existing binary stream utilities.
- The imported document becomes a normal DPaint-js layered image after loading.
- PSD export writes the active frame only.
- Unsupported PSD features are ignored where possible instead of aborting the entire import.
- If the merged composite image is present, it is decoded too, but the editor builds the document from the PSD layer data.
- Section divider records used for Photoshop layer groups are skipped, so only actual paintable layers are imported.
- PSD export can write either uncompressed channel data or PackBits/RLE-compressed channel data.

## Tested So Far

- Basic layered RGB PSD files.
- PSD files with a background layer plus one or more normal pixel layers.
- Files using raw and RLE compression.

## Good Next Steps

- Layer masks.
- Photoshop groups mapped to app layer grouping if the app gains that concept.
- More color modes.
- 16-bit import.
- Better coverage for Photoshop-specific blend modes.
