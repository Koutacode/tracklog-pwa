// deno-lint-ignore no-import-prefix
import { createClient } from "npm:@supabase/supabase-js@2.58.0";

type JsonRecord = Record<string, unknown>;

type MutationAck = {
  mutationId: string;
  entityType: string;
  entityId: string;
  status: "applied" | "duplicate" | "conflict" | "rejected" | "deleted";
  revision?: number;
  changeSeq?: number;
  message?: string;
  code?: string;
  currentRow?: JsonRecord;
};

type SyncEnvelope = {
  ok: true;
  data: {
    protocolVersion: 2;
    cursor: number;
    hasMore: boolean;
    acks: MutationAck[];
    changes: {
      trips: JsonRecord[];
      events: JsonRecord[];
      routePoints: JsonRecord[];
      reports: JsonRecord[];
      deletedTrips: JsonRecord[];
      deletedEvents: JsonRecord[];
      deletedReports: JsonRecord[];
    };
  };
};

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_MUTATIONS = 420;
const MAX_BODY_BYTES = 6 * 1024 * 1024;
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const adminClient = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function requiredText(value: unknown, field: string, maxLength: number) {
  if (typeof value !== "string") {
    throw new HttpError(400, `${field} is required`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new HttpError(400, `${field} is invalid`);
  }
  return normalized;
}

function errorStatus(code: string | undefined) {
  if (code === "42501") return 403;
  if (code?.startsWith("22")) return 400;
  return 500;
}

async function requireUser(req: Request) {
  const authorization = req.headers.get("Authorization") ?? "";
  if (!authorization.toLowerCase().startsWith("bearer ")) {
    throw new HttpError(401, "Authorization header is required");
  }
  const token = authorization.slice(7).trim();
  if (!token) throw new HttpError(401, "Authorization token is required");

  const { data, error } = await adminClient.auth.getUser(token);
  if (error || !data.user || data.user.is_anonymous) {
    throw new HttpError(401, "Authenticated user is required");
  }
  return data.user;
}

async function requireApprovedDevice(userId: string, deviceId: string) {
  const { data, error } = await adminClient
    .from("device_profiles")
    .select("device_id, auth_user_id, approval_status")
    .eq("device_id", deviceId)
    .eq("auth_user_id", userId)
    .maybeSingle();

  if (error) throw new HttpError(500, "Device approval check failed");
  if (!data || data.approval_status !== "approved") {
    throw new HttpError(403, "Approved device is required");
  }
}

function validateEnvelope(value: unknown): SyncEnvelope {
  const envelope = asRecord(value);
  const data = asRecord(envelope.data);
  const changes = asRecord(data.changes);
  const buckets = [
    "trips",
    "events",
    "routePoints",
    "reports",
    "deletedTrips",
    "deletedEvents",
    "deletedReports",
  ];
  const ackStatuses = new Set([
    "applied",
    "duplicate",
    "conflict",
    "rejected",
    "deleted",
  ]);

  if (envelope.ok !== true || data.protocolVersion !== 2) {
    throw new HttpError(500, "Sync RPC returned an invalid envelope");
  }
  if (
    !Number.isSafeInteger(data.cursor) || Number(data.cursor) < 0 ||
    typeof data.hasMore !== "boolean"
  ) {
    throw new HttpError(500, "Sync RPC returned an invalid cursor");
  }
  if (
    !Array.isArray(data.acks) ||
    buckets.some((bucket) => !Array.isArray(changes[bucket]))
  ) {
    throw new HttpError(500, "Sync RPC returned invalid change buckets");
  }
  if (
    data.acks.some((value) => {
      const ack = asRecord(value);
      return typeof ack.mutationId !== "string" ||
        typeof ack.entityType !== "string" ||
        typeof ack.entityId !== "string" ||
        typeof ack.status !== "string" ||
        !ackStatuses.has(ack.status);
    })
  ) {
    throw new HttpError(500, "Sync RPC returned an invalid ACK");
  }
  return value as SyncEnvelope;
}

async function readRequestBody(req: Request) {
  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new HttpError(413, "Sync request is too large");
  }

  if (!req.body) throw new HttpError(400, "Request body must be valid JSON");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new HttpError(413, "Sync request is too large");
      }
      chunks.push(value);
    }
    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return asRecord(JSON.parse(new TextDecoder().decode(merged)));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Request body must be valid JSON");
  } finally {
    reader.releaseLock();
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  }

  try {
    if (!supabaseUrl || !serviceRoleKey) {
      throw new HttpError(500, "TrackLog sync is not configured");
    }

    const user = await requireUser(req);
    const body = await readRequestBody(req);
    if (body.protocolVersion !== 2) {
      throw new HttpError(400, "protocolVersion 2 is required");
    }

    const deviceId = requiredText(body.deviceId, "deviceId", 180);
    if (!Number.isSafeInteger(body.cursor) || Number(body.cursor) < 0) {
      throw new HttpError(400, "cursor must be a non-negative integer");
    }
    if (!Array.isArray(body.mutations)) {
      throw new HttpError(400, "mutations must be an array");
    }
    if (body.mutations.length > MAX_MUTATIONS) {
      throw new HttpError(
        413,
        `At most ${MAX_MUTATIONS} mutations are allowed`,
      );
    }

    await requireApprovedDevice(user.id, deviceId);

    // This is the only database mutation call. PostgreSQL owns validation,
    // per-owner serialization, CAS, tombstones, receipts, and the cursor delta
    // inside one transaction.
    const { data, error } = await adminClient.rpc("tracklog_sync_v2", {
      _owner_user_id: user.id,
      _device_id: deviceId,
      _cursor: Number(body.cursor),
      _mutations: body.mutations,
    });
    if (error) {
      throw new HttpError(
        errorStatus(error.code),
        error.message || "TrackLog sync RPC failed",
      );
    }

    return jsonResponse(validateEnvelope(data));
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error
      ? error.message
      : "TrackLog sync failed";
    return jsonResponse({ ok: false, error: message }, status);
  }
});
