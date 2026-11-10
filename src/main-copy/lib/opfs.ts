import { clearFileBlobs, deleteFileBlob, getAllFileBlobNames, getFileBlob, requestPersistentStorage, saveFileBlob } from './idb'

const MEDIA_DIR = 'media-files'

async function getRoot(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory()
  try {
    return await root.getDirectoryHandle(MEDIA_DIR)
  } catch {
    return await root.getDirectoryHandle(MEDIA_DIR, { create: true })
  }
}

export async function saveFileToOPFS(fileName: string, file: File): Promise<void> {
  try { await requestPersistentStorage() } catch { /* ignore */ }
  try {
    const dir = await getRoot()
    const fileHandle = await dir.getFileHandle(fileName, { create: true })
    const writable = await fileHandle.createWritable()
    await writable.write(file)
    await writable.close()
  } catch (error) {
    console.warn('OPFS save failed; falling back to IndexedDB file storage:', error)
    await saveFileBlob(fileName, file)
  }
}

export async function getFileFromOPFS(fileName: string): Promise<File | null> {
  try {
    const dir = await getRoot()
    const fileHandle = await dir.getFileHandle(fileName)
    return await fileHandle.getFile()
  } catch {
    return (await getFileBlob(fileName)) ?? null
  }
}

export async function getFileURLFromOPFS(fileName: string): Promise<string | null> {
  const file = await getFileFromOPFS(fileName)
  if (!file) return null
  return URL.createObjectURL(file)
}

export async function deleteFileFromOPFS(fileName: string): Promise<void> {
  try {
    const dir = await getRoot()
    await dir.removeEntry(fileName)
  } catch {
    // file didn't exist, ignore
  }
  await deleteFileBlob(fileName)
}

export async function clearOPFS(): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory()
    await root.removeEntry(MEDIA_DIR, { recursive: true })
  } catch {
    // dir didn't exist, ignore
  }
  await clearFileBlobs()
}

export async function listFilesInOPFS(): Promise<string[]> {
  try {
    const dir = await getRoot()
    const files: string[] = []
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'file') {
        files.push(name)
      }
    }
    return files
  } catch {
    return getAllFileBlobNames()
  }
}

export async function debugOPFS(): Promise<void> {
  const files = await listFilesInOPFS()
  if (files.length === 0) {
    console.log('OPFS is empty — no files stored.')
    return
  }
  console.group(`OPFS: ${files.length} file(s) stored`)
  for (const name of files) {
    const file = await getFileFromOPFS(name)
    if (file) {
      const sizeMB = (file.size / (1024 * 1024)).toFixed(2)
      console.log(`${name} — ${sizeMB} MB`)
    }
  }
  console.groupEnd()
}

// Expose to browser console: type `debugOPFS()` in DevTools
if (typeof window !== 'undefined') {
  (window as any).debugOPFS = debugOPFS
}
