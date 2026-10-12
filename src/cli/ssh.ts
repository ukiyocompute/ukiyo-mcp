import { execFile } from 'node:child_process';
import { constants, closeSync, fstatSync, lstatSync, mkdtempSync, openSync, unlinkSync, rmdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export type SshAccess = { host: string; port: number; username: string; privateKey: string };
export async function executeSsh(id: string, access: SshAccess, command: string[], timeout = 60, runner: typeof execFile = execFile): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(access.host) || !/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(access.username) ||
      !Number.isInteger(access.port) || access.port < 1 || access.port > 65535 || typeof access.privateKey !== 'string' || !access.privateKey.includes('PRIVATE KEY') ||
      !/^[a-zA-Z0-9-]+$/.test(id) || !command.length || command.some(arg => arg.includes('\0')) || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 3600) throw new Error('Invalid SSH connection, command, or timeout.');
  const directory = join(homedir(), '.ukiyo');
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe Ukiyo credential directory.');
  const knownHosts = join(directory, 'known_hosts');
  const fd = openSync(knownHosts, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try { const s = fstatSync(fd); if (!s.isFile() || (s.mode & 0o077) || (process.getuid && s.uid !== process.getuid())) throw new Error('Unsafe SSH known_hosts file.'); } finally { closeSync(fd); }
  const temp = mkdtempSync(join(tmpdir(), 'ukiyo-ssh-')); const keyFile = join(temp, 'identity');
  try {
    writeFileSync(keyFile, access.privateKey, { mode: 0o600, flag: 'wx' });
    const remote = command.map(arg => `'${arg.replaceAll("'", "'\\''")}'`).join(' ');
    const args = ['-F', '/dev/null', '-T', '-i', keyFile, '-p', String(access.port), '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
      '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=accept-new', '-o', `HostKeyAlias=ukiyo-${id}`,
      '-o', `UserKnownHostsFile="${knownHosts.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`, `${access.username}@${access.host}`, remote];
    return await new Promise((resolve, reject) => runner('ssh', args, { timeout: timeout * 1000, maxBuffer: 4 * 1024 * 1024, env: { PATH: process.env.PATH }, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') { reject(new Error(error.killed ? 'SSH command timed out.' : 'SSH transport failed. Check SSH availability and the deployment state.')); return; }
      resolve({ exitCode: error?.code as number ?? 0, stdout: String(stdout), stderr: String(stderr) });
    }));
  } finally { try { unlinkSync(keyFile); } finally { rmdirSync(temp); } }
}
