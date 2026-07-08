export interface AuthIdentity {
  id: string;
  email: string;
}

export interface SendInviteParams {
  email: string;
  workspaceId: string;
  personId: string;
}

export interface SentInvite {
  inviteId: string;
}

export interface SendMagicLinkParams {
  email: string;
}

export interface AuthTransport {
  sendInvite(params: SendInviteParams): Promise<SentInvite>;
  sendMagicLink(params: SendMagicLinkParams): Promise<void>;
  userFromAccessToken(accessToken: string): Promise<AuthIdentity | null>;
}

let overrideTransport: AuthTransport | null = null;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not configured`);
  }
  return value;
}

function appOrigin(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? process.env.VERCEL_URL ?? "http://localhost:3000";
}

async function parseAuthResponse(response: Response): Promise<AuthIdentity | null> {
  if (!response.ok) {
    return null;
  }
  const body = (await response.json().catch(() => null)) as { id?: unknown; email?: unknown } | null;
  if (typeof body?.id !== "string" || typeof body.email !== "string") {
    return null;
  }
  return { id: body.id, email: body.email };
}

function supabaseUrl(path: string, query?: URLSearchParams): string {
  const base = requiredEnv("SUPABASE_URL").replace(/\/$/, "");
  const suffix = query === undefined ? "" : `?${query.toString()}`;
  return `${base}/auth/v1/${path}${suffix}`;
}

async function supabasePost(path: string, serviceRole: boolean, body: unknown, query?: URLSearchParams): Promise<unknown> {
  const key = serviceRole ? requiredEnv("SUPABASE_SERVICE_ROLE_KEY") : requiredEnv("SUPABASE_ANON_KEY");
  const response = await fetch(supabaseUrl(path, query), {
    method: "POST",
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Supabase Auth ${path} returned ${response.status}`);
  }
  return response.json().catch(() => null);
}

function inviteIdFromResponse(body: unknown): string {
  const candidate = body as {
    id?: unknown;
    user?: { id?: unknown };
    data?: { id?: unknown; user?: { id?: unknown } };
  } | null;
  const id = candidate?.user?.id ?? candidate?.data?.user?.id ?? candidate?.data?.id ?? candidate?.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("Supabase Auth invite response did not include an invite id");
  }
  return id;
}

const supabaseTransport: AuthTransport = {
  async sendInvite(params) {
    const redirectTo = new URL("/auth/accept", appOrigin());
    redirectTo.searchParams.set("workspace_id", params.workspaceId);
    redirectTo.searchParams.set("person_id", params.personId);
    const query = new URLSearchParams({ redirect_to: redirectTo.toString() });
    const body = await supabasePost(
      "invite",
      true,
      { email: params.email, data: { workspace_id: params.workspaceId, person_id: params.personId } },
      query,
    );
    return { inviteId: inviteIdFromResponse(body) };
  },
  async sendMagicLink(params) {
    const redirectTo = new URL("/auth/session", appOrigin());
    const query = new URLSearchParams({ redirect_to: redirectTo.toString() });
    await supabasePost("otp", false, { email: params.email, type: "magiclink" }, query);
  },
  async userFromAccessToken(accessToken) {
    const key = process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (key === undefined || key === "") {
      throw new Error("SUPABASE_ANON_KEY is not configured");
    }
    const response = await fetch(supabaseUrl("user"), {
      headers: {
        apikey: key,
        authorization: `Bearer ${accessToken}`,
      },
    });
    return parseAuthResponse(response);
  },
};

export function getAuthTransport(): AuthTransport {
  return overrideTransport ?? supabaseTransport;
}

export function setAuthTransportForTests(transport: AuthTransport | null): void {
  overrideTransport = transport;
}
