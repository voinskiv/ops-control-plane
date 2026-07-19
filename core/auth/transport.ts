export interface AuthIdentity {
  id: string;
  email: string;
  authenticationMethods?: string[];
  identities?: AuthUserIdentity[];
}

export interface AuthUserIdentity {
  provider: string;
  identityData: {
    email?: string;
    emailVerified?: boolean;
  };
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
  revokeSession?(accessToken: string): Promise<void>;
}

let overrideTransport: AuthTransport | null = null;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not configured`);
  }
  return value;
}

export function appOrigin(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? process.env.VERCEL_URL ?? "http://localhost:3000";
}

function authenticationMethods(accessToken: string): string[] {
  const payload = accessToken.split(".")[1];
  if (payload === undefined) {
    return [];
  }
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      amr?: Array<{ method?: unknown }>;
    };
    return (claims.amr ?? []).flatMap((entry) => (typeof entry.method === "string" ? [entry.method] : []));
  } catch {
    return [];
  }
}

function authIdentities(value: unknown): AuthUserIdentity[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((candidate) => {
    const identity = candidate as { provider?: unknown; identity_data?: unknown };
    const identityData = identity.identity_data as { email?: unknown; email_verified?: unknown } | null;
    if (typeof identity.provider !== "string" || identityData === null || typeof identityData !== "object") {
      return [];
    }
    return [
      {
        provider: identity.provider,
        identityData: {
          email: typeof identityData.email === "string" ? identityData.email : undefined,
          emailVerified: identityData.email_verified === true,
        },
      },
    ];
  });
}

async function parseAuthResponse(response: Response, accessToken: string): Promise<AuthIdentity | null> {
  if (!response.ok) {
    return null;
  }
  const body = (await response.json().catch(() => null)) as {
    id?: unknown;
    email?: unknown;
    identities?: unknown;
  } | null;
  if (typeof body?.id !== "string" || typeof body.email !== "string") {
    return null;
  }
  return {
    id: body.id,
    email: body.email,
    authenticationMethods: authenticationMethods(accessToken),
    identities: authIdentities(body.identities),
  };
}

function supabaseUrl(path: string, query?: URLSearchParams): string {
  const base = requiredEnv("SUPABASE_URL").replace(/\/$/, "");
  const suffix = query === undefined ? "" : `?${query.toString()}`;
  return `${base}/auth/v1/${path}${suffix}`;
}

export function googleOAuthUrl(redirectTo: string): string {
  return supabaseUrl("authorize", new URLSearchParams({ provider: "google", redirect_to: redirectTo }));
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
    return parseAuthResponse(response, accessToken);
  },
  async revokeSession(accessToken) {
    const key = process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (key === undefined || key === "") {
      throw new Error("SUPABASE_ANON_KEY is not configured");
    }
    const response = await fetch(supabaseUrl("logout", new URLSearchParams({ scope: "local" })), {
      method: "POST",
      headers: {
        apikey: key,
        authorization: `Bearer ${accessToken}`,
      },
    });
    if (!response.ok) {
      throw new Error(`Supabase Auth logout returned ${response.status}`);
    }
  },
};

export function getAuthTransport(): AuthTransport {
  return overrideTransport ?? supabaseTransport;
}

export function setAuthTransportForTests(transport: AuthTransport | null): void {
  overrideTransport = transport;
}
