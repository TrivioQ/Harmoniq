import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { cookies } from 'next/headers';
import { getJwtKey } from './env';

export interface SessionPayload extends JWTPayload {
  userId: string;
  email: string;
}

export async function encrypt(payload: JWTPayload) {
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(getJwtKey());
}

export async function decrypt(input: string): Promise<SessionPayload> {
  const { payload } = await jwtVerify(input, getJwtKey(), {
    algorithms: ['HS256'],
  });
  return payload as SessionPayload;
}

export async function createSession(userId: string, email: string) {
  const expires = new Date(Date.now() + 15 * 60 * 1000); // 15 mins
  const session = await encrypt({ userId, email, exp: expires.getTime() / 1000 });
  const refreshToken = crypto.randomUUID(); // In a real app, store this in DB

  const cookieStore = await cookies();
  cookieStore.set('session', session, {
    expires,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  });

  cookieStore.set('refresh', refreshToken, {
    expires: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  });
}

export async function getSession() {
  const session = (await cookies()).get('session')?.value;
  if (!session) return null;

  try {
    return await decrypt(session);
  } catch {
    return null;
  }
}

export async function clearSession() {
  const cookieStore = await cookies();
  cookieStore.delete('session');
  cookieStore.delete('refresh');
}
