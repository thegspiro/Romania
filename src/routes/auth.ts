/**
 * Authentication routes.
 *
 * Login is two steps and they are not optional:
 *
 *   1. POST /login            username + password  -> session, `password_pending`
 *   2. WebAuthn or a recovery code                 -> session, `authenticated`
 *
 * A `password_pending` session can read nothing private; `request.viewer` only
 * becomes an admin viewer for an `authenticated` one. Between the two steps
 * the session id is rotated, so a token captured during step one is useless
 * afterwards.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type { AppContext } from '../http/server.js';
import { sessionCookieOptions } from '../http/server.js';
import { cookieOptions } from '../http/csrf.js';
import { renderPage } from '../http/context.js';
import { badRequest, unauthorized } from '../http/errors.js';
import {
  clearLoginFailures,
  consumeRecoveryCode,
  countRecentFailures,
  findCredentialByCredentialId,
  findUserById,
  findUserByUsername,
  insertCredential,
  listCredentials,
  listUnusedRecoveryCodes,
  recordCredentialUse,
  recordLoginAttempt,
  type AdminUser,
} from '../auth/repository.js';
import { hashPassword, needsRehash, policyFromConfig, verifyPassword } from '../auth/password.js';
import { updatePasswordHash } from '../auth/repository.js';
import { findMatchingRecoveryCode } from '../auth/recovery.js';
import {
  clearChallenge,
  createSession,
  destroySession,
  packIpAddress,
  promoteSession,
  setChallenge,
} from '../auth/session.js';
import {
  finishAuthentication,
  finishRegistration,
  signCountLooksCloned,
  startAuthentication,
  startRegistration,
  WebAuthnError,
} from '../auth/webauthn.js';
import { recordAudit } from '../content/audit.js';

/**
 * An Argon2id hash of a random string, used to spend the same time verifying a
 * password for a username that does not exist as for one that does. Without
 * it, response time tells an attacker which usernames are real.
 */
let decoyHash: string | null = null;

async function decoy(config: AppContext['config']): Promise<string> {
  decoyHash ??= await hashPassword(
    'decoy-password-never-matches-anything-at-all',
    policyFromConfig(config),
  );
  return decoyHash;
}

interface LoginBody {
  username?: unknown;
  password?: unknown;
}

interface RecoveryBody {
  code?: unknown;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Sends a JSON error without leaking internals. */
function jsonError(reply: FastifyReply, status: number, message: string): FastifyReply {
  return reply.status(status).type('application/json').send({ error: message });
}

export function registerAuthRoutes(app: FastifyInstance, context: AppContext): void {
  const { config, pool } = context;
  const policy = policyFromConfig(config);

  /** The session must have passed the password step. */
  async function requirePendingOrAuthenticated(request: FastifyRequest): Promise<AdminUser> {
    const session = request.session;
    if (session === null) throw unauthorized('no session');

    const user = await findUserById(pool, session.userId);
    if (user === null) throw unauthorized('session references a missing user');
    return user;
  }

  app.get('/login', async (request, reply) => {
    if (request.session?.authState === 'authenticated') {
      return reply.redirect('/admin');
    }
    if (request.session !== null) {
      return reply.redirect('/login/second-factor');
    }
    return renderPage(config, request, reply, 'auth/login', {}, { noindex: true });
  });

  app.post('/login', async (request, reply) => {
    const body = request.body as LoginBody | undefined;
    const username = asString(body?.username).trim();
    const password = asString(body?.password);
    const ip = packIpAddress(request.ip);

    if (username === '' || password === '') {
      return renderPage(
        config,
        request,
        reply,
        'auth/login',
        { username },
        { status: 400, noindex: true, flash: { kind: 'error', text: 'Enter both fields.' } },
      );
    }

    const failures = await countRecentFailures(pool, {
      identifier: username,
      ip,
      windowMinutes: config.LOGIN_WINDOW_MINUTES,
    });

    if (failures >= config.LOGIN_MAX_ATTEMPTS) {
      await recordAudit(
        pool,
        { actor: username, action: 'auth.login.locked', ip: request.ip },
        request.log,
      );
      return renderPage(
        config,
        request,
        reply,
        'auth/login',
        { username },
        {
          status: 429,
          noindex: true,
          flash: {
            kind: 'error',
            text: `Too many failed attempts. Try again in ${config.LOGIN_LOCKOUT_MINUTES} minutes.`,
          },
        },
      );
    }

    const user = await findUserByUsername(pool, username);
    // Always run a verification, even with no such user, so the two cases
    // take the same time.
    const passwordOk = await verifyPassword(user?.passwordHash ?? (await decoy(config)), password);

    if (user === null || !passwordOk) {
      await recordLoginAttempt(pool, { identifier: username, ip, successful: false });
      await recordAudit(
        pool,
        { actor: username, action: 'auth.login.failure', ip: request.ip },
        request.log,
      );
      return renderPage(
        config,
        request,
        reply,
        'auth/login',
        { username },
        {
          status: 401,
          noindex: true,
          flash: { kind: 'error', text: 'Incorrect username or password.' },
        },
      );
    }

    // Upgrade the stored hash when the cost policy has been raised since it
    // was written. This is the only moment the plaintext is available.
    if (needsRehash(user.passwordHash, policy)) {
      await updatePasswordHash(pool, user.id, await hashPassword(password, policy));
    }

    const session = await createSession(pool, {
      userId: user.id,
      ttlMs: config.sessionTtlMs,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      authState: 'password_pending',
    });

    reply.setCookie(config.sessionCookieName, session.token, sessionCookieOptions(config));
    return reply.redirect('/login/second-factor');
  });

  app.get('/login/second-factor', async (request, reply) => {
    if (request.session === null) return reply.redirect('/login');
    if (request.session.authState === 'authenticated') return reply.redirect('/admin');

    const user = await requirePendingOrAuthenticated(request);
    const credentials = await listCredentials(pool, user.id);

    // With no passkey registered, the second factor cannot be presented, so
    // the step becomes registering one. This is the first-login path.
    if (credentials.length === 0) {
      return renderPage(
        config,
        request,
        reply,
        'auth/register-passkey',
        { username: user.username, firstTime: true },
        { noindex: true },
      );
    }

    return renderPage(
      config,
      request,
      reply,
      'auth/passkey',
      { username: user.username },
      { noindex: true },
    );
  });

  // --- Passkey authentication ---------------------------------------------

  app.post('/auth/passkey/authenticate/options', async (request, reply) => {
    const session = request.session;
    if (session === null || session.authState !== 'password_pending') {
      return jsonError(reply, 401, 'Sign in with your password first.');
    }

    const credentials = await listCredentials(pool, session.userId);
    if (credentials.length === 0) {
      return jsonError(reply, 400, 'No passkey is registered for this account.');
    }

    const ceremony = await startAuthentication(config, credentials);
    await setChallenge(pool, session.id, ceremony.challenge);
    return reply.type('application/json').send(ceremony.options);
  });

  app.post('/auth/passkey/authenticate/verify', async (request, reply) => {
    const session = request.session;
    if (session === null || session.authState !== 'password_pending') {
      return jsonError(reply, 401, 'Sign in with your password first.');
    }
    if (session.webauthnChallenge === null) {
      return jsonError(reply, 400, 'This sign-in attempt expired. Start again.');
    }

    const response = request.body as AuthenticationResponseJSON | undefined;
    if (response === undefined || typeof response.id !== 'string') {
      return jsonError(reply, 400, 'Malformed passkey response.');
    }

    const credential = await findCredentialByCredentialId(pool, response.id);
    // The credential must belong to the half-authenticated user; otherwise
    // any registered passkey would complete anyone's login.
    if (credential === null || credential.userId !== session.userId) {
      await clearChallenge(pool, session.id);
      return jsonError(reply, 401, 'That passkey is not registered for this account.');
    }

    let verified;
    try {
      verified = await finishAuthentication(
        config,
        response,
        session.webauthnChallenge,
        credential,
      );
    } catch (error) {
      await clearChallenge(pool, session.id);
      request.log.warn({ err: error }, 'passkey authentication failed');
      return jsonError(
        reply,
        401,
        error instanceof WebAuthnError ? error.message : 'Passkey verification failed.',
      );
    }

    if (signCountLooksCloned(credential.signCount, verified.newSignCount)) {
      // Not fatal on its own -- some authenticators never increment -- but it
      // is the only signal a cloned credential produces, so it is recorded.
      request.log.warn(
        {
          credentialId: credential.id,
          previous: credential.signCount,
          next: verified.newSignCount,
        },
        'passkey signature counter did not advance',
      );
    }

    await recordCredentialUse(pool, credential.id, verified.newSignCount);
    const rotated = await promoteSession(pool, session.id, config.sessionTtlMs);
    reply.setCookie(config.sessionCookieName, rotated, sessionCookieOptions(config));

    await recordLoginAttempt(pool, {
      identifier: (await findUserById(pool, session.userId))?.username ?? String(session.userId),
      ip: packIpAddress(request.ip),
      successful: true,
    });
    await clearLoginFailures(
      pool,
      (await findUserById(pool, session.userId))?.username ?? String(session.userId),
    );
    await recordAudit(
      pool,
      {
        actor: String(session.userId),
        action: 'auth.login.success',
        detail: { method: 'passkey', credential: credential.label },
        ip: request.ip,
      },
      request.log,
    );

    return reply.type('application/json').send({ ok: true, redirect: '/admin' });
  });

  // --- Passkey registration ------------------------------------------------

  app.post('/auth/passkey/register/options', async (request, reply) => {
    const session = request.session;
    if (session === null) return jsonError(reply, 401, 'Sign in first.');

    const user = await findUserById(pool, session.userId);
    if (user === null) return jsonError(reply, 401, 'Sign in first.');

    const existing = await listCredentials(pool, user.id);
    // Registering during login is only allowed when there is nothing to
    // authenticate with; otherwise a stolen password could add a passkey.
    if (session.authState !== 'authenticated' && existing.length > 0) {
      return jsonError(reply, 403, 'Complete sign-in with an existing passkey first.');
    }

    const ceremony = await startRegistration(config, user, existing);
    await setChallenge(pool, session.id, ceremony.challenge);
    return reply.type('application/json').send(ceremony.options);
  });

  app.post('/auth/passkey/register/verify', async (request, reply) => {
    const session = request.session;
    if (session === null) return jsonError(reply, 401, 'Sign in first.');
    if (session.webauthnChallenge === null) {
      return jsonError(reply, 400, 'This registration attempt expired. Start again.');
    }

    const body = request.body as (RegistrationResponseJSON & { label?: unknown }) | undefined;
    if (body === undefined || typeof body.id !== 'string') {
      return jsonError(reply, 400, 'Malformed passkey response.');
    }

    const existing = await listCredentials(pool, session.userId);
    if (session.authState !== 'authenticated' && existing.length > 0) {
      return jsonError(reply, 403, 'Complete sign-in with an existing passkey first.');
    }

    let registration;
    try {
      registration = await finishRegistration(config, body, session.webauthnChallenge);
    } catch (error) {
      await clearChallenge(pool, session.id);
      request.log.warn({ err: error }, 'passkey registration failed');
      return jsonError(
        reply,
        400,
        error instanceof WebAuthnError ? error.message : 'Passkey registration failed.',
      );
    }

    const label = asString(body.label).trim().slice(0, 190) || defaultLabel(registration.backedUp);

    await insertCredential(pool, {
      userId: session.userId,
      credentialId: registration.credentialId,
      publicKey: registration.publicKey,
      signCount: registration.signCount,
      transports: registration.transports,
      label,
      backedUp: registration.backedUp,
      deviceType: registration.deviceType,
      aaguid: registration.aaguid,
    });
    await clearChallenge(pool, session.id);
    await recordAudit(
      pool,
      {
        actor: String(session.userId),
        action: 'auth.passkey.registered',
        detail: { label, backedUp: registration.backedUp },
        ip: request.ip,
      },
      request.log,
    );

    // Registering the first passkey completes the login it was part of.
    if (session.authState === 'password_pending') {
      const rotated = await promoteSession(pool, session.id, config.sessionTtlMs);
      reply.setCookie(config.sessionCookieName, rotated, sessionCookieOptions(config));
      return reply.type('application/json').send({ ok: true, redirect: '/admin/security' });
    }

    return reply.type('application/json').send({ ok: true, redirect: '/admin/security' });
  });

  // --- Recovery codes ------------------------------------------------------

  app.get('/login/recovery', async (request, reply) => {
    if (request.session === null) return reply.redirect('/login');
    if (request.session.authState === 'authenticated') return reply.redirect('/admin');
    return renderPage(config, request, reply, 'auth/recovery', {}, { noindex: true });
  });

  app.post('/login/recovery', async (request, reply) => {
    const session = request.session;
    if (session === null) return reply.redirect('/login');
    if (session.authState === 'authenticated') return reply.redirect('/admin');

    const submitted = asString((request.body as RecoveryBody | undefined)?.code).trim();
    if (submitted === '') throw badRequest('Enter a recovery code.');

    const stored = await listUnusedRecoveryCodes(pool, session.userId);
    const matchId = await findMatchingRecoveryCode(submitted, stored);

    if (matchId === null || !(await consumeRecoveryCode(pool, matchId))) {
      await recordLoginAttempt(pool, {
        identifier: String(session.userId),
        ip: packIpAddress(request.ip),
        successful: false,
      });
      return renderPage(
        config,
        request,
        reply,
        'auth/recovery',
        {},
        {
          status: 401,
          noindex: true,
          flash: {
            kind: 'error',
            text: 'That recovery code is not valid or has already been used.',
          },
        },
      );
    }

    const rotated = await promoteSession(pool, session.id, config.sessionTtlMs);
    reply.setCookie(config.sessionCookieName, rotated, sessionCookieOptions(config));
    await recordAudit(
      pool,
      { actor: String(session.userId), action: 'auth.recovery.used', ip: request.ip },
      request.log,
    );

    return reply.redirect('/admin/security');
  });

  // --- Logout ---------------------------------------------------------------

  app.post('/logout', async (request, reply) => {
    const session = request.session;
    if (session !== null) {
      await destroySession(pool, session.id);
      await recordAudit(
        pool,
        { actor: String(session.userId), action: 'auth.logout', ip: request.ip },
        request.log,
      );
    }
    reply.clearCookie(config.sessionCookieName, cookieOptions(config));
    return reply.redirect('/');
  });
}

function defaultLabel(backedUp: boolean): string {
  return backedUp ? 'Synced passkey' : 'Device passkey';
}
