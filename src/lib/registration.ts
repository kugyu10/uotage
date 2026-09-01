const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const PATH_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export type RegistrationInput = {
  email: string;
  name: string | null;
  funnelSlug: string;
  registrationPath: string | null;
  website: string;
};

export function parseRegistrationInput(value: unknown): RegistrationInput {
  if (!value || typeof value !== "object") throw new Error("INVALID_BODY");
  const body = value as Record<string, unknown>;
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const funnelSlug = typeof body.funnelSlug === "string" ? body.funnelSlug.trim() : "";
  const registrationPath =
    typeof body.registrationPath === "string" ? body.registrationPath.trim() : "";
  const website = typeof body.website === "string" ? body.website.trim() : "";

  if (email.length > 254 || !EMAIL_PATTERN.test(email)) throw new Error("INVALID_EMAIL");
  if (name.length > 100) throw new Error("INVALID_NAME");
  if (!SLUG_PATTERN.test(funnelSlug)) throw new Error("INVALID_FUNNEL");
  if (registrationPath && !PATH_PATTERN.test(registrationPath)) throw new Error("INVALID_PATH");

  return {
    email,
    name: name || null,
    funnelSlug,
    registrationPath: registrationPath || null,
    website,
  };
}

export function createUrlToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}
