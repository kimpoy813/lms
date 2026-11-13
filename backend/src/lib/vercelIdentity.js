// Who a deployment on Vercel is, when it asks another Vercel service for something.
//
// Vercel gives every project a short-lived identity token (OpenID Connect). A function receives
// it with every request, a build finds it in VERCEL_OIDC_TOKEN. Vercel's own services accept it
// in place of a key: Vercel Sandbox (services/judge/vercelSandbox.js) and the AI Gateway
// (services/ai.js). Nothing has to be configured or stored.
//
// Only Node.js itself is used here, so that scripts of the build can use it as well.
const REQUEST_CONTEXT = Symbol.for('@vercel/request-context');

/** The claims of a token, unverified: Vercel checks the signature, this only reads who it is for. */
export function decodeClaims(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

const WITH_REQUEST = 'the project’s identity, handed to this request by Vercel';
const FROM_ENVIRONMENT = 'the project’s identity, from the environment';

/** One identity token → the credentials in it, or why it is not used. */
function readIdentityToken(token) {
  const claims = decodeClaims(token);
  if (!claims?.owner_id || !claims?.project_id) return { problem: 'An identity token was found, but it does not name a team and a project.' };
  const ownProject = process.env.VERCEL_PROJECT_ID || null;
  if (ownProject && claims.project_id !== ownProject) return { problem: 'An identity token for another Vercel project was found; nothing is started with it.' };
  // One that Vercel would turn down anyway, such as a token a build left behind.
  if (Number.isFinite(claims.exp) && claims.exp * 1000 <= Date.now()) return { problem: 'An identity token was found, but it has expired.' };
  return { credentials: { token, teamId: claims.owner_id, projectId: claims.project_id } };
}

/**
 * Who is asking.
 *   - On Vercel the project's own short-lived identity token. Vercel hands it to a function with
 *     every request (`requestToken`: the function's entry point notes it when the request arrives,
 *     see lib/vercel.js) and to a build as VERCEL_OIDC_TOKEN.
 *   - Anywhere else an access token with the team and project it belongs to (Vercel Sandbox only).
 * Asked again for every job: the token changes about every hour.
 *
 * An identity token is only used for the project it was issued to. Where Vercel names the project
 * of the deployment (VERCEL_PROJECT_ID), a token for any other project is refused: nothing is
 * started or spent on an account that merely sent a token along. And a token that came with the
 * request and cannot be used is not passed over in favour of another one. Vercel's SDK looks in
 * the same place before every call it makes and uses what it finds there, whatever it was given,
 * so the only safe thing to do then is nothing.
 *
 * @param {{ accessToken?: string, teamId?: string, projectId?: string, requestToken?: string | null }} [given]
 * @returns {{ credentials: { token: string, teamId: string, projectId: string } | null, source: string, problem: string | null }}
 *   `source` is for the administrator's check; `problem` says why a token that was there is not used.
 */
export function resolveIdentity({ accessToken, teamId, projectId, requestToken } = {}) {
  if (accessToken && teamId && projectId) return { credentials: { token: accessToken, teamId, projectId }, source: 'access token', problem: null };
  const none = (problem = null) => ({ credentials: null, source: 'none', problem });
  const present = (token) => typeof token === 'string' && token !== '';

  // What the platform says at this moment, then what was noted when the request arrived.
  let asked;
  try {
    asked = globalThis[REQUEST_CONTEXT]?.get?.()?.headers?.['x-vercel-oidc-token'];
  } catch {
    asked = undefined;
  }
  const withRequest = [...new Set([asked, requestToken].filter(present))].map(readIdentityToken);
  if (withRequest.length > 0) {
    const refused = withRequest.find((read) => read.problem);
    return refused ? none(refused.problem) : { credentials: withRequest[0].credentials, source: WITH_REQUEST, problem: null };
  }
  if (!present(process.env.VERCEL_OIDC_TOKEN)) return none();
  const read = readIdentityToken(process.env.VERCEL_OIDC_TOKEN);
  return read.problem ? none(read.problem) : { credentials: read.credentials, source: FROM_ENVIRONMENT, problem: null };
}
