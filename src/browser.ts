// Copyright 2020 Google Inc. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { IDisposable } from 'xterm';
import Bindings, { OpenFlags, stringOut } from './bindings.js';
import { FileOrDir, OpenFiles } from './fileSystem.js';
import { createMemoryFileSystem, MemfsDirectoryHandle } from './memfs-adapter.js';

declare const Terminal: typeof import('xterm').Terminal;
declare const LocalEchoController: any;
declare const FitAddon: typeof import('xterm-addon-fit');
declare const WebLinksAddon: typeof import('xterm-addon-web-links');

(async () => {
  let term = new Terminal();

  let fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);

  let localEcho = new LocalEchoController();
  let knownCommands = ['help', 'mount', 'cd', 'ls', 'cat', 'mkdir', 'touch', 'rm'];
  localEcho.addAutocompleteHandler((index: number): string[] =>
    index === 0 ? knownCommands : []
  );
  {
    let storedHistory = localStorage.getItem('command-history');
    if (storedHistory) {
      localEcho.history.entries = storedHistory.split('\n');
      localEcho.history.rewind();
    }
  }
  term.loadAddon(localEcho);

  term.loadAddon(new WebLinksAddon.WebLinksAddon());

  term.open(document.body);
  fitAddon.fit();
  onresize = () => fitAddon.fit();

  const ANSI_GRAY = '\x1B[38;5;251m';
  const ANSI_BLUE = '\x1B[34;1m';
  const ANSI_RESET = '\x1B[0m';

  function writeIndented(s: string) {
    term.write(
      s
        .trimStart()
        .replace(/\n +/g, '\r\n')
        .replace(/https:\S+/g, ANSI_BLUE + '$&' + ANSI_RESET)
        .replace(/^#.*$/gm, ANSI_GRAY + '$&' + ANSI_RESET)
    );
  }

  writeIndented(`
    # Welcome to a shell powered by WebAssembly, WASI, Asyncify and In-Memory File System!
    # This version uses memfs-browser for in-memory file operations
    # Github repo: https://github.com/GoogleChromeLabs/wasi-fs-access

  `);

  const module = WebAssembly.compileStreaming(fetch('./coreutils.async.wasm'));

  // This is just for the autocomplete, so spawn the task and ignore any errors.
  (async () => {
    let helpStr = '';

    await new Bindings({
      openFiles: new OpenFiles({}),
      args: ['--help'],
      stdout: stringOut(chunk => (helpStr += chunk))
    }).run(await module);

    knownCommands = knownCommands.concat(
      helpStr
        .match(/Currently defined functions\/utilities:(.*)/s)?.[1]
        ?.match(/[\w-]+/g) || []
    );
  })();

  writeIndented(`
    # You now have access to an in-memory file system with the following structure:
    $ df -a
    Filesystem          1k-blocks         Used    Available  Use% Mounted on
    memfs                       0            0            0     - /sandbox
    memfs                       0            0            0     - /tmp

    # Pre-populated files:
    # /sandbox/input.txt - contains "hello from input.txt"
    # /sandbox/input2.txt - contains "hello from input2.txt"
    # /sandbox/notadir - a regular file for testing

    # You can create new directories and files:
    $ mkdir /sandbox/mydir
    $ touch /sandbox/myfile.txt

    # To view a list of other commands, use
    $ help

    # Happy hacking with in-memory file system!
  `);

  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();

  const stdin = {
    async read() {
      let onData: IDisposable;
      let line = '';
      try {
        await new Promise<void>(resolve => {
          onData = term.onData(s => {
            // Ctrl+D
            if (s === '\x04') {
              term.writeln('^D');
              return resolve();
            }
            // Enter
            if (s === '\r') {
              term.writeln('');
              line += '\n';
              return resolve();
            }
            // Ignore other functional keys
            if (s.charCodeAt(0) < 32) {
              return;
            }
            // Backspace
            if (s === '\x7F') {
              term.write('\b \b');
              line = line.slice(0, -1);
              return;
            }
            term.write(s);
            line += s;
          });
        });
      } finally {
        onData!.dispose();
      }
      return textEncoder.encode(line);
    }
  };

  const stdout = {
    write(data: Uint8Array) {
      term.write(
        textDecoder.decode(data, { stream: true }).replaceAll('\n', '\r\n')
      );
    }
  };

  const cmdParser = /(?:'(.*?)'|"(.*?)"|(\S+))\s*/gsuy;

  // 创建内存文件系统
  const rootFs = createMemoryFileSystem();
  let preOpens: Record<string, MemfsDirectoryHandle> = {};
  preOpens['/sandbox'] = await rootFs.getDirectoryHandle('sandbox');
  preOpens['/tmp'] = await rootFs.getDirectoryHandle('tmp');

  let pwd = '/sandbox';

  while (true) {
    let line: string = await localEcho.read(`${pwd}$ `);
    localEcho.history.rewind();
    localStorage.setItem(
      'command-history',
      localEcho.history.entries.join('\n')
    );
    let args = Array.from(
      line.matchAll(cmdParser),
      ([, s1, s2, s3]) => s1 ?? s2 ?? s3
    );
    try {
      if (!args.length) {
        continue;
      }
      switch (args[0]) {
        case 'help':
          args[0] = '--help';
          break;
        case 'mount': {
          term.writeln(
            'Mount command is not available in memory file system mode.'
          );
          term.writeln(
            'All files are stored in memory. Use mkdir to create directories.'
          );
          continue;
        }
        case 'cd': {
          let dest = args[1];
          if (dest) {
            // Resolve against the current working dir.
            dest = new URL(dest, `file://${pwd}/`).pathname;
            if (dest.endsWith('/')) {
              dest = dest.slice(0, -1) || '/';
            }
            let openFiles = new OpenFiles(preOpens);
            let { preOpen, relativePath } = openFiles.findRelPath(dest);
            await preOpen.getFileOrDir(
              relativePath,
              FileOrDir.Dir,
              OpenFlags.Directory
            );
            // We got here without failing, set the new working dir.
            pwd = dest;
          } else {
            term.writeln('Provide the directory argument.');
          }
          continue;
        }
      }
      let openFiles = new OpenFiles(preOpens);
      let redirectedStdout;
      if (['>', '>>'].includes(args[args.length - 2])) {
        let path = args.pop()!;
        // Resolve against the current working dir.
        path = new URL(path, `file://${pwd}/`).pathname;
        let { preOpen, relativePath } = openFiles.findRelPath(path);
        let handle = await preOpen.getFileOrDir(
          relativePath,
          FileOrDir.File,
          OpenFlags.Create
        );
        if (args.pop() === '>') {
          redirectedStdout = await handle.createWritable();
        } else {
          redirectedStdout = await handle.createWritable({ keepExistingData: true });
          redirectedStdout.seek((await handle.getFile()).size);
        }
      }
      localEcho.detach();
      let abortController = new AbortController();
      let ctrlCHandler = term.onData(s => {
        if (s === '\x03') {
          term.write('^C');
          abortController.abort();
        }
      });
      try {
        let statusCode = await new Bindings({
          abortSignal: abortController.signal,
          openFiles,
          stdin,
          stdout: redirectedStdout ?? stdout,
          stderr: stdout,
          args: ['$', ...args],
          env: {
            RUST_BACKTRACE: '1',
            PWD: pwd
          }
        }).run(await module);
        if (statusCode !== 0) {
          term.writeln(`Exit code: ${statusCode}`);
        }
      } finally {
        ctrlCHandler.dispose();
        localEcho.attach();
        if (redirectedStdout) {
          await redirectedStdout.close();
        }
      }
    } catch (err) {
      term.writeln((err as Error).message);
    }
  }
})();