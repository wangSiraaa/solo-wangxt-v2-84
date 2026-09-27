/** Thin OPFS (Origin Private File System) helpers.
 *
 * OPFS stores the working copy of imported bytes. It is part of the browser
 * origin's private storage: nothing is uploaded and other sites cannot read
 * it.
 *
 * Main-thread code uses the async FileSystemFileHandle APIs (createWritable /
 * getFile); createSyncAccessHandle is only available inside workers (where
 * DuckDB-Wasm itself opens the registered handles).
 */

export async function opfsRoot(): Promise<FileSystemDirectoryHandle> {
  return await navigator.storage.getDirectory();
}

async function resolveDir(
  root: FileSystemDirectoryHandle,
  path: string,
  create: boolean,
): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
  const parts = path.split('/');
  let dir: FileSystemDirectoryHandle = root;
  for (let i = 0; i < parts.length - 1; i++) {
    dir = await dir.getDirectoryHandle(parts[i], { create });
  }
  return { dir, name: parts[parts.length - 1] };
}

async function getHandle(path: string, create: boolean): Promise<FileSystemFileHandle> {
  const root = await opfsRoot();
  const { dir, name } = await resolveDir(root, path, create);
  return await dir.getFileHandle(name, { create });
}

/** Write bytes to an OPFS path (creates parent directories and truncates). */
export async function opfsWrite(path: string, data: Uint8Array): Promise<void> {
  const handle = await getHandle(path, true);
  const writable = await handle.createWritable();
  try {
    // Blob accepts any ArrayBufferView (avoids the ArrayBuffer vs Shared type friction).
    await writable.write(new Blob([data as BlobPart]));
  } finally {
    await writable.close();
  }
}

export async function opfsExists(path: string): Promise<boolean> {
  try {
    await getHandle(path, false);
    return true;
  } catch {
    return false;
  }
}

export async function opfsRead(path: string): Promise<Uint8Array | null> {
  try {
    const handle = await getHandle(path, false);
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
}

export async function opfsDelete(path: string): Promise<void> {
  const root = await opfsRoot();
  const { dir, name } = await resolveDir(root, path, false);
  await dir.removeEntry(name);
}

/** A FileSystemFileHandle for DuckDB-Wasm BROWSER_FSACCESS registration. */
export async function opfsFileHandle(path: string): Promise<FileSystemFileHandle> {
  return getHandle(path, false);
}
