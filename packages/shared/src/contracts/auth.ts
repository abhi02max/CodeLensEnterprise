import { z } from 'zod';
import { MIN_PASSWORD_LENGTH } from '../constants';
import { Role } from '../enums';
import { IdSchema } from './common';

/**
 * Password policy. Length carries more real security value than character-class
 * rules, so the floor is 12 with a single check that the value is not one of the
 * obvious throwaways.
 */
const WEAK_PASSWORDS = new Set([
  'password1234',
  'passwordpassword',
  '123456789012',
  'qwertyuiop12',
  'letmein12345',
]);

export const PasswordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  .max(200, 'Password must be at most 200 characters')
  .refine((v) => !WEAK_PASSWORDS.has(v.toLowerCase()), 'Password is too common')
  .refine((v) => /[a-zA-Z]/.test(v) && /[0-9]/.test(v), 'Password must contain letters and numbers');

export const EmailSchema = z.string().trim().toLowerCase().email('Enter a valid email address');

export const SignUpSchema = z.object({
  email: EmailSchema,
  password: PasswordSchema,
  name: z.string().trim().min(1, 'Name is required').max(120),
  /** Optional: creates a new organization and makes this user its OWNER. */
  organizationName: z.string().trim().min(2).max(120).optional(),
  /** Optional: accepts a pending invite instead of creating an org. */
  inviteToken: z.string().min(10).optional(),
});
export type SignUpInput = z.infer<typeof SignUpSchema>;

export const SignInSchema = z.object({
  email: EmailSchema,
  password: z.string().min(1, 'Password is required'),
});
export type SignInInput = z.infer<typeof SignInSchema>;

export const RefreshSchema = z.object({
  refreshToken: z.string().min(10).optional(),
});

export const UpdateProfileSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  avatarUrl: z.string().url().max(500).nullable().optional(),
  timezone: z.string().max(60).optional(),
});
export type UpdateProfileInput = z.infer<typeof UpdateProfileSchema>;

export const ChangePasswordSchema = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: PasswordSchema,
  })
  .refine((v) => v.currentPassword !== v.newPassword, {
    message: 'New password must differ from the current one',
    path: ['newPassword'],
  });

// ---------------------------------------------------------------- responses

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  githubLogin: string | null;
  githubConnected: boolean;
  createdAt: string;
}

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  role: Role;
}

export interface SessionResponse {
  user: PublicUser;
  organizations: OrganizationSummary[];
  /** The org the session is currently scoped to. */
  activeOrganizationId: string | null;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface AuthResponse extends SessionResponse {
  tokens: AuthTokens;
}

/**
 * JWT access token payload.
 *
 * `orgId` and `role` are embedded so the common path (authorize a request within
 * one org) needs no database round trip. The tradeoff is that a role change does
 * not take effect until the short-lived access token expires, which is why
 * JWT_ACCESS_TTL is 15 minutes.
 */
export interface JwtPayload {
  sub: string;
  email: string;
  orgId: string | null;
  role: Role | null;
  /** Token generation counter; bumped on password change to revoke sessions. */
  gen: number;
  iat?: number;
  exp?: number;
}

export const SwitchOrganizationSchema = z.object({
  organizationId: IdSchema,
});
