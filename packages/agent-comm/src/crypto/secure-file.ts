import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

const MAX_PRIVATE_FILE_BYTES = 64 * 1024

function temporaryPath(targetPath: string): string {
  return join(dirname(targetPath), `.${basename(targetPath)}.${randomUUID()}.tmp`)
}

function writeTemporaryPrivateFile(targetPath: string, data: string): string {
  const parent = dirname(targetPath)
  // This API only receives operator-owned profile paths; they are not derived from relay or
  // channel input. Profile root/name validation happens in config.ts before this boundary.
  // codeql[js/path-injection]
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  const tempPath = temporaryPath(targetPath)
  // O_EXCL and O_NOFOLLOW prevent symlink replacement at the final filesystem boundary.
  // codeql[js/path-injection]
  const fd = openSync(
    tempPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    writeFileSync(fd, data, 'utf8')
    fchmodSync(fd, 0o600)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  return tempPath
}

export function readPrivateFile(path: string): string {
  // O_NOFOLLOW prevents an attacker from replacing a key with a symlink between validation and use.
  // Profile directories are private (0700); this operator-owned path is validated by config.ts.
  // codeql[js/path-injection]
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_PRIVATE_FILE_BYTES) {
      throw new Error('private file is not a regular file or is unexpectedly large')
    }
    fchmodSync(fd, 0o600)
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

/** Atomically replace a private file without ever following an existing destination symlink. */
export function replacePrivateFile(path: string, data: string): void {
  const tempPath = writeTemporaryPrivateFile(path, data)
  let failure: unknown
  try {
    // Both paths are internal derivatives of the validated operator-owned profile path.
    // codeql[js/path-injection]
    renameSync(tempPath, path)
  } catch (err) {
    failure = err
  }
  try {
    // The random temporary path was created above with O_EXCL inside the private profile directory.
    // codeql[js/path-injection]
    unlinkSync(tempPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT' && failure === undefined) failure = err
  }
  if (failure !== undefined) throw failure
}

/** Atomically create a private file. Returns false when another process created it first. */
export function createPrivateFile(path: string, data: string): boolean {
  const tempPath = writeTemporaryPrivateFile(path, data)
  let created = false
  let failure: unknown
  try {
    // Both paths are internal derivatives of the validated operator-owned profile path.
    // codeql[js/path-injection]
    linkSync(tempPath, path)
    created = true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') failure = err
  }
  try {
    // The random temporary path was created above with O_EXCL inside the private profile directory.
    // codeql[js/path-injection]
    unlinkSync(tempPath)
  } catch (err) {
    if (failure === undefined) failure = err
  }
  if (failure !== undefined) throw failure
  return created
}
