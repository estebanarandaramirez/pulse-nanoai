/**
 * autoClaimOctaNode
 * Automates node registration on cube.octa.computer using HTTP + CSRF scraping.
 * OctaSpace has no public API for this — we replicate the web form submission.
 *
 * Required env vars:
 *   OCTASPACE_WEB_EMAIL    — email for cube.octa.computer login
 *   OCTASPACE_WEB_PASSWORD — password for cube.octa.computer login
 *
 * Input:  { node_token: string }
 * Output: { success: boolean, message: string }
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const CUBE_BASE = 'https://cube.octa.computer';

// Manages a cookie jar across requests
class CookieJar {
  private jar = new Map<string, string>();

  ingest(headers: Headers): void {
    // Deno exposes getSetCookie(); fall back to manual parsing
    const raw: string[] = typeof (headers as any).getSetCookie === 'function'
      ? (headers as any).getSetCookie()
      : (headers.get('set-cookie') ?? '').split(/,(?=[^ ])/);
    for (const cookie of raw) {
      const pair = cookie.split(';')[0].trim();
      const eq = pair.indexOf('=');
      if (eq > 0) this.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  toString(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

function extractCsrf(html: string): string {
  // Rails embeds CSRF in a <meta name="csrf-token"> tag
  const m = html.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']csrf-token["']/i)
    // Fallback: hidden authenticity_token input
    ?? html.match(/name=["']authenticity_token["'][^>]+value=["']([^"']+)["']/i)
    ?? html.match(/value=["']([^"']+)["'][^>]+name=["']authenticity_token["']/i);
  return m ? m[1] : '';
}

function extractTokenField(html: string): string {
  // Find the input field whose name contains "token" (but not authenticity_token)
  const matches = [...html.matchAll(/name=["']([^"']*token[^"']*)["']/gi)];
  for (const m of matches) {
    if (!m[1].includes('authenticity')) return m[1];
  }
  // Rails convention for Hosting::Node model → hosting_node[token]
  return 'hosting_node[token]';
}

function extractFormAction(html: string, fallback: string): string {
  const m = html.match(/<form[^>]+action=["']([^"']+)["']/i);
  if (!m) return fallback;
  return m[1].startsWith('http') ? m[1] : `${CUBE_BASE}${m[1]}`;
}

async function claimNodeOnCube(
  token: string,
  email: string,
  password: string,
): Promise<{ success: boolean; message: string; debug?: string }> {
  const jar = new CookieJar();
  const commonHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  // ── Step 1: GET sign-in page → session cookie + CSRF token ──────────────────
  const loginPageRes = await fetch(`${CUBE_BASE}/users/sign_in`, {
    headers: commonHeaders,
  });
  jar.ingest(loginPageRes.headers);
  const loginHtml = await loginPageRes.text();
  const signInCsrf = extractCsrf(loginHtml);

  if (!signInCsrf) {
    return { success: false, message: 'Could not extract CSRF token from sign-in page — site structure may have changed' };
  }

  // ── Step 2: POST credentials ─────────────────────────────────────────────────
  const signInBody = new URLSearchParams({
    'authenticity_token': signInCsrf,
    'user[email]': email,
    'user[password]': password,
    'user[remember_me]': '0',
    'commit': 'Log in',
  });

  // Use redirect: 'manual' so we capture the Set-Cookie on the 302 response
  // before following the redirect. With redirect: 'follow', Deno silently drops
  // the 302 response headers (including the authenticated session cookie).
  const signInRaw = await fetch(`${CUBE_BASE}/users/sign_in`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      ...commonHeaders,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': jar.toString(),
      'Referer': `${CUBE_BASE}/users/sign_in`,
      'Origin': CUBE_BASE,
    },
    body: signInBody.toString(),
  });
  jar.ingest(signInRaw.headers); // ← captures the authenticated session cookie from 302

  const location = signInRaw.headers.get('location') ?? '';
  const signInStatus = signInRaw.status;

  // A successful Devise sign-in always does 302 to a non-login URL
  if (signInStatus >= 400 || signInStatus === 200 || location.includes('/users/sign_in') || !location) {
    return {
      success: false,
      message: 'cube.octa.computer sign-in failed — check OCTASPACE_WEB_EMAIL and OCTASPACE_WEB_PASSWORD env vars',
      debug: `signInStatus=${signInStatus} location=${location} csrfFound=${!!signInCsrf}`,
    };
  }

  // Follow the redirect manually to pick up any additional cookies
  const redirectTarget = location.startsWith('http') ? location : `${CUBE_BASE}${location}`;
  const signInRes = await fetch(redirectTarget, {
    redirect: 'follow',
    headers: { ...commonHeaders, 'Cookie': jar.toString() },
  });
  jar.ingest(signInRes.headers);

  if (signInRes.url.includes('/users/sign_in')) {
    return {
      success: false,
      message: 'cube.octa.computer sign-in failed — check OCTASPACE_WEB_EMAIL and OCTASPACE_WEB_PASSWORD env vars',
      debug: `redirectedBackToSignIn=true redirectTarget=${redirectTarget}`,
    };
  }

  // ── Step 3: GET the "Add Node" form ──────────────────────────────────────────
  const newNodeRes = await fetch(`${CUBE_BASE}/hosting/nodes/new`, {
    redirect: 'follow',
    headers: {
      ...commonHeaders,
      'Cookie': jar.toString(),
      'Referer': `${CUBE_BASE}/`,
    },
  });
  jar.ingest(newNodeRes.headers);

  if (newNodeRes.url.includes('/users/sign_in')) {
    return {
      success: false,
      message: 'Redirected to sign-in when accessing Add Node — session not established',
      debug: `finalSignInUrl=${signInRes.url} cookieCount=${jar.toString().split(';').length}`,
    };
  }

  const newNodeHtml = await newNodeRes.text();
  const newNodeCsrf = extractCsrf(newNodeHtml);
  const tokenField = extractTokenField(newNodeHtml);
  const formAction = extractFormAction(newNodeHtml, `${CUBE_BASE}/hosting/nodes`);

  // ── Step 4: POST the node token ───────────────────────────────────────────────
  const createBody = new URLSearchParams({
    'authenticity_token': newNodeCsrf,
    [tokenField]: token,
    'commit': 'Add Node',
  });

  const createRes = await fetch(formAction, {
    method: 'POST',
    redirect: 'follow',
    headers: {
      ...commonHeaders,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': jar.toString(),
      'Referer': `${CUBE_BASE}/hosting/nodes/new`,
      'Origin': CUBE_BASE,
    },
    body: createBody.toString(),
  });
  jar.ingest(createRes.headers);
  const createHtml = await createRes.text();

  // ── Step 5: Verify by fetching the nodes list ─────────────────────────────────
  // Redirect away from /new is not a reliable success signal — Rails can redirect
  // to the index with an error flash. The only ground truth is whether the token
  // now appears in the nodes list.
  const listRes = await fetch(`${CUBE_BASE}/hosting/nodes`, {
    redirect: 'follow',
    headers: {
      ...commonHeaders,
      'Cookie': jar.toString(),
      'Referer': CUBE_BASE,
    },
  });
  jar.ingest(listRes.headers);
  const listHtml = await listRes.text();

  if (listHtml.includes(token)) {
    return { success: true, message: `Node token ${token} claimed on cube.octa.computer` };
  }

  // Token not in list — extract the error from whichever page we landed on
  const errMatch = createHtml.match(
    /<[^>]+class="[^"]*(?:alert|flash|error|notice)[^"]*"[^>]*>\s*(?:<[^>]+>\s*)*([^<]{5,})/i,
  );
  const errMsg = errMatch
    ? errMatch[1].trim()
    : `Token not found in nodes list after submission (field: ${tokenField}, action: ${formAction}, status: ${createRes.status})`;

  return {
    success: false,
    message: `Node claim failed: ${errMsg}`,
    debug: `step2Status=${signInStatus} step3Url=${newNodeRes.url} csrfFound=${!!newNodeCsrf} tokenField=${tokenField} action=${formAction} postStatus=${createRes.status} postUrl=${createRes.url}`,
  };
}

// ── Entry point ───────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { node_token } = await req.json().catch(() => ({}));
  if (!node_token) {
    return Response.json({ error: 'node_token is required' }, { status: 400 });
  }

  const email = Deno.env.get('OCTASPACE_WEB_EMAIL');
  const password = Deno.env.get('OCTASPACE_WEB_PASSWORD');

  if (!email || !password) {
    return Response.json({
      success: false,
      message: 'OCTASPACE_WEB_EMAIL and OCTASPACE_WEB_PASSWORD are not set. Add them in Base44 → Settings → Environment Variables.',
    });
  }

  try {
    const result = await claimNodeOnCube(node_token, email, password);
    return Response.json(result);
  } catch (err: any) {
    return Response.json({ success: false, message: `Unexpected error: ${err.message}` }, { status: 500 });
  }
});
