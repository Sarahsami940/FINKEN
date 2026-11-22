/**
 * Passwords: hashed with scrypt, which is slow and memory-hungry on purpose
 * so that a stolen database cannot be cracked quickly. Each password has its
 * own random salt. The hash cannot be turned back into the password, by
 * anyone, Finken included.
 *
 * Settings follow OWASP's guidance for scrypt (N=2^15, r=8, p=3, about
 * 32 MB and a few tens of milliseconds per check). They are stored with
 * each hash, so they can be raised later and old hashes still work: they
 * are re-hashed at the next sign-in.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const COST = { logN: 15, r: 8, p: 3 };
const KEY_BYTES = 32;

function derive(password: string, salt: Buffer, logN: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, KEY_BYTES, { N: 2 ** logN, r, p, maxmem: 256 * 2 ** logN * r }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

/** `scrypt$<logN>$<r>$<p>$<salt>$<hash>`, both in base64. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, COST.logN, COST.r, COST.p);
  return `scrypt$${COST.logN}$${COST.r}$${COST.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** Whether the password matches, and whether its hash should be redone with today's settings. */
export async function verifyPassword(password: string, stored: string): Promise<{ ok: boolean; rehash: boolean }> {
  const [kind, logN, r, p, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hash) return { ok: false, rehash: false };
  const expected = Buffer.from(hash, 'base64');
  const key = await derive(password, Buffer.from(salt, 'base64'), Number(logN), Number(r), Number(p));
  const ok = key.length === expected.length && timingSafeEqual(key, expected);
  return { ok, rehash: ok && (Number(logN) !== COST.logN || Number(r) !== COST.r || Number(p) !== COST.p) };
}

/** A hash of a password nobody has, checked when an email is unknown, so a wrong email takes as long as a wrong password. */
let decoy: Promise<string> | null = null;
export async function spendTimeAsIfChecking(password: string): Promise<void> {
  decoy ??= hashPassword(randomBytes(16).toString('hex'));
  await verifyPassword(password, await decoy);
}

export const MIN_PASSWORD = 10;
export const MAX_PASSWORD = 128;

/**
 * Passwords people pick most often, and the ones made from "finken" itself.
 * Long lists of breached passwords would catch more; this catches the worst.
 */
const COMMON = new Set(
  [
    '1234567890',
    '0123456789',
    '12345678910',
    '0987654321',
    '1111111111',
    '0000000000',
    '1q2w3e4r5t',
    'qwertyuiop',
    'asdfghjkl;',
    'qwerty12345',
    'qwerty123456',
    'password123',
    'password1234',
    'password12345',
    'passw0rd123',
    'p@ssw0rd123',
    'iloveyou123',
    'welcome123',
    'welcome1234',
    'letmein1234',
    'abc1234567',
    'abcd123456',
    'abcdefghij',
    'admin12345',
    'administrator',
    'football123',
    'princess123',
    'sunshine123',
    'pakistan123',
    'pakistan1947',
    'pakistan786',
    'lahore12345',
    'karachi123',
    'islamabad123',
    'bismillah123',
    'allah12345',
    'muhammad123',
    'pakistanzindabad',
    'finken12345',
    'finken123456',
    'finkenfinken',
    'mypassword1',
    'changeme123',
    'computer123',
    'internet123',
    'superman123',
    'starwars123',
    'baseball123',
    'trustno1234',
    'whatever123',
    'qazwsxedcrfv',
    'zaq12wsxcde3',
    '1qaz2wsx3edc',
    'aaaaaaaaaa',
    'qwertyqwerty',
    '1234512345',
    '123123123123',
    '12341234',
    'monkey12345',
    'dragon12345',
    'master12345',
  ].map((p) => p.toLowerCase()),
);

/** Why a new password will not do, in words to show; null when it is fine. */
export function passwordProblem(password: string, about: { email?: string; name?: string } = {}): string | null {
  if (password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (password.length > MAX_PASSWORD) return `Use at most ${MAX_PASSWORD} characters.`;
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || /^(.)\1+$/.test(password) || /^(?:0123456789|1234567890|9876543210)+\d*$/.test(password)) {
    return 'That password is too easy to guess. Try a few unrelated words together.';
  }
  const local = about.email?.split('@')[0]?.toLowerCase();
  if ((about.email && lower === about.email.toLowerCase()) || (local && local.length >= 4 && lower.includes(local))) return 'Do not use your email address in your password.';
  if (about.name && about.name.trim().length >= 4 && lower.includes(about.name.trim().toLowerCase())) return 'Do not use your name in your password.';
  return null;
}
