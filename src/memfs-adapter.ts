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

import { Volume } from 'memfs-browser';
import { SystemError, E } from './bindings.js';

// 适配器类，将 memfs 的接口适配为类似 FileSystemHandle 的接口
export class MemfsFileHandle {
  constructor(
    private volume: Volume,
    private path: string
  ) {}

  get kind(): 'file' {
    return 'file';
  }

  get name(): string {
    return this.path.split('/').pop() || '';
  }

  get isFile(): true {
    return true;
  }

  get isDirectory(): false {
    return false;
  }

  async getFile(): Promise<File> {
    try {
      const data = this.volume.readFileSync(this.path) as Buffer;
      const stats = this.volume.statSync(this.path);
      
      return new File([data], this.name, {
        lastModified: stats.mtime.getTime(),
        type: 'application/octet-stream'
      });
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        throw new DOMException('File not found', 'NotFoundError');
      }
      throw err;
    }
  }

  async createWritable(options: { keepExistingData?: boolean } = {}): Promise<MemfsWritableFileStream> {
    return new MemfsWritableFileStream(this.volume, this.path, options.keepExistingData);
  }
}

export class MemfsDirectoryHandle {
  constructor(
    private volume: Volume,
    private path: string
  ) {}

  get kind(): 'directory' {
    return 'directory';
  }

  get name(): string {
    return this.path.split('/').pop() || '';
  }

  get isFile(): false {
    return false;
  }

  get isDirectory(): true {
    return true;
  }

  async getFileHandle(name: string, options: { create?: boolean } = {}): Promise<MemfsFileHandle> {
    const filePath = this.path === '/' ? `/${name}` : `${this.path}/${name}`;
    
    try {
      const stats = this.volume.statSync(filePath);
      if (stats.isDirectory()) {
        throw new DOMException('Path is a directory', 'TypeMismatchError');
      }
      return new MemfsFileHandle(this.volume, filePath);
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        if (options.create) {
          // 创建空文件
          this.volume.writeFileSync(filePath, '');
          return new MemfsFileHandle(this.volume, filePath);
        }
        throw new DOMException('File not found', 'NotFoundError');
      }
      throw err;
    }
  }

  async getDirectoryHandle(name: string, options: { create?: boolean } = {}): Promise<MemfsDirectoryHandle> {
    const dirPath = this.path === '/' ? `/${name}` : `${this.path}/${name}`;
    
    try {
      const stats = this.volume.statSync(dirPath);
      if (!stats.isDirectory()) {
        throw new DOMException('Path is not a directory', 'TypeMismatchError');
      }
      return new MemfsDirectoryHandle(this.volume, dirPath);
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        if (options.create) {
          this.volume.mkdirSync(dirPath, { recursive: true });
          return new MemfsDirectoryHandle(this.volume, dirPath);
        }
        throw new DOMException('Directory not found', 'NotFoundError');
      }
      throw err;
    }
  }

  async removeEntry(name: string, options: { recursive?: boolean } = {}): Promise<void> {
    const entryPath = this.path === '/' ? `/${name}` : `${this.path}/${name}`;
    
    try {
      const stats = this.volume.statSync(entryPath);
      if (stats.isDirectory()) {
        if (options.recursive) {
          this.volume.rmSync(entryPath, { recursive: true, force: true });
        } else {
          this.volume.rmdirSync(entryPath);
        }
      } else {
        this.volume.unlinkSync(entryPath);
      }
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        throw new DOMException('Entry not found', 'NotFoundError');
      }
      if (err.code === 'ENOTEMPTY') {
        throw new DOMException('Directory not empty', 'InvalidModificationError');
      }
      throw err;
    }
  }

  async *values(): AsyncIterableIterator<MemfsFileHandle | MemfsDirectoryHandle> {
    try {
      const entries = this.volume.readdirSync(this.path);
      for (const entry of entries) {
        const entryPath = this.path === '/' ? `/${entry}` : `${this.path}/${entry}`;
        const stats = this.volume.statSync(entryPath);
        
        if (stats.isDirectory()) {
          yield new MemfsDirectoryHandle(this.volume, entryPath);
        } else {
          yield new MemfsFileHandle(this.volume, entryPath);
        }
      }
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        throw new DOMException('Directory not found', 'NotFoundError');
      }
      throw err;
    }
  }

  async *keys(): AsyncIterableIterator<string> {
    try {
      const entries = this.volume.readdirSync(this.path);
      for (const entry of entries) {
        yield entry as string;
      }
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        throw new DOMException('Directory not found', 'NotFoundError');
      }
      throw err;
    }
  }
}

class MemfsWritableFileStream {
  private data: Uint8Array = new Uint8Array();
  private position: number = 0;
  private closed: boolean = false;

  constructor(
    private volume: Volume,
    private path: string,
    keepExistingData: boolean = false
  ) {
    if (keepExistingData) {
      try {
        const existing = this.volume.readFileSync(this.path) as Buffer;
        this.data = new Uint8Array(existing);
        this.position = this.data.length;
      } catch (err: any) {
        if (err.code !== 'ENOENT') {
          throw err;
        }
      }
    }
  }

  async write(data: { type: 'write'; position?: number; data: Uint8Array } | Uint8Array): Promise<void> {
    if (this.closed) {
      throw new Error('Stream is closed');
    }

    let writeData: Uint8Array;
    let writePosition: number;

    if (data instanceof Uint8Array) {
      writeData = data;
      writePosition = this.position;
    } else {
      writeData = data.data;
      writePosition = data.position ?? this.position;
    }

    // 扩展数据数组如果需要
    const requiredSize = writePosition + writeData.length;
    if (requiredSize > this.data.length) {
      const newData = new Uint8Array(requiredSize);
      newData.set(this.data);
      this.data = newData;
    }

    // 写入数据
    this.data.set(writeData, writePosition);
    this.position = writePosition + writeData.length;
  }

  async seek(position: number): Promise<void> {
    if (this.closed) {
      throw new Error('Stream is closed');
    }
    this.position = position;
  }

  async truncate(size: number): Promise<void> {
    if (this.closed) {
      throw new Error('Stream is closed');
    }
    
    if (size < this.data.length) {
      this.data = this.data.slice(0, size);
    } else if (size > this.data.length) {
      const newData = new Uint8Array(size);
      newData.set(this.data);
      this.data = newData;
    }
    
    if (this.position > size) {
      this.position = size;
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    
    this.closed = true;
    
    // 确保目录存在
    const dir = this.path.substring(0, this.path.lastIndexOf('/'));
    if (dir && dir !== '/') {
      try {
        this.volume.mkdirSync(dir, { recursive: true });
      } catch (err: any) {
        if (err.code !== 'EEXIST') {
          throw err;
        }
      }
    }
    
    // 写入文件
    this.volume.writeFileSync(this.path, Buffer.from(this.data));
  }
}

// 创建内存文件系统实例
export function createMemoryFileSystem(): MemfsDirectoryHandle {
  const volume = new Volume();
  
  // 创建基本目录结构
  volume.mkdirSync('/sandbox', { recursive: true });
  volume.mkdirSync('/tmp', { recursive: true });
  
  // 创建一些测试文件
  volume.writeFileSync('/sandbox/input.txt', 'hello from input.txt\n');
  volume.writeFileSync('/sandbox/input2.txt', 'hello from input2.txt\n');
  volume.writeFileSync('/sandbox/notadir', '');
  
  return new MemfsDirectoryHandle(volume, '/');
}