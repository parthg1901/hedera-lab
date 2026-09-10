import { LabInfrastructureError } from "./types.js";
export async function mirrorGet(base: string, route: string): Promise<{ status: number; body: Record<string, unknown> }> {
  let response: Response;
  try { response = await fetch(`${base}${route}`, { signal: AbortSignal.timeout(5000), redirect: "error" }); }
  catch { throw new LabInfrastructureError("Mirror node unreachable or request timed out"); }
  if (response.status === 404) return { status: 404, body: {} };
  if (!response.ok) throw new LabInfrastructureError(`Mirror node HTTP ${response.status}`);
  try {
    const body = await response.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return { status: response.status, body: body as Record<string, unknown> };
  } catch { throw new LabInfrastructureError("Mirror node returned malformed JSON"); }
}
