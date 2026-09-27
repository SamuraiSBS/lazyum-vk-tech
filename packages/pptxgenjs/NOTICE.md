# Vendored PptxGenJS

This package vendors the CJS runtime and TypeScript declarations from PptxGenJS
4.0.1, distributed under the MIT License in `LICENSE`.

The upstream package declares `image-size`, but the vendored CJS runtime does
not import or execute it: its sole reference is in a commented-out helper.
StudyDeck supplies image sizing and validation through `sharp`, before data is
passed to the presentation generator.  Keeping the unused, vulnerable parser in
the production dependency graph would therefore add attack surface without any
runtime function.
