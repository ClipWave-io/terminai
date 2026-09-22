import { randomBytes, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
export const ROLES = ['owner', 'admin', 'member', 'viewer'];
export const CLASSIFICATIONS = ['general', 'developer', 'analyst', 'marketing'];
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function requireThat(condition, status, message) { if (!condition) throw new HttpError(status, message); }
export const opaqueToken = () => randomBytes(32).toString('base64url');
export const digest = value => createHash('sha256').update(value).digest('hex');
export function safeEqual(a, b) { return typeof a === 'string' && typeof b === 'string' && timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b))); }
export function email(value) {
  requireThat(typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), 400, 'Enter a valid email address.');
  return value.trim().toLowerCase();
}
export function text(value, label, max = 200) {
  requireThat(typeof value === 'string' && value.trim().length > 0 && value.length <= max, 400, `${label} must contain 1–${max} characters.`);
  return value.trim();
}
export function enumValue(value, options, label) { requireThat(options.includes(value), 400, `Invalid ${label}.`); return value; }
export function uuid(value) { requireThat(typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value), 400, 'Invalid identifier.'); return value; }
export async function hashPassword(password) {
  requireThat(typeof password === 'string' && password.length >= 12 && Buffer.byteLength(password) <= 256, 400, 'Use a password of 12–256 bytes.');
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${salt}$${derived.toString('hex')}`;
}
// Constant-work invalid-user path avoids the easy password-hash timing oracle.
const DUMMY = `scrypt$${'0'.repeat(32)}$${'0'.repeat(128)}`;
export async function verifyPassword(password, encoded = DUMMY) {
  if (typeof password !== 'string' || Buffer.byteLength(password) > 256) return false;
  const [scheme, salt, expected] = encoded.split('$');
  if (scheme !== 'scrypt' || !/^[0-9a-f]{32}$/.test(salt) || !/^[0-9a-f]{128}$/.test(expected)) return false;
  const actual = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}
export const isAdmin = membership => ['owner', 'admin'].includes(membership.role);
export function canReadConversation(conversation, member, userId) {
  return conversation.owner_id === userId || (conversation.visibility === 'company' && conversation.allowed_roles.includes(member.role));
}
export function canWriteConversation(conversation, member, userId) {
  return member.role !== 'viewer' && canReadConversation(conversation, member, userId);
}
export function catalogAllowed(assignments, member) {
  return assignments.some(a => (a.subject_type === 'role' && a.subject === member.role) || (a.subject_type === 'classification' && a.subject === member.classification));
}
