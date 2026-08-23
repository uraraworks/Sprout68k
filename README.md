# Sprout68k

[日本語](README.ja.md)

Sprout68k is a browser-only beginner environment for writing X68000 programs in
C. No install and no account are needed — the C compiler itself runs inside
the browser. Write, build, and run against a bundled px68k emulator on the
same page. What you build can be shared with a link (the recipient does not
need a compiler).

See [docs/DESIGN.md](docs/DESIGN.md) (Japanese) for design, implementation and
measurement records.

## Try it now

- **App**: <https://uraraworks.github.io/Sprout68k/ide/>
- **About Sprout68k**: <https://uraraworks.github.io/Sprout68k/ide/about.html>
- **Samples**: <https://uraraworks.github.io/Sprout68k/ide/samples.html>
- **Function reference**: <https://uraraworks.github.io/Sprout68k/ide/reference.html>
- **Help**: <https://uraraworks.github.io/Sprout68k/ide/help.html>

## Usage

The IDE has three panes: a file tree, a CodeMirror-based C editor, and a
px68k execution screen.

- **Edit and save**: sources are saved to the browser's IndexedDB
  (`Sprout68kProjectFS`) as you work; nothing is uploaded anywhere.
- **Build**: the toolbar's Build button runs a wasm build of GCC / binutils
  inside the browser and links your source against the bundled learning
  library and boot sector. Compiler and linker diagnostics are shown with a
  Japanese annotation layer ("what happened" / "what to do next") stacked
  above the original GCC/ld text, which is never removed.
- **Run**: Run/Stop is a single toggle. Each run tears down and recreates the
  emulator (`runFresh()`) so a runaway previous execution is never carried
  over; your edited source is never touched by a run.
- **Download**: the built disk image can be downloaded as a `.xdf` file.
- **Share links**: the toolbar's share dialog can create two kinds of link —
  a "play" link that opens the built binary in WebX68k (no source included),
  and a "read/fix" link that opens in Sprout68k's editor with the source
  itself, so the recipient can open and modify it. Links created through the
  MCP server are always tagged as AI-assisted.
- **Offline**: a Service Worker precaches the IDE, the px68k core, and the
  wasm toolchain, so once loaded once online, write → build → run keeps
  working after the server (or your network) goes away.

## MCP support

`mcp/` contains an MCP server. It builds and runs entirely inside Node,
**without a browser**, so an AI agent can:

- `api_reference` — list the 29 functions available in this environment, with
  descriptions, arguments, working examples, and common pitfalls
- `build` — build the program and return diagnostics with Japanese annotations
- `run` — actually run it and return the text screen, a **PNG of the
  screen**, and the number of drawn pixels
- `share_link` — create a share URL (**always tagged `ai`**)

```bash
npm install --prefix mcp
claude mcp add sprout68k --env PATH="$HOME/x68kdev-toolchain/bin:$PATH" -- node "$PWD/mcp/server.mjs"
```

Prerequisites (Node 22+, a gcc 13.4.0 toolchain), how to check connectivity,
and troubleshooting are in [`mcp/README.md`](mcp/README.md). You can hand
that page to an agent and have it set itself up from there.

## Bundled ROM / disk images

The bundled IPL ROM and character ROM data each carry their own separate
license and attribution. See
[`ide/system/IPLROM-LICENSE.txt`](ide/system/IPLROM-LICENSE.txt) and
[`ide/system/CGROM-NOTICE.md`](ide/system/CGROM-NOTICE.md).

## License and provenance

Sprout68k as a whole is released under GNU GPL version 2; the license text is
in [`COPYING`](COPYING). The px68k-libretro core and host layer bundled with
the IDE are also GPLv2. The core is built from URARA-works'
[`px68k-libretro` emscripten branch](https://github.com/uraraworks/px68k-libretro/tree/emscripten),
upstream of which is
[`libretro/px68k-libretro`](https://github.com/libretro/px68k-libretro); the
corresponding source for both is available from those repositories. The
bundled binary and host layer were brought in from
[`WebX68k`](https://github.com/uraraworks/WebX68k); the core rebuild
procedure lives in that repository's
[`scripts/build-core.sh`](https://github.com/uraraworks/WebX68k/blob/main/scripts/build-core.sh).

The IDE shell is based on the same author's (URARA-works) MIT-licensed
[`WorkbenchNP2`](https://github.com/uraraworks/WorkbenchNP2). CodeMirror is
also MIT-licensed; its license text is at
[`ide/vendor/codemirror/LICENSE.CodeMirror`](ide/vendor/codemirror/LICENSE.CodeMirror).

## Contributing

**The test for any submission is: could someone else get the same kind of
information by measuring it themselves on an emulator or real hardware?**
Disassembly output, ROM internals, and other information that cannot be
obtained by independent measurement are not accepted. Matching submissions
are closed **without reading the body**. Before opening an Issue, Pull
Request, review comment, or replying on social media, read
[`CONTRIBUTING.md`](CONTRIBUTING.md) for the reasoning and what kinds of
information are acceptable.

## Implemented features

- A bootable `.xdf` toolchain: hand-built boot sector, C crt0/IOCS stubs, and
  a native `m68k-elf-gcc` build path, verified stage by stage (Stage A string
  display, Stage B single-color fill, Stage C native C program boot, Stage D
  multi-track/side disk loading up to a full disk).
- A first-version learning library (L0, a standard-name layer, and L1 screen
  functions) and a Breakout sample program.
- A browser-side wasm build of the same GCC/binutils toolchain (cc1, as, ld,
  objcopy), verified byte-identical against the native toolchain's output for
  both Stage C and Breakout.
- A three-pane browser IDE (editor, file tree, px68k execution screen) built
  on WorkbenchNP2: CodeMirror C editing, IndexedDB project storage, one-click
  in-browser build of a user source file, Japanese-annotated compiler/linker
  diagnostics, `.xdf` download, and in-page px68k execution.
- Play and source share links, an offline-capable Service Worker with
  integrity-checked precaching, and a Node-only MCP server for building and
  running from AI agents.

## Known limitations

- No syntax highlighting for m68k assembler, and no source-line debugging for
  68k assembly.
- Verified only on one Chromium-based browser; Safari and Firefox have not
  been measured, so cross-browser compatibility is not confirmed.
