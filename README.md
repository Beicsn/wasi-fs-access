# wasi-fs-access (Memory File System Version)

## What

This is a demo shell powered by [WebAssembly](https://webassembly.org/), [WASI](https://wasi.dev/), [Asyncify](https://emscripten.org/docs/porting/asyncify.html) and an in-memory file system using [memfs-browser](https://github.com/streamich/memfs).

This version has been modified to use an in-memory file system instead of the browser's File System Access API, making it work in any browser without requiring special permissions.

You can access the live version here: https://wasi.rreverser.com/

Or watch a video showing some of the features: [![Youtube recording](https://user-images.githubusercontent.com/557590/95856904-b16b2300-0d52-11eb-9726-5ce4f2df7915.png)](https://youtu.be/qRmO-8b4WmE)

## How

It provides [WASI bindings implementation](https://github.com/GoogleChromeLabs/wasi-fs-access/blob/main/src/bindings.ts#LC511:~:text=getWasiImports()%20%7B) that proxies any filesystem requests to an in-memory filesystem. This allows apps built in languages like C, C++, Rust and others to be compiled to WebAssembly and work as usual within a browser sandbox, accessing and manipulating files in memory.

Since WASI APIs are synchronous by nature, but Web APIs are traditionally asynchronous to avoid blocking the main thread, Asyncify is used to bridge the two types of APIs together. Asyncify is a feature created as part of [Emscripten](https://emscripten.org/) and later extended to work with arbitrary WebAssembly files with the help of a [custom JavaScript wrapper](https://github.com/GoogleChromeLabs/asyncify).

A [Rust port of coreutils with some patches](https://github.com/RReverser/coreutils) was chosen for the demo purposes, but it should be possible to extract and reuse same bindings for any applications compiled for the WebAssembly + WASI target.

## Changes from Original

This version replaces the File System Access API with memfs-browser for the following benefits:

1. **Universal Browser Support**: Works in any modern browser without requiring File System Access API support
2. **No Permissions Required**: No need for user permission dialogs
3. **Faster Operations**: In-memory operations are typically faster than disk I/O
4. **Isolated Environment**: Perfect for testing and sandboxed environments

### Key Modifications

- **memfs-adapter.ts**: New adapter layer that provides FileSystemHandle-like interface for memfs
- **fileSystem.ts**: Updated to use the new memfs adapter
- **browser.ts**: Modified to use in-memory file system instead of File System Access API
- **test.ts**: Updated test runner to use memory file system

### Pre-populated Files

The memory file system comes with some pre-populated test files:
- `/sandbox/input.txt` - contains "hello from input.txt"
- `/sandbox/input2.txt` - contains "hello from input2.txt"
- `/sandbox/notadir` - a regular file for testing

### Want to learn more?

Read up a blog post about Asyncify: https://web.dev/asyncify/

Or check out my presentation from the [WebAssembly Live!](https://webassembly.live/) here: https://www.slideshare.net/RReverser/asyncifying-webassembly-for-the-modern-web

And / or the talk: https://youtu.be/pzIJYAbcbf8?t=82