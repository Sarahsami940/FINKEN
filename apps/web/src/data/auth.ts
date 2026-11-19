/**
 * Authentication for the prototype.
 *
 * PROTOTYPE ONLY — this is not production security. Accounts live in this
 * browser's IndexedDB; there is no server, no email verification and no
 * password recovery. Passwords are stored as salted PBKDF2 hashes so they are
 * never kept in plain text, but anyone with access to this browser profile
 * can read or replace the stored data.
 *
 * The app depends only on the `AuthService` interface, so this class can be
 * replaced by a Firebase (or other) implementation without touching the UI.
 */
import type { ID, User } from '@finken/domain/types';
import type { Entity, StorageAdapter } from './storage';

export const GUEST_ID: ID = 'guest';

export interface RegistrationInput {
  name: string;
  email: string;
  password: string;
  confirmPassword: string;
}

export type RegistrationErrors = Partial<Record<keyof RegistrationInput, string>>;

/** A failure the user can act on; its message is safe to show as-is. */
export class AuthError extends Error {
  constructor(
    message: string,
    readonly field?: keyof RegistrationInput,
  ) {
    super(message);
  }
}

export interface AuthService {
  register(input: RegistrationInput): Promise<User>;
  login(email: string, password: string): Promise<User>;
  getUser(id: ID): Promise<User | null>;
  /** Returns the local guest profile, creating it on first use. */
  ensureGuest(): Promise<User>;
  updateUser(user: User): Promise<void>;
  removeUser(id: ID): Promise<void>;
}

export const MIN_PASSWORD_LENGTH = 8;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateRegistration(input: RegistrationInput): RegistrationErrors {
  const errors: RegistrationErrors = {};
  if (!input.name.trim()) errors.name = 'Enter your name.';
  if (!EMAIL_PATTERN.test(input.email.trim())) errors.email = 'Enter a valid email address.';
  if (input.password.length < MIN_PASSWORD_LENGTH) errors.password = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (input.confirmPassword !== input.password) errors.confirmPassword = 'The two passwords do not match.';
  return errors;
}

interface Credential extends Entity {
  /** Lower-cased, used for lookup. */
  email: string;
  salt: string;
  hash: string;
}

const ITERATIONS = 100_000;

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function hashPassword(password: string, salt: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new AuthError('Accounts need a secure page (https or localhost). You can still try Finken as a guest.');
  }
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromBase64(salt), iterations: ITERATIONS }, key, 256);
  return toBase64(new Uint8Array(bits));
}

export class LocalAuthService implements AuthService {
  constructor(private storage: StorageAdapter) {}

  private async credentialFor(email: string): Promise<Credential | undefined> {
    const wanted = email.trim().toLowerCase();
    return (await this.storage.getAll<Credential>('credentials')).find((c) => c.email === wanted);
  }

  async register(input: RegistrationInput): Promise<User> {
    const errors = validateRegistration(input);
    const [field] = Object.keys(errors) as (keyof RegistrationInput)[];
    if (field) throw new AuthError(errors[field]!, field);

    const email = input.email.trim();
    if (await this.credentialFor(email)) {
      throw new AuthError('An account with this email already exists on this device. Try logging in.', 'email');
    }
    const salt = toBase64(crypto.getRandomValues(new Uint8Array(16)));
    const hash = await hashPassword(input.password, salt);
    const user: User = { id: crypto.randomUUID(), name: input.name.trim(), email, isGuest: false };
    await this.storage.put('users', user);
    await this.storage.put<Credential>('credentials', { id: user.id, email: email.toLowerCase(), salt, hash });
    return user;
  }

  async login(email: string, password: string): Promise<User> {
    // One message for both cases, so the form does not reveal which emails exist.
    const failed = new AuthError('That email and password do not match an account on this device.');
    const credential = await this.credentialFor(email);
    if (!credential) throw failed;
    if ((await hashPassword(password, credential.salt)) !== credential.hash) throw failed;
    const user = await this.getUser(credential.id);
    if (!user) throw failed;
    return user;
  }

  async getUser(id: ID): Promise<User | null> {
    return (await this.storage.getAll<User>('users')).find((u) => u.id === id) ?? null;
  }

  async ensureGuest(): Promise<User> {
    const existing = await this.getUser(GUEST_ID);
    if (existing) return existing;
    const guest: User = { id: GUEST_ID, name: '', isGuest: true };
    await this.storage.put('users', guest);
    return guest;
  }

  updateUser(user: User): Promise<void> {
    return this.storage.put('users', user);
  }

  async removeUser(id: ID): Promise<void> {
    await this.storage.remove('users', id);
    await this.storage.remove('credentials', id);
  }
}
