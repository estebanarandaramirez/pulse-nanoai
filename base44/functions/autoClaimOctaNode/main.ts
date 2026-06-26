/**
 * autoClaimOctaNode
 * Automates node registration on cube.octa.computer using HTTP + CSRF scraping.
 * OctaSpace has no public API for this — we replicate the web form submission.
 *
 * Required env vars:
 *   OCTASPACE_WEB_EMAIL    — email for cube.octa.computer login
 *   OCTASPACE_WEB_PASSWORD — password for cube.octa.computer login
 *
 * Input:  { node_token: string, node_name?: string }
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

// Extract all editable form fields (hidden + text/number inputs + selects) for PATCH submissions
function extractEditFormBody(html: string, formAction: string): URLSearchParams {
  const body = new URLSearchParams();

  const escapedAction = formAction.replace(CUBE_BASE, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedBase = CUBE_BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The edit form action is the node path (without /edit suffix)
  const nodePathMatch = formAction.match(/\/hosting\/nodes\/\d+/);
  const nodePathEsc = nodePathMatch ? nodePathMatch[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : escapedAction;
  const formChunkMatch = html.match(
    new RegExp(`<form[^>]+\\saction=["'](?:${escapedBase})?${nodePathEsc}["'][\\s\\S]*?<\\/form>`, 'i')
  );
  const scope = formChunkMatch ? formChunkMatch[0] : html;

  // Hidden inputs (includes authenticity_token and _method)
  for (const m of scope.matchAll(/<input[^>]+type=["']hidden["'][^>]*>/gi)) {
    const name = m[0].match(/\sname=["']([^"']+)["']/i)?.[1];
    const value = m[0].match(/\svalue=["']([^"']*)["']/i)?.[1] ?? '';
    if (name) body.set(name, value);
  }

  // Text / number inputs
  for (const m of scope.matchAll(/<input[^>]+type=["'](?:text|number)["'][^>]*>/gi)) {
    const name = m[0].match(/\sname=["']([^"']+)["']/i)?.[1];
    const value = m[0].match(/\svalue=["']([^"']*)["']/i)?.[1] ?? '';
    if (name) body.set(name, value);
  }

  // Selects — use the selected option if present, else first option
  for (const sel of scope.matchAll(/<select[^>]+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/select>/gi)) {
    const name = sel[1];
    const selectedOpt = [...sel[2].matchAll(/<option[^>]+value=["']([^"']+)["'][^>]*selected/gi)][0]
      ?? [...sel[2].matchAll(/<option[^>]+value=["']([^"']+)["']/gi)][0];
    if (selectedOpt) body.set(name, selectedOpt[1]);
  }

  return body;
}

// Extract a node ID (/hosting/nodes/:id) from a URL or HTML blob
function extractNodeId(html: string, url: string): string | null {
  const fromUrl = url.match(/\/hosting\/nodes\/(\d+)/);
  if (fromUrl) return fromUrl[1];
  const fromHtml = html.match(/\/hosting\/nodes\/(\d+)/);
  return fromHtml ? fromHtml[1] : null;
}

// Find a node ID on the nodes list page by matching a node name
async function findNodeIdByName(
  jar: CookieJar,
  commonHeaders: Record<string, string>,
  nodeName: string,
): Promise<string | null> {
  const listRes = await fetch(`${CUBE_BASE}/hosting/nodes`, {
    redirect: 'follow',
    headers: { ...commonHeaders, 'Cookie': jar.toString() },
  });
  jar.ingest(listRes.headers);
  const html = await listRes.text();

  // Find the href="/hosting/nodes/:id" closest to the node name
  const escaped = nodeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const byName = html.match(new RegExp(
    `href=["'](/(?:hosting/)?nodes/(\\d+))["'][\\s\\S]{0,400}${escaped}|${escaped}[\\s\\S]{0,400}href=["']/(?:hosting/)?nodes/(\\d+)["']`,
  ));
  if (byName) return byName[2] ?? byName[3] ?? null;

  // Fallback: return the first node ID found (most recently added in a sorted list)
  const first = html.match(/href=["']\/(?:hosting\/)?nodes\/(\d+)["']/i);
  return first ? first[1] : null;
}

// Configure a node: enable Rental service and Enable service ports
async function configureNode(
  jar: CookieJar,
  commonHeaders: Record<string, string>,
  nodeId: string,
): Promise<{ success: boolean; message: string; debug?: string }> {
  // ── Step A: GET the node configuration page ─────────────────────────────────
  // OctaSpace doesn't use /edit — try the node page directly, then with tab param
  const candidateUrls = [
    `${CUBE_BASE}/nodes/${nodeId}?type=configuration`,
    `${CUBE_BASE}/nodes/${nodeId}`,
  ];

  let editHtml = '';
  let editRes: Response | null = null;
  const urlAttempts: string[] = [];
  for (const url of candidateUrls) {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: {
        ...commonHeaders,
        'Cookie': jar.toString(),
        'Referer': `${CUBE_BASE}/hosting/nodes`,
      },
    });
    jar.ingest(res.headers);
    const html = await res.text();
    urlAttempts.push(`${url} → ${res.status} finalUrl=${res.url} len=${html.length}`);
    // Accept the first URL that returns a non-error page that isn't the login page
    if (res.status < 400 && !res.url.includes('/sign_in') && !res.url.includes('/login') && html.length > 200) {
      editHtml = html;
      editRes = res;
      break;
    }
  }

  if (!editRes || !editHtml) {
    return {
      success: false,
      message: `Node ${nodeId} config: could not find configuration page`,
      debug: urlAttempts.join(' | '),
    };
  }

  const editCsrf = extractCsrf(editHtml);
  if (!editCsrf) {
    return {
      success: false,
      message: `Node ${nodeId} config: could not extract CSRF from configuration page`,
      debug: `editUrl=${editRes.url} htmlLen=${editHtml.length} htmlSnippet=${editHtml.slice(0, 400).replace(/\s+/g, ' ')}`,
    };
  }

  // ── Step B: Build the PATCH body from existing form fields ──────────────────
  const patchUrl = `${CUBE_BASE}/nodes/${nodeId}`;
  const body = extractEditFormBody(editHtml, patchUrl);
  // Also dump field names for debugging if save fails
  const allFieldNames: string[] = [];
  for (const [k] of body.entries()) allFieldNames.push(k);

  // Ensure _method is PATCH (Rails method override)
  body.set('_method', 'patch');
  body.set('authenticity_token', editCsrf);

  // Inspect all raw input names from HTML (body only has submitted fields; checkboxes
  // that are unchecked won't appear in body, but hidden siblings will)
  const allInputs: string[] = [];
  for (const m of editHtml.matchAll(/<input[^>]+name=["']([^"']+)["'][^>]*>/gi)) {
    const name = m[0].match(/\sname=["']([^"']+)["']/i)?.[1] ?? '';
    if (name) allInputs.push(name);
  }

  // Enable Rental service ─────────────────────────────────────────────────────
  const servicesArrayField = allInputs.find(n => n.match(/services\[\]/i));
  const rentalBoolField = allInputs.find(n => n.match(/\[rental\]/i));
  if (servicesArrayField) {
    // Array-style: the hidden sibling sends [] so the array is always submitted;
    // we append the "rental" value to opt-in.
    body.append(servicesArrayField, 'rental');
  } else if (rentalBoolField) {
    body.set(rentalBoolField, '1');
  } else {
    // Blind attempt using both common patterns
    body.append('node[services][]', 'rental');
  }

  // Enable service ports ──────────────────────────────────────────────────────
  const portsEnabledField = allInputs.find(n =>
    n.match(/service_ports?_enabled|enable_service_ports?/i)
  ) ?? 'node[service_ports_enabled]';
  body.set(portsEnabledField, '1');

  // Port range — override whatever is already in the form
  const portStartField = allInputs.find(n => n.match(/port_start|service_port_start/i)) ?? 'node[service_port_start]';
  const portEndField   = allInputs.find(n => n.match(/port_end|service_port_end/i))   ?? 'node[service_port_end]';
  body.set(portStartField, '51800');
  body.set(portEndField,   '51816');

  // ── Step C: PATCH /hosting/nodes/:id ────────────────────────────────────────
  const turboReqId = crypto.randomUUID();
  const saveRes = await fetch(patchUrl, {
    method: 'POST',   // Rails tunnels PATCH via hidden _method field
    redirect: 'follow',
    headers: {
      ...commonHeaders,
      'Accept': 'text/vnd.turbo-stream.html, text/html, application/xhtml+xml',
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'Cookie': jar.toString(),
      'Referer': editRes.url,
      'Origin': CUBE_BASE,
      'X-CSRF-Token': editCsrf,
      'X-Turbo-Request-Id': turboReqId,
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
    },
    body: body.toString(),
  });
  jar.ingest(saveRes.headers);
  const saveHtml = await saveRes.text();

  if (saveHtml.includes('successfully updated') || saveHtml.includes('Node was successfully')) {
    return { success: true, message: `Node ${nodeId} configured: Rental enabled, service ports 51800-51816 open` };
  }

  // Surface any toast error
  const errMatch = saveHtml.match(/<div[^>]+flex-1[^>]*>\s*([^<]{5,}?)\s*<\/div>/i);
  const errMsg = errMatch ? errMatch[1].trim() : `HTTP ${saveRes.status}`;
  return {
    success: false,
    message: `Node ${nodeId} config save failed: ${errMsg}`,
    debug: `configUrl=${editRes.url} fields=${JSON.stringify(allFieldNames.slice(0, 20))} patchStatus=${saveRes.status}`,
  };
}

async function claimNodeOnCube(
  token: string,
  email: string,
  password: string,
  nodeName: string,
  autoConfigure: boolean,
): Promise<{ success: boolean; message: string; node_id?: string; configure_result?: { success: boolean; message: string }; debug?: string }> {
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

  // Note: nodes list shows names not tokens, so we can't detect duplicates here.
  // OctaSpace's server will reject with "Node was not created" if the token is
  // already claimed — we'll handle that in Step 6.

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
  createBody.set('data_center_type', 'own');
  createBody.set('node[name]', nodeName);
  createBody.set('commit', 'Create');

  const turboReqId = crypto.randomUUID();
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
      'X-Turbo-Request-Id': turboReqId,
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
    },
    body: createBody.toString(),
  });
  jar.ingest(createRes.headers);
  const createHtml = await createRes.text();

  // ── Step 6: Detect success from the POST response ────────────────────────────
  // The nodes list only shows node names, not tokens — check the Turbo Stream
  // response directly for OctaSpace's success toast text.
  if (createHtml.includes('successfully created')) {
    // ── Step 7: Extract node ID so we can configure it ───────────────────────
    let nodeId = extractNodeId(createHtml, createRes.url);
    if (!nodeId) {
      nodeId = await findNodeIdByName(jar, commonHeaders, nodeName);
    }

    if (!autoConfigure || !nodeId) {
      return {
        success: true,
        message: `Node token ${token} claimed on cube.octa.computer`,
        node_id: nodeId ?? undefined,
      };
    }

    // ── Steps 8-9: Configure the node (Rental + service ports) ───────────────
    const configResult = await configureNode(jar, commonHeaders, nodeId);
    return {
      success: true,
      message: `Node token ${token} claimed on cube.octa.computer`,
      node_id: nodeId,
      configure_result: configResult,
    };
  }

  // Extract the toast error message
  const toastMatch = createHtml.match(/<div[^>]+flex-1[^>]*>\s*([^<]{5,}?)\s*<\/div>/i);
  const errMsg = toastMatch
    ? toastMatch[1].trim()
    : `Submission returned status ${createRes.status} but no success message`;

  return {
    success: false,
    message: `Node claim failed: ${errMsg}`,
    debug: `action=${formAction} postStatus=${createRes.status}`,
  };
}

// ── Entry point ───────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { node_token, node_name, node_id, auto_configure = true, list_nodes = false } = await req.json().catch(() => ({}));
  if (!node_token && !node_id && !list_nodes) {
    return Response.json({ error: 'node_token, node_id, or list_nodes:true is required' }, { status: 400 });
  }

  const email = Deno.env.get('OCTASPACE_WEB_EMAIL');
  const password = Deno.env.get('OCTASPACE_WEB_PASSWORD');

  if (!email || !password) {
    return Response.json({
      success: false,
      message: 'OCTASPACE_WEB_EMAIL and OCTASPACE_WEB_PASSWORD are not set. Add them in Base44 → Settings → Environment Variables.',
    });
  }

  // Shared sign-in helper — mirrors Steps 1-2 of claimNodeOnCube exactly
  async function signInAndGetJar() {
    const jar = new CookieJar();
    const hdrs: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
    };
    const loginPageRes = await fetch(`${CUBE_BASE}/users/sign_in`, { headers: hdrs });
    jar.ingest(loginPageRes.headers);
    const loginHtml = await loginPageRes.text();
    const csrf = extractCsrf(loginHtml);
    if (!csrf) throw new Error('Could not extract CSRF from sign-in page');
    const signInRaw = await fetch(`${CUBE_BASE}/users/sign_in`, {
      method: 'POST', redirect: 'manual',
      headers: { ...hdrs, 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': jar.toString(), 'Referer': `${CUBE_BASE}/users/sign_in`, 'Origin': CUBE_BASE },
      body: new URLSearchParams({ authenticity_token: csrf, 'user[email]': email!, 'user[password]': password!, 'user[remember_me]': '0', commit: 'Log in' }).toString(),
    });
    jar.ingest(signInRaw.headers);
    const location = signInRaw.headers.get('location') ?? '';
    if (signInRaw.status >= 400 || signInRaw.status === 200 || location.includes('/sign_in') || !location) {
      throw new Error(`Sign-in failed — status=${signInRaw.status} location=${location}`);
    }
    const redirectTarget = location.startsWith('http') ? location : `${CUBE_BASE}${location}`;
    const signInRes = await fetch(redirectTarget, { redirect: 'follow', headers: { ...hdrs, 'Cookie': jar.toString() } });
    jar.ingest(signInRes.headers);
    return { jar, hdrs };
  }

  try {
    // list_nodes mode: sign in and return all node IDs visible in the hosting dashboard
    if (list_nodes) {
      const { jar, hdrs } = await signInAndGetJar();
      const listRes = await fetch(`${CUBE_BASE}/hosting/nodes`, {
        redirect: 'follow',
        headers: { ...hdrs, 'Cookie': jar.toString() },
      });
      jar.ingest(listRes.headers);
      const listHtml = await listRes.text();
      // Extract all /hosting/nodes/:id hrefs and their adjacent text (node name)
      const nodes: Array<{ id: string; path: string; context: string }> = [];
      for (const m of listHtml.matchAll(/href=["'](\/(?:hosting\/)?nodes\/(\d+)[^"']*)["'][^>]*>([^<]{0,60})/gi)) {
        const id = m[2];
        if (!nodes.find(n => n.id === id)) {
          nodes.push({ id, path: m[1], context: m[3].trim() });
        }
      }
      return Response.json({ success: true, nodes, list_url: listRes.url, html_len: listHtml.length });
    }

    // configure_only mode: skip claim, go straight to configureNode with the given node_id
    if (node_id && !node_token) {
      const { jar, hdrs: commonHeaders } = await signInAndGetJar();
      const configResult = await configureNode(jar, commonHeaders, String(node_id));
      return Response.json({ success: configResult.success, node_id: String(node_id), configure_result: configResult });
    }

    const result = await claimNodeOnCube(
      node_token,
      email,
      password,
      node_name || node_token.slice(-6).toUpperCase(),
      auto_configure !== false,
    );
    return Response.json(result);
  } catch (err: any) {
    return Response.json({ success: false, message: `Unexpected error: ${err.message}` }, { status: 500 });
  }
});
