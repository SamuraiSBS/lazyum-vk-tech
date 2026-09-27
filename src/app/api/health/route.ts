export const runtime = "nodejs";

export async function GET() {
  return Response.json(
    { ok: true },
    { headers: { "Cache-Control": "no-store" } },
  );
}
