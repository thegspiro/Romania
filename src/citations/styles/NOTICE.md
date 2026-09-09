# Vendored Citation Style Language files

These files are **not** part of this project's source code. They are vendored,
unmodified, from the Citation Style Language project so that citation rendering
works offline and produces byte-identical output across deployments.

| File | Upstream | License |
| --- | --- | --- |
| `chicago-notes-bibliography.csl` | [citation-style-language/styles](https://github.com/citation-style-language/styles) | CC BY-SA 3.0 |
| `locales-en-US.xml` | [citation-style-language/locales](https://github.com/citation-style-language/locales) | CC BY-SA 3.0 |

The style currently vendored is **Chicago Manual of Style, 18th edition (notes
and bibliography)**.

## Updating

Do not hand-edit these files. Replace them from upstream:

```sh
cd src/citations/styles
curl -sSfL -o chicago-notes-bibliography.csl \
  https://raw.githubusercontent.com/citation-style-language/styles/master/chicago-notes-bibliography.csl
curl -sSfL -o locales-en-US.xml \
  https://raw.githubusercontent.com/citation-style-language/locales/master/locales-en-US.xml
```

Then run `npm test`. The citation fixture tests in `tests/unit/citations.test.ts`
exist to catch formatting changes introduced by a style update, so review any
resulting diffs deliberately rather than updating the expected strings on
autopilot — a changed expectation means every citation on the site changed too.
