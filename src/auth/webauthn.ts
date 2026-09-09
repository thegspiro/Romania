/**
 * WebAuthn (passkey) ceremonies.
 *
 * Three choices here are what keep third-party credential managers such as
 * Bitwarden, 1Password, iCloud Keychain and hardware security keys all usable.
 * Changing any of them will silently hide some authenticators from the
 * browser's prompt, which looks to the operator like "passkeys are broken":
 *
 *   1. `authenticatorAttachment` is deliberately NOT set. Setting it to
 *      'platform' restricts the prompt to authenticators built into the
 *      device and excludes every cross-platform credential manager.
 *   2. `attestation: 'none'`. Requesting attestation would let us identify the
 *      authenticator model, which is of no use to a single-operator site and
 *      causes some authenticators to prompt or refuse.
 *   3. `userVerification: 'preferred'`, not 'required'. The password is
 *      already the first factor; demanding a PIN or biometric on top of it
 *      excludes simple hardware keys for no gain in a two-factor design.
 *
 * The challenge for each ceremony is stored on the session row and checked
 * here, so a challenge issued to one browser cannot be completed by another.
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { Config } from '../config.js';
import type { AdminUser, StoredCredential } from './repository.js';

export class WebAuthnError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'WebAuthnError';
  }
}

/** Ceremonies time out client-side after this long; the server enforces its own TTL too. */
const CEREMONY_TIMEOUT_MS = 120_000;

export interface RegistrationCeremony {
  options: PublicKeyCredentialCreationOptionsJSON;
  challenge: string;
}

export async function startRegistration(
  config: Config,
  user: AdminUser,
  existing: readonly StoredCredential[],
): Promise<RegistrationCeremony> {
  const options = await generateRegistrationOptions({
    rpName: config.WEBAUTHN_RP_NAME,
    rpID: config.WEBAUTHN_RP_ID,
    userName: user.username,
    userDisplayName: user.displayName,
    userID: new Uint8Array(user.webauthnUserHandle),
    attestationType: 'none',
    timeout: CEREMONY_TIMEOUT_MS,
    // Stops the same authenticator being registered twice, which would leave
    // the operator unable to tell the two entries apart.
    excludeCredentials: existing.map((credential) => ({
      id: credential.credentialId,
      transports: credential.transports,
    })),
    authenticatorSelection: {
      // No authenticatorAttachment: see the file comment.
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  });

  return { options, challenge: options.challenge };
}

export interface VerifiedRegistration {
  credentialId: string;
  publicKey: Buffer;
  signCount: number;
  transports: string[];
  backedUp: boolean;
  deviceType: string;
  aaguid: Buffer | null;
}

export async function finishRegistration(
  config: Config,
  response: RegistrationResponseJSON,
  expectedChallenge: string,
): Promise<VerifiedRegistration> {
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: [...config.WEBAUTHN_ORIGINS],
      expectedRPID: config.WEBAUTHN_RP_ID,
      // The password already established user presence and identity; see the
      // file comment on why verification is preferred rather than required.
      requireUserVerification: false,
    });
  } catch (error) {
    throw new WebAuthnError(
      error instanceof Error ? error.message : 'Passkey registration could not be verified.',
    );
  }

  if (!verification.verified) {
    throw new WebAuthnError('Passkey registration could not be verified.');
  }

  const info = verification.registrationInfo;
  return {
    credentialId: info.credential.id,
    publicKey: Buffer.from(info.credential.publicKey),
    signCount: info.credential.counter,
    transports: info.credential.transports ?? [],
    backedUp: info.credentialBackedUp,
    deviceType: info.credentialDeviceType,
    aaguid: parseAaguid(info.aaguid),
  };
}

export interface AuthenticationCeremony {
  options: PublicKeyCredentialRequestOptionsJSON;
  challenge: string;
}

export async function startAuthentication(
  config: Config,
  credentials: readonly StoredCredential[],
): Promise<AuthenticationCeremony> {
  const options = await generateAuthenticationOptions({
    rpID: config.WEBAUTHN_RP_ID,
    timeout: CEREMONY_TIMEOUT_MS,
    allowCredentials: credentials.map((credential) => ({
      id: credential.credentialId,
      transports: credential.transports,
    })),
    userVerification: 'preferred',
  });

  return { options, challenge: options.challenge };
}

export interface VerifiedAuthentication {
  newSignCount: number;
}

export async function finishAuthentication(
  config: Config,
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
  credential: StoredCredential,
): Promise<VerifiedAuthentication> {
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: [...config.WEBAUTHN_ORIGINS],
      expectedRPID: config.WEBAUTHN_RP_ID,
      credential: {
        id: credential.credentialId,
        publicKey: new Uint8Array(credential.publicKey),
        counter: credential.signCount,
        transports: credential.transports,
      },
      requireUserVerification: false,
    });
  } catch (error) {
    throw new WebAuthnError(
      error instanceof Error ? error.message : 'Passkey could not be verified.',
    );
  }

  if (!verification.verified) {
    throw new WebAuthnError('Passkey could not be verified.');
  }

  return { newSignCount: verification.authenticationInfo.newCounter };
}

/**
 * Detects a cloned authenticator.
 *
 * A signature counter that fails to advance means either a cloned credential
 * or an authenticator that does not implement counters. Cloud-synced passkeys
 * (Bitwarden among them) legitimately report a constant 0, so a zero counter
 * is not evidence of anything -- but a counter that goes backwards from a
 * non-zero value is.
 */
export function signCountLooksCloned(previous: number, next: number): boolean {
  if (previous === 0 && next === 0) return false;
  return next <= previous;
}

function parseAaguid(aaguid: string | undefined): Buffer | null {
  if (aaguid === undefined || aaguid === '') return null;
  const hex = aaguid.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) return null;
  return Buffer.from(hex, 'hex');
}
