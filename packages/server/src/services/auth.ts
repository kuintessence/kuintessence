import { Role, type RoleName } from "@kuintessence/shared";
import * as jose from "jose";
import { z } from "zod";

const ROLE_VALUES = Object.values(Role) as [RoleName, ...RoleName[]];

const BaseTokenPayloadSchema = z.object({
  sub: z.string().min(1),
  role: z.enum(ROLE_VALUES),
  email: z.string().email(),
  orgIds: z.array(z.string().min(1)).optional(),
});

const SessionIdClaimSchema = z.string().uuid().optional();

export const TokenPayloadSchema = BaseTokenPayloadSchema.extend({
  sid: SessionIdClaimSchema,
  tokenUse: z.literal("access").optional(),
}).transform(({ sid, tokenUse: _tokenUse, ...payload }) => ({
  ...payload,
  ...(sid ? { sessionId: sid } : {}),
}));

const RefreshTokenPayloadSchema = BaseTokenPayloadSchema.extend({
  sid: SessionIdClaimSchema,
  jti: z.string().uuid(),
  tokenUse: z.literal("session_refresh"),
}).transform(({ sid, tokenUse: _tokenUse, jti, ...payload }) => ({
  ...payload,
  ...(sid ? { sessionId: sid } : {}),
  refreshTokenId: jti,
}));

export type TokenPayload = z.infer<typeof TokenPayloadSchema>;
export type SessionRefreshTokenPayload = z.infer<typeof RefreshTokenPayloadSchema>;

function tokenClaims(payload: TokenPayload): Record<string, string | string[]> {
  return {
    sub: payload.sub,
    role: payload.role,
    email: payload.email,
    ...(payload.orgIds ? { orgIds: payload.orgIds } : {}),
    ...(payload.sessionId ? { sid: payload.sessionId } : {}),
  };
}

export async function signToken(
  payload: TokenPayload,
  secret: string,
  expiresInSec: number,
): Promise<string> {
  const secretKey = new TextEncoder().encode(secret);
  return new jose.SignJWT({ ...tokenClaims(payload), tokenUse: "access" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + expiresInSec)
    .sign(secretKey);
}

export async function signSessionRefreshToken(
  payload: TokenPayload,
  secret: string,
  expiresInSec: number,
  refreshTokenId: string = crypto.randomUUID(),
): Promise<string> {
  const secretKey = new TextEncoder().encode(secret);
  return new jose.SignJWT({ ...tokenClaims(payload), tokenUse: "session_refresh" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setJti(refreshTokenId)
    .setExpirationTime(Math.floor(Date.now() / 1000) + expiresInSec)
    .sign(secretKey);
}

export async function verifyToken(token: string, secret: string): Promise<TokenPayload> {
  const secretKey = new TextEncoder().encode(secret);
  const { payload } = await jose.jwtVerify(token, secretKey);
  return TokenPayloadSchema.parse(payload);
}

export async function verifySessionRefreshToken(
  token: string,
  secret: string,
): Promise<SessionRefreshTokenPayload> {
  const secretKey = new TextEncoder().encode(secret);
  const { payload } = await jose.jwtVerify(token, secretKey);
  return RefreshTokenPayloadSchema.parse(payload);
}
