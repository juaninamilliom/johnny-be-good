# Architecture images

The README embeds `architecture.png` and `app-integration.png`. The corresponding SVG files are the editable sources. Update both source and rendered PNG in the same change when the architecture changes.

Images are 1800 × 1140. Export the SVGs through an SVG-capable renderer, keeping the declared canvas size, then inspect the PNGs for clipping, overlapping labels and misleading arrow direction. Generating documentation images does not require building the application. No image-rendering dependency is part of the evaluation runtime.
