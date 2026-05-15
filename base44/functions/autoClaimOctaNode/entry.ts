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

function extractFormAction(html: string, fallback: string): string {
  // Match only the HTML action= attribute (not data-action= or similar)
  const forms = [...html.matchAll(/<form[^>]+\saction=["']([^"']+)["']/gi)];
  for (const m of forms) {
    const action = m[1].startsWith('http') ? m[1] : `${CUBE_BASE}${m[1]}`;
    if (!action.includes('sign_out') && !action.includes('sign_in')) return action;
  }
  return fallback;
}

// Extract form fields scoped to the specific form whose action matches formAction
function extractFormBody(html: string, formAction: string, tokenOverride: { field: string; value: string }): URLSearchParams {
  const body = new URLSearchParams();

  // Isolate the specific form by its action attribute
  const actionPath = formAction.replace(CUBE_BASE, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const formChunkMatch = html.match(new RegExp(`<form[^>]+\\saction=["'](?:${CUBE_BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})?${actionPath}["'][\\s\\S]*?<\\/form>`, 'i'));
  const scope = formChunkMatch ? formChunkMatch[0] : html;

  // Hidden inputs from this form only
  for (const m of scope.matchAll(/<input[^>]+type=["']hidden["'][^>]*>/gi)) {
    const name = m[0].match(/\sname=["']([^"']+)["']/i)?.[1];
    const value = m[0].match(/\svalue=["']([^"']*)["']/i)?.[1] ?? '';
    if (name) body.set(name, value);
  }

  // Select elements from this form — pick first non-empty option
  for (const sel of scope.matchAll(/<select[^>]+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/select>/gi)) {
    const name = sel[1];
    const firstOption = [...sel[2].matchAll(/<option[^>]+value=["']([^"']+)["']/gi)][0];
    if (firstOption) body.set(name, firstOption[1]);
  }

  // Remove _method if it's not POST (don't accidentally send PATCH/DELETE)
  if ((body.get('_method') ?? '').toLowerCase() !== 'post') body.delete('_method');

  // Override with the actual node token
  body.set(tokenOverride.field, tokenOverride.value);

  return body;
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
  // Use redirect: 'manual' so we capture the Set-Cookie on the 302 response
  // before following the redirect. With redirect: 'follow', Deno silently drops
  // the 302 response headers (including the authenticated session cookie).
  const signInBody = new URLSearchParams({
    'authenticity_token': signInCsrf,
    'user[email]': email,
    'user[password]': password,
    'user[remember_me]': '0',
    'commit': 'Log in',
  });

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

  // ── Step 3: GET the nodes list to discover the "Add Node" URL ───────────────
  const listPageRes = await fetch(`${CUBE_BASE}/hosting/nodes`, {
    redirect: 'follow',
    headers: { ...commonHeaders, 'Cookie': jar.toString(), 'Referer': `${CUBE_BASE}/` },
  });
  jar.ingest(listPageRes.headers);

  if (listPageRes.url.includes('/users/sign_in')) {
    return {
      success: false,
      message: 'Redirected to sign-in when accessing nodes list — session not established',
      debug: `finalSignInUrl=${signInRes.url}`,
    };
  }

  const listPageHtml = await listPageRes.text();

  // If token is already claimed, we're done
  if (listPageHtml.includes(token)) {
    return { success: true, message: `Node token ${token} is already claimed on cube.octa.computer` };
  }

  // Find the "Add Node" / "New Node" href in the nodes list page
  const addNodeUrl = (() => {
    const m = listPageHtml.match(/href=["']([^"']*(?:new|add)[^"']*)["'][^>]*>[\s\S]{0,60}(?:node|Node)/i)
      ?? listPageHtml.match(/(?:node|Node)[\s\S]{0,60}<[^>]+href=["']([^"']*(?:new|add)[^"']*)["']/i)
      ?? listPageHtml.match(/href=["']([^"']+)["'][^>]*>[\s\S]{0,30}(?:Add|New)[\s\S]{0,30}Node/i);
    if (!m) return null;
    return m[1].startsWith('http') ? m[1] : `${CUBE_BASE}${m[1]}`;
  })();

  if (!addNodeUrl) {
    const snippet = listPageHtml.replace(/<script[\s\S]*?<\/script>/gi, '').slice(0, 2000);
    return {
      success: false,
      message: 'Could not find Add Node link on the nodes list page',
      debug: `listPageSnippet=${snippet}`,
    };
  }

  // ── Step 4: GET the Add Node form (load in Turbo modal context) ──────────────
  const newNodeRes = await fetch(addNodeUrl, {
    redirect: 'follow',
    headers: {
      ...commonHeaders,
      'Accept': 'text/vnd.turbo-stream.html, text/html, application/xhtml+xml',
      'Cookie': jar.toString(),
      'Referer': `${CUBE_BASE}/hosting/nodes`,
      'Turbo-Frame': 'modal',
    },
  });
  jar.ingest(newNodeRes.headers);

  if (newNodeRes.url.includes('/users/sign_in')) {
    return {
      success: false,
      message: 'Redirected to sign-in when accessing Add Node form',
      debug: `addNodeUrl=${addNodeUrl}`,
    };
  }

  const newNodeHtml = await newNodeRes.text();
  const newNodeCsrf = extractCsrf(newNodeHtml);
  const formAction = extractFormAction(newNodeHtml, `${CUBE_BASE}/nodes`);

  if (!newNodeCsrf) {
    const snippet = newNodeHtml.replace(/<script[\s\S]*?<\/script>/gi, '').slice(0, 1500);
    return {
      success: false,
      message: 'Could not extract CSRF token from Add Node form',
      debug: `addNodeUrl=${addNodeUrl} pageSnippet=${snippet}`,
    };
  }

  // ── Step 5: POST the node token ───────────────────────────────────────────────
  // Build body from form hidden inputs + selects, then add fields the browser
  // sets via JavaScript (data_center_type radio, name text input, commit button)
  const createBody = extractFormBody(newNodeHtml, formAction, { field: 'node[token]', value: token });
  // Remove data_center_attributes — those are for creating a NEW DC, not selecting one
  for (const key of [...createBody.keys()]) {
    if (key.startsWith('node[data_center_attributes]')) createBody.delete(key);
  }
  createBody.set('data_center_type', 'own');   // "Select" radio — always use existing DC
  createBody.set('node[name]', '');            // optional name field
  createBody.set('commit', 'Create');

  const createRes = await fetch(formAction, {
    method: 'POST',
    redirect: 'follow',
    headers: {
      ...commonHeaders,
      'Accept': 'text/vnd.turbo-stream.html, text/html, application/xhtml+xml',
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'Cookie': jar.toString(),
      'Referer': `${CUBE_BASE}/hosting/nodes`,
      'Origin': CUBE_BASE,
      'Turbo-Frame': 'modal',
      'X-CSRF-Token': newNodeCsrf,
    },
    body: createBody.toString(),
  });
  jar.ingest(createRes.headers);
  const createHtml = await createRes.text();

  // ── Step 6: Verify by fetching the nodes list ─────────────────────────────────
  const verifyRes = await fetch(`${CUBE_BASE}/hosting/nodes`, {
    redirect: 'follow',
    headers: { ...commonHeaders, 'Cookie': jar.toString(), 'Referer': CUBE_BASE },
  });
  jar.ingest(verifyRes.headers);
  const verifyHtml = await verifyRes.text();

  if (verifyHtml.includes(token)) {
    return { success: true, message: `Node token ${token} claimed on cube.octa.computer` };
  }

  const errMatch = createHtml.match(
    /<[^>]+class="[^"]*(?:alert|flash|error|notice)[^"]*"[^>]*>\s*(?:<[^>]+>\s*)*([^<]{5,})/i,
  );
  const errMsg = errMatch
    ? errMatch[1].trim()
    : `Token not found in nodes list after submission (action: ${formAction}, status: ${createRes.status})`;

  const responseSnippet = createHtml.slice(0, 3000);

  return {
    success: false,
    message: `Node claim failed: ${errMsg}`,
    debug: `body=${createBody.toString()} action=${formAction} postStatus=${createRes.status} responseSnippet=${responseSnippet}`,
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
