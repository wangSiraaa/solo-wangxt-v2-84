/**
 * OPFS（Origin Private File System）：存放导入文件的字节副本。
 * 这样刷新页面后可以从浏览器自己的存储恢复工作文件，
 * 而不需要重新读取用户磁盘上的原始文件（浏览器也无权在未授权时这么做）。
 */

export const OPFS_DIR = 'research-joiner';

let dirPromise: Promise<FileSystemDirectoryHandle> | null = null;

export function opfsSupported(): boolean {
  try {
    return (
      typeof navigator !== 'undefined' &&
      !!navigator.storage &&
      typeof (navigator.storage as { getDirectory?: unknown }).getDirectory === 'function'
    );
  } catch {
    return false;
  }
}

function workDir(): Promise<FileSystemDirectoryHandle> {
  if (!dirPromise) {
    dirPromise = (async () => {
      const storage = navigator.storage as unknown as {
        getDirectory: () => Promise<FileSystemDirectoryHandle>;
      };
      const root = await storage.getDirectory();
      return root.getDirectoryHandle(OPFS_DIR, { create: true });
    })();
  }
  return dirPromise;
}

/** 写入（或覆盖）一个工作文件，返回句柄 */
export async function opfsWrite(name: string, bytes: Uint8Array): Promise<FileSystemFileHandle> {
  const dir = await workDir();
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await (
    handle as unknown as {
      createWritable: () => Promise<{
        write: (data: Uint8Array) => Promise<void>;
        close: () => Promise<void>;
      }>;
    }
  ).createWritable();
  await writable.write(bytes);
  await writable.close();
  return handle;
}

/** 打开已有工作文件；不存在返回 null */
export async function opfsOpen(name: string): Promise<FileSystemFileHandle | null> {
  try {
    const dir = await workDir();
    return await dir.getFileHandle(name, { create: false });
  } catch {
    return null;
  }
}

export async function opfsReadBytes(name: string): Promise<Uint8Array | null> {
  const handle = await opfsOpen(name);
  if (!handle) return null;
  const file = await handle.getFile();
  const buf = await file.arrayBuffer();
  return new Uint8Array(buf);
}

export async function opfsDelete(name: string): Promise<void> {
  try {
    const dir = await workDir();
    await dir.removeEntry(name);
  } catch {
    // 不存在则忽略
  }
}
